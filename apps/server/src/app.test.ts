import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { PagoStore } from "./mock/store.ts";

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

    const again = await post("/api/payments/confirm", { sessionId: "s1", token });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("TOKEN_USED");
  });

  it("flux HTTP: cancel, token greșit, cerere incompletă", async () => {
    const { app } = setup();
    const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url, payload });

    const { token } = (await post("/api/payments/prepare", { sessionId: "s1", items: [{ kind: "bill", billId: "b-apa" }] })).json();
    expect((await post("/api/payments/confirm", { sessionId: "s1", token: "gresit" })).statusCode).toBe(404);
    expect((await post("/api/payments/cancel", { sessionId: "s1", token })).json().cancelled).toBe(true);
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

  it("POST /api/dev/reset schimbă varianta", async () => {
    const { app, get } = setup();
    const res = await app.inject({ method: "POST", url: "/api/dev/reset", payload: { variant: "no-bills" } });
    expect(res.statusCode).toBe(200);
    expect((await get("/api/bills")).body).toEqual([]);

    const bad = await app.inject({ method: "POST", url: "/api/dev/reset", payload: { variant: "bla" } });
    expect(bad.statusCode).toBe(400);
  });
});
