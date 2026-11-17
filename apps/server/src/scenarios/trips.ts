import { readFileSync } from "node:fs";
import { addDays, daysBetween, type IsoDate, type ProductType } from "@pago/shared";
import type { PagoStore } from "../mock/store.ts";
import { normalize } from "../payments/intent.ts";

/**
 * MOTORUL DE SCENARII — reguli deterministe, nu LLM.
 * Regulile stau în countries.json. LLM-ul (sau modelul simulat) doar întreabă motorul și povestește rezultatul.
 */

export interface Requirement {
  id: string;
  when: "car" | "always";
  check: "rca_covers" | "vignette" | "service";
  country?: string;
  label: string;
  short: string;
  productType: ProductType;
  suggestedProductId?: string;
  alternatives?: ProductType[];
}

/** Ce trebuie să știi despre o țară: acte, taxe de drum (cu prețuri estimative), roaming. */
export interface CountryInfo {
  documents: string;
  roadTolls: string;
  tollEstimate?: string;
  roaming?: string;
}

export interface CountryRules {
  code: string;
  name: string;
  inName: string;
  aliases: string[];
  verified: boolean;
  requirements: Requirement[];
  info?: CountryInfo;
}

export function loadCountryRules(): CountryRules[] {
  const raw = JSON.parse(readFileSync(new URL("./countries.json", import.meta.url), "utf8"));
  return raw.countries as CountryRules[];
}

export type Reason =
  | "missing" // nu există deloc
  | "expired" // a expirat deja
  | "expires_before_trip" // expiră înainte de plecare
  | "expires_during_trip" // expiră în timpul călătoriei
  | "not_covered"; // există, dar nu acoperă țara

export interface ChecklistItem {
  id: string;
  label: string;
  short: string;
  status: "ok" | "missing";
  reasons: Reason[];
  /** Pentru RCA / vinietă: până când e valabil ce ai acum, și câte zile mai are. */
  currentValidUntil?: IsoDate;
  currentDaysLeft?: number;
  productType: ProductType;
  alternatives?: ProductType[];
  suggestedProduct?: { id: string; name: string; price: number };
  /** Pentru viniete / internet: țara actului (ex. „HU”). */
  country?: string;
}

export type ChecklistResult =
  | { known: false; country: string; message: string; trip: { start: IsoDate; end: IsoDate }; withCar: boolean | null }
  | {
      known: true;
      country: string;
      name: string;
      inName: string;
      verified: boolean;
      hasCar: boolean;
      withCar: boolean | null; // null = nu știm încă (întreabă utilizatorul)
      trip: { start: IsoDate; end: IsoDate };
      items: ChecklistItem[];
      missingCount: number;
      info?: CountryInfo;
    };

export interface TripInput {
  country: string;
  /** Peste câte zile pleacă (implicit 7 = „săptămâna viitoare”). */
  startInDays?: number;
  /** Câte zile durează (implicit 7). */
  days?: number;
  /** Dacă ia mașina. Lipsă = nu știm încă. */
  withCar?: boolean;
}

export function findCountry(rules: CountryRules[], input: string): CountryRules | undefined {
  const n = normalize(input);
  return rules.find((c) => c.code.toLowerCase() === n || normalize(c.name) === n || c.aliases.includes(n));
}

