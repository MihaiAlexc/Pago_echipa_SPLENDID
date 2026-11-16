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
    expect(t1.reply).toBe("Ai trei facturi neplătite: curent 187,40 lei, gaz 94,20 lei și apă 56 de lei. Pe care vrei s-o plătesc? Pot să le plătesc și pe toate.");
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

describe("D3 — plec în Turcia (proactiv)", () => {
  it("întreabă de mașină, spune ce lipsește, propune pe rând, cere confirmare pentru fiecare", async () => {
    const h = createHarness(new ScriptedLlm());

    const t1 = await h.say("Plec în Turcia săptămâna viitoare.");
    expect(names(t1)).toEqual(["run_trip_checklist"]);
    expect(t1.reply).toBe("Pot să te ajut să te pregătești. Mașina o iei cu tine?");

    const t2 = await h.say("Da.");
    expect(names(t2)).toEqual(["run_trip_checklist"]);
    expect(t2.toolCalls[0].input).toMatchObject({ country: "turcia", withCar: true });
    expect(t2.reply).toBe(
      "Am verificat trei lucruri. RCA-ul tău expiră în 6 zile, înainte de plecare, iar Cartea Verde actuală nu acoperă Turcia. Îți lipsește și vinieta pentru Bulgaria. Începem cu RCA-ul?",
    );
    expect(t2.pending).toBeNull(); // nimic pregătit încă

    const t3 = await h.say("Da.");
    expect(t3.reply).toBe("RCA 12 luni cu Carte Verde valabilă și în Turcia costă 450 de lei. Îl cumpăr?");
    expect(t3.pending?.lines.map((l) => l.refId)).toEqual(["rca-12m-tr"]); // UNA singură, nu toate odată

    const t4 = await h.say("Da.");
    expect(t4.outcome).toBe("confirmed");
    expect(t4.reply).toBe("Gata. Urmează vinieta pentru Bulgaria: 7 zile costă 75 de lei. O cumpăr?");
    expect(t4.pending?.lines.map((l) => l.refId)).toEqual(["vinieta-bg-7z"]);

    const t5 = await h.say("Da.");
    expect(t5.reply).toBe("Gata. Mai ai nevoie și de internet în Turcia. Îți arăt pachetele de roaming sau o cartelă locală?");
    expect(t5.pending).toBeNull();

    const t6 = await h.say("Pachetele de roaming.");
    expect(t6.reply).toBe("Am două oferte de roaming: 7 zile 35 de lei și 15 zile 60 de lei. Care te interesează?");

    const t7 = await h.say("Cel de 15 zile.");
    expect(t7.pending?.lines.map((l) => l.refId)).toEqual(["roaming-tr-15z"]);

    const t8 = await h.say("Da.");
    expect(t8.reply).toBe("Gata. Acum ai tot ce-ți trebuie în Turcia. Drum bun!");
    expect(h.store.listPayments().map((p) => p.lines[0].refId)).toEqual(["rca-12m-tr", "vinieta-bg-7z", "roaming-tr-15z"]);
  });

  it("fără mașină → direct la internet", async () => {
    const h = createHarness(new ScriptedLlm());
    await h.say("Plec în Turcia săptămâna viitoare.");
    const t = await h.say("Nu, merg cu avionul.");
    expect(t.reply).toBe("Atunci ai nevoie în principal de internet în Turcia. Îți arăt pachetele de roaming sau o cartelă locală?");

    const t2 = await h.say("O cartelă locală.");
    expect(t2.pending?.lines.map((l) => l.refId)).toEqual(["cartela-tr"]);
  });

  it("„nu” la o propunere → nu cumpără nimic", async () => {
    const h = createHarness(new ScriptedLlm());
    await h.say("Plec în Turcia săptămâna viitoare.");
    await h.say("Da.");
    await h.say("Da.");
    const t = await h.say("Nu.");
    expect(t.outcome).toBe("cancelled");
    expect(h.store.listPayments()).toHaveLength(0);
  });
});

describe("D4 — termen care expiră (la deschiderea aplicației)", () => {
  it("salută proactiv o singură dată; „da, arată-mi ofertele” → oferte; nimic cumpărat fără alegere", async () => {
    const h = createHarness(new ScriptedLlm());
    expect(h.agent.proactiveGreeting("test")).toBe("Bună, Maria! RCA-ul tău expiră în 6 zile. Vrei să-l reînnoiesc?");
    expect(h.agent.proactiveGreeting("test")).toBeNull(); // doar o dată pe sesiune

    const t1 = await h.say("Da, arată-mi ofertele.");
    expect(t1.outcome).toBe("pass"); // nu e confirmare de plată
    expect(names(t1)).toEqual(["search_products"]);
    expect(t1.reply).toContain("oferte de RCA");
    expect(t1.pending).toBeNull();
    expect(h.store.listPayments()).toHaveLength(0);
  });

  it("totul în regulă → niciun mesaj proactiv", () => {
    const h = createHarness(new ScriptedLlm());
    h.store.reset("all-good");
    expect(h.agent.proactiveGreeting("test")).toBeNull();
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

describe("facturi adăugate de utilizator din pagină", () => {
  it("asistentul o vede și o plătește", async () => {
    const h = createHarness(new ScriptedLlm());
    const bill = h.store.addBill({ category: "phone", provider: "Telefonia Demo", amount: 42.5, dueDate: "2026-11-21" });

    const t1 = await h.say("Plătește factura la telefon.");
    expect(t1.reply).toBe("Factura la telefon este de 42,50 lei, scadentă în 5 zile. O plătesc acum?");
    await h.say("Da.");
    expect(h.bill(bill.id).status).toBe("paid");
  });

  it("factură ștearsă între pregătire și „da” → nu se plătește nimic", async () => {
    const h = createHarness(new ScriptedLlm());
    await h.say("Plătește factura la apă.");
    h.store.removeBill("b-apa");
    const t = await h.say("Da.");
    expect(t.outcome).toBe("failed");
    expect(h.store.listPayments()).toHaveLength(0);
  });
});

describe("„Cât am de plată?”", () => {
  it("adună facturile de plată", async () => {
    const h = createHarness(new ScriptedLlm());
    const t = await h.say("Cât am de plată luna asta?");
    expect(names(t)).toEqual(["list_bills"]);
    expect(t.reply).toBe("Ai trei facturi de plată, în total 337,60 lei: curent 187,40 lei, gaz 94,20 lei și apă 56 de lei. Factura la gaz e întârziată.");
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
