import { useEffect, useRef, useState } from "react";
import { formatLei, type PendingPaymentForClient } from "@pago/shared";
import "./app.css";

type Msg = { from: "user" | "bot"; text: string };

// O sesiune nouă la fiecare încărcare a paginii.
const sessionId = crypto.randomUUID();

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
    { from: "bot", text: "Bună! Cu ce te pot ajuta? De exemplu: „Plătește factura la curent” sau „Cât am de plată?”" },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingPaymentForClient | null>(null);
  const [mode, setMode] = useState("…");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((h) => setMode(h.llmMode)).catch(() => setMode("offline"));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending, busy]);

  const add = (m: Msg) => setMessages((prev) => [...prev, m]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    add({ from: "user", text: t });
    setInput("");
    setBusy(true);
    try {
      const r = await post<{ reply: string; pending: PendingPaymentForClient | null }>("/api/chat", { sessionId, message: t });
      add({ from: "bot", text: r.reply });
      setPending(r.pending);
    } catch {
      add({ from: "bot", text: "Nu pot ajunge la server acum. Mai încearcă puțin mai târziu." });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const r = await post<{ payment: { total: number } }>("/api/payments/confirm", { sessionId, token: pending.token });
      add({ from: "bot", text: `Gata, am plătit ${formatLei(r.payment.total)}.` });
    } catch (e) {
      add({ from: "bot", text: (e as Error).message });
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  async function cancel() {
    if (!pending || busy) return;
    await post("/api/payments/cancel", { sessionId, token: pending.token }).catch(() => {});
    setPending(null);
    add({ from: "bot", text: "Bine, nu am plătit nimic." });
  }

  async function reset() {
    await post("/api/dev/reset", { variant: "demo" }).catch(() => {});
    setPending(null);
    setMessages([{ from: "bot", text: "Am pornit povestea de la început. Cu ce te pot ajuta?" }]);
  }

  return (
    <div className="app">
      <header className="top">
        <span className="brand">pago</span>
        <span className="sub">Asistent · model: {mode}</span>
        <button className="link" onClick={reset} aria-label="Repornește demo-ul">↺</button>
      </header>

      <main className="chat" aria-live="polite">
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.from}`}>{m.text}</div>
        ))}
        {busy && <div className="bubble bot thinking">Se gândește…</div>}

        {pending && (
          <section className="confirm" aria-label="Confirmare plată">
            <h2>Confirmi plata?</h2>
            <ul>
              {pending.lines.map((l) => (
                <li key={l.refId}><span>{l.label}</span><b>{formatLei(l.amount)}</b></li>
              ))}
            </ul>
            <p className="total">Total: <b>{formatLei(pending.total)}</b></p>
            {pending.requiresScreenConfirm && <p className="note">Peste 500 de lei: confirmă cu butonul.</p>}
            <div className="actions">
              <button className="yes" onClick={confirm} disabled={busy}>Confirmă</button>
              <button className="no" onClick={cancel} disabled={busy}>Anulează</button>
            </div>
          </section>
        )}
        <div ref={endRef} />
      </main>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Scrie un mesaj…"
          aria-label="Mesaj"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>Trimite</button>
      </form>
    </div>
  );
}
