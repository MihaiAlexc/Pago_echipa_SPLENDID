import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { createHarness, names } from "../../../../tests/dialogues/harness.ts";
import { GroqClient, fromOpenAiResponse, recoverFailedToolCall, stripNulls, toOpenAiMessages, toOpenAiTools } from "./groq.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";

type Body = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

/** Un răspuns Groq (format OpenAI), construit de mână. */
function completion(message: { content?: string | null; tool_calls?: { id: string; name: string; args: unknown }[] }, finish = "stop"): OpenAI.Chat.ChatCompletion {
  return {
    id: "x", object: "chat.completion", created: 0, model: "openai/gpt-oss-120b",
    choices: [{
      index: 0, logprobs: null,
      finish_reason: (message.tool_calls?.length ? "tool_calls" : finish) as "stop",
      message: {
        role: "assistant", refusal: null,
        content: message.content ?? null,
        ...(message.tool_calls ? {
          tool_calls: message.tool_calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })),
        } : {}),
      },
    }],
  };
}

describe("Groq: traducerea Anthropic ↔ OpenAI", () => {
  it("tool-urile devin funcții, cu aceeași schemă", () => {
    const tools = toOpenAiTools(TOOL_DEFINITIONS);
    expect(tools).toHaveLength(TOOL_DEFINITIONS.length);
    const prep = tools.find((t) => t.type === "function" && t.function.name === "prepare_payment")!;
    expect(prep.type === "function" && prep.function.parameters).toEqual(TOOL_DEFINITIONS.find((t) => t.name === "prepare_payment")!.input_schema);
  });

  it("istoricul: system, user, assistant cu tool_calls, rezultate ca mesaje „tool”", () => {
    const msgs = toOpenAiMessages("SISTEM", [
      { role: "user", content: [{ type: "text", text: "Plătește curentul" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "list_bills", input: { status: "due" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: '{"ok":true}' }] },
      { role: "assistant", content: [{ type: "text", text: "O plătesc?" }] },
      { role: "user", content: "da" },
    ]);
    expect(msgs).toEqual([
      { role: "system", content: "SISTEM" },
      { role: "user", content: "Plătește curentul" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_bills", arguments: '{"status":"due"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
      { role: "assistant", content: "O plătesc?" },
      { role: "user", content: "da" },
    ]);
  });

  it("răspunsul: tool_calls → tool_use; argumente JSON invalide → {} (nu crapă)", () => {
    const res = completion({ tool_calls: [{ id: "c1", name: "list_bills", args: { status: "due" } }] });
    expect(fromOpenAiResponse(res)).toEqual({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "c1", name: "list_bills", input: { status: "due" } }],
    });

    const broken = completion({ tool_calls: [{ id: "c2", name: "list_bills", args: {} }] });
    broken.choices[0].message.tool_calls![0] = { id: "c2", type: "function", function: { name: "list_bills", arguments: "{nu e json" } };
    expect(fromOpenAiResponse(broken).content[0]).toMatchObject({ type: "tool_use", input: {} });

    expect(fromOpenAiResponse(completion({ content: "Bună!" })).stop_reason).toBe("end_turn");
    expect(fromOpenAiResponse(completion({ content: "..." }, "length")).stop_reason).toBe("max_tokens");
  });
});

describe("Groq în agent (răspunsuri simulate): siguranța plăților rămâne în cod", () => {
  /** Un „Groq” fals care joacă D1: pregătește plata la curent, apoi răspunde. */
  function fakeGroq() {
    const bodies: Body[] = [];
    const script = [
      completion({ tool_calls: [{ id: "c1", name: "prepare_payment", args: { items: [{ kind: "bill", billId: "b-curent" }] } }] }),
      completion({ content: "Factura la curent este de 187,40 lei. O plătesc acum?" }),
      completion({ content: "Gata, am plătit 187,40 lei pentru curent." }),
    ];
    const client = new GroqClient("openai/gpt-oss-120b", async (body) => {
      bodies.push(structuredClone(body));
      const next = script.shift();
      if (!next) throw new Error("scriptul s-a terminat");
      return next;
    });
    return { client, bodies };
  }

  it("D1: plata se pregătește prin tool, „Da” o confirmă backend-ul, token-ul nu ajunge la Groq", async () => {
    const { client, bodies } = fakeGroq();
    const h = createHarness(client);

    const t1 = await h.say("Plătește factura la curent.");
    expect(names(t1)).toEqual(["prepare_payment"]);
    expect(t1.pending?.total).toBe(187.4);
    expect(h.store.listPayments()).toHaveLength(0); // nimic plătit înainte de „da”

    const t2 = await h.say("Da.");
    expect(t2.outcome).toBe("confirmed"); // decis în cod, înainte de Groq
    expect(h.bill("b-curent").status).toBe("paid");

    expect(JSON.stringify(bodies)).not.toContain(t1.pending!.token);
    // Groq a aflat de confirmare prin blocul <eveniment_aplicatie> din mesajul utilizatorului.
    const last = bodies.at(-1)!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("eveniment_aplicatie");
    expect(bodies[0].model).toBe("openai/gpt-oss-120b");
    expect(bodies[0].messages[0].role).toBe("system");
  });

  it("modelul nu poate confirma singur: nu există tool de confirmare", async () => {
    const names = toOpenAiTools(TOOL_DEFINITIONS).map((t) => (t.type === "function" ? t.function.name : ""));
    expect(names).not.toContain("confirm_payment");
  });

  it("eroare Groq → mesaj prietenos, nimic plătit", async () => {
    const client = new GroqClient("openai/gpt-oss-120b", async () => {
      throw new Error("rețea căzută");
    });
    const h = createHarness(client);
    const t = await h.say("Plătește factura la curent.");
    expect(t.error).toBeDefined();
    expect(t.reply).toContain("Nu am plătit nimic");
    expect(h.store.listPayments()).toHaveLength(0);
  });
});

