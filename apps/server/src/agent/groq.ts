import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { LlmClient, LlmRequest, LlmResponse } from "./llm.ts";

/** Endpoint-ul Groq compatibil OpenAI și modelul implicit (se poate schimba cu GROQ_MODEL în .env). */
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
// (llama-3.3-70b-versatile nu mai e disponibil pe Groq; gpt-oss-120b e cel mai bun model de acolo pentru tool-uri.)
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.ChatCompletionTool;
type ChatCreate = (body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming) => Promise<OpenAI.Chat.ChatCompletion>;

/*
 * Agentul (agent.ts) vorbește peste tot în formatul Anthropic (blocuri text / tool_use / tool_result).
 * Groq folosește formatul OpenAI. Aici doar TRADUCEM între cele două, în ambele sensuri,
 * ca agentul, tool-urile și stratul de confirmare a plăților să rămână neschimbate.
 */

/** Tool-urile noastre (format Anthropic) → tool-uri „function” (format OpenAI). */
export function toOpenAiTools(tools: Anthropic.Beta.BetaTool[]): ChatTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

/** Promptul de sistem + istoricul (format Anthropic) → mesaje OpenAI. */
export function toOpenAiMessages(system: string, history: Anthropic.Beta.BetaMessageParam[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];

  for (const msg of history) {
    const blocks = typeof msg.content === "string" ? [{ type: "text" as const, text: msg.content }] : (msg.content ?? []);

    if (msg.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
      const toolCalls = blocks
        .filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // Mesaj „user”: rezultatele tool-urilor devin mesaje separate cu rol „tool”,
    // iar textul (inclusiv blocul <eveniment_aplicatie>) rămâne mesaj „user”.
    const texts: string[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        const content = typeof b.content === "string"
          ? b.content
          : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content });
      } else if (b.type === "text") {
        texts.push(b.text);
      }
    }
    if (texts.length) out.push({ role: "user", content: texts.join("\n") });
  }
  return out;
}

/** Răspunsul OpenAI → răspunsul în format Anthropic, pe care îl așteaptă agentul. */
export function fromOpenAiResponse(res: OpenAI.Chat.ChatCompletion): LlmResponse {
  const choice = res.choices[0];
  if (!choice) throw new Error("Groq nu a întors niciun răspuns.");
  const content: Anthropic.Beta.BetaContentBlock[] = [];

  // Unele modele (ex. Qwen) își pun „gândirea” în <think>…</think>; utilizatorul nu trebuie s-o audă.
  const text = choice.message.content?.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
  if (text) content.push({ type: "text", text, citations: null } as Anthropic.Beta.BetaTextBlock);

  for (const call of choice.message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    let input: unknown = {};
    try {
      input = call.function.arguments ? stripNulls(JSON.parse(call.function.arguments)) : {};
    } catch {
      input = {}; // argumente invalide → tool-ul întoarce o eroare de validare, nu crapă agentul
    }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input } as Anthropic.Beta.BetaToolUseBlock);
  }

  const hasToolUse = content.some((b) => b.type === "tool_use");
  const stop_reason: LlmResponse["stop_reason"] = hasToolUse
    ? "tool_use"
    : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
  return { content, stop_reason };
}

/** Groq refuză uneori un apel de tool generat greșit de model (400 „tool_use_failed”). */
function isToolUseFailed(e: unknown): e is InstanceType<typeof OpenAI.APIError> {
  if (!(e instanceof OpenAI.APIError) || e.status !== 400) return false;
  const code = e.code ?? (e.error as { code?: unknown } | undefined)?.code;
  return code === "tool_use_failed" || /tool call validation failed|failed to call a function/i.test(e.message);
}

/** Scoate câmpurile `null` (modelele gpt-oss pun `"vehicleId": null` la câmpurile opționale). */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, stripNulls(v)]));
  }
  return value;
}

/**
 * Cea mai des întâlnită cauză a lui „tool_use_failed”: modelul pune `null` la un câmp opțional, iar Groq
 * respinge tot apelul (iar la reîncercare face la fel). Groq ne trimite apelul respins în `failed_generation`;
 * îl reparăm (fără null) și îl executăm noi. Argumentele sunt oricum validate de tool-urile noastre.
 */
