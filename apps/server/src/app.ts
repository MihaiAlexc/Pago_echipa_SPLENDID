import Fastify from "fastify";
import type { BillStatus, ProductType, SeedVariant } from "@pago/shared";
import { PagoError, PagoStore } from "./mock/store.ts";

const BILL_STATUSES: BillStatus[] = ["unpaid", "paid", "overdue"];
const PRODUCT_TYPES: ProductType[] = ["rca", "vignette", "roaming", "sim"];
const VARIANTS: SeedVariant[] = ["demo", "all-good", "rca-expired", "no-bills"];

export interface AppOptions {
  store?: PagoStore;
}

/**
 * Construiește aplicația (fără s-o pornească), ca s-o putem testa
 * direct cu `app.inject(...)`, fără port deschis.
 */
export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: false });
  const store = options.store ?? new PagoStore();

  // Erorile de business devin 4xx cu un cod clar; restul rămân 500.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PagoError) {
      const status = err.code.endsWith("NOT_FOUND") ? 404 : 409;
      return reply.status(status).send({ error: err.code, message: err.message });
    }
    const e = err as { statusCode?: number; message?: string };
    reply.status(e.statusCode ?? 500).send({ error: "INTERNAL", message: e.message ?? "Eroare internă" });
  });

  // Toate rutele stau sub /api; frontend-ul (Vite) le trimite aici prin proxy.
  app.get("/api/health", async () => ({
    ok: true,
    llmMode: process.env.LLM_MODE ?? "mock",
  }));

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

  // Plățile (prepare / confirm / cancel) se adaugă la Pasul 2, împreună cu token-ul de confirmare.

  // ---------- Doar pentru demo și teste: repornește povestea ----------

  app.post<{ Body: { variant?: string } | undefined }>("/api/dev/reset", async (req, reply) => {
    const variant = (req.body?.variant ?? "demo") as SeedVariant;
    if (!VARIANTS.includes(variant)) {
      return reply.status(400).send({ error: "BAD_VARIANT", message: `variant trebuie să fie: ${VARIANTS.join(", ")}` });
    }
    store.reset(variant);
    return { ok: true, variant };
  });

  return app;
}
