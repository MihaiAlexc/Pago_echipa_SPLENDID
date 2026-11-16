import { describe, expect, it } from "vitest";
import { ScriptedLlm } from "../../apps/server/src/agent/scripted.ts";
import type { LlmClient } from "../../apps/server/src/agent/llm.ts";
import { createHarness, names } from "./harness.ts";

// Dialogurile din IMPLEMENTATION_PLAN.md (secțiunea 7), cu modelul simulat.
// Verificăm ACȚIUNILE și ordinea lor; textul doar în punctele importante.

describe("D1 — plata unei facturi, cu confirmare", () => {
  it("pregătește, așteaptă „da”, apoi plătește", async () => {
    const h = createHarness(new ScriptedLlm());

    const t1 = await h.say("Plătește factura la curent.");
    expect(names(t1)).toContain("prepare_payment");
    expect(t1.reply).toBe("Factura la curent este de 187,40 lei, scadentă în 3 zile. O plătesc acum?");
    expect(h.bill("b-curent").status).toBe("unpaid"); // nimic plătit încă
    expect(t1.pending?.total).toBe(187.4); // cardul Confirmă / Anulează

    const t2 = await h.say("Da.");
    expect(t2.outcome).toBe("confirmed"); // confirmat în COD, înainte de model
    expect(names(t2)).not.toContain("prepare_payment");
    expect(h.bill("b-curent").status).toBe("paid");
    expect(h.store.listPayments()).toHaveLength(1);
    expect(t2.reply).toBe("Gata, am plătit 187,40 lei pentru curent. Mai ai de plată gazul și apa.");
    expect(t2.pending).toBeNull();
  });

  it("modelul nu vede niciodată token-ul de confirmare", async () => {
    const h = createHarness(new ScriptedLlm());
    const t1 = await h.say("Plătește factura la curent.");
    await h.say("Da.");
    expect(t1.pending?.token).toBeTruthy();
    expect(h.everythingTheModelSaw()).not.toContain(t1.pending!.token);
  });
});

describe("D2 — cerere ambiguă", () => {
  it("întreabă care factură, apoi „Nu” anulează", async () => {
    const h = createHarness(new ScriptedLlm());

    const t1 = await h.say("Plătește o factură.");
    expect(names(t1)).toEqual(["list_bills"]); // fără prepare_payment: nu ghicim
    expect(t1.reply).toBe("Ai trei facturi neplătite: curent 187,40 lei, gaz 94,20 lei și apă 56 de lei. Pe care vrei s-o plătesc?");
    expect(t1.pending).toBeNull();

    const t2 = await h.say("Cea la gaz.");
    expect(names(t2)).toContain("prepare_payment");
    expect(t2.reply).toBe("Factura la gaz este de 94,20 lei și e întârziată. O plătesc acum?");

    const t3 = await h.say("Nu.");
    expect(t3.outcome).toBe("cancelled");
    expect(t3.reply).toBe("Bine, nu am plătit nimic.");
    expect(h.store.listPayments()).toHaveLength(0);
    expect(t3.pending).toBeNull();
  });
});

describe("D5 — nu înțelege / date lipsă", () => {
  it("frază tăiată → cere clarificare, fără plată", async () => {
    const h = createHarness(new ScriptedLlm());
    const t = await h.say("Plătește factura de la...");
    expect(names(t)).not.toContain("prepare_payment");
    expect(t.reply).toBe("Nu am înțeles bine. Ce factură vrei să plătesc?");
  });

  it("țară necunoscută → răspuns cinstit, fără invenții", async () => {
    const h = createHarness(new ScriptedLlm());
    const t = await h.say("Plec în Japonia.");
    expect(names(t)).not.toContain("prepare_payment");
    expect(t.reply).toContain("Pentru Japonia nu am încă informații");
  });
});

describe("D6 — siguranță: sumă incertă", () => {
  it("suma plătită vine din date, nu din ce a spus utilizatorul", async () => {
    const h = createHarness(new ScriptedLlm());
    const t1 = await h.say("Plătește o sută de lei la gaz.");
    expect(t1.reply).toBe("Factura la gaz este de 94,20 lei, nu 100. O plătesc pe cea de 94,20?");
    expect(t1.pending?.total).toBe(94.2);

    await h.say("Da.");
    expect(h.store.listPayments()[0].total).toBe(94.2);
  });
});

describe("siguranță: nicio plată fără „da”", () => {
  it.each(["poate", "hmm", "da, arată-mi ofertele", "nu știu"])("„%s” după o plată pregătită nu plătește", async (answer) => {
    const h = createHarness(new ScriptedLlm());
    await h.say("Plătește factura la apă.");
    const t = await h.say(answer);
    expect(t.outcome).toBe("pass");
    expect(h.store.listPayments()).toHaveLength(0);
  });

  it("„da” fără nimic pregătit nu plătește nimic", async () => {
    const h = createHarness(new ScriptedLlm());
    const t = await h.say("Da.");
    expect(t.outcome).toBe("pass");
    expect(h.store.listPayments()).toHaveLength(0);
  });

  it("factură deja plătită → nu pregătește nimic", async () => {
    const h = createHarness(new ScriptedLlm());
    const t = await h.say("Plătește factura la internet.");
    expect(names(t)).not.toContain("prepare_payment");
    expect(t.reply).toBe("Factura la internet este deja plătită.");
  });
});

describe("„Cât am de plată?”", () => {
  it("adună facturile de plată", async () => {
    const h = createHarness(new ScriptedLlm());
    const t = await h.say("Cât am de plată luna asta?");
    expect(names(t)).toEqual(["list_bills"]);
    expect(t.reply).toBe("Ai trei facturi de plată, în total 337,60 lei: curent 187,40 lei, gaz 94,20 lei și apă 56 de lei.");
  });
});

describe("erori ale modelului", () => {
  it("mesaj prietenos, nimic plătit, conversația poate continua", async () => {
    let fail = true;
    const flaky: LlmClient = {
      name: "flaky",
      complete: (req) => (fail ? Promise.reject(new Error("rețea căzută")) : new ScriptedLlm().complete(req)),
    };
    const h = createHarness(flaky);
    const t1 = await h.say("Plătește factura la curent.");
    expect(t1.reply).toContain("problemă tehnică");
    expect(h.store.listPayments()).toHaveLength(0);

    fail = false;
    const t2 = await h.say("Plătește factura la curent.");
    expect(t2.reply).toContain("187,40 lei");
  });
});
