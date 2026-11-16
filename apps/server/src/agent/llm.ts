import type Anthropic from "@anthropic-ai/sdk";

/**
 * Ce îi trimitem modelului și ce primim înapoi.
 * Folosim formatul Anthropic peste tot; modelul simulat răspunde în același format,
 * ca agentul să nu știe (și să nu-i pese) dacă vorbește cu Claude sau cu simularea.
 */
export interface LlmRequest {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
}

export type LlmResponse = Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason">;

/**
 * Eticheta cu care backend-ul îi spune modelului ce s-a decis ÎN COD înainte de el
 * (ex. „plata a fost confirmată”), ca să formuleze răspunsul. Conținutul e JSON.
 */
export const EVENT_TAG = "eveniment_aplicatie";

export interface LlmClient {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
