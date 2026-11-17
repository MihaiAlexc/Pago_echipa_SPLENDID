import { useEffect, useRef, useState } from "react";
import { BillsCard, CheckoutCard, ProductsCard, TripCard, TripOffersCard, type ChatCard } from "./cards.tsx";
import { IconClose, IconMic, IconSend, IconSpeaker, IconStop } from "./icons.tsx";
import type { Assistant, VoiceState } from "./useAssistant.ts";

/**
 * Sfera „Pago AI”: respiră liniștit în așteptare, pulsează și emite unde când te ascultă,
 * se rotește cât se gândește și „bate” la fiecare cuvânt rostit când vorbește.
 */
export function Orb({ state, tick, size = 132 }: { state: VoiceState; tick: number; size?: number }) {
  const [beat, setBeat] = useState(false);
  useEffect(() => {
    if (state !== "speaking") return;
    setBeat(true);
    const t = setTimeout(() => setBeat(false), 140);
    return () => clearTimeout(t);
  }, [tick, state]);
  return (
    <div className={`orb ${state} ${beat ? "beat" : ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <span className="orb-ring r1" /><span className="orb-ring r2" /><span className="orb-ring r3" />
      <span className="orb-core" />
      <span className="orb-shine" />
      <span className="orb-wave">
        {Array.from({ length: 5 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 0.11}s` }} />)}
      </span>
    </div>
  );
}

function stateLabel(a: Assistant) {
  if (a.isRecording && a.awaitingAnswer && a.pending) return "Te ascult: spune „da” sau „nu” · atinge ca să oprești";
  if (a.isRecording && a.awaitingAnswer) return "Te ascult: răspunde · atinge ca să oprești";
  if (a.isRecording) return "Te ascult… atinge ca să oprești";
  if (a.voiceState === "thinking" || a.busy) return "Mă gândesc…";
  if (a.voiceState === "speaking") return "Vorbesc… atinge ca să vorbești tu";
  return a.sttSupported ? "Atinge și vorbește" : "Scrie mesajul mai jos";
}

