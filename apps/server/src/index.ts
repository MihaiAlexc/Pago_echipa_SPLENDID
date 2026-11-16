import { buildApp } from "./app.ts";

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
