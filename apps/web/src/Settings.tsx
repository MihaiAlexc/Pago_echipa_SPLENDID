import { useEffect, useState } from "react";
import { api, getApiBase, isNative, setApiBase } from "./api.ts";
import { IllBrain, IllRestart, IllServer, IllShield, IllVoice } from "./icons.tsx";

/** Iconița „Contul meu” (persoană + rotiță), ca în setările Pago. */
const IllAccount = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="10" cy="7" r="4" fill="var(--blue)" /><path d="M2.5 20.5a7.5 7.5 0 0 1 12.7-5.4" fill="var(--blue)" />
    <circle cx="17.5" cy="17.5" r="4" fill="var(--yellow)" /><circle cx="17.5" cy="17.5" r="1.5" fill="#fff" />
  </svg>
);
import type { Assistant } from "./useAssistant.ts";

/** Setări, grupate ca în Pago: Pago AI, Conexiune, Demo. */
export function Settings({ a, mode, onReconnect, userName, onUserChanged }: {
  a: Assistant; mode: string; onReconnect: () => void; userName: string; onUserChanged: () => void;
}) {
  const [base, setBase] = useState(getApiBase());
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [name, setName] = useState(userName);
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingName, setSavingName] = useState(false);
  useEffect(() => setName(userName), [userName]);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setSavingName(true);
    try {
      const u = await api.put<{ name: string }>("/api/me", { name });
      setName(u.name);
      setNameMsg({ ok: true, text: `Salvat. Te voi saluta „Bună, ${u.name.split(" ")[0]}!”` });
      onUserChanged();
    } catch (err) {
      setNameMsg({ ok: false, text: (err as Error).message });
    } finally {
      setSavingName(false);
    }
  }

  async function saveAndTest(e: React.FormEvent) {
    e.preventDefault();
    const saved = setApiBase(base);
    setBase(saved);
    setTest({ ok: true, text: "Verific…" });
    try {
      const h = await api.get<{ llmMode: string }>("/api/health");
      setTest({ ok: true, text: `Conectat. Model: ${h.llmMode}` });
      onReconnect();
    } catch {
      setTest({ ok: false, text: "Nu răspunde. Verifică adresa, că serverul rulează și că telefonul e în aceeași rețea Wi-Fi." });
    }
  }

  const hasRomanian = a.voiceList.some((v) => v.romanian);

  return (
    <div className="screen flush">
      <h1 className="page-title pad">Setări</h1>

      <h2 className="band">Personale</h2>
      <form className="rows" onSubmit={saveName}>
        <div className="srow">
          <IllAccount />
          <div className="srow-body">
            <label className="select-label">
              <b>Contul meu · numele tău</b>
              <input value={name} onChange={(e) => { setName(e.target.value); setNameMsg(null); }} maxLength={40} autoComplete="name" autoCapitalize="words" placeholder="ex. Maria Ionescu" />
            </label>
            <span>Pago AI te salută și îți vorbește pe numele acesta.</span>
            {nameMsg && <span className={nameMsg.ok ? "ok-text" : "warn-text"}>{nameMsg.text}</span>}
          </div>
        </div>
        <div className="srow">
          <span className="srow-spacer" />
          <button type="submit" className="btn-green" disabled={savingName || name.trim() === userName}>Salvează numele</button>
        </div>
      </form>

      <h2 className="band">Pago AI</h2>
      <div className="rows">
        <div className="srow">
          <IllVoice size={34} />
          <div className="srow-body">
            <b>Vocea asistentului</b>
            <span>{a.voiceOn ? "Răspunsurile sunt citite cu voce tare" : "Răspunsurile apar doar ca text"}</span>
          </div>
          <button
            className={`switch ${a.voiceOn ? "on" : ""}`}
            role="switch"
            aria-checked={a.voiceOn}
            aria-label="Vocea asistentului"
            onClick={() => (a.voiceOn ? (a.stopSpeaking(), a.setVoiceOn(false)) : a.setVoiceOn(true))}
            disabled={!a.ttsSupported}
          ><i /></button>
        </div>
        {!isNative && a.ttsSupported && (
          <div className="srow">
            <span className="srow-spacer" />
            <div className="srow-body">
              <label className="select-label">
                <b>Alege vocea</b>
                <select value={a.voiceName ?? ""} onChange={(e) => a.chooseVoice(e.target.value)}>
                  {!a.voiceName && <option value="">Implicită a browserului</option>}
                  {a.voiceList.map((v) => <option key={v.name} value={v.name}>{v.romanian ? "🇷🇴 " : ""}{v.name} ({v.lang})</option>)}
                </select>
              </label>
              {!hasRomanian && a.voiceList.length > 0 && (
                <span className="warn-text">Browserul nu are voce în română. Încearcă Microsoft Edge sau aplicația de pe telefon.</span>
              )}
            </div>
          </div>
        )}
        <div className="srow">
          <IllBrain size={34} />
          <div className="srow-body">
            <b>Model AI</b>
            <span>{mode}</span>
          </div>
        </div>
      </div>

      <h2 className="band">Conexiune</h2>
      <form className="rows" onSubmit={saveAndTest}>
        <div className="srow">
          <IllServer size={34} />
          <div className="srow-body">
            <label className="select-label">
              <b>Adresa serverului</b>
              <input
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder={isNative ? "ex. 192.168.1.104:3001" : "gol = același server ca pagina"}
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <span>{isNative ? "IP-ul laptopului din rețeaua Wi-Fi, portul 3001. Cu cablu și „adb reverse”: localhost:3001." : "În browser, lasă gol."}</span>
            {test && <span className={test.ok ? "ok-text" : "warn-text"}>{test.text}</span>}
          </div>
        </div>
        <div className="srow">
          <span className="srow-spacer" />
          <button type="submit" className="btn-green">Salvează și testează</button>
        </div>
      </form>

      <h2 className="band">Demo</h2>
      <div className="rows">
        <button className="srow as-btn" onClick={a.reset}>
          <IllRestart size={34} />
          <div className="srow-body">
            <b>Repornește povestea</b>
            <span>Datele Mariei revin la început</span>
          </div>
        </button>
        <div className="srow">
          <IllShield size={34} />
          <div className="srow-body">
            <b>Date de test</b>
            <span>Toate sumele, furnizorii și prețurile sunt fictive. Nicio plată nu e reală.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
