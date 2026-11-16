import { describe, expect, it } from "vitest";
import { PagoStore } from "../mock/store.ts";
import { ConfirmError, PaymentConfirmation, TOKEN_TTL_MS } from "./confirmation.ts";

function setup() {
  let clock = new Date(2026, 10, 16, 12, 0, 0).getTime();
  const store = new PagoStore({ now: () => new Date(clock) });
  const conf = new PaymentConfirmation(store, { nowMs: () => clock });
  const advance = (ms: number) => { clock += ms; };
  const bill = (id: string) => store.listBills().find((b) => b.id === id)!;
  return { store, conf, advance, bill };
}

const S = "sesiune-1";
const CURENT = [{ kind: "bill" as const, billId: "b-curent" }];

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect((e as ConfirmError).code).toBe(code);
    return;
  }
  throw new Error(`Se aștepta ${code}`);
}

describe("prepare", () => {
  it("nu mută bani: factura rămâne neplătită", () => {
    const { conf, store, bill } = setup();
    const p = conf.prepare(S, CURENT);
    expect(p.total).toBe(187.4);
    expect(bill("b-curent").status).toBe("unpaid");
    expect(store.listPayments()).toHaveLength(0);
  });

  it("sumarul pentru LLM nu conține token-ul", () => {
    const { conf } = setup();
    conf.prepare(S, CURENT);
    const summary = conf.getPendingSummary(S)!;
    expect(summary.total).toBe(187.4);
    expect(JSON.stringify(summary)).not.toMatch(/token/i);
  });

  it("o plată nouă o înlocuiește pe cea veche, iar token-ul vechi nu mai merge", () => {
    const { conf } = setup();
    const old = conf.prepare(S, CURENT);
    conf.prepare(S, [{ kind: "bill", billId: "b-apa" }]);
    expectCode(() => conf.confirm(S, old.token, "button"), "TOKEN_USED");
    expect(conf.getPendingSummary(S)!.total).toBe(56);
  });
});

describe("confirm", () => {
  it("cu token corect → plata se face o singură dată", () => {
    const { conf, bill } = setup();
    const { token } = conf.prepare(S, CURENT);
    const payment = conf.confirm(S, token, "button");
    expect(payment.total).toBe(187.4);
    expect(bill("b-curent").status).toBe("paid");
  });

  it("token reutilizat → TOKEN_USED (fără plată dublă)", () => {
    const { conf, store } = setup();
    const { token } = conf.prepare(S, CURENT);
    conf.confirm(S, token, "button");
    expectCode(() => conf.confirm(S, token, "button"), "TOKEN_USED");
    expect(store.listPayments()).toHaveLength(1);
  });

  it("token inexistent → TOKEN_INVALID", () => {
    const { conf } = setup();
    conf.prepare(S, CURENT);
    expectCode(() => conf.confirm(S, "token-inventat", "button"), "TOKEN_INVALID");
  });

  it("token din altă sesiune → TOKEN_INVALID", () => {
    const { conf } = setup();
    const { token } = conf.prepare(S, CURENT);
    expectCode(() => conf.confirm("alta-sesiune", token, "button"), "TOKEN_INVALID");
  });

  it("token expirat → TOKEN_EXPIRED, nu se plătește", () => {
    const { conf, advance, bill } = setup();
    const { token } = conf.prepare(S, CURENT);
    advance(TOKEN_TTL_MS + 1);
    expectCode(() => conf.confirm(S, token, "button"), "TOKEN_EXPIRED");
    expect(bill("b-curent").status).toBe("unpaid");
  });

  it("token expirat, după ce frontend-ul a cerut plata în așteptare → tot TOKEN_EXPIRED", () => {
    const { conf, advance } = setup();
    const { token } = conf.prepare(S, CURENT);
    advance(TOKEN_TTL_MS + 1);
    expect(conf.getPendingForClient(S)).toBeNull(); // aici token-ul e scos din așteptare
    expectCode(() => conf.confirm(S, token, "button"), "TOKEN_EXPIRED");
  });

  it("suma modificată între pregătire și confirmare → AMOUNT_CHANGED, nu se plătește", () => {
    const { conf, bill } = setup();
    const { token } = conf.prepare(S, CURENT);
    bill("b-curent").amount = 250; // furnizorul a schimbat suma între timp
    expectCode(() => conf.confirm(S, token, "button"), "AMOUNT_CHANGED");
    expect(bill("b-curent").status).toBe("unpaid");
  });

  it("factura plătită între timp → eroare, nu se plătește de două ori", () => {
    const { conf, store } = setup();
    const { token } = conf.prepare(S, CURENT);
    store.executePayment(CURENT); // plătită pe altă cale
    expect(() => conf.confirm(S, token, "button")).toThrow(/deja plătită/);
    expect(store.listPayments()).toHaveLength(1);
  });

  it("peste 500 lei: vocea nu confirmă, butonul da", () => {
    const { conf } = setup();
    const { token, requiresScreenConfirm } = conf.prepare(S, [
      { kind: "product", productId: "rca-12m-tr" },
      { kind: "product", productId: "vinieta-bg-7z" },
    ]); // 450 + 75 = 525 lei
    expect(requiresScreenConfirm).toBe(true);
    expectCode(() => conf.confirm(S, token, "voice"), "SCREEN_CONFIRM_REQUIRED");
    expect(conf.confirm(S, token, "button").total).toBe(525); // token-ul încă merge cu butonul
  });

  it("exact 500 lei sau mai puțin: merge și vocal", () => {
    const { conf } = setup();
    const p = conf.prepare(S, [{ kind: "product", productId: "rca-12m-tr" }]); // 450
    expect(p.requiresScreenConfirm).toBe(false);
  });
});

