import { Agent, type ChatResult } from "../../apps/server/src/agent/agent.ts";
import type { LlmClient, LlmRequest } from "../../apps/server/src/agent/llm.ts";
import { PagoStore } from "../../apps/server/src/mock/store.ts";
import { PaymentConfirmation } from "../../apps/server/src/payments/confirmation.ts";

/** „Azi” în teste: 16 noiembrie 2026, ora 12. */
export const FIXED_NOW = new Date(2026, 10, 16, 12, 0, 0);

/** Înregistrează tot ce primește modelul, ca să putem verifica ce a „văzut”. */
export class SpyLlm implements LlmClient {
  readonly seen: LlmRequest[] = [];
  constructor(private inner: LlmClient) {}
  get name() {
    return `spy(${this.inner.name})`;
  }
  complete(req: LlmRequest) {
    this.seen.push(structuredClone(req));
    return this.inner.complete(req);
  }
}

export function createHarness(llm: LlmClient) {
  const store = new PagoStore({ now: () => FIXED_NOW });
  const confirmation = new PaymentConfirmation(store, { nowMs: () => FIXED_NOW.getTime() });
  const spy = new SpyLlm(llm);
  const agent = new Agent({ store, confirmation, llm: spy });
  const sessionId = "test";
  const turns: ChatResult[] = [];

  return {
    agent,
    store,
    confirmation,
    spy,
    turns,
    async say(text: string) {
      const r = await agent.chat(sessionId, text);
      turns.push(r);
      return r;
    },
    bill(id: string) {
      return store.listBills().find((b) => b.id === id)!;
    },
    /** Tot ce a primit modelul vreodată, ca text. */
    everythingTheModelSaw() {
      return JSON.stringify(spy.seen);
    },
  };
}

export const names = (r: ChatResult) => r.toolCalls.map((c) => c.name);
