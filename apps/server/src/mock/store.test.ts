import { describe, expect, it } from "vitest";
import { PagoError, PagoStore } from "./store.ts";

// Ceas fix: „azi” e mereu 16 noiembrie 2026, ora 12.
const fixedNow = () => new Date(2026, 10, 16, 12, 0, 0);
const newStore = (variant: "demo" | "all-good" | "rca-expired" | "no-bills" = "demo") =>
  new PagoStore({ variant, now: fixedNow });

function expectPagoError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PagoError);
    expect((e as PagoError).code).toBe(code);
    return;
  }
  throw new Error(`Se aștepta eroarea ${code}`);
}

describe("povestea Mariei (seed demo)", () => {
  const store = newStore();

  it("are facturile din plan", () => {
    const bills = store.listBills();
    const byCat = Object.fromEntries(bills.map((b) => [b.category, b]));
    expect(byCat.electricity).toMatchObject({ amount: 187.4, dueDate: "2026-11-19", status: "unpaid" });
    expect(byCat.gas).toMatchObject({ amount: 94.2, dueDate: "2026-11-14", status: "overdue" });
    expect(byCat.water).toMatchObject({ amount: 56, dueDate: "2026-11-28", status: "unpaid" });
    expect(byCat.internet).toMatchObject({ amount: 55, status: "paid" });
  });

  it("are RCA care expiră în 6 zile, fără Turcia", () => {
    const [rca] = store.getPolicies("v1");
    expect(rca.validUntil).toBe("2026-11-22");
    expect(rca.countries).not.toContain("TR");
  });

  it("are rovinietă, dar nu vinietă pentru Bulgaria", () => {
    const countries = store.getVignettes("v1").map((v) => v.country);
    expect(countries).toEqual(["RO"]);
  });

  it("are prețurile din dialogurile D3/D4", () => {
    const price = (id: string) => store.searchProducts().find((p) => p.id === id)?.price;
    expect(price("rca-6m")).toBe(230);
    expect(price("rca-12m")).toBe(410);
    expect(price("rca-12m-tr")).toBe(450);
    expect(price("vinieta-bg-7z")).toBe(75);
  });
});

describe("variantele de seed", () => {
  it("all-good: nimic de plată, RCA acoperă Turcia", () => {
    const store = newStore("all-good");
    expect(store.listBills("unpaid")).toHaveLength(0);
    expect(store.listBills("overdue")).toHaveLength(0);
    expect(store.getPolicies()[0].countries).toContain("TR");
  });

  it("rca-expired: RCA expirat acum 3 zile", () => {
    expect(newStore("rca-expired").getPolicies()[0].validUntil).toBe("2026-11-13");
  });

  it("no-bills: fără facturi", () => {
    expect(newStore("no-bills").listBills()).toHaveLength(0);
  });
});

