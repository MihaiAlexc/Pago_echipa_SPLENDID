import type Anthropic from "@anthropic-ai/sdk";
import type { PendingPaymentForClient } from "@pago/shared";
import type { PagoStore } from "../mock/store.ts";
import type { PaymentConfirmation, TurnOutcome } from "../payments/confirmation.ts";
import { EVENT_TAG, type LlmClient } from "./llm.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { CATEGORY_RO, TOOL_DEFINITIONS, executeTool, type ToolResult } from "./tools.ts";
import { getExpiringItems } from "../scenarios/trips.ts";
import { spokenLei } from "./scripted.ts";

/** Blocul prin care aplicația îi spune modelului ce s-a decis deja în cod. */
function eventBlock(outcome: TurnOutcome): Anthropic.Beta.BetaTextBlockParam {
  return { type: "text", text: `<${EVENT_TAG}>${JSON.stringify(outcome)}</${EVENT_TAG}>` };
}

/** „ Plata de 187,40 lei încă așteaptă: spune „da” ca s-o fac sau „nu” ca s-o anulez.” */
export function pendingReminder(pending: PendingPaymentForClient): string {
  return pending.requiresScreenConfirm
    ? ` Plata de ${spokenLei(pending.total)} încă așteaptă confirmarea cu butonul de pe ecran.`
    : ` Plata de ${spokenLei(pending.total)} încă așteaptă: spune „da” ca s-o fac sau „nu” ca s-o anulez.`;
}

/** Câte runde model → tool-uri permitem într-o singură tură (protecție împotriva buclelor). */
const MAX_STEPS = 8;

export interface ToolCallRecord {
  name: string;
  input: unknown;
  result: ToolResult;
}

export interface ChatResult {
  reply: string;
  /** Ce a decis backend-ul înainte de LLM (confirmat / anulat / ...), sau "pass". */
  outcome: TurnOutcome["kind"];
  /** Tool-urile apelate de model în tura asta, în ordine (folosite de teste). */
  toolCalls: ToolCallRecord[];
  /** Plata care așteaptă confirmare, cu token — pentru cardul Confirmă / Anulează din frontend. */
  pending: PendingPaymentForClient | null;
  error?: string;
}

/**
 * Bucla agentului: mesaj → (confirmare în cod) → LLM → tool-uri → LLM → ... → răspuns.
 */
export class Agent {
  private sessions = new Map<string, Anthropic.Beta.BetaMessageParam[]>();

  constructor(
    private deps: { store: PagoStore; confirmation: PaymentConfirmation; llm: LlmClient },
  ) {}

  get llmName() {
    return this.deps.llm.name;
  }

  clearSessions() {
    this.sessions.clear();
    this.greeted.clear();
  }

  private greeted = new Set<string>();

  /**
   * D4 — mesaj proactiv la deschiderea aplicației, O SINGURĂ DATĂ pe sesiune.
   * Decis de reguli (ce expiră), nu de LLM. Intră în istoric, ca un „da” ulterior să aibă context.
   */
  proactiveGreeting(sessionId: string): string | null {
    if (this.greeted.has(sessionId)) return null;
    this.greeted.add(sessionId);

    const { store } = this.deps;
    const name = store.getUser().name.split(" ")[0];
    const items = getExpiringItems(store, 30);
    const zile = (n: number) => (n === 1 ? "zi" : n >= 20 ? "de zile" : "zile");

    let text: string | null = null;
    const rca = items.find((i) => i.kind === "rca" && i.daysLeft <= 14);
    const vignette = items.find((i) => i.kind === "vignette" && i.daysLeft <= 7);
    const overdue = items.find((i) => i.kind === "bill" && i.daysLeft < 0);
    if (rca) {
      text = rca.daysLeft < 0 ? `Bună, ${name}! RCA-ul tău a expirat acum ${-rca.daysLeft} ${zile(-rca.daysLeft)}. Vrei să-l reînnoiesc?`
        : rca.daysLeft === 0 ? `Bună, ${name}! RCA-ul tău expiră azi. Vrei să-l reînnoiesc?`
        : `Bună, ${name}! RCA-ul tău expiră în ${rca.daysLeft} ${zile(rca.daysLeft)}. Vrei să-l reînnoiesc?`;
    } else if (vignette) {
      text = vignette.daysLeft < 0 ? `Bună, ${name}! Rovinieta ta a expirat. Vrei să-ți arăt ofertele?`
        : `Bună, ${name}! Rovinieta ta expiră în ${vignette.daysLeft} ${zile(vignette.daysLeft)}. Vrei să-ți arăt ofertele?`;
    } else if (overdue) {
      const bill = store.listBills().find((b) => b.id === overdue.refId)!;
      text = `Bună, ${name}! Ai o factură întârziată la ${CATEGORY_RO[bill.category]}. Vrei s-o plătesc?`;
    }
    if (!text) return null;

    const history = this.sessions.get(sessionId) ?? [];
    history.push({ role: "user", content: [{ type: "text", text: `<${EVENT_TAG}>${JSON.stringify({ kind: "app_opened" })}</${EVENT_TAG}>` }] });
    history.push({ role: "assistant", content: [{ type: "text", text }] });
    this.sessions.set(sessionId, history);
    return text;
  }

