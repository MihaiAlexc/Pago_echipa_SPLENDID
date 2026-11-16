import { describe, expect, it } from "vitest";
import { ScriptedLlm } from "../../apps/server/src/agent/scripted.ts";
import { createHarness, names } from "./harness.ts";

// Ce știe modelul simulat în plus față de dialogurile din plan.
const h0 = () => createHarness(new ScriptedLlm());

describe("mai multe facturi odată", () => {
  it("„plătește curentul și apa” → o singură plată cu ambele", async () => {
    const h = h0();
    const t1 = await h.say("Plătește curentul și apa.");
    expect(t1.reply).toBe("Curentul și apa: curent 187,40 lei și apă 56 de lei, în total 243,40 lei. Le plătesc acum?");
    expect(t1.pending?.total).toBe(243.4);

    const t2 = await h.say("da");
    expect(t2.reply).toBe("Gata, am plătit 243,40 lei pentru curent și apă. Mai ai de plată gazul.");
    expect(h.bill("b-curent").status).toBe("paid");
    expect(h.bill("b-apa").status).toBe("paid");
  });

  it("„plătește toate facturile”", async () => {
    const h = h0();
    const t = await h.say("Plătește toate facturile.");
    expect(t.reply).toContain("Toate cele trei facturi");
    expect(t.pending?.total).toBe(337.6);
  });

  it("„achită facturile întârziate”", async () => {
    const h = h0();
    const t = await h.say("Achită facturile întârziate.");
    expect(t.pending?.lines.map((l) => l.refId)).toEqual(["b-gaz"]);
  });

  it("factură deja plătită în aceeași cerere → spune asta și o plătește doar pe cealaltă", async () => {
    const h = h0();
    const t = await h.say("Plătește internetul și apa.");
    expect(t.reply).toContain("Factura la internet e deja plătită.");
    expect(t.pending?.lines.map((l) => l.refId)).toEqual(["b-apa"]);
  });
});

describe("sinonime și greșeli de recunoaștere vocală", () => {
  it.each([
    ["Vreau să plătesc lumina.", "b-curent"],
    ["Achită gazele.", "b-gaz"],
    ["Plătește curentu.", "b-curent"], // litera lipsă (vocea a tăiat „l”)
  ])("„%s”", async (text, billId) => {
    const h = h0();
    const t = await h.say(text);
    expect(t.pending?.lines[0].refId).toBe(billId);
  });
});

describe("întrebări despre facturi", () => {
  it("„cât e factura la apă?” → informează, nu pregătește plata; „da” → o pregătește", async () => {
    const h = h0();
    const t1 = await h.say("Cât e factura la apă?");
    expect(names(t1)).not.toContain("prepare_payment");
    expect(t1.reply).toBe("Factura la apă e de 56 de lei, scadentă în 12 zile. Vrei s-o plătesc?");

    const t2 = await h.say("Da.");
    expect(t2.pending?.total).toBe(56);
  });

  it("„ce facturi am întârziate?”", async () => {
    const h = h0();
    const t = await h.say("Ce facturi am întârziate?");
    expect(t.reply).toBe("Ai o factură întârziată: gaz 94,20 lei. Vrei s-o plătesc?");
  });
});

describe("alegerea dintr-o listă", () => {
  it("„a doua” după „Pe care vrei s-o plătesc?”", async () => {
    const h = h0();
    await h.say("Plătește o factură.");
    const t = await h.say("A doua.");
    expect(t.pending?.lines[0].refId).toBe("b-gaz");
  });
});

describe("corecturi", () => {
  it("„nu, factura de apă” înlocuiește plata pregătită", async () => {
    const h = h0();
    const t1 = await h.say("Plătește factura la curent.");
    const t2 = await h.say("Nu, factura de apă.");
    expect(t2.outcome).toBe("pass"); // nu e un „nu” simplu → nu anulează în cod
    expect(t2.pending?.lines[0].refId).toBe("b-apa");
    expect(t2.pending?.token).not.toBe(t1.pending?.token);
  });
});