describe("plăți", () => {
  it("plătește o factură: devine paid și apare în istoric", () => {
    const store = newStore();
    const payment = store.executePayment([{ kind: "bill", billId: "b-curent" }]);

    expect(payment.total).toBe(187.4);
    expect(store.listBills().find((b) => b.id === "b-curent")).toMatchObject({ status: "paid", paidAt: "2026-11-16" });
    expect(store.listPayments()).toHaveLength(1);
  });

  it("suma vine din date, nu din cerere", () => {
    const store = newStore();
    // Cererea nu are câmp de sumă; chiar dacă cineva ar adăuga unul, e ignorat.
    const payment = store.executePayment([{ kind: "bill", billId: "b-gaz", amount: 100 } as never]);
    expect(payment.total).toBe(94.2);
  });

  it("factură deja plătită → eroare", () => {
    expectPagoError(() => newStore().executePayment([{ kind: "bill", billId: "b-internet" }]), "BILL_ALREADY_PAID");
  });

  it("aceeași factură plătită de două ori → a doua oară eroare", () => {
    const store = newStore();
    store.executePayment([{ kind: "bill", billId: "b-apa" }]);
    expectPagoError(() => store.executePayment([{ kind: "bill", billId: "b-apa" }]), "BILL_ALREADY_PAID");
  });

  it("factură sau produs inexistent → eroare", () => {
    expectPagoError(() => newStore().executePayment([{ kind: "bill", billId: "nu-exista" }]), "BILL_NOT_FOUND");
    expectPagoError(() => newStore().executePayment([{ kind: "product", productId: "nu-exista" }]), "PRODUCT_NOT_FOUND");
  });

  it("cerere goală sau duplicată → eroare", () => {
    expectPagoError(() => newStore().executePayment([]), "EMPTY_PAYMENT");
    expectPagoError(
      () => newStore().executePayment([{ kind: "bill", billId: "b-apa" }, { kind: "bill", billId: "b-apa" }]),
      "DUPLICATE_ITEM",
    );
  });

  it("totul sau nimic: dacă un element e invalid, nu se plătește nimic", () => {
    const store = newStore();
    expectPagoError(
      () => store.executePayment([{ kind: "bill", billId: "b-curent" }, { kind: "bill", billId: "b-internet" }]),
      "BILL_ALREADY_PAID",
    );
    expect(store.listBills().find((b) => b.id === "b-curent")?.status).toBe("unpaid");
    expect(store.listPayments()).toHaveLength(0);
  });

  it("mai multe facturi odată: totalul e suma lor", () => {
    const payment = newStore().executePayment([
      { kind: "bill", billId: "b-curent" },
      { kind: "bill", billId: "b-gaz" },
    ]);
    expect(payment.total).toBe(281.6);
  });

  it("cumpărarea RCA cu Turcia adaugă o poliță nouă", () => {
    const store = newStore();
    store.executePayment([{ kind: "product", productId: "rca-12m-tr" }]);
    const newest = store.getPolicies("v1").at(-1)!;
    expect(newest).toMatchObject({ validFrom: "2026-11-16", validUntil: "2027-11-16" });
    expect(newest.countries).toContain("TR");
  });

  it("cumpărarea vinietei pentru Bulgaria și a roamingului", () => {
    const store = newStore();
    store.executePayment([
      { kind: "product", productId: "vinieta-bg-7z" },
      { kind: "product", productId: "roaming-tr-7z" },
    ]);
    expect(store.getVignettes("v1").map((v) => v.country)).toContain("BG");
    expect(store.getServices()).toMatchObject([{ type: "roaming", country: "TR", validUntil: "2026-11-23" }]);
  });

  it("adaugă o factură: neplătită dacă scadența e în viitor, întârziată dacă a trecut", () => {
    const store = newStore();
    const future = store.addBill({ category: "phone", provider: "Telefonia Demo", amount: 42.5, dueDate: "2026-11-20" });
    const past = store.addBill({ category: "gas", provider: "Alt Gaz", amount: 10, dueDate: "2026-11-01" });
    expect(future).toMatchObject({ status: "unpaid", amount: 42.5 });
    expect(past.status).toBe("overdue");
    expect(store.listBills()).toHaveLength(6);

    // și se poate plăti ca oricare alta
    expect(store.executePayment([{ kind: "bill", billId: future.id }]).total).toBe(42.5);
  });

  it("adăugare invalidă → INVALID_BILL", () => {
    const store = newStore();
    const ok = { category: "phone" as const, provider: "X", amount: 10, dueDate: "2026-11-20" };
    expectPagoError(() => store.addBill({ ...ok, amount: 0 }), "INVALID_BILL");
    expectPagoError(() => store.addBill({ ...ok, provider: "  " }), "INVALID_BILL");
    expectPagoError(() => store.addBill({ ...ok, dueDate: "mâine" }), "INVALID_BILL");
    expectPagoError(() => store.addBill({ ...ok, category: "bla" as never }), "INVALID_BILL");
  });

  it("șterge o factură", () => {
    const store = newStore();
    store.removeBill("b-apa");
    expect(store.listBills().map((b) => b.id)).not.toContain("b-apa");
    expectPagoError(() => store.removeBill("b-apa"), "BILL_NOT_FOUND");
  });

  it("reset readuce povestea la început", () => {
    const store = newStore();
    store.executePayment([{ kind: "bill", billId: "b-curent" }]);
    store.reset("demo");
    expect(store.listBills("unpaid")).toHaveLength(2);
    expect(store.listPayments()).toHaveLength(0);
  });
});
