import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { PagoStore } from "./mock/store.ts";
import { ScriptedLlm } from "./agent/scripted.ts";

const fixedNow = () => new Date(2026, 10, 16, 12, 0, 0);

function setup() {
  const store = new PagoStore({ now: fixedNow });
  const app = buildApp({ store });
  const get = async (url: string) => {
    const res = await app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.json() };
  };
  return { app, store, get };
}

describe("API Pago simulat", () => {
  it("GET /api/health", async () => {
    const { get } = setup();
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("GET /api/me → Maria", async () => {
    const { body } = await setup().get("/api/me");
    expect(body.name).toBe("Maria Ionescu");
  });

  it("GET /api/bills (toate și filtrate)", async () => {
    const { get } = setup();
    expect((await get("/api/bills")).body).toHaveLength(4);

    const unpaid = (await get("/api/bills?status=unpaid")).body;
    expect(unpaid.map((b: { category: string }) => b.category).sort()).toEqual(["electricity", "water"]);

    const overdue = (await get("/api/bills?status=overdue")).body;
    expect(overdue).toMatchObject([{ category: "gas", amount: 94.2 }]);
  });

  it("GET /api/bills cu status greșit → 400", async () => {
    expect((await setup().get("/api/bills?status=bla")).status).toBe(400);
  });

  it("GET /api/vehicles", async () => {
    const { body } = await setup().get("/api/vehicles");
    expect(body).toMatchObject([{ id: "v1", plate: "B-123-ABC", make: "Dacia", model: "Logan" }]);
  });

  it("GET /api/policies", async () => {
    const { body } = await setup().get("/api/policies?vehicleId=v1");
    expect(body).toMatchObject([{ type: "RCA", validUntil: "2026-11-22" }]);
  });

  it("GET /api/vignettes", async () => {
    const { body } = await setup().get("/api/vignettes?vehicleId=v1");
    expect(body).toMatchObject([{ country: "RO", validUntil: "2026-12-06" }]);
  });

  it("GET /api/products (toate și pe tip)", async () => {
    const { get } = setup();
    expect((await get("/api/products")).body.length).toBeGreaterThan(5);

    const rca = (await get("/api/products?type=rca")).body;
    expect(rca.map((p: { price: number }) => p.price)).toEqual([230, 410, 450]);

    expect((await get("/api/products?type=bla")).status).toBe(400);
  });

  it("GET /api/payments: gol la început, apoi arată plata făcută intern", async () => {
    const { get, store } = setup();
    expect((await get("/api/payments")).body).toEqual([]);

    store.executePayment([{ kind: "bill", billId: "b-curent" }]);
    expect((await get("/api/payments")).body).toMatchObject([{ total: 187.4 }]);
    expect((await get("/api/bills?status=unpaid")).body).toHaveLength(1);
  });

  it("nu există nicio rută care plătește direct (vine la Pasul 2, cu confirmare)", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/api/payments", payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("flux HTTP: prepare → pending → confirm (cu buton)", async () => {
    const { app, get } = setup();
    const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url, payload });

    const prep = await post("/api/payments/prepare", { sessionId: "s1", items: [{ kind: "bill", billId: "b-curent" }] });
    expect(prep.statusCode).toBe(200);
    const { token, total } = prep.json();
    expect(total).toBe(187.4);

    expect((await get("/api/payments/pending?sessionId=s1")).body.pending.token).toBe(token);

    const ok = await post("/api/payments/confirm", { sessionId: "s1", token });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().payment.total).toBe(187.4);
    // După buton, asistentul spune ce urmează — la fel ca după un „da” rostit.
    expect(ok.json().reply).toBe("Gata, am plătit 187,40 lei pentru curent. Mai ai de plată gazul și apa.");
    expect(ok.json().pending).toBeNull();

    const again = await post("/api/payments/confirm", { sessionId: "s1", token });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("TOKEN_USED");
  });

  it("flux HTTP: cancel, token greșit, cerere incompletă", async () => {
    const { app } = setup();
    const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url, payload });

    const { token } = (await post("/api/payments/prepare", { sessionId: "s1", items: [{ kind: "bill", billId: "b-apa" }] })).json();
    expect((await post("/api/payments/confirm", { sessionId: "s1", token: "gresit" })).statusCode).toBe(404);
    expect((await post("/api/payments/cancel", { sessionId: "s1", token })).json()).toEqual({ cancelled: true, reply: "Bine, nu am plătit nimic." });
    expect((await post("/api/payments/confirm", { sessionId: "s1", token })).statusCode).toBe(409);
    expect((await post("/api/payments/confirm", { sessionId: "s1" })).statusCode).toBe(400);

    const paid = await post("/api/payments/prepare", { sessionId: "s1", items: [{ kind: "bill", billId: "b-internet" }] });
    expect(paid.statusCode).toBe(409);
    expect(paid.json().error).toBe("BILL_ALREADY_PAID");

    const empty = await post("/api/payments/prepare", { sessionId: "s1", items: [] });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("EMPTY_PAYMENT");
  });

  it("POST /api/bills adaugă, DELETE /api/bills/:id șterge", async () => {
    const { app, get } = setup();
    const add = await app.inject({
      method: "POST", url: "/api/bills",
      payload: { category: "phone", provider: "Telefonia Demo", amount: 42.5, dueDate: "2026-11-20" },
    });
    expect(add.statusCode).toBe(201);
    const { id } = add.json();
    expect((await get("/api/bills")).body).toHaveLength(5);

    const bad = await app.inject({ method: "POST", url: "/api/bills", payload: { category: "phone", provider: "X", amount: -1, dueDate: "2026-11-20" } });
    expect(bad.statusCode).toBe(400);

    expect((await app.inject({ method: "DELETE", url: `/api/bills/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/bills/${id}` })).statusCode).toBe(404);
    expect((await get("/api/bills")).body).toHaveLength(4);
  });

  it("Mașina mea: GET /api/car, modificare mașină, adăugare și ștergere acte", async () => {
    const { app, get } = setup();
    const car = (await get("/api/car")).body;
    expect(car.vehicle).toMatchObject({ plate: "B-123-ABC", make: "Dacia" });
    expect(car.policies).toHaveLength(1);
    expect(car.vignettes).toHaveLength(1);

    const upd = await app.inject({ method: "PUT", url: "/api/vehicles/v1", payload: { plate: "cj-99-xyz", make: "Skoda", model: "Octavia" } });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().plate).toBe("CJ-99-XYZ");
    expect((await app.inject({ method: "PUT", url: "/api/vehicles/v1", payload: { plate: "", make: "X", model: "Y" } })).statusCode).toBe(400);

    const rca = await app.inject({ method: "POST", url: "/api/documents", payload: { kind: "rca", validUntil: "2027-11-16", coversTurkey: true } });
    expect(rca.statusCode).toBe(201);
    expect(rca.json().countries).toContain("TR");

    const vg = await app.inject({ method: "POST", url: "/api/documents", payload: { kind: "vignette", country: "BG", validUntil: "2026-12-01" } });
    const roaming = await app.inject({ method: "POST", url: "/api/documents", payload: { kind: "roaming", country: "tr", validUntil: "2026-12-01" } });
    expect(roaming.json().country).toBe("TR");

    const after = (await get("/api/car")).body;
    expect(after.policies).toHaveLength(2);
    expect(after.vignettes.map((v: { country: string }) => v.country)).toEqual(["RO", "BG"]);
    expect(after.services).toHaveLength(1);

    expect((await app.inject({ method: "DELETE", url: `/api/documents/${vg.json().id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/documents/${vg.json().id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/documents", payload: { kind: "rca", validUntil: "mâine" } })).statusCode).toBe(400);
  });

  it("POST /api/dev/reset schimbă varianta", async () => {
    const { app, get } = setup();
    const res = await app.inject({ method: "POST", url: "/api/dev/reset", payload: { variant: "no-bills" } });
    expect(res.statusCode).toBe(200);
    expect((await get("/api/bills")).body).toEqual([]);

    const bad = await app.inject({ method: "POST", url: "/api/dev/reset", payload: { variant: "bla" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("aplicația Android: CORS și carduri", () => {
  it("CORS doar pentru originile aplicației (localhost / capacitor)", async () => {
    const app = buildApp({ llm: new ScriptedLlm() });
    const ok = await app.inject({ method: "OPTIONS", url: "/api/chat", headers: { origin: "http://localhost", "access-control-request-method": "POST" } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost");

    const evil = await app.inject({ method: "GET", url: "/api/bills", headers: { origin: "https://rau.example.com" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("/api/chat întoarce cardurile din rezultatele tool-urilor", async () => {
    const app = buildApp({ llm: new ScriptedLlm() });
    const r1 = await app.inject({ method: "POST", url: "/api/chat", payload: { sessionId: "c1", message: "Plec în Turcia săptămâna viitoare." } });
    const r2 = await app.inject({ method: "POST", url: "/api/chat", payload: { sessionId: "c1", message: "Da." } });
    const trip = r2.json().cards.find((c: { type: string }) => c.type === "trip");
    expect(r1.json().cards.some((c: { type: string }) => c.type === "trip")).toBe(false); // încă nu știm dacă ia mașina
    expect(trip.checklist.country).toBe("TR");
    expect(trip.checklist.missingCount).toBeGreaterThan(0);
  });
});

describe("plăți directe din ecrane, asigurare de călătorie, ITP", () => {
  it("asigurarea de călătorie: suma = preț × persoane (−10% de la 4), calculată pe server", async () => {
    const app = buildApp({ llm: new ScriptedLlm() });
    const r3 = await app.inject({ method: "POST", url: "/api/payments/prepare", payload: { sessionId: "ui-1", items: [{ kind: "product", productId: "travel-standard-7z", persons: 3 }] } });
    expect(r3.json().total).toBe(135);
    expect(r3.json().lines[0].label).toContain("3 persoane");
    const r4 = await app.inject({ method: "POST", url: "/api/payments/prepare", payload: { sessionId: "ui-2", items: [{ kind: "product", productId: "travel-standard-7z", persons: 4 }] } });
    expect(r4.json().total).toBe(162);
    const bad = await app.inject({ method: "POST", url: "/api/payments/prepare", payload: { sessionId: "ui-3", items: [{ kind: "product", productId: "travel-basic-7z", persons: 12 }] } });
    expect(bad.statusCode).toBe(400);
  });

  it("plata cu `quiet` nu mai întreabă asistentul, iar asigurarea apare la acte", async () => {
    let llmCalls = 0;
    const llm = { name: "numar", complete: (req: Parameters<ScriptedLlm["complete"]>[0]) => { llmCalls++; return new ScriptedLlm().complete(req); } };
    const app = buildApp({ llm });
    const prep = await app.inject({ method: "POST", url: "/api/payments/prepare", payload: { sessionId: "ui-q", items: [{ kind: "product", productId: "travel-basic-7z", persons: 2 }] } });
    const conf = await app.inject({ method: "POST", url: "/api/payments/confirm", payload: { sessionId: "ui-q", token: prep.json().token, quiet: true } });
    expect(conf.statusCode).toBe(200);
    expect(conf.json().payment.total).toBe(58);
    expect(llmCalls).toBe(0);
    const car = (await app.inject({ method: "GET", url: "/api/car" })).json();
    expect(car.services.some((s: { type: string; persons?: number }) => s.type === "insurance" && s.persons === 2)).toBe(true);
  });

  it("ITP: apare la mașină, se actualizează (înlocuiește vechiul) și se poate șterge", async () => {
    const app = buildApp({ llm: new ScriptedLlm() });
    const before = (await app.inject({ method: "GET", url: "/api/car" })).json();
    expect(before.inspections).toHaveLength(1);
    const add = await app.inject({ method: "POST", url: "/api/documents", payload: { kind: "itp", validUntil: "2028-11-17" } });
    expect(add.statusCode).toBe(201);
    const after = (await app.inject({ method: "GET", url: "/api/car" })).json();
    expect(after.inspections).toHaveLength(1);
    expect(after.inspections[0].validUntil).toBe("2028-11-17");
    const del = await app.inject({ method: "DELETE", url: `/api/documents/${after.inspections[0].id}` });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/car" })).json().inspections).toHaveLength(0);
  });

  it("călătorie: cardul cu pachete (asigurare pe 7 zile + rovinietă și vinietă BG cu mașina)", async () => {
    const app = buildApp({ llm: new ScriptedLlm() });
    await app.inject({ method: "POST", url: "/api/chat", payload: { sessionId: "t1", message: "Plec în Turcia săptămâna viitoare." } });
    const r = await app.inject({ method: "POST", url: "/api/chat", payload: { sessionId: "t1", message: "Da." } });
    const offers = r.json().cards.find((c: { type: string }) => c.type === "trip_offers");
    expect(offers.insurance.map((p: { tier: string }) => p.tier)).toEqual(["Basic", "Standard", "Premium"]);
    expect(offers.vignettes.map((p: { country: string }) => p.country).sort()).toEqual(expect.arrayContaining(["RO", "BG"]));
  });
});

describe("cardul cu pachete apare și pentru țări din afara regulilor", () => {
  it("Japonia → card cu asigurarea de călătorie (fără viniete, nu știm dacă ia mașina)", async () => {
    const app = buildApp({ llm: new ScriptedLlm() });
    const r = await app.inject({ method: "POST", url: "/api/chat", payload: { sessionId: "jp", message: "Plec în Japonia." } });
    const offers = r.json().cards.find((c: { type: string }) => c.type === "trip_offers");
    expect(offers.countryName).toMatch(/^Japonia$/i);
    expect(offers.insurance).toHaveLength(3);
    expect(offers.vignettes).toHaveLength(0);
  });
});

describe("Setări: schimbarea numelui", () => {
  it("salvează numele, îl folosește în salut și respinge un nume invalid", async () => {
    const app = buildApp({ llm: new ScriptedLlm() });
    const ok = await app.inject({ method: "PUT", url: "/api/me", payload: { name: "  Ana-Maria   Popescu " } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe("Ana-Maria Popescu");
    expect((await app.inject({ method: "GET", url: "/api/me" })).json().name).toBe("Ana-Maria Popescu");
    const hello = await app.inject({ method: "GET", url: "/api/proactive?sessionId=n1" });
    expect(hello.json().message).toMatch(/^Bună, Ana-Maria!/);
    for (const bad of ["", "A", "<script>", "x".repeat(41)]) {
      expect((await app.inject({ method: "PUT", url: "/api/me", payload: { name: bad } })).statusCode).toBe(400);
    }
  });
});
