import type Anthropic from "@anthropic-ai/sdk";
import { addDays, daysBetween, type Bill, type IsoDate, type PaymentRequestItem, type ProductType } from "@pago/shared";
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
    name: "add_bill",
    description:
      "Adaugă o factură nouă în lista utilizatorului (NU plătește nimic). Ai nevoie de tip și sumă; dacă lipsesc, întreabă-l întâi. Scadența: dueDate „YYYY-MM-DD” sau „DD.MM”, ori dueInDays; dacă nu o spune, implicit peste 14 zile. După adăugare, spune-i înapoi tipul, suma și scadența.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["electricity", "gas", "water", "internet", "phone"] },
        amount: { type: "number", description: "Suma în lei" },
        provider: { type: "string", description: "Furnizorul, dacă îl spune" },
        dueDate: { type: "string", description: "„YYYY-MM-DD” sau „DD.MM”" },
        dueInDays: { type: "number" },
      },
      required: ["category", "amount"],
    },
  },
  {
    name: "remove_bill",
    description: "Șterge o factură din listă (după id, din list_bills). Spune-i utilizatorului ce ai șters.",
    input_schema: {
      type: "object",
      properties: { billId: { type: "string" } },
      required: ["billId"],
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
      case "add_bill": {
        const today = ctx.store.today();
        const dueDate = resolveDueDate(today, args.dueDate, args.dueInDays);
        const provider = typeof args.provider === "string" && args.provider.trim() ? args.provider : "Adăugată prin voce";
        const bill = ctx.store.addBill({
          category: args.category as Bill["category"],
          provider,
          amount: Number(args.amount),
          dueDate,
        });
        return { ok: true, data: { ...bill, categoryRo: CATEGORY_RO[bill.category], daysUntilDue: daysBetween(today, bill.dueDate) } };
      }
      case "remove_bill": {
        const bill = ctx.store.listBills().find((b) => b.id === args.billId);
        ctx.store.removeBill(String(args.billId ?? ""));
        return { ok: true, data: { removed: bill ? { ...bill, categoryRo: CATEGORY_RO[bill.category] } : null } };
      }
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

/**
 * Scadența spusă de utilizator → „YYYY-MM-DD”.
 * Acceptă „2026-11-25”, „25.11” (următoarea apariție a datei), sau un număr de zile. Implicit: peste 14 zile.
 */
export function resolveDueDate(today: IsoDate, dueDate: unknown, dueInDays: unknown): IsoDate {
  if (typeof dueDate === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return dueDate;
    const m = dueDate.match(/^(\d{1,2})\.(\d{1,2})$/);
    if (m) {
      const [y] = today.split("-").map(Number);
      const day = Number(m[1]), month = Number(m[2]);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        const pad = (n: number) => String(n).padStart(2, "0");
        let candidate = `${y}-${pad(month)}-${pad(day)}`;
        // Dacă data a trecut de mult anul ăsta (peste o lună), e probabil anul viitor.
        if (daysBetween(today, candidate) < -31) candidate = `${y + 1}-${pad(month)}-${pad(day)}`;
        return candidate;
      }
    }
  }
  if (typeof dueInDays === "number" && Number.isFinite(dueInDays)) return addDays(today, Math.round(dueInDays));
  return addDays(today, 14);
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
