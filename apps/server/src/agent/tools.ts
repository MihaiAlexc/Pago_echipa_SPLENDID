import type Anthropic from "@anthropic-ai/sdk";
import { daysBetween, type Bill, type PaymentRequestItem, type ProductType } from "@pago/shared";
import { PagoError, type PagoStore } from "../mock/store.ts";
import type { PaymentConfirmation } from "../payments/confirmation.ts";
import { getExpiringItems, runTripChecklist } from "../scenarios/trips.ts";

/**
 * Tool-urile pe care le poate apela LLM-ul.
 * IMPORTANT: niciunul nu confirmă o plată. `prepare_payment` doar pregătește și NU întoarce token-ul.
 * Confirmarea o face backend-ul (buton sau „da” recunoscut în cod) — vezi payments/confirmation.ts.
 */

export const CATEGORY_RO: Record<Bill["category"], string> = {
  electricity: "curent",
  gas: "gaz",
  water: "apă",
  internet: "internet",
  phone: "telefon",
};

export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_bills",
    description:
      "Listează facturile utilizatorului. status: 'due' = tot ce e de plată (neplătite + întârziate), 'unpaid', 'overdue', 'paid'. Fără status = toate. Fiecare factură are sumă, scadență și câte zile mai sunt până la scadență (negativ = întârziată).",
    input_schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["due", "unpaid", "overdue", "paid"] } },
    },
  },
  {
    name: "get_vehicles",
    description: "Lista mașinilor utilizatorului (id, număr de înmatriculare, marcă, model).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_policies",
    description: "Polițele RCA ale unei mașini: valabilitate, câte zile mai are, țările acoperite (Carte Verde).",
    input_schema: {
      type: "object",
      properties: { vehicleId: { type: "string" } },
      required: ["vehicleId"],
    },
  },
  {
    name: "check_vignette",
    description: "Rovinieta (RO) și alte viniete (ex. BG) ale unei mașini, cu valabilitate.",
    input_schema: {
      type: "object",
      properties: { vehicleId: { type: "string" } },
      required: ["vehicleId"],
    },
  },
  {
    name: "search_products",
    description: "Caută în catalog produse de cumpărat: 'rca', 'vignette' (rovinietă/vinietă), 'roaming', 'sim' (cartelă). Întoarce id, nume, preț, durată.",
    input_schema: {
      type: "object",
      properties: { type: { type: "string", enum: ["rca", "vignette", "roaming", "sim"] } },
      required: ["type"],
    },
  },
  {
    name: "run_trip_checklist",
    description:
      "Verifică ce îi trebuie utilizatorului pentru o călătorie într-o țară, după reguli fixe (RCA / Carte Verde, viniete pe drum, internet). Întoarce ce are deja, ce lipsește și produsul sugerat pentru fiecare lipsă. Dacă țara nu e cunoscută, întoarce known=false: atunci spune cinstit că nu ai informații. Dacă withCar=null, întreabă întâi dacă ia mașina. Regulile sunt exemple (verified=false).",
    input_schema: {
      type: "object",
      properties: {
        country: { type: "string", description: "Numele țării, ex. „Turcia”" },
        startInDays: { type: "number", description: "Peste câte zile pleacă (implicit 7)" },
        days: { type: "number", description: "Câte zile durează călătoria (implicit 7)" },
        withCar: { type: "boolean", description: "Dacă ia mașina; omite dacă nu știi încă" },
      },
      required: ["country"],
    },
  },
  {
    name: "get_expiring_items",
    description: "Ce expiră sau e scadent în următoarele N zile (RCA, rovinietă, facturi), cel mai urgent primul. daysLeft negativ = deja expirat / întârziat.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "Implicit 30" } },
    },
  },
  {
    name: "prepare_payment",
    description:
      "Pregătește o plată (NU plătește). Sumele se iau din date, nu din ce spune utilizatorul. După acest apel, spune-i utilizatorului ce se plătește și cât, și întreabă-l dacă confirmă. Confirmarea o face utilizatorul (prin „da” sau butonul de pe ecran), nu tu.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["bill", "product"] },
              billId: { type: "string", description: "Pentru kind='bill'" },
              productId: { type: "string", description: "Pentru kind='product'" },
              vehicleId: { type: "string", description: "Opțional, pentru RCA/vinietă" },
            },
            required: ["kind"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "cancel_pending_payment",
    description: "Anulează plata pregătită care așteaptă confirmare (de ex. dacă utilizatorul se răzgândește sau vrea altceva).",
    input_schema: { type: "object", properties: {} },
  },
];

