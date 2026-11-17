import { useCallback, useEffect, useRef, useState } from "react";
import { App as NativeApp } from "@capacitor/app";
import type { Bill, User } from "@pago/shared";
import { api, isNative } from "./api.ts";
import { AssistantSheet } from "./Assistant.tsx";
import { Bills } from "./Bills.tsx";
import { Car, type CarData } from "./Car.tsx";
import { SuccessScreen } from "./cards.tsx";
import { Home, type Screen } from "./Home.tsx";
import { IconBills, IconCarNav, IconGrid, IconHome, IconMic } from "./icons.tsx";
import { OtherPayments } from "./OtherPayments.tsx";
import { PayProvider } from "./pay.tsx";
import { Settings } from "./Settings.tsx";
import { useAssistant } from "./useAssistant.ts";
import "./app.css";

/** Bara de jos, ca în Pago: Acasă, Facturi, [Pago AI în centru], Alte plăți, Mașina. Setări: rotița de pe Acasă. */
const NAV: { id: Screen; label: string; icon: React.ReactNode }[] = [
  { id: "home", label: "Acasă", icon: <IconHome /> },
  { id: "bills", label: "Facturi", icon: <IconBills /> },
  { id: "other", label: "Alte plăți", icon: <IconGrid /> },
  { id: "car", label: "Mașina", icon: <IconCarNav /> },
];
/** Ordinea ecranelor (pentru direcția animației) și coloana lor în bara de jos (coloana 2 = Pago AI; Setări nu e în bară). */
const ORDER: Record<Screen, number> = { home: 0, bills: 1, other: 2, car: 3, settings: 4 };
const COLUMN: Record<Screen, number> = { home: 0, bills: 1, other: 3, car: 4, settings: -1 };

export function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [showHistory, setShowHistory] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [bills, setBills] = useState<Bill[]>([]);
  const [car, setCar] = useState<CarData | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState("…");

  const loadData = useCallback(async () => {
    try {
      const [b, c] = await Promise.all([api.get<Bill[]>("/api/bills"), api.get<CarData>("/api/car")]);
      setBills(b);
      setCar(c);
    } catch {
      /* serverul nu răspunde; datele rămân cum erau */
    }
  }, []);

  const loadAll = useCallback(() => {
    api.get<{ llmMode: string }>("/api/health").then((h) => setMode(h.llmMode)).catch(() => setMode("fără conexiune la server"));
    api.get<User>("/api/me").then(setUser).catch(() => {});
    loadData();
  }, [loadData]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const a = useAssistant(loadData);

  /** Deschide asistentul; cu text → îl și trimite (ex. butonul „Plătește” de pe o factură). */
  function ask(text?: string) {
    setSheetOpen(true);
    if (text) a.send(text);
  }

  // Direcția tranziției: spre dreapta în bara de jos → ecranul vine din dreapta, și invers.
  const [direction, setDirection] = useState<"fwd" | "back">("fwd");
  function go(s: Screen, opts?: { history?: boolean }) {
    if (s !== screen) setDirection(ORDER[s] > ORDER[screen] ? "fwd" : "back");
    setScreen(s);
    if (s === "bills") setShowHistory(Boolean(opts?.history));
    window.scrollTo({ top: 0 });
  }

  // Butonul „Înapoi” de pe Android: închide panoul Pago AI → revine la Acasă → minimizează aplicația (nu o închide).
  const backState = useRef({ sheetOpen, screen });
  backState.current = { sheetOpen, screen };
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    if (!isNative) return;
    const handles = [
      NativeApp.addListener("backButton", () => {
        const { sheetOpen: open, screen: current } = backState.current;
        if (open) setSheetOpen(false);
        else if (current !== "home") goRef.current("home");
        else NativeApp.minimizeApp();
      }),
      // Aplicația trece în fundal → panoul se închide, deci microfonul și vocea se opresc.
      NativeApp.addListener("pause", () => setSheetOpen(false)),
    ];
    return () => handles.forEach((h) => h.then((x) => x.remove()));
  }, []);

  return (
    <PayProvider onPaid={loadData}>
    <div className="app">
      <main className="content" inert={sheetOpen}>
        {/* key = ecranul → la schimbare, React montează din nou și pornește animația de intrare. */}
        <div key={screen} className={`screen-anim ${direction}`}>
        {screen === "home" && <Home userName={user?.name ?? ""} bills={bills} car={car} proactive={a.proactive} onAsk={ask} onGo={go} />}
        {screen === "bills" && (
          <Bills
            bills={bills}
            showHistory={showHistory}
            onShowHistory={setShowHistory}
            onChanged={loadData}
          />
        )}
        {screen === "other" && <OtherPayments onGo={go} />}
        {screen === "car" && <Car data={car} onChanged={loadData} />}
        {screen === "settings" && <Settings a={a} mode={mode} onReconnect={loadAll} userName={user?.name ?? ""} onUserChanged={loadAll} />}
        </div>
      </main>

      <nav className="tabbar" aria-label="Navigare" inert={sheetOpen} style={{ ["--col" as string]: COLUMN[screen] }}>
        {COLUMN[screen] >= 0 && <span className="tab-indicator" aria-hidden="true" />}
        {NAV.slice(0, 2).map((n) => (
          <button key={n.id} className={screen === n.id ? "on" : ""} aria-current={screen === n.id ? "page" : undefined} onClick={() => go(n.id)}>
            {n.icon}<span>{n.label}</span>
          </button>
        ))}
        <button className="tab-ai" onClick={() => ask()} aria-label="Pago AI: vorbește cu asistentul">
          <span className={`tab-ai-orb ${a.pending ? "attention" : ""}`}><IconMic size={30} /></span>
          <span>Pago AI</span>
        </button>
        {NAV.slice(2).map((n) => (
          <button key={n.id} className={screen === n.id ? "on" : ""} aria-current={screen === n.id ? "page" : undefined} onClick={() => go(n.id)}>
            {n.icon}<span>{n.label}</span>
          </button>
        ))}
      </nav>

      <AssistantSheet a={a} open={sheetOpen} onClose={() => setSheetOpen(false)} />
      {a.success && <SuccessScreen total={a.success.total} lines={a.success.lines} onClose={a.clearSuccess} />}
    </div>
    </PayProvider>
  );
}
