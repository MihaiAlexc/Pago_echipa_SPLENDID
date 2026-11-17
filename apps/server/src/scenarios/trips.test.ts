import { describe, expect, it } from "vitest";
import { PagoStore } from "../mock/store.ts";
import { getExpiringItems, loadCountryRules, runTripChecklist, type CountryRules } from "./trips.ts";

const fixedNow = () => new Date(2026, 10, 16, 12, 0, 0);
const newStore = (variant: "demo" | "all-good" | "rca-expired" = "demo") => new PagoStore({ variant, now: fixedNow });

describe("run_trip_checklist", () => {
  it("țară necunoscută → known=false (fără invenții)", () => {
    expect(runTripChecklist(newStore(), { country: "Japonia" })).toMatchObject({ known: false });
  });

  it("găsește țara după nume, alias sau cod", () => {
    for (const c of ["Turcia", "turciei", "Istanbul", "TR"]) {
      expect(runTripChecklist(newStore(), { country: c })).toMatchObject({ known: true, country: "TR" });
    }
  });

  it("nu știm dacă ia mașina → withCar=null și verificăm doar ce nu ține de mașină", () => {
    const r = runTripChecklist(newStore(), { country: "Turcia" });
    if (!r.known) throw new Error();
    expect(r.withCar).toBeNull();
    expect(r.items.map((i) => i.id)).toEqual(["internet"]);
  });

  it("Turcia cu mașina, povestea Mariei: RCA expiră înainte de plecare și nu acoperă Turcia; lipsesc vinieta BG și internetul", () => {
    const r = runTripChecklist(newStore(), { country: "Turcia", withCar: true, startInDays: 7, days: 7 });
    if (!r.known) throw new Error();
    expect(r.trip).toEqual({ start: "2026-11-23", end: "2026-11-30" });
    expect(r.items.map((i) => [i.id, i.status])).toEqual([["rca", "missing"], ["vignette-bg", "missing"], ["internet", "missing"]]);
    expect(r.items[0].reasons).toEqual(["expires_before_trip", "not_covered"]);
    expect(r.items[0].suggestedProduct).toMatchObject({ id: "rca-12m-tr", price: 450 });
    expect(r.items[1].suggestedProduct).toMatchObject({ id: "vinieta-bg-7z", price: 75 });
  });

  it("dacă pleacă mâine, RCA-ul expiră în timpul călătoriei", () => {
    const r = runTripChecklist(newStore(), { country: "Turcia", withCar: true, startInDays: 1, days: 10 });
    if (!r.known) throw new Error();
    expect(r.items[0].reasons).toContain("expires_during_trip");
  });

  it("după ce cumpără ce lipsește, totul e OK", () => {
    const store = newStore();
    store.executePayment([
      { kind: "product", productId: "rca-12m-tr" },
      { kind: "product", productId: "vinieta-bg-7z" },
      { kind: "product", productId: "roaming-tr-15z" },
    ]);
    const r = runTripChecklist(store, { country: "Turcia", withCar: true, startInDays: 1 });
    if (!r.known) throw new Error();
    expect(r.missingCount).toBe(0);
  });

  it("fără mașină → doar internetul", () => {
    const r = runTripChecklist(newStore(), { country: "Turcia", withCar: false });
    if (!r.known) throw new Error();
    expect(r.items.map((i) => i.id)).toEqual(["internet"]);
  });

  it("toate regulile sunt marcate ca exemple (de verificat)", () => {
    expect(loadCountryRules().every((c) => c.verified === false)).toBe(true);
  });

  it("o țară nouă se adaugă doar din date, fără cod nou", () => {
    const rules: CountryRules[] = [
      ...loadCountryRules(),
      {
        code: "IS", name: "Islanda", inName: "în Islanda", aliases: ["islanda"], verified: false,
        requirements: [{ id: "vignette-is", when: "car", check: "vignette", country: "IS", label: "Vinietă Islanda", short: "vinieta pentru Islanda", productType: "vignette" }],
      },
    ];
    const r = runTripChecklist(newStore(), { country: "Islanda", withCar: true }, rules);
    expect(r).toMatchObject({ known: true, country: "IS", missingCount: 1 });
  });
});

describe("get_expiring_items", () => {
  it("povestea Mariei: gazul întârziat, RCA în 6 zile, curentul în 3 zile...", () => {
    const items = getExpiringItems(newStore(), 30);
    expect(items.map((i) => [i.kind, i.daysLeft])).toEqual([
      ["bill", -2], ["bill", 3], ["rca", 6], ["bill", 12], ["vignette", 20],
    ]);
  });

  it("totul în regulă → nimic urgent", () => {
    expect(getExpiringItems(newStore("all-good"), 30)).toEqual([]);
  });
});

describe("călătorii în toată Europa și în orice țară", () => {
  it("Germania: autostrăzi gratuite, CI, viniete Ungaria + Austria pe drum, RCA-ul standard acoperă Germania", () => {
    const r = runTripChecklist(newStore(), { country: "Germania", withCar: true, startInDays: 1, days: 4 });
    if (!r.known) throw new Error("Germania ar trebui să fie în reguli");
    expect(r.info?.documents).toMatch(/identitate/i);
    expect(r.info?.roadTolls).toMatch(/GRATUITE/);
    const ids = r.items.filter((i) => i.status === "missing").map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["vignette-hu", "vignette-at"]));
    expect(r.items.find((i) => i.id === "rca")?.status).toBe("ok"); // RCA-ul Mariei acoperă DE și e valabil 6 zile
    expect(r.items.find((i) => i.id === "vignette-hu")?.suggestedProduct?.id).toBe("vinieta-hu-10z");
  });

  it("toate țările au acte și taxe de drum completate", () => {
    const rules = loadCountryRules();
    expect(rules.length).toBeGreaterThanOrEqual(20);
    for (const c of rules) {
      expect(c.info?.documents, c.code).toBeTruthy();
      expect(c.info?.roadTolls, c.code).toBeTruthy();
    }
  });

  it("țară care nu e în reguli (Japonia): nu „nu știu”, ci instrucțiuni să răspundă din cunoștințe + datele călătoriei", () => {
    const r = runTripChecklist(newStore(), { country: "Japonia", days: 10 });
    expect(r.known).toBe(false);
    if (r.known) return;
    expect(r.message).toMatch(/NU spune că nu știi/);
    expect(r.trip.start < r.trip.end).toBe(true);
  });
});
