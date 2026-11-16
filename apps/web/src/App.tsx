import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatLei, type Bill, type PendingPaymentForClient } from "@pago/shared";
import { Bills } from "./Bills.tsx";
import { BrowserSpeechToText, BrowserTextToSpeech } from "./speech.ts";
import "./app.css";

type Msg = { from: "user" | "bot"; text: string };
type VoiceState = "idle" | "listening" | "thinking" | "speaking";

// O sesiune nouă la fiecare încărcare a paginii.
const sessionId = crypto.randomUUID();

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

export function App() {
  const [messages, setMessages] = useState<Msg[]>([
    { from: "bot", text: "Bună! Cu ce te pot ajuta? Scrie sau apasă pe microfon și vorbește. De exemplu: „Plătește factura la curent” sau „Cât am de plată?”" },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingPaymentForClient | null>(null);
  const [bills, setBills] = useState<Bill[]>([]);
  const [mode, setMode] = useState("…");
  const [voiceOn, setVoiceOn] = useState(false); // citește răspunsurile cu voce
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const stt = useMemo(() => new BrowserSpeechToText(), []);
  const tts = useMemo(() => new BrowserTextToSpeech(), []);

  const loadBills = useCallback(async () => {
    try {
      setBills(await fetch("/api/bills").then((r) => r.json()));
    } catch {
      /* serverul nu răspunde; lista rămâne cum era */
    }
  }, []);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((h) => setMode(h.llmMode)).catch(() => setMode("offline"));
    loadBills();
  }, [loadBills]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending, busy]);

  const add = (m: Msg) => setMessages((prev) => [...prev, m]);

  async function sayAloud(text: string, force = false) {
    if (!(voiceOn || force) || !tts.supported) return;
    setVoiceState("speaking");
    await tts.speak(text);
    setVoiceState("idle");
  }

  async function send(text: string, viaVoice = false) {
    const t = text.trim();
    if (!t || busy) return;
    tts.stop();
    add({ from: "user", text: t });
    setInput("");
    setBusy(true);
    setVoiceState("thinking");
    try {
      const r = await post<{ reply: string; pending: PendingPaymentForClient | null }>("/api/chat", { sessionId, message: t });
      add({ from: "bot", text: r.reply });
      setPending(r.pending);
      setBusy(false);
      loadBills();
      await sayAloud(r.reply, viaVoice);
    } catch {
      add({ from: "bot", text: "Nu pot ajunge la server acum. Mai încearcă puțin mai târziu." });
      setBusy(false);
    } finally {
      setVoiceState("idle");
    }
  }

  async function listen() {
    setVoiceError(null);
    if (voiceState === "listening") {
      stt.stop();
      return;
    }
    tts.stop();
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

  async function confirm() {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const r = await post<{ payment: { total: number } }>("/api/payments/confirm", { sessionId, token: pending.token });
      const text = `Gata, am plătit ${formatLei(r.payment.total)}.`;
      add({ from: "bot", text });
      sayAloud(text);
    } catch (e) {
      add({ from: "bot", text: (e as Error).message });
    } finally {
      setPending(null);
      setBusy(false);
      loadBills();
    }
  }

  async function cancel() {
    if (!pending || busy) return;
    await post("/api/payments/cancel", { sessionId, token: pending.token }).catch(() => {});
    setPending(null);
    const text = "Bine, nu am plătit nimic.";
    add({ from: "bot", text });
    sayAloud(text);
  }

  async function reset() {
    tts.stop();
    await post("/api/dev/reset", { variant: "demo" }).catch(() => {});
    setPending(null);
    setMessages([{ from: "bot", text: "Am pornit povestea de la început. Cu ce te pot ajuta?" }]);
    loadBills();
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
        <button
          className="icon-btn"
          onClick={() => { if (voiceOn) tts.stop(); setVoiceOn(!voiceOn); }}
          aria-pressed={voiceOn}
          aria-label={voiceOn ? "Oprește citirea cu voce" : "Pornește citirea cu voce"}
          title={voiceOn ? "Răspunsurile sunt citite cu voce" : "Răspunsurile nu sunt citite"}
        >
          {voiceOn ? "🔊" : "🔇"}
        </button>
        <button className="icon-btn" onClick={reset} aria-label="Repornește demo-ul" title="Repornește demo-ul">↺</button>
      </header>

      <div className="layout">
        <Bills
          bills={bills}
          onChanged={loadBills}
          onPayWithAssistant={(b) => send(`Plătește factura la ${SPOKEN_CATEGORY[b.category]}.`)}
        />

        <section className="assistant" aria-label="Asistent">
          <div className="chat" aria-live="polite">
            {messages.map((m, i) => (
              <div key={i} className={`bubble ${m.from}`}>{m.text}</div>
            ))}
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
              {stt.supported ? micLabel : "Vocea nu e disponibilă în acest browser — scrie mesajul."}
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
