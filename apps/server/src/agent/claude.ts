import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest, LlmResponse } from "./llm.ts";

/** Modelul ales în plan; se poate schimba cu LLM_MODEL în .env. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/**
 * Claude real, prin SDK-ul oficial. Cheia se citește din mediu (ANTHROPIC_API_KEY), doar pe server.
 */
export class ClaudeClient implements LlmClient {
  readonly name: string;
  private client: Anthropic;

  constructor(private model: string = process.env.LLM_MODEL || DEFAULT_MODEL) {
    this.name = `claude:${model}`;
    this.client = new Anthropic();
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      // Conversație de voce: răspunsuri scurte și rapide.
      output_config: { effort: "low" },
      // Prompt caching: promptul de sistem și tool-urile sunt mereu aceleași.
      cache_control: { type: "ephemeral" },
      // Dacă modelul refuză o cerere, API-ul încearcă automat un model de rezervă.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    return { content: res.content, stop_reason: res.stop_reason };
  }
}