export function AssistantSheet({ a, open, onClose }: { a: Assistant; open: boolean; onClose: () => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  const [typing, setTyping] = useState(!a.sttSupported);
  const { hardStop } = a;

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [a.messages, a.pending, a.busy, open]);

  // Panoul se închide pe ORICE cale (X, fundal, butonul Înapoi, tras în jos) → microfonul și vocea se opresc.
  useEffect(() => {
    if (!open) hardStop();
  }, [open, hardStop]);

  // Componenta dispare → eliberăm microfonul.
  useEffect(() => () => hardStop(), [hardStop]);

  const close = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Tras în jos de mâner / antet → panoul urmărește degetul; peste ~120px se închide.
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ startY: number; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { startY: e.clientY, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) setDragY(Math.max(0, e.clientY - drag.current.startY));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (dragY > 120) close();
    setDragY(0);
  };

  // Cardul cu pachete de călătorie apare o singură dată pe țară (asistentul poate verifica lista de mai multe ori).
  const firstOffers = new Map<string, number>();
  for (const m of a.messages) for (const c of m.cards ?? []) if (c.type === "trip_offers" && !firstOffers.has(c.country)) firstOffers.set(c.country, m.id);

  function renderCard(card: ChatCard, i: number, msgId: number) {
    if (card.type === "trip_offers") return firstOffers.get(card.country) === msgId ? <TripOffersCard key={i} card={card} /> : null;
    if (card.type === "bills") return <BillsCard key={i} bills={card.bills} onPay={(b) => a.send(`Plătește factura la ${b.categoryRo}.`)} />;
    if (card.type === "trip") return <TripCard key={i} checklist={card.checklist} onStart={() => a.send("Da, începem.")} />;
    return <ProductsCard key={i} products={card.products} onPick={(p) => a.send(`Vreau ${p.name}.`)} />;
  }

  return (
    <div className={`sheet-wrap ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="sheet-backdrop" onClick={close} />
      <section
        className={`sheet ${dragY ? "dragging" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Pago AI"
        inert={!open}
        style={dragY ? { transform: `translate(-50%, ${dragY}px)` } : undefined}
      >
        <div className="sheet-drag" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <div className="sheet-grip" aria-hidden="true" />
        <header className="sheet-head">
          <div className="sheet-title">
            <span className="ai-dot" aria-hidden="true" />
            Pago AI
          </div>
          <button
            className={`chip ${a.voiceOn ? "on" : ""}`}
            onClick={() => (a.voiceOn ? (a.stopSpeaking(), a.setVoiceOn(false)) : a.setVoiceOn(true))}
            aria-pressed={a.voiceOn}
            disabled={!a.ttsSupported}
          >
            <IconSpeaker size={16} /> {a.voiceOn ? "Voce pornită" : "Voce oprită"}
          </button>
          <button className="round-btn" onClick={close} aria-label="Închide asistentul"><IconClose /></button>
        </header>
        </div>

        <div className="sheet-chat" aria-live="polite">
          {a.messages.map((m) => {
            const partial = m.shown !== undefined && m.shown < m.text.length;
            return (
              <div key={m.id} className={`turn ${m.from}`}>
                <div className={`bubble ${m.from} ${m.id === a.speakingId ? "speaking" : ""}`}>
                  <span aria-hidden={partial ? "true" : undefined}>
                    {partial ? m.text.slice(0, m.shown) : m.text}
                    {partial && <span className="caret" />}
                  </span>
                  {partial && <span className="sr-only">{m.text}</span>}
                  {m.from === "bot" && a.ttsSupported && m.id !== a.speakingId && (
                    <button className="replay" onClick={() => a.speakMessage(m.id, m.text)} aria-label="Ascultă mesajul"><IconSpeaker size={16} /></button>
                  )}
                </div>
                {m.cards?.map((c, i) => renderCard(c, i, m.id))}
              </div>
            );
          })}
          {a.busy && <div className="bubble bot typing" aria-label="Se gândește"><i /><i /><i /></div>}
          {a.pending && <CheckoutCard pending={a.pending} busy={a.busy} onConfirm={a.confirm} onCancel={a.cancel} />}
          <div ref={endRef} />
        </div>

        <footer className="sheet-foot">
          {a.voiceError && <p className="error">{a.voiceError}</p>}
          {a.isRecording && a.input && <p className="live-transcript">„{a.input}”</p>}

          <div className="orb-row">
            <button
              className="kbd-btn"
              onClick={() => setTyping((t) => !t)}
              aria-pressed={typing}
              aria-label={typing ? "Ascunde tastatura" : "Scrie un mesaj"}
            >
              Aa
            </button>
            {/* Comutator: apasă = vorbește, apasă din nou = oprește microfonul. Cât vorbește asistentul: îl oprește. */}
            <button
              className={`orb-btn ${a.isRecording ? "recording" : ""}`}
              onClick={() => (a.isRecording ? a.stopRecording() : a.voiceState === "speaking" ? a.stopSpeaking() : a.listen())}
              disabled={(a.busy && !a.isRecording) || !a.sttSupported}
              aria-label={stateLabel(a)}
              aria-pressed={a.isRecording}
            >
              <Orb state={a.isRecording ? "listening" : a.busy ? "thinking" : a.voiceState} tick={a.wordTick} />
              <span className="orb-icon">{a.isRecording ? <IconStop size={30} /> : <IconMic size={34} />}</span>
            </button>
            <span className="kbd-btn ghost" aria-hidden="true" />
          </div>
          <p className="orb-label">{stateLabel(a)}</p>

          {typing && (
            <form className="composer" onSubmit={(e) => { e.preventDefault(); a.send(a.input); }}>
              <input
                value={a.input}
                onChange={(e) => a.setInput(e.target.value)}
                placeholder="Scrie un mesaj…"
                aria-label="Mesaj"
                disabled={a.busy || a.voiceState === "listening"}
              />
              <button type="submit" disabled={a.busy || !a.input.trim()} aria-label="Trimite"><IconSend /></button>
            </form>
          )}
        </footer>
      </section>
    </div>
  );
}
