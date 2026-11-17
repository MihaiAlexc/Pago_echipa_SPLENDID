import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech as NativeTts } from "@capacitor-community/text-to-speech";
import { isNative } from "./api.ts";

/**
 * Vocea, abstractizată: în browser folosim Web Speech API (ro-RO); în aplicația Android folosim
 * recunoașterea și vocea native ale telefonului (WebView-ul de Android NU are Web Speech API).
 * Restul aplicației vede doar interfețele de mai jos.
 */

export interface SpeechToText {
  readonly supported: boolean;
  /** Ascultă o frază. `onPartial` primește textul pe măsură ce vorbești. Întoarce fraza finală. */
  listen(onPartial?: (text: string) => void): Promise<string>;
  stop(): void;
}

export interface TextToSpeech {
  readonly supported: boolean;
  /** Citește textul. `onProgress(n)` = câte caractere au fost rostite până acum (pentru textul care apare treptat). */
  speak(text: string, onProgress?: (chars: number) => void): Promise<void>;
  stop(): void;
}

export class SpeechError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const STT_MESSAGES: Record<string, string> = {
  "not-allowed": "Microfonul e blocat. Permite accesul la microfon din setările browserului.",
  "service-not-allowed": "Microfonul e blocat. Permite accesul la microfon din setările browserului.",
  "no-speech": "Nu am auzit nimic. Mai încearcă.",
  "audio-capture": "Nu găsesc microfonul.",
  network: "Recunoașterea vocală are nevoie de internet.",
};

// Tipuri minime pentru Web Speech API (nu sunt în lib.dom pentru toate browserele).
interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEvent { results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string; interimResults: boolean; maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionCtor = new () => Recognition;

export class BrowserSpeechToText implements SpeechToText {
  private Ctor: RecognitionCtor | undefined;
  private current: Recognition | null = null;

  constructor(private lang = "ro-RO") {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    this.Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  }

  get supported() {
    return Boolean(this.Ctor) && window.isSecureContext;
  }

  listen(onPartial?: (text: string) => void): Promise<string> {
    if (!this.Ctor) return Promise.reject(new SpeechError("unsupported", "Browserul nu suportă recunoașterea vocală. Folosește Chrome sau scrie mesajul."));
    if (!window.isSecureContext) return Promise.reject(new SpeechError("insecure", "Microfonul merge doar pe HTTPS sau localhost."));
    this.stop();

    return new Promise((resolve, reject) => {
      const rec = new this.Ctor!();
      this.current = rec;
      rec.lang = this.lang;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let finalText = "";
      let failed = false;

      rec.onresult = (e) => {
        let text = "";
        for (let i = 0; i < e.results.length; i++) {
          text += e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText = text;
        }
        onPartial?.(text);
      };
      rec.onerror = (e) => {
        failed = true;
        if (e.error === "aborted") return resolve("");
        reject(new SpeechError(e.error, STT_MESSAGES[e.error] ?? `Eroare la microfon (${e.error}).`));
      };
      rec.onend = () => {
        this.current = null;
        if (!failed) resolve(finalText.trim());
      };
      rec.start();
    });
  }

  stop() {
    this.current?.stop();
    this.current = null;
  }
}

/** O voce pe care o poate alege utilizatorul. */
export interface VoiceOption {
  name: string;
  lang: string;
  romanian: boolean;
}

const VOICE_KEY = "pago.voice";

export class BrowserTextToSpeech implements VoiceOutput {
  /** Vocea aleasă de utilizator (numele ei); dacă lipsește, alegem automat. */
  private preferred: string | null = null;

  constructor(private lang = "ro-RO") {
    try {
      this.preferred = localStorage.getItem(VOICE_KEY);
    } catch {
      /* fără localStorage */
    }
  }

  get supported() {
    return "speechSynthesis" in window;
  }

  private isRomanian(v: SpeechSynthesisVoice) {
    return v.lang.toLowerCase().replace("_", "-").startsWith("ro");
  }

  /** Vocile disponibile: cele românești primele, cele mai naturale primele. */
  voices(): VoiceOption[] {
    if (!this.supported) return [];
    return speechSynthesis
      .getVoices()
      .map((v) => ({ v, score: (this.isRomanian(v) ? 100 : 0) + (/natural|online|neural|google/i.test(v.name) ? 10 : 0) }))
      .sort((a, b) => b.score - a.score || a.v.name.localeCompare(b.v.name))
      .map(({ v }) => ({ name: v.name, lang: v.lang, romanian: this.isRomanian(v) }));
  }

  /** Există măcar o voce românească în acest browser? */
  hasRomanian(): boolean {
    return this.supported && speechSynthesis.getVoices().some((v) => this.isRomanian(v));
  }

  /** Numele vocii care va fi folosită acum. */
  currentVoiceName(): string | null {
    return this.voice()?.name ?? null;
  }

  setPreferred(name: string | null) {
    this.preferred = name;
    try {
      if (name) localStorage.setItem(VOICE_KEY, name);
      else localStorage.removeItem(VOICE_KEY);
    } catch {
      /* fără localStorage */
    }
  }

  /** Vocile se încarcă asincron în unele browsere; anunțăm când apar. */
  onVoicesChanged(cb: () => void) {
    if (!this.supported) return () => {};
    speechSynthesis.addEventListener("voiceschanged", cb);
    return () => speechSynthesis.removeEventListener("voiceschanged", cb);
  }

  private voice(): SpeechSynthesisVoice | undefined {
    const all = speechSynthesis.getVoices();
    const chosen = this.preferred ? all.find((v) => v.name === this.preferred) : undefined;
    if (chosen) return chosen;
    // Automat: cea mai naturală voce românească (ex. „Microsoft Alina Online (Natural)” în Edge, „Google română” pe Android).
    const ro = all.filter((v) => this.isRomanian(v));
    return ro.find((v) => /natural|online|neural/i.test(v.name)) ?? ro.find((v) => /google/i.test(v.name)) ?? ro[0];
  }

  speak(text: string, onProgress?: (chars: number) => void): Promise<void> {
    if (!this.supported || !text) {
      onProgress?.(text.length);
      return Promise.resolve();
    }
    speechSynthesis.cancel();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.lang;
      const v = this.voice();
      if (v) u.voice = v;
      u.rate = 1;

      let done = false;
      let gotBoundary = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let startedAt = 0;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(startGuard);
        onProgress?.(text.length);
        resolve();
      };

      // Plan B: unele voci (ex. cele din cloud pe Android) nu trimit poziția cuvintelor.
      // Atunci arătăm textul în ritmul estimat al vorbirii (~14 caractere pe secundă).
      const tick = () => {
        if (done || gotBoundary) return;
        const chars = Math.floor(((performance.now() - startedAt) / 1000) * 14);
        onProgress?.(Math.min(chars, text.length - 1));
        timer = setTimeout(tick, 80);
      };

      u.onstart = () => {
        startedAt = performance.now();
        clearTimeout(startGuard);
        tick();
      };
      // Poziția exactă a cuvântului rostit: arătăm textul până la sfârșitul lui.
      u.onboundary = (e) => {
        gotBoundary = true;
        clearTimeout(timer);
        const end = text.indexOf(" ", e.charIndex + 1);
        onProgress?.(end === -1 ? text.length : end);
      };
      u.onend = finish;
      u.onerror = finish; // întreruperea nu e o eroare

      // Dacă vocea nu pornește deloc (ex. browserul o blochează), arătăm tot textul.
      const startGuard = setTimeout(() => {
        if (!startedAt) {
          speechSynthesis.cancel();
          finish();
        }
      }, 2500);

      speechSynthesis.speak(u);
    });
  }

  stop() {
    if (this.supported) speechSynthesis.cancel();
  }
}