describe("cancel", () => {
  it("anulează plata și token-ul", () => {
    const { conf, bill } = setup();
    const { token } = conf.prepare(S, CURENT);
    expect(conf.cancel(S, token)).toBe(true);
    expectCode(() => conf.confirm(S, token, "button"), "TOKEN_USED");
    expect(bill("b-curent").status).toBe("unpaid");
    expect(conf.getPendingSummary(S)).toBeNull();
  });
});

describe("handleUserMessage (înainte de LLM)", () => {
  it("D1: „Da.” confirmă plata în așteptare", () => {
    const { conf, bill } = setup();
    conf.prepare(S, CURENT);
    const out = conf.handleUserMessage(S, "Da.");
    expect(out.kind).toBe("confirmed");
    expect(bill("b-curent").status).toBe("paid");
  });

  it("D2: „Nu.” anulează, nu plătește nimic", () => {
    const { conf, store } = setup();
    conf.prepare(S, [{ kind: "bill", billId: "b-gaz" }]);
    expect(conf.handleUserMessage(S, "Nu.").kind).toBe("cancelled");
    expect(store.listPayments()).toHaveLength(0);
    expect(conf.getPendingSummary(S)).toBeNull();
  });

  it.each(["poate", "hmm", "da, arată-mi ofertele"])("„%s” nu confirmă; mesajul merge la LLM", (text) => {
    const { conf, store } = setup();
    conf.prepare(S, CURENT);
    expect(conf.handleUserMessage(S, text).kind).toBe("pass");
    expect(store.listPayments()).toHaveLength(0);
    expect(conf.getPendingSummary(S)).not.toBeNull(); // plata rămâne în așteptare
  });

  it("„da” fără nimic în așteptare → nu face nimic", () => {
    const { conf, store } = setup();
    expect(conf.handleUserMessage(S, "da").kind).toBe("pass");
    expect(store.listPayments()).toHaveLength(0);
  });

  it("„da” peste prag → cere butonul de pe ecran", () => {
    const { conf, store } = setup();
    conf.prepare(S, [
      { kind: "product", productId: "rca-12m-tr" },
      { kind: "product", productId: "vinieta-bg-7z" },
    ]);
    expect(conf.handleUserMessage(S, "da").kind).toBe("needs_screen");
    expect(store.listPayments()).toHaveLength(0);
  });

  it("„da” după expirare → nu plătește", () => {
    const { conf, advance, store } = setup();
    conf.prepare(S, CURENT);
    advance(TOKEN_TTL_MS + 1);
    expect(conf.handleUserMessage(S, "da").kind).toBe("pass");
    expect(store.listPayments()).toHaveLength(0);
  });
});
