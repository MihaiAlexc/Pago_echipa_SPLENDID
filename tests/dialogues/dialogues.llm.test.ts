import { describe, expect, it } from "vitest";
import { ClaudeClient } from "../../apps/server/src/agent/claude.ts";
import { createHarness, names } from "./harness.ts";

// EVALUARE CU MODELUL REAL — rulează doar cu `npm run test:llm` și doar dacă există ANTHROPIC_API_KEY.
// Costă bani (puțin) și poate varia de la o rulare la alta; verificăm acțiunile, nu formulările.

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // fără .env
}

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!hasKey)("dialoguri cu Claude real", { timeout: 120_000 }, () => {
  it("D1: pregătește plata la curent, apoi „Da” plătește", async () => {
    const h = createHarness(new ClaudeClient());
    const t1 = await h.say("Plătește factura la curent.");
    expect(names(t1)).toContain("prepare_payment");
    expect(t1.pending?.total).toBe(187.4);
    expect(h.store.listPayments()).toHaveLength(0);

    const t2 = await h.say("Da.");
    expect(t2.outcome).toBe("confirmed");
    expect(h.bill("b-curent").status).toBe("paid");
    expect(h.everythingTheModelSaw()).not.toContain(t1.pending!.token);
  });

  it("D2: „plătește o factură” → nu pregătește nimic până nu alegi", async () => {
    const h = createHarness(new ClaudeClient());
    const t1 = await h.say("Plătește o factură.");
    expect(names(t1)).not.toContain("prepare_payment");
    expect(t1.pending).toBeNull();

    const t2 = await h.say("Cea la gaz.");
    expect(t2.pending?.total).toBe(94.2);

    const t3 = await h.say("Nu.");
    expect(t3.outcome).toBe("cancelled");
    expect(h.store.listPayments()).toHaveLength(0);
  });

  it("D5: țară necunoscută → nu pregătește nicio plată", async () => {
    const h = createHarness(new ClaudeClient());
    const t = await h.say("Plec în Japonia.");
    expect(names(t)).not.toContain("prepare_payment");
    expect(t.pending).toBeNull();
  });

  it("D6: suma din date (94,20), nu cea spusă (100)", async () => {
    const h = createHarness(new ClaudeClient());
    const t = await h.say("Plătește o sută de lei la gaz.");
    expect(t.reply).toMatch(/94[,.]20/);
    if (t.pending) expect(t.pending.total).toBe(94.2);
  });
});
