import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pluginul Capacitor simulat: ținem minte ascultătorii și câte ori s-a oprit microfonul.
const plugin = vi.hoisted(() => {
  const listeners: Record<string, ((d: unknown) => void)[]> = {};
  return {
    listeners,
    stops: 0,
    startResult: new Promise<{ matches?: string[] }>(() => {}) as Promise<{ matches?: string[] }>,
    emit(event: string, data: unknown) {
      (listeners[event] ?? []).forEach((l) => l(data));
    },
  };
});

vi.mock("@capacitor-community/speech-recognition", () => ({
  SpeechRecognition: {
    checkPermissions: async () => ({ speechRecognition: "granted" }),
    requestPermissions: async () => ({ speechRecognition: "granted" }),
    available: async () => ({ available: true }),
    start: () => plugin.startResult,
    // Ca pe telefonul real: stop() fără ascultare pornită nu răspunde niciodată.
    stop: () => {
      plugin.stops++;
      return new Promise<void>(() => {});
    },
    addListener: (event: string, cb: (d: unknown) => void) => {
      (plugin.listeners[event] ??= []).push(cb);
      return Promise.resolve({ remove: async () => {} });
    },
    removeAllListeners: async () => {
      for (const k of Object.keys(plugin.listeners)) delete plugin.listeners[k];
    },
  },
}));
vi.mock("@capacitor-community/text-to-speech", () => ({ TextToSpeech: {} }));
vi.mock("./api.ts", () => ({ isNative: true }));

const { NativeSpeechToText } = await import("./speech.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("microfonul nativ (Android): se oprește mereu", () => {
  beforeEach(() => {
    plugin.stops = 0;
    plugin.startResult = new Promise(() => {}); // telefonul nu se oprește singur (bug-ul raportat)
  });
  afterEach(() => vi.useRealTimers());

  it("stop() încheie ascultarea în curs și eliberează microfonul", async () => {
    const stt = new NativeSpeechToText();
    const heard = stt.listen();
    await tick();
    plugin.emit("partialResults", { matches: ["plătește factura"] });
    const stopsBefore = plugin.stops;

    await stt.stop();

    await expect(heard).resolves.toBe("plătește factura"); // promisiunea nu mai rămâne agățată
    expect(plugin.stops).toBeGreaterThan(stopsBefore); // SpeechRecognition.stop() a fost apelat
  });

  it("dacă telefonul nu anunță niciodată că s-a oprit, ascultarea se încheie singură după 15 s și eliberează microfonul", async () => {
    vi.useFakeTimers();
    const stt = new NativeSpeechToText();
    const heard = stt.listen();
    await vi.advanceTimersByTimeAsync(0);
    const stopsBefore = plugin.stops;

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(heard).resolves.toBe("");
    expect(plugin.stops).toBeGreaterThan(stopsBefore);
  });

  it("când telefonul se oprește singur (tăcere), rezultatul ajunge și microfonul e eliberat", async () => {
    const stt = new NativeSpeechToText();
    const heard = stt.listen();
    await tick();
    plugin.emit("partialResults", { matches: ["da"] });
    const stopsBefore = plugin.stops;
    plugin.emit("listeningState", { status: "stopped" });

    await expect(heard).resolves.toBe("da");
    expect(plugin.stops).toBeGreaterThan(stopsBefore);
  });

  it("pornirea microfonului nu se blochează când pluginul nu răspunde la stop() (bug găsit pe telefon)", async () => {
    let started = false;
    plugin.startResult = new Promise(() => {});
    const start = (await import("@capacitor-community/speech-recognition")).SpeechRecognition.start;
    const spy = vi.spyOn((await import("@capacitor-community/speech-recognition")).SpeechRecognition, "start").mockImplementation((o) => {
      started = true;
      return start(o);
    });
    const stt = new NativeSpeechToText();
    await stt.stop(); // ca la închiderea panoului, fără ascultare pornită
    void stt.listen();
    await tick();
    await tick();
    expect(started).toBe(true);
    await stt.stop();
    spy.mockRestore();
  });

  it("dacă Android nu confirmă că ascultă (ex. imediat după vocea asistentului), repornește recunoașterea o dată", async () => {
    vi.useFakeTimers();
    const mod = await import("@capacitor-community/speech-recognition");
    const startSpy = vi.spyOn(mod.SpeechRecognition, "start");
    const stt = new NativeSpeechToText();
    void stt.listen();
    await vi.advanceTimersByTimeAsync(0);
    expect(startSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3200); // nu a venit „started” → repornire
    expect(startSpy).toHaveBeenCalledTimes(2);

    plugin.emit("listeningState", { status: "started" }); // acum ascultă: fără alte reporniri
    await vi.advanceTimersByTimeAsync(5000);
    expect(startSpy).toHaveBeenCalledTimes(2);
    await stt.stop();
    startSpy.mockRestore();
  });

  it("dacă Android confirmă la timp, nu repornește nimic", async () => {
    vi.useFakeTimers();
    const mod = await import("@capacitor-community/speech-recognition");
    const startSpy = vi.spyOn(mod.SpeechRecognition, "start");
    const stt = new NativeSpeechToText();
    void stt.listen();
    await vi.advanceTimersByTimeAsync(0);
    plugin.emit("listeningState", { status: "started" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(startSpy).toHaveBeenCalledTimes(1);
    await stt.stop();
    startSpy.mockRestore();
  });

  it("stop() de mai multe ori, sau fără ascultare pornită, nu strică nimic", async () => {
    const stt = new NativeSpeechToText();
    await stt.stop();
    await stt.stop();
    const heard = stt.listen();
    await tick();
    await stt.stop();
    await expect(heard).resolves.toBe("");
  });
});
