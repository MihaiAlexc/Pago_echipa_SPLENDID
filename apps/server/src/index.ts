import tls from "node:tls";
import { buildApp } from "./app.ts";

// Node are lista lui de certificate și NU are încredere în cele instalate în Windows. Pe calculatoare cu
// antivirus care verifică HTTPS (sau proxy de firmă), apelurile către Groq / Anthropic picau cu
// „unable to verify the first certificate”. Adăugăm și certificatele sistemului, ca browserul.
try {
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...tls.getCACertificates("system")]);
} catch {
  // Node mai vechi (fără aceste funcții) → rămân certificatele implicite.
}

// Citește `.env` din rădăcina proiectului, dacă există (cheia API stă doar aici, pe server).
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Fără .env → rulăm cu valorile implicite (model simulat).
}

// SERVER_PORT (nu PORT), ca să nu se ciocnească cu portul setat de alte unelte pentru web.
const port = Number(process.env.SERVER_PORT ?? 3001);
const app = buildApp();

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => console.log(`Server pornit pe http://localhost:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
