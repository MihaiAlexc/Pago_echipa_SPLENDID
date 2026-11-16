import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatLei, type Bill, type PendingPaymentForClient } from "@pago/shared";
import { Bills } from "./Bills.tsx";
import { Car, type CarData } from "./Car.tsx";
import { BrowserSpeechToText, BrowserTextToSpeech, type VoiceOption } from "./speech.ts";
import "./app.css";

/** `shown` = câte caractere se văd (textul apare treptat cât timp asistentul vorbește). */
type Msg = { id: number; from: "user" | "bot"; text: string; shown?: number };
type VoiceState = "idle" | "listening" | "thinking" | "speaking";

// O sesiune nouă la fiecare încărcare a paginii.
const sessionId = crypto.randomUUID();
let nextId = 1;

const SPOKEN_CATEGORY: Record<Bill["category"], string> = {
  electricity: "curent", gas: "gaz", water: "apă", internet: "internet", phone: "telefon",
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.message ?? "Eroare"), { data });
  return data as T;
}

const WELCOME = "Bună! Cu ce te pot ajuta? Scrie sau apasă pe microfon și vorbește. De exemplu: „Plătește factura la curent” sau „Plec în Turcia”.";

export function App() {
  const [messages, setMessages] = useState<Msg[]>([{ id: nextId++, from: "bot", text: WELCOME }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingPaymentForClient | null>(null);
  const [bills, setBills] = useState<Bill[]>([]);
  const [car, setCar] = useState<CarData | null>(null);
  const [mode, setMode] = useState("…");
  const [voiceOn, setVoiceOn] = useState(false); // vocea asistentului (citește răspunsurile)
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [tab, setTab] = useState<"bills" | "car">("bills");
  const endRef = useRef<HTMLDivElement>(null);
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;

  const stt = useMemo(() => new BrowserSpeechToText(), []);
  const tts = useMemo(() => new BrowserTextToSpeech(), []);
  const [voiceList, setVoiceList] = useState<VoiceOption[]>([]);
  const [voiceName, setVoiceName] = useState<string | null>(null);

  // Vocile apar asincron; le reîncărcăm când se schimbă lista.
  useEffect(() => {
    const refresh = () => {
      setVoiceList(tts.voices());
      setVoiceName(tts.currentVoiceName());
    };
    refresh();
    return tts.onVoicesChanged(refresh);
  }, [tts]);

  const hasRomanianVoice = voiceList.some((v) => v.romanian);

  function chooseVoice(name: string) {
    tts.setPreferred(name || null);
    setVoiceName(tts.currentVoiceName());
    if (voiceOn) botSays("Așa sună vocea asta.", true);
  }

  const loadData = useCallback(async () => {
    try {
      const [b, c] = await Promise.all([fetch("/api/bills").then((r) => r.json()), fetch("/api/car").then((r) => r.json())]);
      setBills(b);
      setCar(c);
    } catch {
      /* serverul nu răspunde; datele rămân cum erau */
    }
  }, []);

  /** D4: dacă ceva expiră, asistentul începe el conversația (o dată pe sesiune). */
  const loadProactive = useCallback(async () => {
    try {
      const r = await fetch(`/api/proactive?sessionId=${sessionId}`).then((x) => x.json());
      if (r.message) setMessages([{ id: nextId++, from: "bot", text: r.message }]);
    } catch {
      /* fără mesaj proactiv */
    }
  }, []);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((h) => setMode(h.llmMode)).catch(() => setMode("offline"));
    loadData();
    loadProactive();
  }, [loadData, loadProactive]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending, busy]);

  const setShown = (id: number, shown: number | undefined) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, shown } : m)));

  /** Citește un mesaj cu voce; textul lui apare pe măsură ce e rostit. */
  async function speakMessage(id: number, text: string) {
    if (!tts.supported) return;
    setSpeakingId(id);
    setVoiceState("speaking");
    setShown(id, 0);
    await tts.speak(text, (chars) => setShown(id, chars));
    setShown(id, undefined);
    setSpeakingId((cur) => (cur === id ? null : cur));
    setVoiceState("idle");
  }

  /** Adaugă un răspuns al asistentului; cu vocea pornită îl și citește. */
  async function botSays(text: string, forceVoice = false) {
    const id = nextId++;
    const speak = (voiceOnRef.current || forceVoice) && tts.supported;
    setMessages((prev) => [...prev, { id, from: "bot", text, shown: speak ? 0 : undefined }]);
    if (speak) await speakMessage(id, text);
  }

  function stopSpeaking() {
    tts.stop();
    setSpeakingId(null);
    setMessages((prev) => prev.map((m) => (m.shown !== undefined ? { ...m, shown: undefined } : m)));
  }

  async function send(text: string, viaVoice = false) {
    const t = text.trim();
    if (!t || busy) return;
    stopSpeaking();
    setMessages((prev) => [...prev, { id: nextId++, from: "user", text: t }]);
    setInput("");
    setBusy(true);
    setVoiceState("thinking");
    try {
      const r = await post<{ reply: string; pending: PendingPaymentForClient | null }>("/api/chat", { sessionId, message: t });
      setPending(r.pending);
      setBusy(false);
      setVoiceState("idle");
      loadData();
      await botSays(r.reply, viaVoice);
    } catch {
      setBusy(false);
      setVoiceState("idle");
      await botSays("Nu pot ajunge la server acum. Mai încearcă puțin mai târziu.");
    }
  }

  async function listen() {
    setVoiceError(null);
    if (voiceState === "listening") {
      stt.stop();
      return;
    }
    stopSpeaking();
    setVoiceOn(true); // dacă vorbești, îți și răspundem cu voce
    setVoiceState("listening");
    try {
      const heard = await stt.listen((partial) => setInput(partial));
      setVoiceState("idle");
      if (heard) await send(heard, true);
      else setInput("");
    } catch (e) {
      setVoiceState("idle");
      setVoiceError((e as Error).message);
    }
  }

  function toggleVoice() {
    if (voiceOn) {
      stopSpeaking();
      setVoiceOn(false);
    } else {
      setVoiceOn(true);
      voiceOnRef.current = true;
      botSays("Vocea asistentului e pornită. Îți citesc răspunsurile cu voce tare.", true);
    }
  }

  async function confirm() {
    if (!pending || busy) return;
    setBusy(true);
    let text: string;
    try {
      const r = await post<{ payment: { total: number } }>("/api/payments/confirm", { sessionId, token: pending.token });
      text = `Gata, am plătit ${formatLei(r.payment.total)}.`;
    } catch (e) {
      text = (e as Error).message;
    }
    setPending(null);
    setBusy(false);
    loadData();
    await botSays(text);
  }

  async function cancel() {
    if (!pending || busy) return;
    await post("/api/payments/cancel", { sessionId, token: pending.token }).catch(() => {});
    setPending(null);
    await botSays("Bine, nu am plătit nimic.");
  }

  async function reset() {
    stopSpeaking();
    await post("/api/dev/reset", { variant: "demo" }).catch(() => {});
    setPending(null);
    setMessages([{ id: nextId++, from: "bot", text: "Am pornit povestea de la început. Cu ce te pot ajuta?" }]);
    loadData();
    loadProactive();
  }

  const micLabel =
    voiceState === "listening" ? "Ascult… (apasă ca să oprești)"
    : voiceState === "thinking" ? "Mă gândesc…"
    : voiceState === "speaking" ? "Vorbesc… (apasă ca să vorbești tu)"
    : "Apasă și vorbește";

  return (
    <div className="page">
      <header className="top">
        <span className="brand">pago</span>
        <span className="sub">Asistent · model: {mode}</span>
        <button className="icon-btn" onClick={reset} aria-label="Repornește demo-ul" title="Repornește demo-ul">↺</button>
      </header>

      <div className="layout">
        <div className="side">
          <div className="tabs" role="tablist" aria-label="Datele mele">
            <button role="tab" aria-selected={tab === "bills"} className={tab === "bills" ? "on" : ""} onClick={() => setTab("bills")}>Facturi</button>
            <button role="tab" aria-selected={tab === "car"} className={tab === "car" ? "on" : ""} onClick={() => setTab("car")}>Mașina mea</button>
          </div>
          {tab === "bills" ? (
            <Bills
              bills={bills}
              onChanged={loadData}
              onPayWithAssistant={(b) => send(`Plătește factura la ${SPOKEN_CATEGORY[b.category]}.`)}
            />
          ) : (
            <Car data={car} onChanged={loadData} />
          )}
        </div>

        <section className="assistant" aria-label="Asistent">
          <div className="voice-bar">
            <button
              className={`voice-toggle ${voiceOn ? "on" : ""}`}
              onClick={toggleVoice}
              aria-pressed={voiceOn}
              disabled={!tts.supported}
            >
              <span aria-hidden="true">{voiceOn ? "🔊" : "🔇"}</span>
              {tts.supported ? (voiceOn ? "Vocea asistentului: pornită" : "Pornește vocea asistentului") : "Vocea nu e disponibilă"}
            </button>
            {speakingId !== null && (
              <button className="small-btn" onClick={stopSpeaking}>Oprește</button>
            )}
          </div>
          {tts.supported && (
            <div className="voice-pick">
              <label>
                Vocea
                <select value={voiceName ?? ""} onChange={(e) => chooseVoice(e.target.value)} aria-label="Alege vocea asistentului">
                  {!voiceName && <option value="">Implicită a browserului</option>}
                  {voiceList.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.romanian ? "🇷🇴 " : ""}{v.name} ({v.lang})
                    </option>
                  ))}
                </select>
              </label>
              {!hasRomanianVoice && voiceList.length > 0 && (
                <p className="warn">
                  Acest browser nu are o voce în română, așa că textul e citit cu accent străin.
                  Deschide pagina în <b>Microsoft Edge</b> (are voci românești naturale) sau pe telefon, în Chrome pe Android.
                </p>
              )}
            </div>
          )}

          <div className="chat" aria-live="polite">
            {messages.map((m) => {
              const partial = m.shown !== undefined && m.shown < m.text.length;
              return (
                <div key={m.id} className={`bubble ${m.from} ${m.id === speakingId ? "speaking" : ""}`}>
                  {/* Cititoarele de ecran primesc textul complet; vizual apare treptat. */}
                  <span aria-hidden={partial ? "true" : undefined}>
                    {partial ? m.text.slice(0, m.shown) : m.text}
                    {partial && <span className="caret" />}
                  </span>
                  {partial && <span className="sr-only">{m.text}</span>}
                  {m.from === "bot" && tts.supported && m.id !== speakingId && (
                    <button className="replay" onClick={() => speakMessage(m.id, m.text)} aria-label="Ascultă mesajul" title="Ascultă mesajul">🔊</button>
                  )}
                </div>
              );
            })}
            {busy && <div className="bubble bot thinking">Se gândește…</div>}

            {pending && (
              <div className="confirm" role="group" aria-label="Confirmare plată">
                <h2>Confirmi plata?</h2>
                <ul>
                  {pending.lines.map((l) => (
                    <li key={l.refId}><span>{l.label}</span><b>{formatLei(l.amount)}</b></li>
                  ))}
                </ul>
                <p className="total">Total: <b>{formatLei(pending.total)}</b></p>
                <p className="note">
                  {pending.requiresScreenConfirm
                    ? "Peste 500 de lei: confirmă cu butonul."
                    : "Poți spune „da” sau apăsa butonul."}
                </p>
                <div className="actions">
                  <button className="yes" onClick={confirm} disabled={busy}>Confirmă</button>
                  <button className="no" onClick={cancel} disabled={busy}>Anulează</button>
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="voice">
            <button
              className={`mic ${voiceState}`}
              onClick={listen}
              disabled={busy || !stt.supported}
              aria-label={micLabel}
            >
              <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            </button>
            <span className="mic-label">
              {stt.supported ? micLabel : "Microfonul nu e disponibil în acest browser — scrie mesajul."}
            </span>
          </div>
          {voiceError && <p className="error center">{voiceError}</p>}

          <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Scrie un mesaj…"
              aria-label="Mesaj"
              disabled={busy || voiceState === "listening"}
            />
            <button type="submit" disabled={busy || !input.trim()}>Trimite</button>
          </form>
        </section>
      </div>
    </div>
  );
}
