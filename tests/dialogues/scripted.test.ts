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

describe("facturi adăugate și șterse prin voce", () => {
  it("totul într-o frază → adaugă (fără plată), citește înapoi, „da” plătește exact factura nouă", async () => {
    const h = h0();
    const t1 = await h.say("Adaugă o factură la curent de la Enel de 120 de lei, scadentă pe 25 noiembrie.");
    expect(names(t1)).toEqual(["add_bill"]);
    expect(t1.reply).toBe("Am adăugat factura la curent de 120 de lei, scadentă pe 25.11.2026. Vrei s-o plătesc?");
    expect(t1.pending).toBeNull(); // adăugarea nu plătește nimic
    const added = h.store.listBills().at(-1)!;
    expect(added).toMatchObject({ category: "electricity", provider: "Enel", amount: 120, dueDate: "2026-11-25", status: "unpaid" });

    const t2 = await h.say("Da.");
    // Există și factura veche la curent (187,40) — se pregătește exact cea nouă, de 120.
    expect(t2.pending?.lines.map((l) => l.refId)).toEqual([added.id]);
    expect(h.store.listPayments()).toHaveLength(0);
    await h.say("Da.");
    expect(h.bill(added.id).status).toBe("paid");
    expect(h.bill("b-curent").status).toBe("unpaid");
  });

  it("în mai mulți pași: tipul, apoi suma (și scadența din prima frază)", async () => {
    const h = h0();
    const t1 = await h.say("Adaugă o factură nouă cu scadența peste 10 zile.");
    expect(t1.reply).toBe("La ce e factura: curent, gaz, apă, internet sau telefon?");
    const t2 = await h.say("Telefon.");
    expect(t2.reply).toBe("Ce sumă are factura la telefon?");
    const t3 = await h.say("42 50");
    expect(t3.reply).toBe("Am adăugat factura la telefon de 42,50 lei, scadentă pe 26.11.2026. Vrei s-o plătesc?");
    expect(h.store.listBills().at(-1)).toMatchObject({ category: "phone", amount: 42.5, provider: "Adăugată prin voce" });
  });

  it("suma spusă în cuvinte", async () => {
    const h = h0();
    await h.say("Adaugă factura la apă.");
    const t = await h.say("Patruzeci și cinci de lei.");
    expect(h.store.listBills().at(-1)).toMatchObject({ category: "water", amount: 45 });
    expect(t.reply).toContain("de 45 de lei");
  });

  it("scadență implicită: peste 14 zile", async () => {
    const h = h0();
    await h.say("Adaugă o factură la internet de 60 de lei.");
    expect(h.store.listBills().at(-1)?.dueDate).toBe("2026-11-30");
  });

  it("șterge prin voce: o alege pe cea cu suma spusă", async () => {
    const h = h0();
    const t = await h.say("Șterge factura la apă.");
    expect(names(t)).toEqual(["list_bills", "remove_bill"]);
    expect(t.reply).toBe("Am șters factura la apă de 56 de lei.");
    expect(h.store.listBills().map((b) => b.id)).not.toContain("b-apa");
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

  it("întrebare din afara subiectului → spune cinstit că nu știe, nu plătește", async () => {
    const h = h0();
    const t = await h.say("Care e capitala Franței?");
    expect(t.reply).toContain("La asta nu știu să răspund");
    expect(t.toolCalls).toHaveLength(0);
    expect(t.pending).toBeNull();
  });

  it("zgomot → cere repetarea o singură dată, apoi oferă alternativa de pe ecran", async () => {
    const h = h0();
    expect((await h.say("asdf qwer")).reply).toContain("Nu am înțeles bine");
    expect((await h.say("zxcv")).reply).toContain("butoanele de pe ecran");
  });

  it.each([
    ["Cine ești?", "Sunt asistentul vocal Pago"],
    ["Ești robot?", "Sunt un asistent virtual"],
    ["Noapte bună", "La revedere"], // nu „Bună!”
    ["E sigur să plătesc prin tine?", "Da, e sigur. Nu pot plăti nimic de unul singur"],
    ["Care e limita pentru confirmarea vocală?", "Până la 500 de lei poți confirma cu vocea"],
    ["Datele sunt reale?", "Aceasta este o versiune demonstrativă"],
    ["Cum adaug o factură?", "Spune, de exemplu: „Adaugă o factură"],
    ["Regulile sunt verificate?", "Regulile mele pentru călătorii sunt orientative"],
  ])("întrebare generală „%s” → răspuns fix, fără tool-uri", async (text, start) => {
    const h = h0();
    const t = await h.say(text);
    expect(t.reply.startsWith(start)).toBe(true);
    expect(t.toolCalls).toHaveLength(0);
    expect(t.pending).toBeNull();
  });

  it("„repetă” spune din nou ultima replică, iar răspunsul de după se leagă de ea", async () => {
    const h = h0();
    const t1 = await h.say("Plătește o factură.");
    const t2 = await h.say("Mai spune o dată.");
    expect(t2.reply).toBe(t1.reply);
    const t3 = await h.say("A doua.");
    expect(t3.pending?.lines[0].refId).toBe("b-gaz");
  });
});

describe("ce înseamnă termenii (și pasul următor)", () => {
  it("„ce e RCA?” → explică, apoi „da” verifică RCA-ul din cont", async () => {
    const h = h0();
    const t1 = await h.say("Ce e RCA?");
    expect(t1.reply).toBe("RCA-ul este asigurarea auto obligatorie: acoperă pagubele pe care le produci altora într-un accident. Vrei să verific până când e valabil al tău?");
    const t2 = await h.say("Da.");
    expect(names(t2)).toEqual(["get_vehicles", "check_policies"]);
    expect(t2.reply).toContain("e valabil până pe 22.11.2026");
  });

  it("„ce e cartea verde?” NU e „cartelă” → nu pregătește nicio cumpărare", async () => {
    const h = h0();
    const t = await h.say("Ce e cartea verde?");
    expect(t.reply).toContain("Cartea Verde este documentul");
    expect(names(t)).not.toContain("prepare_payment");
    expect(t.pending).toBeNull();
  });

  it("„ce e vinieta?” → „da” arată ofertele pentru Bulgaria", async () => {
    const h = h0();
    await h.say("Ce e vinieta?");
    const t = await h.say("Da.");
    expect(t.reply).toContain("oferte de vinietă pentru Bulgaria");
  });
});

describe("întrebări despre cont", () => {
  it.each([
    ["Cum mă cheamă?", "Te cheamă Maria Ionescu.", ["get_profile"]],
    ["Care e numărul meu de telefon?", "Numărul tău de telefon din cont este 0700 000 000.", ["get_profile"]], // nu factura la telefon
    ["Ce zi e azi?", "Azi e luni, 16 noiembrie 2026.", ["get_profile"]],
    ["Cât e ceasul?", "E ora 12:00.", ["get_profile"]],
    ["Ce mașină am?", "Mașina ta este Dacia Logan, cu numărul de înmatriculare B-123-ABC.", ["get_vehicles"]],
    ["Care e seria de șasiu?", "Seria de șasiu a mașinii B-123-ABC este UU1DEMO0000000001.", ["get_vehicles"]],
  ])("„%s”", async (text, reply, tools) => {
    const h = h0();
    const t = await h.say(text);
    expect(t.reply).toBe(reply);
    expect(names(t)).toEqual(tools);
  });

  it("„ce am plătit?” → istoricul plăților făcute prin asistent", async () => {
    const h = h0();
    expect((await h.say("Ce am plătit până acum?")).reply)
      .toBe("Nu ai făcut încă nicio plată prin mine. În listă apare ca plătită factura la internet, de 55 de lei.");

    await h.say("Plătește factura la curent.");
    await h.say("Da.");
    expect((await h.say("Ce am plătit?")).reply).toBe("Ai făcut o plată prin mine: Factură Lumina Energie, 187,40 lei.");

    await h.say("Plătește apa.");
    await h.say("Da.");
    expect((await h.say("Cât am cheltuit?")).reply).toBe("Ai făcut două plăți prin mine, în total 243,40 lei. Ultima: Factură Izvor Apă, 56 de lei.");
  });
});

describe("mai multe întrebări despre facturi", () => {
  it.each([
    ["Care e cea mai mare factură?", "Cea mai mare factură de plată e cea la curent: 187,40 lei, scadentă în 3 zile. Vrei s-o plătesc?"],
    ["Care e cea mai mică factură?", "Cea mai mică factură de plată e cea la apă: 56 de lei, scadentă în 12 zile. Vrei s-o plătesc?"],
    ["Ce factură expiră prima?", "Cea mai urgentă e factura la gaz: 94,20 lei, era scadentă pe 14.11.2026, deci e întârziată. Vrei s-o plătesc?"],
    ["Câte facturi am?", "Ai trei facturi de plată și una plătită."],
    ["Ce facturi am plătit?", "Ai o factură plătită: internet 55 de lei."],
    ["Cine e furnizorul la gaz?", "Factura la gaz e de la Flacăra Gaz."],
    ["Am factură la telefon?", "Nu am găsit nicio factură la telefon."],
    ["Am plătit gazul?", "Nu încă. Factura la gaz e de 94,20 lei, era scadentă pe 14.11.2026, deci e întârziată. Vrei s-o plătesc?"],
    ["Sunt la zi cu facturile?", "Nu chiar. Ai trei facturi de plată, în total 337,60 lei: curent 187,40 lei, gaz 94,20 lei și apă 56 de lei. Factura la gaz e întârziată."],
    ["Ce am de plătit până vineri?", "Până vineri ai două facturi de plată, în total 281,60 lei: curent 187,40 lei și gaz 94,20 lei. Factura la gaz e întârziată."],
    ["Ce am de plată azi?", "Azi ai o factură de plată: gaz 94,20 lei. Factura la gaz e întârziată."],
  ])("„%s”", async (text, reply) => {
    const h = h0();
    const t = await h.say(text);
    expect(t.reply).toBe(reply);
    expect(t.pending).toBeNull(); // o întrebare nu pregătește nicio plată
  });

  it("„cea mai mare factură” → „da” o pregătește exact pe aceea", async () => {
    const h = h0();
    await h.say("Care e cea mai mare factură?");
    const t = await h.say("Da.");
    expect(t.pending?.lines.map((l) => l.refId)).toEqual(["b-curent"]);
  });

  it("două facturi într-o întrebare → totalul lor; „da” le pregătește pe amândouă", async () => {
    const h = h0();
    const t1 = await h.say("Cât e curentul și gazul împreună?");
    expect(t1.reply).toContain("Împreună fac 281,60 lei. Vrei să le plătesc?");
    const t2 = await h.say("Da.");
    expect(t2.pending?.total).toBe(281.6);
  });

  it("„și la gaz?” după o întrebare rămâne întrebare (nu pregătește plata)", async () => {
    const h = h0();
    await h.say("Cât e factura la curent?");
    const t = await h.say("Și la gaz?");
    expect(names(t)).not.toContain("prepare_payment");
    expect(t.reply).toContain("Factura la gaz e de 94,20 lei");
  });

  it("fără facturi (varianta no-bills)", async () => {
    const h = h0();
    h.store.reset("no-bills");
    expect((await h.say("Sunt la zi cu facturile?")).reply).toBe("Da, ești la zi: nu ai nimic de plată.");
  });
});

describe("privire de ansamblu", () => {
  it("„ce expiră în curând?” → termenele, cele mai urgente primele", async () => {
    const h = h0();
    const t = await h.say("Ce expiră în curând?");
    expect(names(t)).toEqual(["get_expiring_items", "list_bills"]);
    expect(t.reply).toBe("În următoarele 30 de zile: factura la gaz e întârziată cu 2 zile, factura la curent e scadentă în 3 zile, RCA-ul expiră în 6 zile, factura la apă e scadentă în 12 zile și rovinieta expiră în 20 de zile.");
  });

  it("„care e situația mea?” → rezumat; „cu gazul” → pregătește gazul", async () => {
    const h = h0();
    const t1 = await h.say("Care e situația mea?");
    expect(t1.reply).toBe("Ai trei facturi de plată, în total 337,60 lei, dintre care una întârziată. RCA-ul expiră în 6 zile și rovinieta expiră în 20 de zile. Cu ce vrei să încep?");
    const t2 = await h.say("Cu gazul.");
    expect(t2.pending?.lines[0].refId).toBe("b-gaz");
  });

  it("„ce îmi recomanzi?” → cel mai urgent lucru, cu un singur pas următor", async () => {
    const h = h0();
    const t1 = await h.say("Ce îmi recomanzi?");
    expect(t1.reply).toBe("Cel mai urgent e gazul: factura de 94,20 lei e întârziată cu 2 zile. Vrei s-o plătesc?");
    expect(t1.pending).toBeNull();
    const t2 = await h.say("Da.");
    expect(t2.pending?.lines.map((l) => l.refId)).toEqual(["b-gaz"]);
  });

  it("RCA expirat → el e cel mai urgent (varianta rca-expired)", async () => {
    const h = h0();
    h.store.reset("rca-expired");
    expect((await h.say("Ce e mai urgent?")).reply).toBe("Cel mai urgent e RCA-ul: a expirat acum 3 zile. Vrei să-l reînnoiesc?");
    expect((await h.say("Pot circula cu mașina?")).reply).toContain("fără RCA nu ai voie să circuli");
  });

  it("totul în regulă (varianta all-good)", async () => {
    const h = h0();
    h.store.reset("all-good");
    expect((await h.say("Totul e în regulă?")).reply).toBe("Totul e în regulă: nu ai facturi de plată și nimic nu expiră în următoarele 30 de zile.");
    expect((await h.say("Pot circula cu mașina?")).reply).toBe("Da. RCA-ul e valabil încă 200 de zile, iar rovinieta încă 200 de zile.");
  });
});

describe("RCA: țări acoperite, recomandări, roaming", () => {
  it.each([
    ["RCA-ul meu e valabil în Bulgaria?", "Da, RCA-ul tău acoperă Bulgaria. E valabil până pe 22.11.2026, adică încă 6 zile."],
    ["Pot merge în Grecia cu RCA-ul meu?", "Da, RCA-ul tău acoperă Grecia. E valabil până pe 22.11.2026, adică încă 6 zile."],
    ["RCA-ul acoperă Turcia?", "Nu, RCA-ul tău nu acoperă Turcia. Vrei să-ți arăt ofertele de RCA?"],
    ["Am roaming?", "Nu ai niciun pachet de roaming sau cartelă activă. Vrei să-ți arăt ofertele de roaming?"],
    ["Am internet în Turcia?", "Nu ai niciun pachet de roaming sau cartelă activă pentru Turcia. Vrei să-ți arăt ofertele de roaming?"], // nu factura la internet
  ])("„%s”", async (text, reply) => {
    const h = h0();
    const t = await h.say(text);
    expect(t.reply).toBe(reply);
    expect(t.pending).toBeNull();
  });

  it("„care e diferența?” compară ofertele, fără să aleagă; apoi alegerea merge", async () => {
    const h = h0();
    await h.say("Vreau RCA.");
    const t1 = await h.say("Care e diferența?");
    expect(t1.reply).toBe("Dintre ofertele de RCA, cea mai ieftină este cea de 6 luni, 230 de lei. Cea de 12 luni costă 410 lei, dar iese mai ieftin pe zi. Cea cu Turcia, 450 de lei, îți trebuie doar dacă mergi cu mașina acolo. Care te interesează?");
    expect(t1.pending).toBeNull();
    const t2 = await h.say("Cea de 12 luni.");
    expect(t2.pending?.lines[0].refId).toBe("rca-12m");
  });

  it("o întrebare generală între oferte și alegere nu pierde firul", async () => {
    const h = h0();
    await h.say("Vreau RCA.");
    await h.say("Ce e cartea verde?");
    const t = await h.say("A doua.");
    expect(t.pending?.lines[0].refId).toBe("rca-12m");
  });

  it("alegere neclară → cere clarificare; alegerea următoare tot merge", async () => {
    const h = h0();
    await h.say("Vreau RCA.");
    expect((await h.say("blabla")).reply).toContain("Nu am înțeles care ofertă");
    expect((await h.say("6 luni")).pending?.lines[0].refId).toBe("rca-6m");
  });

  it("după ce ai cumpărat roaming, „am roaming?” îl vede", async () => {
    const h = h0();
    await h.say("Vreau roaming.");
    await h.say("7 zile");
    await h.say("Da.");
    expect((await h.say("Am roaming?")).reply).toBe("Ai un pachet de roaming pentru Turcia, până pe 23.11.2026, adică încă 7 zile.");
  });
});

describe("călătorii: alte formulări", () => {
  it("„ce îmi trebuie pentru Turcia?” pornește verificarea de călătorie", async () => {
    const h = h0();
    const t = await h.say("Ce îmi trebuie pentru Turcia?");
    expect(names(t)).toEqual(["run_trip_checklist"]);
    expect(t.reply).toBe("Pot să te ajut să te pregătești. Mașina o iei cu tine?");
  });

  it("„în ce țări mă poți ajuta?” → lista din reguli; „în Grecia” pornește verificarea", async () => {
    const h = h0();
    const t1 = await h.say("În ce țări mă poți ajuta?");
    expect(names(t1)).toEqual(["list_trip_countries"]);
    expect(t1.reply).toBe("Am reguli de călătorie pentru 21 de țări, de exemplu Turcia, Bulgaria, Grecia, Germania și Austria. Sunt orientative, de verificat din surse oficiale înainte de drum. Unde pleci?");
    const t2 = await h.say("În Grecia.");
    expect(t2.toolCalls[0].input).toMatchObject({ country: "grecia" });
  });

  it("„plec în vacanță” (fără țară) → întreabă unde", async () => {
    const h = h0();
    expect((await h.say("Plec în vacanță.")).reply).toContain("Unde pleci?");
  });

  it("„plec în concediu în Grecia pentru două săptămâni cu mașina” → țara, durata și mașina dintr-o frază", async () => {
    const h = h0();
    const t = await h.say("Plec în concediu în Grecia pentru două săptămâni cu mașina.");
    expect(t.toolCalls[0].input).toMatchObject({ country: "grecia", days: 14, withCar: true });
  });

  it("„peste două săptămâni” → data plecării", async () => {
    const h = h0();
    const t = await h.say("Plec în Turcia peste două săptămâni cu avionul.");
    expect(t.toolCalls[0].input).toMatchObject({ country: "turcia", startInDays: 14, withCar: false });
  });
});

describe("factură + produs în aceeași frază", () => {
  it("întâi factura (cu confirmarea ei), apoi ofertele pentru produs", async () => {
    const h = h0();
    const t1 = await h.say("Plătește gazul și cumpără rovinietă.");
    expect(t1.reply).toBe("Factura la gaz este de 94,20 lei și e întârziată. De rovinietă ne ocupăm imediat după. O plătesc acum?");
    expect(t1.pending?.lines.map((l) => l.refId)).toEqual(["b-gaz"]); // doar factura, nu și rovinieta

    const t2 = await h.say("Da.");
    expect(t2.reply).toBe("Gata, am plătit 94,20 lei pentru gaz. Am trei oferte de rovinietă: 7 zile 16 lei, 30 de zile 36 de lei și 12 luni 140 de lei. Care te interesează?");
    expect(t2.pending).toBeNull();
  });
});

describe("siguranță: cât timp o plată așteaptă confirmarea", () => {
  it("o întrebare generală nu schimbă plata; aplicația amintește de ea; „da” o confirmă", async () => {
    const h = h0();
    await h.say("Plătește factura la curent.");
    const t1 = await h.say("E sigur?");
    expect(t1.outcome).toBe("pass");
    expect(t1.reply).toMatch(/^Da, e sigur\..* Plata de 187,40 lei încă așteaptă: spune „da” ca s-o fac sau „nu” ca s-o anulez\.$/);
    expect(t1.pending?.total).toBe(187.4);
    expect(h.store.listPayments()).toHaveLength(0);

    const t2 = await h.say("Da.");
    expect(t2.outcome).toBe("confirmed");
    expect(h.bill("b-curent").status).toBe("paid");
  });

  it("asistentul NU pune altă întrebare: un „da” ar confirma plata, nu întrebarea", async () => {
    const h = h0();
    await h.say("Plătește factura la curent.");
    // Fără plată în așteptare, aceste răspunsuri se termină cu „Vrei să…?”.
    for (const question of ["Ce e RCA?", "Cât e factura la apă?", "Până când am RCA?", "Vreau rovinietă."]) {
      const t = await h.say(question);
      expect(t.reply).not.toMatch(/\?/);
      expect(t.reply).toContain("Plata de 187,40 lei încă așteaptă");
      expect(t.pending?.lines.map((l) => l.refId)).toEqual(["b-curent"]); // aceeași plată, neschimbată
    }
    expect(h.store.listPayments()).toHaveLength(0);
  });

  it("„ce plătesc?” / „cât era suma?” → spune din nou ce e pregătit (din date, fără token)", async () => {
    const h = h0();
    const t1 = await h.say("Plătește factura la curent.");
    const t2 = await h.say("Cât era suma?");
    expect(names(t2)).toEqual(["get_pending_payment"]);
    expect(t2.reply).toBe("Am pregătit: Factură Lumina Energie, 187,40 lei. Spune „da” ca s-o fac sau „nu” ca s-o anulez.");
    expect(h.everythingTheModelSaw()).not.toContain(t1.pending!.token);
    expect(h.store.listPayments()).toHaveLength(0);
  });

  it("„stai puțin” nu plătește și nu anulează", async () => {
    const h = h0();
    await h.say("Plătește factura la curent.");
    const t = await h.say("Stai puțin.");
    expect(t.reply).toBe("Sigur, nu e nicio grabă. Plata de 187,40 lei încă așteaptă: spune „da” ca s-o fac sau „nu” ca s-o anulez.");
    expect(t.pending?.total).toBe(187.4);
  });

  it.each(["Renunț la plată.", "M-am răzgândit.", "Nu mai vreau."])("„%s” anulează plata pregătită", async (text) => {
    const h = h0();
    await h.say("Plătește factura la curent.");
    const t = await h.say(text);
    expect(t.reply).toBe("Bine, am anulat plata. Nu am plătit nimic.");
    expect(t.pending).toBeNull();
    expect(h.store.listPayments()).toHaveLength(0);
  });

  it("„anulează plata” fără nimic pregătit", async () => {
    const h = h0();
    expect((await h.say("Anulează plata.")).reply).toBe("Nu ai nicio plată în așteptare, deci nu am plătit nimic.");
  });

  it("peste 500 de lei: amintește de butonul de pe ecran, nu de „da”", async () => {
    const h = h0();
    h.store.addBill({ category: "phone", provider: "Telefonia Demo", amount: 620, dueDate: "2026-11-21" });
    await h.say("Plătește factura la telefon.");
    const t = await h.say("E sigur?");
    expect(t.reply).toContain("Plata de 620 de lei încă așteaptă confirmarea cu butonul de pe ecran.");
  });
});

describe("butoanele Confirmă / Anulează de pe ecran", () => {
  it("după Confirmă, asistentul continuă călătoria cu următorul lucru (ca după un „da” rostit)", async () => {
    const h = h0();
    await h.say("Plec în Turcia săptămâna viitoare.");
    await h.say("Da.");
    const t = await h.say("Da."); // RCA pregătit, 450 de lei
    const payment = h.confirmation.confirm("test", t.pending!.token, "button");
    const next = await h.agent.afterButton("test", { kind: "confirmed", payment });
    expect(next.reply).toBe("Gata. Urmează vinieta pentru Bulgaria: 7 zile costă 75 de lei. O cumpăr?");
    expect(next.pending?.lines.map((l) => l.refId)).toEqual(["vinieta-bg-7z"]);
    expect(h.everythingTheModelSaw()).not.toContain(t.pending!.token);
  });

  it("după Anulează, un „da” ulterior nu plătește nimic", async () => {
    const h = h0();
    const t = await h.say("Plătește factura la curent.");
    h.confirmation.cancel("test", t.pending!.token);
    expect((await h.agent.afterButton("test", { kind: "cancelled" })).reply).toBe("Bine, nu am plătit nimic.");
    const after = await h.say("Da.");
    expect(after.outcome).toBe("pass");
    expect(h.store.listPayments()).toHaveLength(0);
  });
});