  async chat(sessionId: string, text: string): Promise<ChatResult> {
    // 1) ÎNAINTE de LLM: un „da”/„nu” clar la o plată în așteptare se decide în cod.
    const outcome = this.deps.confirmation.handleUserMessage(sessionId, text);
    const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text }];
    if (outcome.kind !== "pass") content.push(eventBlock(outcome));
    return this.run(sessionId, content, outcome);
  }

  /**
   * Butonul Confirmă / Anulează de pe ecran. Plata a fost deja decisă în cod (payments/confirmation.ts);
   * aici modelul doar află ce s-a întâmplat și spune ce urmează — la fel ca după un „da” / „nu” rostit
   * (ce a mai rămas de plată, următorul pas din pregătirea unei călătorii).
   */
  async afterButton(sessionId: string, outcome: Extract<TurnOutcome, { kind: "confirmed" | "cancelled" }>): Promise<ChatResult> {
    return this.run(sessionId, [eventBlock(outcome)], outcome);
  }

  private async run(sessionId: string, content: Anthropic.Beta.BetaContentBlockParam[], outcome: TurnOutcome): Promise<ChatResult> {
    const { store, confirmation, llm } = this.deps;
    const history = this.sessions.get(sessionId) ?? [];
    const rollbackTo = history.length;
    const toolCalls: ToolCallRecord[] = [];
    history.push({ role: "user", content });

    // 2) Bucla cu modelul.
    try {
      let reply = "";
      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await llm.complete({ system: SYSTEM_PROMPT, messages: history, tools: TOOL_DEFINITIONS });
        history.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });

        if (res.stop_reason === "pause_turn") continue;

        if (res.stop_reason === "tool_use") {
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const block of res.content) {
            if (block.type !== "tool_use") continue;
            const result = executeTool({ store, confirmation, sessionId }, block.name, block.input);
            toolCalls.push({ name: block.name, input: block.input, result });
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
              is_error: !result.ok,
            });
          }
          history.push({ role: "user", content: results }); // toate rezultatele într-un singur mesaj
          continue;
        }

        if (res.stop_reason === "refusal") {
          reply = "Nu te pot ajuta cu asta. Te pot ajuta cu facturile, RCA-ul sau rovinieta.";
        } else {
          reply = res.content
            .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
            .map((b) => b.text)
            .join(" ")
            .trim();
        }
        break;
      }

      if (!reply) reply = "Scuze, m-am încurcat. Poți să repeți, te rog?";
      this.sessions.set(sessionId, history);

      // 3) SIGURANȚĂ, în cod: dacă o plată pregătită mai devreme încă așteaptă și modelul a vorbit despre
      //    altceva, îi amintim utilizatorului de ea. Altfel un „da” spus la altă întrebare ar confirma plata.
      const pending = confirmation.getPendingForClient(sessionId);
      const talkedAboutIt = toolCalls.some((c) => c.name === "prepare_payment" || c.name === "get_pending_payment");
      if (pending && !talkedAboutIt && outcome.kind !== "needs_screen") reply += pendingReminder(pending);

      return { reply, outcome: outcome.kind, toolCalls, pending };
    } catch (e) {
      // Eroare de rețea / LLM: istoricul revine la starea de dinainte (fără tool_use fără rezultat).
      history.length = rollbackTo;
      this.sessions.set(sessionId, history);
      console.error("Eroare LLM:", e);
      const reply = outcome.kind === "confirmed"
        ? "Plata a fost făcută, dar am o problemă tehnică acum. Te rog să mai încerci peste puțin."
        : "Am o problemă tehnică acum. Nu am plătit nimic. Te rog să mai încerci peste puțin.";
      return {
        reply, outcome: outcome.kind, toolCalls,
        pending: confirmation.getPendingForClient(sessionId),
        error: (e as Error).message,
      };
    }
  }
}