export function runTripChecklist(store: PagoStore, input: TripInput, rules: CountryRules[] = loadCountryRules()): ChecklistResult {
  const country = findCountry(rules, String(input.country ?? ""));
  const today = store.today();
  const start = addDays(today, Math.max(0, Math.round(input.startInDays ?? 7)));
  const end = addDays(start, Math.max(1, Math.round(input.days ?? 7)));
  const vehicle = store.getVehicles()[0];
  const hasCar = Boolean(vehicle);
  const withCar = input.withCar === undefined ? (hasCar ? null : false) : input.withCar && hasCar;

  if (!country) {
    // Țară fără reguli în baza noastră: NU răspundem „nu știu”. Modelul folosește cunoștințele lui generale
    // (marcate ca orientative), iar interfața arată oricum pachetele de asigurare de călătorie.
    return {
      known: false,
      country: String(input.country ?? ""),
      trip: { start, end },
      withCar,
      message:
        "Țara nu e în baza de reguli a aplicației. NU spune că nu știi. Din cunoștințele tale generale, spune pe scurt: ce act trebuie (carte de identitate sau pașaport, viză dacă e cazul), taxele de drum (vinietă, autostradă cu taxă sau gratuit) cu un preț estimativ, și dacă roamingul e inclus. Spune clar că sunt informații orientative de verificat pe mae.ro. Spune că pe ecran sunt pachetele de asigurare de călătorie, unde poate alege numărul de persoane. Nu pregăti plăți pentru acte din afara catalogului.",
    };
  }

  const product = (id?: string) => {
    const p = id ? store.searchProducts().find((x) => x.id === id) : undefined;
    return p ? { id: p.id, name: p.name, price: p.price } : undefined;
  };

  const items: ChecklistItem[] = [];
  for (const req of country.requirements) {
    if (req.when === "car" && withCar !== true) continue;
    const base = {
      id: req.id, label: req.label, short: req.short, productType: req.productType,
      alternatives: req.alternatives, suggestedProduct: product(req.suggestedProductId), country: req.country,
    };

    if (req.check === "rca_covers") {
      const policies = store.getPolicies(vehicle!.id);
      const okPolicy = policies.find((p) => p.countries.includes(country.code) && p.validFrom <= start && p.validUntil >= end);
      if (okPolicy) { items.push({ ...base, status: "ok", reasons: [], currentValidUntil: okPolicy.validUntil, currentDaysLeft: daysBetween(today, okPolicy.validUntil) }); continue; }

      const current = [...policies].sort((a, b) => (a.validUntil < b.validUntil ? 1 : -1))[0];
      const reasons: Reason[] = [];
      if (!current) reasons.push("missing");
      else {
        if (current.validUntil < today) reasons.push("expired");
        else if (current.validUntil < start) reasons.push("expires_before_trip");
        else if (current.validUntil < end) reasons.push("expires_during_trip");
        if (!current.countries.includes(country.code)) reasons.push("not_covered");
      }
      items.push({
        ...base, status: "missing", reasons,
        currentValidUntil: current?.validUntil,
        currentDaysLeft: current ? daysBetween(today, current.validUntil) : undefined,
      });
      continue;
    }

    if (req.check === "vignette") {
      const vg = store.getVignettes(vehicle!.id).filter((v) => v.country === req.country);
      const ok = vg.find((v) => v.validFrom <= start && v.validUntil >= start);
      items.push(ok ? { ...base, status: "ok", reasons: [] } : { ...base, status: "missing", reasons: ["missing"] });
      continue;
    }

    // service: roaming sau cartelă pentru țară, valabile în timpul călătoriei
    const services = store.getServices().filter((s) => s.country === req.country && s.validUntil >= start);
    items.push(services.length ? { ...base, status: "ok", reasons: [] } : { ...base, status: "missing", reasons: ["missing"] });
  }

  return {
    known: true,
    country: country.code,
    name: country.name,
    inName: country.inName,
    verified: country.verified,
    hasCar,
    withCar,
    trip: { start, end },
    items,
    missingCount: items.filter((i) => i.status === "missing").length,
    info: country.info,
  };
}

export interface ExpiringItem {
  kind: "rca" | "vignette" | "bill";
  label: string;
  daysLeft: number; // negativ = expirat / întârziat
  refId: string;
}

/** Ce expiră în următoarele `days` zile (sau a expirat deja): RCA, rovinietă, facturi. Cele mai urgente primele. */
export function getExpiringItems(store: PagoStore, days = 30): ExpiringItem[] {
  const today = store.today();
  const out: ExpiringItem[] = [];
  for (const v of store.getVehicles()) {
    const rca = [...store.getPolicies(v.id)].sort((a, b) => (a.validUntil < b.validUntil ? 1 : -1))[0];
    if (rca) {
      const left = daysBetween(today, rca.validUntil);
      if (left <= days) out.push({ kind: "rca", label: `RCA ${v.plate}`, daysLeft: left, refId: rca.id });
    }
    const ro = [...store.getVignettes(v.id)].filter((x) => x.country === "RO").sort((a, b) => (a.validUntil < b.validUntil ? 1 : -1))[0];
    if (ro) {
      const left = daysBetween(today, ro.validUntil);
      if (left <= days) out.push({ kind: "vignette", label: `Rovinietă ${v.plate}`, daysLeft: left, refId: ro.id });
    }
  }
  for (const b of store.listBills()) {
    if (b.status === "paid") continue;
    const left = daysBetween(today, b.dueDate);
    if (left <= days) out.push({ kind: "bill", label: `Factură ${b.provider}`, daysLeft: left, refId: b.id });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}