/** Ce folosește interfața pentru voce (în browser: cu alegerea vocii; pe telefon: vocea sistemului). */
export interface VoiceOutput extends TextToSpeech {
  voices(): VoiceOption[];
  currentVoiceName(): string | null;
  setPreferred(name: string | null): void;
  onVoicesChanged(cb: () => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Android (Capacitor): recunoașterea vocală și vocea native ale telefonului.
// ---------------------------------------------------------------------------------------------

export class NativeSpeechToText implements SpeechToText {
  readonly supported = true;
  private active = false;

  constructor(private lang = "ro-RO") {}

  async listen(onPartial?: (text: string) => void): Promise<string> {
    let perm = await SpeechRecognition.checkPermissions();
    if (perm.speechRecognition !== "granted") perm = await SpeechRecognition.requestPermissions();
    if (perm.speechRecognition !== "granted") {
      throw new SpeechError("not-allowed", "Microfonul e blocat. Permite accesul la microfon din setările telefonului (Aplicații → Pago AI → Permisiuni).");
    }
    const { available } = await SpeechRecognition.available();
    if (!available) throw new SpeechError("unsupported", "Telefonul nu are recunoaștere vocală. Instalează sau activează aplicația Google.");

    await this.stop();
    await SpeechRecognition.removeAllListeners();
    this.active = true;

    return new Promise<string>((resolve, reject) => {
      let last = "";
      let done = false;
      let heardStart = false; // Android a confirmat că ascultă (sau a sosit deja text)
      let restarting = false;
      let restarts = 0;
      const finish = (text: string) => {
        if (done) return;
        done = true;
        this.active = false;
        this.endCurrent = null;
        clearTimeout(guard);
        clearTimeout(watchdog);
        SpeechRecognition.removeAllListeners();
        // Eliberăm MEREU microfonul la final (altfel, dacă telefonul nu s-a oprit singur, rămânea pornit).
        SpeechRecognition.stop().catch(() => {});
        resolve(text.trim());
      };
      // stop() din afară (buton, închiderea panoului, aplicația în fundal) încheie imediat ascultarea.
      this.endCurrent = () => finish(last);
      // Plasă de siguranță: nicio ascultare nu durează mai mult de 15 secunde.
      const guard = setTimeout(() => finish(last), MAX_LISTEN_MS);

      SpeechRecognition.addListener("partialResults", (d) => {
        heardStart = true;
        if (d.matches?.[0]) {
          last = d.matches[0];
          onPartial?.(last);
        }
      });
      SpeechRecognition.addListener("listeningState", (s) => {
        if (s.status === "started") heardStart = true;
        // Rezultatul final mai poate sosi imediat după „stopped” (dar nu când îl repornim noi).
        if (s.status === "stopped" && !restarting) setTimeout(() => finish(last), 400);
      });

      const start = () =>
        SpeechRecognition.start({ language: this.lang, partialResults: true, popup: false, maxResults: 1 });

      // Paznic: uneori (ex. imediat după ce a vorbit asistentul) serviciul Google „pornește” fără să deschidă
      // microfonul și nu anunță nimic. Dacă nu confirmă la timp că ascultă, îl repornim (o singură dată).
      let watchdog: ReturnType<typeof setTimeout>;
      const arm = () => {
        watchdog = setTimeout(async () => {
          if (done || heardStart || restarts >= 1) return;
          restarts++;
          restarting = true;
          await Promise.race([SpeechRecognition.stop().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
          await new Promise((r) => setTimeout(r, 250));
          restarting = false;
          if (done) return;
          arm();
          start().then((r) => { if (r?.matches?.[0]) finish(r.matches[0]); }).catch(() => {});
        }, START_TIMEOUT_MS);
      };
      arm();

      start()
        .then((r) => {
          if (r?.matches?.[0]) finish(r.matches[0]);
        })
        .catch((e: unknown) => {
          const msg = String((e as Error)?.message ?? e);
          // „Nu s-a auzit nimic” / „nu s-a potrivit nimic” nu sunt erori: întoarcem text gol.
          if (/no match|no speech|didn't understand|not understood|^7$|^6$/i.test(msg)) return finish(last);
          if (done) return;
          done = true;
          this.active = false;
          this.endCurrent = null;
          clearTimeout(guard);
          SpeechRecognition.removeAllListeners();
          SpeechRecognition.stop().catch(() => {});
          reject(new SpeechError("native", `Nu am putut folosi microfonul (${msg}).`));
        });
    });
  }

  /** Încheiat de `stop()`: rezolvă ascultarea în curs și eliberează microfonul. */
  private endCurrent: (() => void) | null = null;

  /**
   * Oprește microfonul și eliberează resursa hardware. Sigur de apelat oricând, chiar și de mai multe ori.
   * NU așteaptă răspunsul pluginului: pe Android, `SpeechRecognition.stop()` fără o ascultare pornită nu răspunde
   * niciodată, iar o așteptare aici bloca următoarea pornire a microfonului.
   */
  async stop() {
    const end = this.endCurrent;
    const wasActive = this.active;
    this.endCurrent = null;
    this.active = false;
    if (end) end(); // finish() apelează deja SpeechRecognition.stop()
    else if (wasActive) SpeechRecognition.stop().catch(() => {});
  }
}

/** Cât poate asculta microfonul o dată, maxim (apoi se oprește singur). */
const MAX_LISTEN_MS = 15_000;
/** În cât timp trebuie Android să confirme că ascultă; altfel repornim recunoașterea o dată. */
const START_TIMEOUT_MS = 2500;

export class NativeTextToSpeech implements VoiceOutput {
  readonly supported = true;

  constructor(private lang = "ro-RO") {}

  voices(): VoiceOption[] {
    return []; // pe telefon se folosește vocea românească din setările Android (Google TTS)
  }
  currentVoiceName() {
    return "Vocea telefonului (română)";
  }
  setPreferred() {}
  onVoicesChanged() {
    return () => {};
  }

  async speak(text: string, onProgress?: (chars: number) => void): Promise<void> {
    if (!text) return;
    let gotRange = false;
    const startedAt = performance.now();
    // Textul apare odată cu vorbirea: poziția exactă (onRangeStart) sau, dacă lipsește, ritmul estimat.
    const timer = setInterval(() => {
      if (!gotRange) onProgress?.(Math.min(Math.floor(((performance.now() - startedAt) / 1000) * 14), text.length - 1));
    }, 80);
    const handle = await NativeTts.addListener("onRangeStart", (info) => {
      gotRange = true;
      onProgress?.(info.end);
    });
    try {
      await NativeTts.speak({ text, lang: this.lang, rate: 1.0, pitch: 1.0, volume: 1.0, category: "playback" });
    } catch {
      /* oprit de utilizator sau fără voce: arătăm tot textul */
    } finally {
      clearInterval(timer);
      handle.remove();
      onProgress?.(text.length);
    }
  }

  stop() {
    NativeTts.stop().catch(() => {});
  }
}

/** Vocea potrivită pentru locul în care rulează aplicația. */
export function createSpeech(): { stt: SpeechToText; tts: VoiceOutput } {
  return isNative
    ? { stt: new NativeSpeechToText(), tts: new NativeTextToSpeech() }
    : { stt: new BrowserSpeechToText(), tts: new BrowserTextToSpeech() };
}
