import Fastify from "fastify";
import type { BillStatus, PaymentRequestItem, ProductType, SeedVariant } from "@pago/shared";
import { PagoError, PagoStore, type DocumentInput, type NewBillInput, type VehicleInput } from "./mock/store.ts";
import { ConfirmError, PaymentConfirmation } from "./payments/confirmation.ts";
import { Agent } from "./agent/agent.ts";
import { cardsFromToolCalls } from "./agent/cards.ts";
import { ClaudeClient } from "./agent/claude.ts";
import { GroqClient } from "./agent/groq.ts";
import type { LlmClient } from "./agent/llm.ts";
import { ScriptedLlm } from "./agent/scripted.ts";

/**
 * Un model real doar dacă e cerut explicit (LLM_MODE) și avem cheia lui; altfel modelul simulat.
 *   LLM_MODE=groq   + GROQ_API_KEY      → Llama 3.3 70B prin Groq
 *   LLM_MODE=claude + ANTHROPIC_API_KEY → Claude
 */
export function createLlmFromEnv(): LlmClient {
  const mode = process.env.LLM_MODE;
  if (mode === "groq") {
    if (process.env.GROQ_API_KEY) return new GroqClient();
    console.warn("LLM_MODE=groq, dar lipsește GROQ_API_KEY → folosesc modelul simulat.");
  }
  if (mode === "claude") {
    if (process.env.ANTHROPIC_API_KEY) return new ClaudeClient();
    console.warn("LLM_MODE=claude, dar lipsește ANTHROPIC_API_KEY → folosesc modelul simulat.");
  }
  return new ScriptedLlm();
}

/** Originile aplicației Android (Capacitor WebView). */
export function isAppOrigin(origin: string): boolean {
  return /^(https?|capacitor):\/\/localhost(:\d+)?$/.test(origin);
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
const PRODUCT_TYPES: ProductType[] = ["rca", "vignette", "roaming", "sim", "travel"];
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
        : ["EMPTY_PAYMENT", "DUPLICATE_ITEM", "INVALID_BILL", "INVALID_CAR", "INVALID_DOCUMENT", "INVALID_PERSONS", "INVALID_NAME"].includes(err.code)
          ? 400 // cerere greșită
          : 409; // conflict cu starea datelor (ex. factură deja plătită)
      return reply.status(status).send({ error: err.code, message: err.message });
    }
    const e = err as { statusCode?: number; message?: string };
    reply.status(e.statusCode ?? 500).send({ error: "INTERNAL", message: e.message ?? "Eroare internă" });
  });

  // CORS doar pentru aplicația Android (Capacitor): pagina ei rulează pe http://localhost în telefon și
  // trimite cereri direct la laptop (http://192.168.x.x:3001). Browserul de pe laptop trece prin proxy-ul
  // Vite (aceeași origine), deci nu are nevoie de CORS. Alte site-uri nu primesc acces.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !isAppOrigin(origin)) return;
    reply.header("access-control-allow-origin", origin);
    reply.header("vary", "origin");
    reply.header("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    reply.header("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") return reply.status(204).send();
  });

  // Toate rutele stau sub /api; frontend-ul (Vite) le trimite aici prin proxy.
  app.get("/api/health", async () => ({
    ok: true,
    llmMode: agent.llmName,
  }));

  // ---------- Conversația cu asistentul ----------

  // D4: la deschiderea aplicației, un mesaj proactiv (o singură dată pe sesiune), dacă ceva expiră.
  app.get<{ Querystring: { sessionId?: string } }>("/api/proactive", async (req, reply) => {
    if (!req.query.sessionId) return reply.status(400).send({ error: "BAD_REQUEST", message: "Lipsește sessionId." });
    return { message: agent.proactiveGreeting(req.query.sessionId) };
  });

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
      cards: cardsFromToolCalls(result.toolCalls, store),
    };
  });

  // ---------- API Pago simulat (doar citire) ----------

  app.get("/api/me", async () => store.getUser());
  app.put<{ Body: { name?: string } }>("/api/me", async (req) => store.updateUserName(req.body?.name));

  app.get<{ Querystring: { status?: string } }>("/api/bills", async (req, reply) => {
    const { status } = req.query;
    if (status && !BILL_STATUSES.includes(status as BillStatus)) {
      return reply.status(400).send({ error: "BAD_STATUS", message: `status trebuie să fie: ${BILL_STATUSES.join(", ")}` });
    }
    return store.listBills(status as BillStatus | undefined);
  });

  // Utilizatorul își poate edita lista de facturi din pagină (asistentul lucrează pe aceeași listă).
  app.post<{ Body: NewBillInput }>("/api/bills", async (req, reply) => {
    const bill = store.addBill(req.body ?? ({} as NewBillInput));
    return reply.status(201).send(bill);
  });

  app.delete<{ Params: { id: string } }>("/api/bills/:id", async (req) => {
    store.removeBill(req.params.id);
    return { ok: true };
  });

  app.get("/api/vehicles", async () => store.getVehicles());

  // ---------- Mașina mea: detalii + acte, editabile din pagină ----------

  /** Tot ce ține de mașină, într-un singur răspuns (pentru secțiunea „Mașina mea”). */
  app.get("/api/car", async () => {
    const vehicle = store.getVehicles()[0] ?? null;
    return {
      vehicle,
      policies: vehicle ? store.getPolicies(vehicle.id) : [],
      vignettes: vehicle ? store.getVignettes(vehicle.id) : [],
      services: store.getServices(),
      inspections: vehicle ? store.getInspections(vehicle.id) : [],
    };
  });

  app.post<{ Body: VehicleInput }>("/api/vehicles", async (req, reply) =>
    reply.status(201).send(store.addVehicle(req.body ?? ({} as VehicleInput))),
  );

  app.put<{ Params: { id: string }; Body: VehicleInput }>("/api/vehicles/:id", async (req) =>
    store.updateVehicle(req.params.id, req.body ?? ({} as VehicleInput)),
  );

  app.post<{ Body: DocumentInput }>("/api/documents", async (req, reply) =>
    reply.status(201).send(store.addDocument(req.body ?? ({} as DocumentInput))),
  );

  app.delete<{ Params: { id: string } }>("/api/documents/:id", async (req) => {
    store.removeDocument(req.params.id);
    return { ok: true };
  });

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

  // `quiet: true` = plată făcută direct din ecrane (Facturi, Mașina...), fără asistent: nu mai întrebăm modelul ce urmează.
  app.post<{ Body: { sessionId?: string; token?: string; quiet?: boolean } }>("/api/payments/confirm", async (req, reply) => {
    const { sessionId, token, quiet } = req.body ?? {};
    if (!sessionId || !token) return badRequest(reply, "Lipsește sessionId sau token.");
    const payment = confirmation.confirm(sessionId, token, "button");
    if (quiet) return { payment, reply: null, pending: null };
    // Asistentul află de plată și spune ce urmează (ce a mai rămas, următorul pas al călătoriei).
    const next = await agent.afterButton(sessionId, { kind: "confirmed", payment });
    return { payment, reply: next.reply, pending: next.pending };
  });

  app.post<{ Body: { sessionId?: string; token?: string; quiet?: boolean } }>("/api/payments/cancel", async (req, reply) => {
    const { sessionId, token, quiet } = req.body ?? {};
    if (!sessionId) return badRequest(reply, "Lipsește sessionId.");
    const cancelled = confirmation.cancel(sessionId, token);
    const next = cancelled && !quiet ? await agent.afterButton(sessionId, { kind: "cancelled" }) : null;
    return { cancelled, reply: next?.reply ?? null };
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
