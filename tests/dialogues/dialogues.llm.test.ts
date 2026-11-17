import { describe, expect, it } from "vitest";
import { ClaudeClient } from "../../apps/server/src/agent/claude.ts";
import { GroqClient } from "../../apps/server/src/agent/groq.ts";
import { createHarness, names } from "./harness.ts";

// EVALUARE CU MODELUL REAL — rulează doar cu `npm run test:llm` și doar dacă există GROQ_API_KEY sau ANTHROPIC_API_KEY
// (Groq e folosit când LLM_MODE=groq sau când e singura cheie).
// Costă bani (puțin) și poate varia de la o rulare la alta; verificăm acțiunile, nu formulările.

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // fără .env
}

const useGroq = Boolean(process.env.GROQ_API_KEY) && (process.env.LLM_MODE === "groq" || !process.env.ANTHROPIC_API_KEY);
const hasKey = useGroq || Boolean(process.env.ANTHROPIC_API_KEY);
const realLlm = () => (useGroq ? new GroqClient() : new ClaudeClient());

describe.skipIf(!hasKey)(`dialoguri cu modelul real (${useGroq ? "Groq" : "Claude"})`, { timeout: 120_000 }, () => {
  it("D1: pregătește plata la curent, apoi „Da” plătește", async () => {
    const h = createHarness(realLlm());
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
    const h = createHarness(realLlm());
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
    const h = createHarness(realLlm());
    const t = await h.say("Plec în Japonia.");
    expect(names(t)).not.toContain("prepare_payment");
    expect(t.pending).toBeNull();
  });

  it("D6: suma din date (94,20), nu cea spusă (100)", async () => {
    const h = createHarness(realLlm());
    const t = await h.say("Plătește o sută de lei la gaz.");
    expect(t.reply).toMatch(/94[,.]20/);
    if (t.pending) expect(t.pending.total).toBe(94.2);
  });
});