describe("Groq: apeluri de tool respinse („tool_use_failed”)", () => {
  // Exact ce a trimis gpt-oss-120b în testul live: `vehicleId: null` la un câmp opțional.
  const failed_generation = JSON.stringify({
    name: "prepare_payment",
    arguments: { items: [{ kind: "product", productId: "rca-12m-tr", vehicleId: null }] },
  });
  const toolNames = TOOL_DEFINITIONS.map((t) => t.name);

  it("stripNulls scoate doar null-urile", () => {
    expect(stripNulls({ a: null, b: 0, c: "", d: [{ e: null, f: 1 }] })).toEqual({ b: 0, c: "", d: [{ f: 1 }] });
  });

  it("repară apelul din failed_generation", () => {
    const fixed = recoverFailedToolCall({ failed_generation }, toolNames);
    expect(fixed?.stop_reason).toBe("tool_use");
    expect(fixed?.content[0]).toMatchObject({
      type: "tool_use", name: "prepare_payment", input: { items: [{ kind: "product", productId: "rca-12m-tr" }] },
    });
  });

  it("nu „repară” tool-uri necunoscute sau JSON stricat", () => {
    expect(recoverFailedToolCall({ failed_generation: JSON.stringify({ name: "confirm_payment", arguments: {} }) }, toolNames)).toBeNull();
    expect(recoverFailedToolCall({ failed_generation: "{nu e json" }, toolNames)).toBeNull();
    expect(recoverFailedToolCall({}, toolNames)).toBeNull();
  });

  it("în agent: plata se pregătește din apelul reparat, fără să mai întrebe Groq încă o dată", async () => {
    let calls = 0;
    const client = new GroqClient("openai/gpt-oss-120b", async () => {
      calls++;
      if (calls === 1) {
        throw new OpenAI.APIError(400, { message: "Tool call validation failed", code: "tool_use_failed", failed_generation }, "tool_use_failed", new Headers());
      }
      return completion({ content: "Un RCA pe 12 luni cu Carte Verde pentru Turcia costă 450 de lei. Îl cumpăr?" });
    });
    const h = createHarness(client);
    const t = await h.say("Cumpără RCA-ul cu Turcia.");
    expect(names(t)).toEqual(["prepare_payment"]);
    expect(t.pending?.total).toBe(450);
    expect(calls).toBe(2); // apelul respins + răspunsul după tool
    expect(h.store.listPayments()).toHaveLength(0);
  });
});

describe("Groq: limita atinsă pe un model → trece automat la modelul de rezervă", () => {
  const limit = () =>
    new OpenAI.APIError(429, { message: "Rate limit reached ... tokens per day (TPD)" }, "Rate limit reached for model on tokens per day (TPD). Please try again in 10m54.048s.", new Headers());

  it("folosește modelul următor și ține minte că primul e epuizat", async () => {
    const used: string[] = [];
    let now = 0;
    const client = new GroqClient("openai/gpt-oss-120b", async (body) => {
      used.push(body.model);
      if (body.model === "openai/gpt-oss-120b") throw limit();
      return completion({ content: "Bună!" });
    }, ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"], () => now);

    const req = { system: "s", messages: [{ role: "user" as const, content: "salut" }], tools: TOOL_DEFINITIONS };
    expect((await client.complete(req)).content[0]).toMatchObject({ type: "text", text: "Bună!" });
    expect(used).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    expect(client.name).toBe("groq:openai/gpt-oss-20b");

    await client.complete(req); // primul e încă epuizat: nu-l mai încercăm
    expect(used.slice(2)).toEqual(["openai/gpt-oss-20b"]);

    now += 11 * 60_000; // după resetarea limitei, revine la modelul principal
    await client.complete(req);
    expect(used.slice(3)[0]).toBe("openai/gpt-oss-120b"); // îl încearcă din nou pe cel principal
  });

  it("dacă toate modelele sunt epuizate, eroarea ajunge la agent (mesaj prietenos, nimic plătit)", async () => {
    const client = new GroqClient("a", async () => { throw limit(); }, ["b"]);
    const h = createHarness(client);
    const t = await h.say("Plătește factura la curent.");
    expect(t.error).toMatch(/429/);
    expect(t.reply).toContain("Nu am plătit nimic");
  });
});
