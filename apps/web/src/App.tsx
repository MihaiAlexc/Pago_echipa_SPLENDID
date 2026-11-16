import { useEffect, useState } from "react";
import { formatLei } from "@pago/shared";

type Health = { ok: boolean; llmMode: string };

// Ecran provizoriu pentru Pasul 0: arată că web-ul vorbește cu serverul.
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Reîncercăm de câteva ori: la pornire, serverul poate fi gata după web.
    let cancelled = false;
    async function check(attempt = 1): Promise<void> {
      try {
        const r = await fetch("/api/health");
        if (!r.ok) throw new Error(String(r.status));
        const data: Health = await r.json();
        if (!cancelled) { setHealth(data); setError(null); }
      } catch {
        if (cancelled) return;
        if (attempt < 5) setTimeout(() => check(attempt + 1), 1000);
        else setError("Serverul nu răspunde.");
      }
    }
    check();
    return () => { cancelled = true; };
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 16, fontSize: 20 }}>
      <h1>Pago Asistent</h1>
      {error && <p>❌ {error}</p>}
      {health && (
        <p>
          ✅ Server conectat (model: <b>{health.llmMode}</b>)
        </p>
      )}
      {!health && !error && <p>Se conectează…</p>}
      <p>Test comun: {formatLei(187.4)}</p>
      <p>
        <a href="/voice-test.html">Test de voce →</a>
      </p>
    </main>
  );
}
