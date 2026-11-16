import Fastify from "fastify";
import type { BillStatus, PaymentRequestItem, ProductType, SeedVariant } from "@pago/shared";
import { PagoError, PagoStore } from "./mock/store.ts";
import { ConfirmError, PaymentConfirmation } from "./payments/confirmation.ts";
import { Agent } from "./agent/agent.ts";
import { ClaudeClient } from "./agent/claude.ts";
import type { LlmClient } from "./agent/llm.ts";
import { ScriptedLlm } from "./agent/scripted.ts";

/** Modelul real doar dacă e cerut explicit și avem cheie; altfel modelul simulat. */
export function createLlmFromEnv(): LlmClient {
  if (process.env.LLM_MODE === "claude" && process.env.ANTHROPIC_API_KEY) return new ClaudeClient();
  if (process.env.LLM_MODE === "claude") console.warn("LLM_MODE=claude, dar lipsește ANTHROPIC_API_KEY → folosesc modelul simulat.");
  return new ScriptedLlm();
}

const CONFIRM_STATUS: Record<string, number> = {
  NO_PENDING_PAYMENT: 404,
  TOKEN_INVALID: 404,
  TOKEN_USED: 409,
  TOKEN_EXPIRED: 410,
  AMOUNT_CHANGED: 409,
  SCREEN_CONFIRM_REQUIRED: 403,
};

const BILL_STATUSES: BillStatus[] = ["unpaid", "paid", "overdue"];
const PRODUCT_TYPES: ProductType[] = ["rca", "vignette", "roaming", "sim"];
const VARIANTS: SeedVariant[] = ["demo", "all-good", "rca-expired", "no-bills"];

export interface AppOptions {
  store?: PagoStore;
  confirmation?: PaymentConfirmation;
  llm?: LlmClient;
}

/**
 * Construiește aplicația (fără s-o pornească), ca s-o putem testa
 * direct cu `app.inject(...)`, fără port deschis.
 */
export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: false });
  const store = options.store ?? new PagoStore();
  const confirmation = options.confirmation ?? new PaymentConfirmation(store);
  const agent = new Agent({ store, confirmation, llm: options.llm ?? createLlmFromEnv() });

  // Erorile de business devin 4xx cu un cod clar; restul rămân 500.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ConfirmError) {
      return reply.status(CONFIRM_STATUS[err.code] ?? 409).send({ error: err.code, message: err.message });
    }
    if (err instanceof PagoError) {
      const status = err.code.endsWith("NOT_FOUND")
        ? 404 // nu există
        : err.code === "EMPTY_PAYMENT" || err.code === "DUPLICATE_ITEM"
          ? 400 // cerere greșită
          : 409; // conflict cu starea datelor (ex. factură deja plătită)
      return reply.status(status).send({ error: err.code, message: err.message });
    }
    const e = err as { statusCode?: number; message?: string };
    reply.status(e.statusCode ?? 500).send({ error: "INTERNAL", message: e.message ?? "Eroare internă" });
  });

  // Toate rutele stau sub /api; frontend-ul (Vite) le trimite aici prin proxy.
  app.get("/api/health", async () => ({
    ok: true,
    llmMode: agent.llmName,
  }));

  // ---------- Conversația cu asistentul ----------

  app.post<{ Body: { sessionId?: string; message?: string } }>("/api/chat", async (req, reply) => {
    const { sessionId, message } = req.body ?? {};
    if (!sessionId || typeof message !== "string" || !message.trim()) {
      return reply.status(400).send({ error: "BAD_REQUEST", message: "Lipsește sessionId sau message." });
    }
    const result = await agent.chat(sessionId, message.trim());
    // Frontend-ul primește răspunsul, plata în așteptare (cu token, pentru buton) și numele tool-urilor.
    return {
      reply: result.reply,
      outcome: result.outcome,
      pending: result.pending,
      actions: result.toolCalls.map((c) => c.name),
    };
  });

  // ---------- API Pago simulat (doar citire) ----------

  app.get("/api/me", async () => store.getUser());

  app.get<{ Querystring: { status?: string } }>("/api/bills", async (req, reply) => {
    const { status } = req.query;
    if (status && !BILL_STATUSES.includes(status as BillStatus)) {
      return reply.status(400).send({ error: "BAD_STATUS", message: `status trebuie să fie: ${BILL_STATUSES.join(", ")}` });
    }
    return store.listBills(status as BillStatus | undefined);
  });

  app.get("/api/vehicles", async () => store.getVehicles());

  app.get<{ Querystring: { vehicleId?: string } }>("/api/policies", async (req) =>
    store.getPolicies(req.query.vehicleId),
  );

  app.get<{ Querystring: { vehicleId?: string } }>("/api/vignettes", async (req) =>
    store.getVignettes(req.query.vehicleId),
  );

  app.get("/api/services", async () => store.getServices());

  app.get<{ Querystring: { type?: string } }>("/api/products", async (req, reply) => {
    const { type } = req.query;
    if (type && !PRODUCT_TYPES.includes(type as ProductType)) {
      return reply.status(400).send({ error: "BAD_TYPE", message: `type trebuie să fie: ${PRODUCT_TYPES.join(", ")}` });
    }
    return store.searchProducts(type as ProductType | undefined);
  });

  app.get("/api/payments", async () => store.listPayments());

  // ---------- Plăți: DOAR prin stratul de confirmare ----------
  // prepare nu mută bani; confirm cere token-ul pe care îl are doar frontend-ul.

  const badRequest = (reply: { status: (n: number) => { send: (b: unknown) => unknown } }, message: string) =>
    reply.status(400).send({ error: "BAD_REQUEST", message });

  app.post<{ Body: { sessionId?: string; items?: PaymentRequestItem[] } }>("/api/payments/prepare", async (req, reply) => {
    const { sessionId, items } = req.body ?? {};
    if (!sessionId || !Array.isArray(items)) return badRequest(reply, "Lipsește sessionId sau items.");
    return confirmation.prepare(sessionId, items);
  });

  app.get<{ Querystring: { sessionId?: string } }>("/api/payments/pending", async (req, reply) => {
    if (!req.query.sessionId) return badRequest(reply, "Lipsește sessionId.");
    return { pending: confirmation.getPendingForClient(req.query.sessionId) };
  });

  app.post<{ Body: { sessionId?: string; token?: string } }>("/api/payments/confirm", async (req, reply) => {
    const { sessionId, token } = req.body ?? {};
    if (!sessionId || !token) return badRequest(reply, "Lipsește sessionId sau token.");
    return { payment: confirmation.confirm(sessionId, token, "button") };
  });

  app.post<{ Body: { sessionId?: string; token?: string } }>("/api/payments/cancel", async (req, reply) => {
    const { sessionId, token } = req.body ?? {};
    if (!sessionId) return badRequest(reply, "Lipsește sessionId.");
    return { cancelled: confirmation.cancel(sessionId, token) };
  });

  // ---------- Doar pentru demo și teste: repornește povestea ----------

  app.post<{ Body: { variant?: string } | undefined }>("/api/dev/reset", async (req, reply) => {
    const variant = (req.body?.variant ?? "demo") as SeedVariant;
    if (!VARIANTS.includes(variant)) {
      return reply.status(400).send({ error: "BAD_VARIANT", message: `variant trebuie să fie: ${VARIANTS.join(", ")}` });
    }
    store.reset(variant);
    confirmation.clearAll();
    agent.clearSessions();
    return { ok: true, variant };
  });

  return app;
}
