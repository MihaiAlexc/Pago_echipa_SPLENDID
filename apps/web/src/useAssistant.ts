import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatLei, type PendingPaymentForClient } from "@pago/shared";
import { api } from "./api.ts";
import { verifyBiometric } from "./biometric.ts";
import type { ChatCard } from "./cards.tsx";
import { createSpeech, type VoiceOption } from "./speech.ts";

/** `shown` = câte caractere se văd (textul apare treptat cât timp asistentul vorbește). */
export type Msg = { id: number; from: "user" | "bot"; text: string; shown?: number; cards?: ChatCard[] };
export type VoiceState = "idle" | "listening" | "thinking" | "speaking";
export type Success = { total: number; lines: PendingPaymentForClient["lines"] };

type ChatResponse = {
  reply: string;
  outcome: "pass" | "confirmed" | "cancelled" | "needs_screen" | string;
  pending: PendingPaymentForClient | null;
  cards?: ChatCard[];
};

/** Cât așteptăm după ce tace vocea asistentului, înainte să repornim microfonul (Android eliberează sunetul). */
const RESUME_AFTER_TTS_MS = 450;

// O sesiune nouă la fiecare pornire a aplicației.
const sessionId = crypto.randomUUID();
let nextId = 1;

const WELCOME = "Bună! Sunt Pago AI. Spune-mi ce vrei să plătești sau unde pleci. De exemplu: „Plătește factura la curent” sau „Plec în Turcia”.";

/**
 * Toată conversația cu asistentul: mesaje, voce (ascultă / vorbește), plata în așteptare, confirmare.
 * Siguranța plăților rămâne pe server: aici doar trimitem „da”-ul sau apăsarea butonului.
 */
