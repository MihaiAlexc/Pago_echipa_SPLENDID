import Fastify from "fastify";

/**
 * Construiește aplicația (fără s-o pornească), ca s-o putem testa
 * direct cu `app.inject(...)`, fără port deschis.
 */
export function buildApp() {
  const app = Fastify({ logger: false });

  // Toate rutele stau sub /api; frontend-ul (Vite) le trimite aici prin proxy.
  app.get("/api/health", async () => ({
    ok: true,
    llmMode: process.env.LLM_MODE ?? "mock",
  }));

  return app;
}
