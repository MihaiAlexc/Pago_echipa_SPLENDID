import { daysBetween, type Product } from "@pago/shared";
import type { PagoStore } from "../mock/store.ts";
import type { ChecklistResult } from "../scenarios/trips.ts";
import type { ToolCallRecord } from "./agent.ts";

/**
 * Cardurile pe care interfața le arată sub răspunsul asistentului. Sunt construite DOAR din rezultatele
 * tool-urilor și din catalog (date reale din backend), nu din textul modelului — deci nu pot conține sume inventate.
 * Cardul de plată (Confirmă / Anulează) nu e aici: vine separat, ca `pending`, cu token-ul.
 */
export type ChatCard =
  | {
      type: "bills";
      bills: { id: string; categoryRo: string; provider: string; amount: number; dueDate: string; daysUntilDue: number; status: string }[];
    }
  | { type: "trip"; checklist: Extract<ChecklistResult, { known: true }> }
  | {
      /** Pachete pentru călătorie: asigurare de călătorie (preț pe persoană) + rovinietă / viniete pe drum. */
      type: "trip_offers";
      country: string;
      countryName: string;
      days: number;
      withCar: boolean | null;
      insurance: Product[];
      vignettes: Product[];
    }
  | { type: "products"; products: Product[] };

export function cardsFromToolCalls(calls: ToolCallRecord[], store?: PagoStore): ChatCard[] {
  const lastOk = (name: string) => [...calls].reverse().find((c) => c.name === name && c.result.ok);
  const cards: ChatCard[] = [];

  const trip = lastOk("run_trip_checklist");
  const checklist = trip?.result.ok ? (trip.result.data as ChecklistResult) : null;
  // Doar după ce știm dacă ia mașina: altfel lista ar include acte de care poate nu are nevoie.
  if (checklist?.known && checklist.withCar !== null) cards.push({ type: "trip", checklist });

  // Pachetele pentru călătorie (asigurare + viniete), cu alegerea numărului de persoane în interfață.
  // Apar pentru ORICE țară: și pentru cele din reguli, și pentru cele pe care modelul le descrie din cunoștințele lui.
  if (checklist && store) {
    const days = Math.max(1, daysBetween(checklist.trip.start, checklist.trip.end));
    const travel = store.searchProducts("travel");
    // Pachetul cel mai scurt care acoperă toată călătoria (sau cel mai lung, dacă nimic nu ajunge).
    const durations = [...new Set(travel.map((p) => p.durationDays))].sort((a, b) => a - b);
    const duration = durations.find((d) => d >= days) ?? durations.at(-1);
    // Viniete: rovinieta + cele de pe drum, din regulile țării (pentru o țară necunoscută, doar rovinieta).
    const route = checklist.known ? checklist.items.filter((i) => i.productType === "vignette" && i.country).map((i) => i.country!) : [];
    const countries = ["RO", ...route];
    const name = checklist.known ? checklist.name : titleCase(checklist.country);
    const showVignettes = checklist.known ? checklist.withCar !== false : checklist.withCar === true;
    cards.push({
      type: "trip_offers",
      country: checklist.known ? checklist.country : normalizeKey(checklist.country),
      countryName: name,
      days,
      withCar: checklist.withCar,
      insurance: travel.filter((p) => p.durationDays === duration),
      vignettes: showVignettes ? store.searchProducts("vignette").filter((p) => countries.includes(p.country ?? "")) : [],
    });
  }

  const bills = lastOk("list_bills");
  if (bills?.result.ok) {
    const list = bills.result.data as Extract<ChatCard, { type: "bills" }>["bills"];
    if (list.length) cards.push({ type: "bills", bills: list });
  }

  const products = lastOk("search_products");
  if (products?.result.ok) {
    const list = products.result.data as Product[];
    if (list.length) cards.push({ type: "products", products: list });
  }
  return cards;
}

/** „japonia” → „Japonia” (numele scris de model, pentru o țară care nu e în reguli). */
function titleCase(s: string): string {
  const t = s.trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "Călătorie";
}

/** Cheie stabilă pentru o țară necunoscută (ca să nu repetăm cardul în conversație). */
function normalizeKey(s: string): string {
  return s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "") || "x";
}