export interface ToolContext {
  store: PagoStore;
  confirmation: PaymentConfirmation;
  sessionId: string;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string; message: string };

/** Execută un tool cerut de LLM. Nu aruncă: erorile devin rezultate pe care LLM-ul le poate explica. */
export function executeTool(ctx: ToolContext, name: string, input: unknown): ToolResult {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "list_bills":
        return { ok: true, data: listBills(ctx, args.status) };
      case "get_vehicles":
        return { ok: true, data: ctx.store.getVehicles() };
      case "check_policies":
        return {
          ok: true,
          data: ctx.store.getPolicies(String(args.vehicleId ?? "")).map((p) => ({
            ...p,
            daysLeft: daysBetween(ctx.store.today(), p.validUntil),
          })),
        };
      case "check_vignette":
        return {
          ok: true,
          data: ctx.store.getVignettes(String(args.vehicleId ?? "")).map((v) => ({
            ...v,
            daysLeft: daysBetween(ctx.store.today(), v.validUntil),
          })),
        };
      case "search_products":
        return { ok: true, data: ctx.store.searchProducts(args.type as ProductType) };
      case "run_trip_checklist":
        return {
          ok: true,
          data: runTripChecklist(ctx.store, {
            country: String(args.country ?? ""),
            startInDays: typeof args.startInDays === "number" ? args.startInDays : undefined,
            days: typeof args.days === "number" ? args.days : undefined,
            withCar: typeof args.withCar === "boolean" ? args.withCar : undefined,
          }),
        };
      case "get_expiring_items":
        return { ok: true, data: getExpiringItems(ctx.store, typeof args.days === "number" ? args.days : 30) };
      case "prepare_payment": {
        const items = parseItems(args.items);
        const { token: _secret, ...summary } = ctx.confirmation.prepare(ctx.sessionId, items); // token-ul NU ajunge la LLM
        return {
          ok: true,
          data: {
            status: "awaiting_user_confirmation",
            ...summary,
            note: summary.requiresScreenConfirm
              ? "Suma e peste 500 de lei: utilizatorul trebuie să confirme cu butonul de pe ecran."
              : "Utilizatorul poate confirma spunând „da” sau cu butonul de pe ecran.",
          },
        };
      }
      case "cancel_pending_payment":
        return { ok: true, data: { cancelled: ctx.confirmation.cancel(ctx.sessionId) } };
      default:
        return { ok: false, error: "UNKNOWN_TOOL", message: `Tool necunoscut: ${name}` };
    }
  } catch (e) {
    if (e instanceof PagoError) return { ok: false, error: e.code, message: e.message };
    const err = e as { code?: string; message?: string };
    return { ok: false, error: err.code ?? "TOOL_ERROR", message: err.message ?? "Eroare la tool." };
  }
}

function listBills(ctx: ToolContext, status: unknown) {
  const today = ctx.store.today();
  const all = ctx.store.listBills();
  const filtered =
    status === "due" ? all.filter((b) => b.status !== "paid")
    : status === "unpaid" || status === "overdue" || status === "paid" ? all.filter((b) => b.status === status)
    : all;
  return filtered.map((b) => ({
    id: b.id,
    category: b.category,
    categoryRo: CATEGORY_RO[b.category],
    provider: b.provider,
    amount: b.amount,
    dueDate: b.dueDate,
    daysUntilDue: daysBetween(today, b.dueDate),
    status: b.status,
  }));
}

function parseItems(raw: unknown): PaymentRequestItem[] {
  if (!Array.isArray(raw)) throw new PagoError("EMPTY_PAYMENT", "Lipsește lista de elemente de plătit.");
  return raw.map((it) => {
    const o = (it ?? {}) as Record<string, unknown>;
    if (o.kind === "bill" && typeof o.billId === "string") return { kind: "bill", billId: o.billId };
    if (o.kind === "product" && typeof o.productId === "string") {
      return { kind: "product", productId: o.productId, vehicleId: typeof o.vehicleId === "string" ? o.vehicleId : undefined };
    }
    throw new PagoError("EMPTY_PAYMENT", "Element de plată invalid.");
  });
}