export function useAssistant(onDataChanged: () => void) {
  const [messages, setMessages] = useState<Msg[]>([{ id: nextId++, from: "bot", text: WELCOME }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingPaymentForClient | null>(null);
  const [voiceOn, setVoiceOn] = useState(true); // pe telefon: asistentul răspunde cu voce
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [awaitingAnswer, setAwaitingAnswer] = useState(false);
  const [success, setSuccess] = useState<Success | null>(null);
  const [wordTick, setWordTick] = useState(0); // crește la fiecare cuvânt rostit → animația „bate” odată cu vocea
  const [proactive, setProactive] = useState<string | null>(null);

  const [isRecording, setIsRecording] = useState(false); // microfonul ascultă acum
  const listeningRef = useRef(false);
  const listenRunRef = useRef(0); // numărul ascultării curente (una oprită nu mai poate trimite nimic)
  const handsFreeRef = useRef(true); // după o întrebare a asistentului, microfonul repornește singur pentru UN răspuns
  const quietRef = useRef(false); // după închiderea panoului: nu mai citim răspunsuri cu voce până la următoarea acțiune
  const confirmingRef = useRef(false);
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const { stt, tts } = useMemo(() => createSpeech(), []);
  const [voiceList, setVoiceList] = useState<VoiceOption[]>([]);
  const [voiceName, setVoiceName] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => {
      setVoiceList(tts.voices());
      setVoiceName(tts.currentVoiceName());
    };
    refresh();
    return tts.onVoicesChanged(refresh);
  }, [tts]);

  /** D4: dacă ceva expiră, asistentul începe el conversația (o dată pe sesiune). */
  const loadProactive = useCallback(async () => {
    try {
      const r = await api.get<{ message: string | null }>(`/api/proactive?sessionId=${sessionId}`);
      if (r.message) {
        setProactive(r.message);
        setMessages([{ id: nextId++, from: "bot", text: r.message }]);
      }
    } catch {
      /* fără mesaj proactiv */
    }
  }, []);

  useEffect(() => {
    loadProactive();
  }, [loadProactive]);

  const setShown = (id: number, shown: number | undefined) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, shown } : m)));

  async function speakMessage(id: number, text: string) {
    if (!tts.supported) return;
    pauseListening(); // cât vorbește asistentul, microfonul NU ascultă (altfel s-ar auzi pe el însuși)
    setSpeakingId(id);
    setVoiceState("speaking");
    setShown(id, 0);
    let lastWord = 0;
    await tts.speak(text, (chars) => {
      setShown(id, chars);
      if (chars - lastWord >= 4) {
        lastWord = chars;
        setWordTick((t) => t + 1);
      }
    });
    setShown(id, undefined);
    setSpeakingId((cur) => (cur === id ? null : cur));
    setVoiceState("idle");
  }

  async function botSays(text: string, cards?: ChatCard[], forceVoice = false) {
    const id = nextId++;
    const speak = (voiceOnRef.current || forceVoice) && tts.supported && !quietRef.current;
    setMessages((prev) => [...prev, { id, from: "bot", text, cards, shown: speak ? 0 : undefined }]);
    if (speak) await speakMessage(id, text);
  }

  function stopSpeaking() {
    tts.stop();
    setSpeakingId(null);
    setVoiceState((s) => (s === "speaking" ? "idle" : s));
    setMessages((prev) => prev.map((m) => (m.shown !== undefined ? { ...m, shown: undefined } : m)));
  }

  async function send(text: string, viaVoice = false) {
    const t = text.trim();
    if (!t || busy) return;
    stopSpeaking();
    quietRef.current = false; // utilizatorul a cerut ceva: răspunsul se poate citi din nou cu voce
    const before = pendingRef.current;
    setMessages((prev) => [...prev, { id: nextId++, from: "user", text: t }]);
    setInput("");
    setBusy(true);
    setVoiceState("thinking");
    try {
      const r = await api.post<ChatResponse>("/api/chat", { sessionId, message: t });
      setPending(r.pending);
      setBusy(false);
      setVoiceState("idle");
      onDataChanged();
      // „Da” rostit → serverul a confirmat plata: arătăm ecranul de plată reușită.
      if (r.outcome === "confirmed" && before) setSuccess({ total: before.total, lines: before.lines });
      await botSays(r.reply, r.cards?.length ? r.cards : undefined);
      // Dacă vorbim și asistentul îți pune o întrebare (sau așteaptă „da” / „nu”), pornim singuri microfonul pentru UN răspuns.
      // Conversație „mâini libere”: dacă ai vorbit, după ce asistentul TERMINĂ de vorbit, microfonul repornește singur,
      // ca să poți răspunde direct („Da, plătește”) fără să atingi ecranul. Se oprește dacă taci, dacă apeși stop
      // sau dacă închizi panoul. Pauza scurtă lasă Android-ul să elibereze sunetul vocii înainte de microfon.
      if (viaVoice && stt.supported && handsFreeRef.current && !quietRef.current) {
        await new Promise((res) => setTimeout(res, RESUME_AFTER_TTS_MS));
        if (handsFreeRef.current && !quietRef.current && !listeningRef.current) await listen(true);
      }
    } catch {
      setBusy(false);
      setVoiceState("idle");
      await botSays("Nu pot ajunge la server acum. Verifică adresa serverului în Setări și că laptopul e în aceeași rețea.");
    }
  }

  /**
   * Butonul de microfon e un comutator: apasă = ascultă, apasă din nou = oprește.
   * `forAnswer` = pornit automat după o întrebare a asistentului (mod „mâini libere”), doar dacă utilizatorul
   * n-a oprit microfonul între timp.
   */
  async function listen(forAnswer = false) {
    setVoiceError(null);
    if (listeningRef.current) {
      if (!forAnswer) stopRecording(); // al doilea apăsat = oprește
      return;
    }
    if (forAnswer && !handsFreeRef.current) return;
    if (!forAnswer) {
      handsFreeRef.current = true; // utilizatorul a apăsat microfonul: pornim conversația vocală
      quietRef.current = false;
    }
    stopSpeaking();
    setVoiceOn(true);
    voiceOnRef.current = true;
    const run = ++listenRunRef.current; // ascultarea asta; una nouă sau stopRecording() o invalidează
    listeningRef.current = true;
    setIsRecording(true);
    setAwaitingAnswer(forAnswer);
    setVoiceState("listening");
    const stillMine = () => run === listenRunRef.current;
    const end = () => {
      if (!stillMine()) return;
      listeningRef.current = false;
      setIsRecording(false);
      setAwaitingAnswer(false);
      setVoiceState((s) => (s === "listening" ? "idle" : s));
    };
    try {
      const heard = await stt.listen((partial) => stillMine() && setInput(partial));
      if (!stillMine()) return; // oprit manual / panou închis: nu trimitem nimic
      end();
      if (heard) await send(heard, true);
      else setInput("");
    } catch (e) {
      if (!stillMine()) return;
      end();
      if (!(forAnswer && (e as { code?: string }).code === "no-speech")) setVoiceError((e as Error).message);
    }
  }

  /**
   * Oprește microfonul și eliberează resursa hardware (apelează stop() din pluginul Capacitor).
   * Ce s-a auzit până acum NU se trimite, iar modul „mâini libere” se oprește până la următoarea apăsare pe microfon.
   */
  const stopRecording = useCallback(() => {
    handsFreeRef.current = false;
    listenRunRef.current++; // ascultarea în curs nu mai are voie să trimită sau să schimbe starea
    listeningRef.current = false;
    stt.stop();
    setIsRecording(false);
    setAwaitingAnswer(false);
    setInput("");
    setVoiceState((s) => (s === "listening" ? "idle" : s));
  }, [stt]);

  /**
   * Oprire completă: microfonul și vocea. La închiderea panoului, când aplicația trece în fundal
   * sau când componenta dispare. Un răspuns care sosește după asta apare în conversație, dar nu mai e citit cu voce.
   */
  const hardStop = useCallback(() => {
    stopRecording();
    quietRef.current = true;
    tts.stop();
    setSpeakingId(null);
    setVoiceState((s) => (s === "speaking" ? "idle" : s));
    setMessages((prev) => (prev.some((m) => m.shown !== undefined) ? prev.map((m) => ({ ...m, shown: undefined })) : prev));
  }, [stopRecording, tts]);

  // Aplicația în fundal / tab ascuns → eliberăm microfonul și oprim vocea.
  useEffect(() => {
    const onVisibility = () => document.hidden && hardStop();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [hardStop]);

  // Componenta dispare (ex. aplicația se închide / se reîncarcă) → eliberăm microfonul.
  useEffect(() => () => {
    stt.stop();
    tts.stop();
  }, [stt, tts]);

  /** Pauză (nu oprire): invalidează ascultarea în curs fără să oprească modul „mâini libere”. */
  function pauseListening() {
    if (!listeningRef.current) return;
    listenRunRef.current++;
    listeningRef.current = false;
    stt.stop();
    setIsRecording(false);
    setAwaitingAnswer(false);
  }

  /** Compatibilitate: folosit de butoanele Confirmă / Anulează. */
  function stopListening() {
    if (listeningRef.current) stopRecording();
  }

  async function confirm() {
    const p = pendingRef.current;
    if (!p || busy || confirmingRef.current) return;
    confirmingRef.current = true; // un al doilea apăsat cât e deschisă amprenta nu mai pornește încă o verificare
    stopListening();
    stopSpeaking();
    setBusy(true);
    // BARIERĂ DE SECURITATE (doar în aplicația de telefon): amprentă / Face Unlock ÎNAINTE să trimitem cererea de plată.
    // Fallback: dacă telefonul nu are amprentă / față / blocare de ecran setată, sau rulăm în browser,
    // plata continuă cu confirmarea de pe ecran, ca înainte. Plata tot serverul o validează, cu token-ul.
    const bio = await verifyBiometric(`Plătești ${formatLei(p.total)}`);
    if (bio === "cancelled") {
      confirmingRef.current = false;
      setBusy(false);
      await botSays("Nu te-am putut verifica, așa că nu am plătit nimic. Apasă din nou Confirmă plata când vrei.");
      return;
    }
    try {
      const r = await api.post<{ payment: { total: number }; reply?: string; pending?: PendingPaymentForClient | null }>(
        "/api/payments/confirm", { sessionId, token: p.token });
      setPending(r.pending ?? null);
      setBusy(false);
      setSuccess({ total: r.payment.total, lines: p.lines });
      onDataChanged();
      await botSays(r.reply ?? `Gata, am plătit ${formatLei(r.payment.total)}.`);
    } catch (e) {
      setPending(null);
      setBusy(false);
      onDataChanged();
      await botSays((e as Error).message);
    } finally {
      confirmingRef.current = false;
    }
  }

  async function cancel() {
    const p = pendingRef.current;
    if (!p || busy) return;
    stopListening();
    setBusy(true);
    const r = await api.post<{ reply?: string | null }>("/api/payments/cancel", { sessionId, token: p.token }).catch(() => null);
    setPending(null);
    setBusy(false);
    await botSays(r?.reply ?? "Bine, nu am plătit nimic.");
  }

  const clearSuccess = useCallback(() => setSuccess(null), []);

  async function reset() {
    stopSpeaking();
    await api.post("/api/dev/reset", { variant: "demo" }).catch(() => {});
    setPending(null);
    setSuccess(null);
    setMessages([{ id: nextId++, from: "bot", text: "Am pornit povestea de la început. Cu ce te pot ajuta?" }]);
    onDataChanged();
    loadProactive();
  }

  function chooseVoice(name: string) {
    tts.setPreferred(name || null);
    setVoiceName(tts.currentVoiceName());
    if (voiceOnRef.current) botSays("Așa sună vocea asta.", undefined, true);
  }

  return {
    messages, input, setInput, busy, pending, voiceOn, setVoiceOn, voiceState, speakingId, voiceError, awaitingAnswer,
    success, clearSuccess, wordTick, proactive,
    sttSupported: stt.supported, ttsSupported: tts.supported, voiceList, voiceName, chooseVoice,
    isRecording, send, listen, stopRecording, hardStop, stopListening, stopSpeaking, speakMessage, confirm, cancel, reset,
  };
}

export type Assistant = ReturnType<typeof useAssistant>;