describe("mașina: RCA și rovinietă", () => {
  it("„până când am RCA?” → valabilitate + propune reînnoirea; „da” → oferte; „cea de 12 luni” → pregătește; „da” → cumpără", async () => {
    const h = h0();
    const t1 = await h.say("Până când am RCA?");
    expect(names(t1)).toEqual(["get_vehicles", "check_policies"]);
    expect(t1.reply).toBe("RCA-ul pentru B-123-ABC e valabil până pe 22.11.2026, adică încă 6 zile. Nu acoperă Turcia. Vrei să-l reînnoiesc?");

    const t2 = await h.say("Da, arată-mi ofertele.");
    // „410 lei” fără „de”: în română, numerele terminate în 01–19 nu iau „de”.
    expect(t2.reply).toBe("Am trei oferte de RCA: 6 luni 230 de lei, 12 luni 410 lei și 12 luni cu Turcia 450 de lei. Care te interesează?");
    expect(t2.pending).toBeNull(); // încă nimic pregătit

    const t3 = await h.say("Cea de 12 luni.");
    expect(t3.reply).toBe("RCA 12 luni costă 410 lei. Îl cumpăr?");
    expect(t3.pending?.total).toBe(410);

    const t4 = await h.say("Da.");
    expect(t4.outcome).toBe("confirmed");
    expect(t4.reply).toBe("Gata, am plătit 410 lei pentru RCA 12 luni. Mai ai de plată curentul, gazul și apa.");
    expect(h.store.getPolicies("v1").at(-1)?.validUntil).toBe("2027-11-16");
  });

  it.each([
    ["Cea mai ieftină.", "rca-6m"],
    ["A treia.", "rca-12m-tr"],
    ["Cea cu Turcia.", "rca-12m-tr"],
    ["Șase luni.", "rca-6m"],
  ])("alegere „%s”", async (choice, productId) => {
    const h = h0();
    await h.say("Vreau RCA.");
    const t = await h.say(choice);
    expect(t.pending?.lines[0].refId).toBe(productId);
  });

  it("RCA expirat (varianta rca-expired)", async () => {
    const h = h0();
    h.store.reset("rca-expired");
    const t = await h.say("Mai am RCA?");
    expect(t.reply).toContain("a expirat acum 3 zile");
  });

  it("„am rovinietă?”", async () => {
    const h = h0();
    const t = await h.say("Am rovinietă?");
    expect(t.reply).toBe("Rovinieta pentru B-123-ABC e valabilă până pe 06.12.2026, adică încă 20 de zile.");
  });

  it("vinietă pentru Bulgaria: oferte", async () => {
    const h = h0();
    const t = await h.say("Cumpără-mi vinieta pentru Bulgaria.");
    expect(t.reply).toBe("Am trei oferte de vinietă pentru Bulgaria: week-end 30 de lei, 7 zile 75 de lei și 30 de zile 140 de lei. Care te interesează?");
    const t2 = await h.say("7 zile");
    expect(t2.pending?.lines[0].refId).toBe("vinieta-bg-7z");
  });
});

describe("datele editate în „Mașina mea” sunt folosite de asistent", () => {
  it("număr nou de înmatriculare + RCA cu Turcia adăugat manual → Turcia nu mai cere RCA", async () => {
    const h = h0();
    h.store.updateVehicle("v1", { plate: "CJ-99-XYZ", make: "Skoda", model: "Octavia" });
    h.store.addDocument({ kind: "rca", validUntil: "2027-11-16", coversTurkey: true });

    const t1 = await h.say("Până când am RCA?");
    expect(t1.reply).toContain("RCA-ul pentru CJ-99-XYZ e valabil până pe 16.11.2027");

    await h.say("Plec în Turcia săptămâna viitoare.");
    const t2 = await h.say("Da.");
    expect(t2.reply).not.toContain("RCA");
    expect(t2.reply).toContain("vinieta pentru Bulgaria");
  });
});

describe("conversație", () => {
  it.each([
    ["Bună!", "Bună! Pot să plătesc facturi"],
    ["Mulțumesc!", "Cu plăcere"],
    ["Ce poți face?", "Pot să-ți plătesc facturile"],
  ])("„%s”", async (text, start) => {
    const h = h0();
    const t = await h.say(text);
    expect(t.reply.startsWith(start)).toBe(true);
    expect(t.pending).toBeNull();
  });

  it("frază necunoscută → nu ghicește, nu plătește", async () => {
    const h = h0();
    const t = await h.say("Care e capitala Franței?");
    expect(t.reply).toContain("Nu am înțeles bine");
    expect(t.pending).toBeNull();
  });
});