export function recoverFailedToolCall(error: unknown, toolNames: string[]): LlmResponse | null {
  const raw = (error as { failed_generation?: unknown } | undefined)?.failed_generation;
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const calls = (Array.isArray(parsed) ? parsed : [parsed]) as { name?: unknown; arguments?: unknown }[];
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  for (const [i, call] of calls.entries()) {
    if (typeof call?.name !== "string" || !toolNames.includes(call.name)) return null;
    let args = call.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        return null;
      }
    }
    content.push({ type: "tool_use", id: `groq_fix_${Date.now()}_${i}`, name: call.name, input: stripNulls(args) } as Anthropic.Beta.BetaToolUseBlock);
  }
  return content.length ? { content, stop_reason: "tool_use" } : null;
}

/**
 * Llama 3.3 70B prin Groq (gratuit, compatibil OpenAI). Cheia se citește din mediu (GROQ_API_KEY), doar pe server.
 * Siguranța plăților NU depinde de acest model: confirmarea se face în payments/confirmation.ts, înainte de LLM.
 */
/** Modelele de rezervă, în ordine (limitele Groq sunt PE MODEL). Se pot schimba cu GROQ_FALLBACK_MODELS. */
export const GROQ_FALLBACK_MODELS = ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"];

/** 429 cu limită lungă (pe zi / minute întregi): modelul e epuizat pentru o vreme, trecem la altul. */
function exhaustedFor(e: unknown): number | null {
  if (!(e instanceof OpenAI.APIError) || e.status !== 429) return null;
  const m = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(e.message);
  const ms = m ? ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000 : 60_000;
  return Math.max(ms, 5_000);
}

/**
 * Modelele prin Groq (gratuit, compatibil OpenAI). Cheia se citește din mediu (GROQ_API_KEY), doar pe server.
 * Dacă un model își atinge limita (ex. 200.000 de tokeni pe zi), trecem automat la următorul model din listă
 * până la resetarea limitei, ca demo-ul să nu se oprească.
 * Siguranța plăților NU depinde de acest model: confirmarea se face în payments/confirmation.ts, înainte de LLM.
 */
export class GroqClient implements LlmClient {
  private create: ChatCreate;
  private models: string[];
  /** Până când e epuizat fiecare model (timestamp ms). */
  private exhaustedUntil = new Map<string, number>();
  private lastModel: string;

  constructor(
    model: string = process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL,
    /** Doar pentru teste: înlocuiește apelul la Groq. */
    create?: ChatCreate,
    fallbacks: string[] = (process.env.GROQ_FALLBACK_MODELS ?? GROQ_FALLBACK_MODELS.join(",")).split(",").map((x) => x.trim()).filter(Boolean),
    private now: () => number = Date.now,
  ) {
    this.models = [model, ...fallbacks.filter((f) => f !== model)];
    this.lastModel = model;
    if (create) {
      this.create = create;
    } else {
      // maxRetries mic: la limita pe zi nu are rost să așteptăm, trecem la alt model.
      const client = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL, maxRetries: 1 });
      this.create = (body) => client.chat.completions.create(body);
    }
  }

  get name() {
    return `groq:${this.lastModel}`;
  }

  private body(model: string, req: LlmRequest): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    return {
      model,
      messages: toOpenAiMessages(req.system, req.messages),
      tools: toOpenAiTools(req.tools),
      tool_choice: "auto",
      temperature: 0.2, // conversație de plăți: răspunsuri stabile, nu creative
      // Loc și pentru „gândirea” modelelor gpt-oss; răspunsul vizibil rămâne scurt (cerut în prompt).
      max_tokens: 4096,
      // Modelele gpt-oss „gândesc” înainte să răspundă; pentru voce vrem răspunsuri rapide.
      ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" as const } : {}),
    };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const available = this.models.filter((m) => (this.exhaustedUntil.get(m) ?? 0) <= this.now());
    const order = available.length ? available : this.models; // toate epuizate: încercăm totuși, eroarea ajunge la agent
    let lastError: unknown;
    for (const model of order) {
      const body = this.body(model, req);
      try {
        const res = fromOpenAiResponse(await this.create(body));
        this.lastModel = model;
        return res;
      } catch (e) {
        const wait = exhaustedFor(e);
        if (wait !== null) {
          this.exhaustedUntil.set(model, this.now() + wait);
          console.warn(`Groq: ${model} și-a atins limita; trec la următorul model pentru ${Math.round(wait / 60000)} min.`);
          lastError = e;
          continue;
        }
        if (!isToolUseFailed(e)) throw e;
        const fixed = recoverFailedToolCall(e.error, req.tools.map((t) => t.name));
        if (fixed) {
          this.lastModel = model;
          return fixed;
        }
        return fromOpenAiResponse(await this.create(body)); // altfel, o singură reîncercare
      }
    }
    throw lastError;
  }
}
