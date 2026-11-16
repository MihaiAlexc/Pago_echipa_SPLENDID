import type Anthropic from "@anthropic-ai/sdk";
import { formatLei, type BillCategory } from "@pago/shared";
import { normalize } from "../payments/intent.ts";
import { EVENT_TAG, type LlmClient, type LlmRequest, type LlmResponse } from "./llm.ts";

/**
 * MODEL SIMULAT — răspunsuri scriptate, fără cheie API.
 * Imită un LLM: citește conversația, cere tool-uri în același format ca Claude și scrie răspunsul.
 * Acoperă dialogurile din plan (D1, D2, D5, D6) și câteva variații. Nu e inteligent: e un plan B
 * pentru demo și o bază deterministă pentru teste.
 */

type Block = Anthropic.Beta.BetaContentBlock;
type ToolCall = { name: string; input: Record<string, unknown> };
type BillView = {
  id: string; category: BillCategory; categoryRo: string; amount: number;
  daysUntilDue: number; status: "unpaid" | "paid" | "overdue";
};

const CATEGORY_WORDS: Record<string, BillCategory> = {
  curent: "electricity", curentul: "electricity", electricitate: "electricity", lumina: "electricity",
  gaz: "gas", gazul: "gas", gaze: "gas",
  apa: "water", apei: "water",
  internet: "internet", internetul: "internet",
  telefon: "phone", telefonul: "phone",
};

/** „gazul și apa” */
const ARTICULATED: Record<BillCategory, string> = {
  electricity: "curentul", gas: "gazul", water: "apa", internet: "internetul", phone: "telefonul",
};

const COUNT_WORDS = ["zero", "o", "două", "trei", "patru", "cinci", "șase", "șapte", "opt", "nouă", "zece"];

let idCounter = 0;

export class ScriptedLlm implements LlmClient {
  readonly name = "mock";

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const turn = readTurn(req.messages);
    const action = decide(turn);
    if ("tool" in action) {
      const block = { type: "tool_use", id: `toolu_mock_${++idCounter}`, name: action.tool.name, input: action.tool.input } as unknown as Block;
      return { content: [block], stop_reason: "tool_use" };
    }
    return { content: [{ type: "text", text: action.text, citations: null } as unknown as Block], stop_reason: "end_turn" };
  }
}

// ---------- citirea conversației ----------

interface Turn {
  userText: string; // ultimul mesaj scris/rostit de utilizator
  event: Record<string, unknown> | null; // ce a decis backend-ul înainte de LLM (confirmat / anulat ...)
  results: { name: string; data: unknown; ok: boolean }[]; // rezultatele tool-urilor din tura curentă
  lastAssistantText: string; // ce a spus asistentul în tura precedentă
}

function readTurn(messages: Anthropic.Beta.BetaMessageParam[]): Turn {
  // Ultimul mesaj de utilizator care conține text (nu doar rezultate de tool-uri).
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && blocks(m).some((b) => b.type === "text")) { start = i; break; }
  }
  const turn: Turn = { userText: "", event: null, results: [], lastAssistantText: "" };
  if (start < 0) return turn;

  for (const b of blocks(messages[start])) {
    if (b.type !== "text") continue;
    const text = b.text ?? "";
    if (text.startsWith(`<${EVENT_TAG}>`)) {
      turn.event = JSON.parse(text.slice(EVENT_TAG.length + 2, -(EVENT_TAG.length + 3)));
    } else {
      turn.userText += text;
    }
  }

  // Numele tool-urilor, după id.
  const names = new Map<string, string>();
  for (let i = start + 1; i < messages.length; i++) {
    for (const b of blocks(messages[i])) {
      if (b.type === "tool_use") names.set(b.id ?? "", b.name ?? "");
      if (b.type === "tool_result") {
        const parsed = JSON.parse(String(b.content));
        turn.results.push({ name: names.get(b.tool_use_id ?? "") ?? "?", ok: parsed.ok, data: parsed.data ?? parsed });
      }
    }
  }

  for (let i = start - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      turn.lastAssistantText = blocks(messages[i]).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
      break;
    }
  }
  return turn;
}

/** Vedere simplă asupra blocurilor unui mesaj: doar câmpurile de care are nevoie simularea. */
interface LooseBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
}

function blocks(m: Anthropic.Beta.BetaMessageParam): LooseBlock[] {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown as LooseBlock[]);
}

// ---------- decizia ----------

type Action = { tool: ToolCall } | { text: string };

function decide(t: Turn): Action {
  if (t.event) return afterEvent(t);

  const norm = normalize(t.userText);
  const words = norm.split(" ");

  // Călătorii: la Pasul 3 nu avem încă reguli pentru nicio țară → răspuns cinstit (D5).
  const trip = norm.match(/\b(?:plec|plecam|merg|mergem|calatoresc)\b.*?\bin ([a-z]+)/);
  if (trip) {
    const country = originalWord(t.userText, trip[1]);
    return { text: `Pentru ${country} nu am încă informații despre ce acte sunt necesare, deci nu vreau să-ți dau indicații greșite. Te pot ajuta cu facturile sau cu roamingul.` };
  }

  // „Cât am de plată?”
  if (/\b(cat|ce)\b.*\bde plata\b/.test(norm) || /\bce facturi\b/.test(norm)) {
    const bills = result<BillView[]>(t, "list_bills");
    if (!bills) return call("list_bills", { status: "due" });
    if (bills.length === 0) return { text: "Nu ai nimic de plată acum." };
    const total = Math.round(bills.reduce((s, b) => s + b.amount, 0) * 100) / 100;
    return { text: `Ai ${countFacturi(bills.length)} de plată, în total ${spokenLei(total)}: ${listBillsSpoken(bills)}.` };
  }

  const category = words.map((w) => CATEGORY_WORDS[w]).find(Boolean);
  const wantsToPay = words.some((w) => w.startsWith("plat")) ||
    (category !== undefined && normalize(t.lastAssistantText).includes("platesc"));

  if (wantsToPay && category) return payCategory(t, category, parseAmount(norm));

  if (wantsToPay) {
    // „Plătește factura de la...” (frază tăiată) → nu ghicim (D5).
    if (/\b(de la|la)$/.test(norm) || norm.endsWith(" de")) {
      return { text: "Nu am înțeles bine. Ce factură vrei să plătesc?" };
    }
    // „Plătește o factură” → întrebăm care (D2).
    const bills = result<BillView[]>(t, "list_bills");
    if (!bills) return call("list_bills", { status: "due" });
    if (bills.length === 0) return { text: "Nu ai nicio factură de plată. Totul e în regulă." };
    if (bills.length === 1) return payCategory(t, bills[0].category, null);
    return { text: `Ai ${countFacturi(bills.length, "neplătite")}: ${listBillsSpoken(bills)}. Pe care vrei s-o plătesc?` };
  }

  return { text: "Nu am înțeles bine. Te pot ajuta să plătești o factură sau să-ți spun ce ai de plată." };
}

function payCategory(t: Turn, category: BillCategory, spokenAmount: number | null): Action {
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", {});

  const catRo = bills.find((b) => b.category === category)?.categoryRo ?? ARTICULATED[category];
  const due = bills.find((b) => b.category === category && b.status !== "paid");
  if (!due) {
    return bills.some((b) => b.category === category)
      ? { text: `Factura la ${catRo} este deja plătită.` }
      : { text: `Nu am găsit nicio factură la ${catRo}.` };
  }

  const prepared = t.results.find((r) => r.name === "prepare_payment");
  if (!prepared) return call("prepare_payment", { items: [{ kind: "bill", billId: due.id }] });
  if (!prepared.ok) return { text: "Nu am putut pregăti plata. Mai încerci o dată?" };

  // D6: suma spusă de utilizator nu contează; plătim suma din date și o spunem clar.
  if (spokenAmount !== null && Math.abs(spokenAmount - due.amount) > 0.009) {
    return { text: `Factura la ${due.categoryRo} este de ${formatLei(due.amount)}, nu ${formatNumber(spokenAmount)}. O plătesc pe cea de ${formatNumber(due.amount)}?` };
  }

  const when =
    due.status === "overdue" || due.daysUntilDue < 0 ? " și e întârziată"
    : due.daysUntilDue === 0 ? ", scadentă azi"
    : due.daysUntilDue === 1 ? ", scadentă mâine"
    : `, scadentă în ${due.daysUntilDue} zile`;
  return { text: `Factura la ${due.categoryRo} este de ${spokenLei(due.amount)}${when}. O plătesc acum?` };
}

function afterEvent(t: Turn): Action {
  const e = t.event!;
  switch (e.kind) {
    case "cancelled":
      return { text: "Bine, nu am plătit nimic." };
    case "needs_screen":
      return { text: `Suma este de ${spokenLei(Number((e.summary as { total: number }).total))}, peste 500 de lei, așa că te rog să confirmi cu butonul de pe ecran.` };
    case "failed":
      return { text: `Plata nu a reușit: ${String(e.message)}` };
    case "confirmed": {
      const payment = e.payment as { total: number; lines: { kind: string; refId: string; label: string }[] };
      const bills = result<BillView[]>(t, "list_bills");
      if (!bills) return call("list_bills", {});
      const what = payment.lines
        .map((l) => (l.kind === "bill" ? bills.find((b) => b.id === l.refId)?.categoryRo ?? l.label : l.label))
        .join(" și ");
      const remaining = bills.filter((b) => b.status !== "paid");
      const tail = remaining.length
        ? ` Mai ai de plată ${joinRo(remaining.map((b) => ARTICULATED[b.category]))}.`
        : " Nu mai ai alte facturi de plată.";
      return { text: `Gata, am plătit ${spokenLei(payment.total)} pentru ${what}.${tail}` };
    }
    default:
      return { text: "Am înțeles." };
  }
}

// ---------- ajutoare ----------

function call(name: string, input: Record<string, unknown>): Action {
  return { tool: { name, input } };
}

function result<T>(t: Turn, name: string): T | null {
  const r = t.results.find((x) => x.name === name);
  return r && r.ok ? (r.data as T) : null;
}

/** 187.4 → „187,40 lei”; 56 → „56 de lei”; 15 → „15 lei” (regula lui „de” în română). */
export function spokenLei(n: number): string {
  if (!Number.isInteger(n)) return formatLei(n);
  const lastTwo = n % 100;
  return lastTwo === 0 && n > 0 || lastTwo >= 20 ? `${n} de lei` : `${n} lei`;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ",");
}

function countFacturi(n: number, adj?: string): string {
  const word = n === 1 ? "factură" : "facturi";
  const adjForm = adj ? (n === 1 ? " neplătită" : ` ${adj}`) : "";
  return `${n <= 10 ? COUNT_WORDS[n] : n} ${word}${adjForm}`;
}

function listBillsSpoken(bills: BillView[]): string {
  return joinRo(bills.map((b) => `${b.categoryRo} ${spokenLei(b.amount)}`));
}

function joinRo(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} și ${parts.at(-1)}`;
}

/** Găsește cuvântul în forma originală (cu majusculă și diacritice): „japonia” → „Japonia”. */
function originalWord(text: string, normalizedWord: string): string {
  const found = text.split(/[\s,.!?]+/).find((w) => normalize(w) === normalizedWord) ?? normalizedWord;
  return found.charAt(0).toUpperCase() + found.slice(1);
}

// „o sută de lei”, „100 lei”, „nouăzeci și patru de lei” → număr
const UNITS: Record<string, number> = {
  un: 1, unu: 1, o: 1, una: 1, doi: 2, doua: 2, trei: 3, patru: 4, cinci: 5, sase: 6, sapte: 7, opt: 8, noua: 9,
  zece: 10, unsprezece: 11, doisprezece: 12, douasprezece: 12, treisprezece: 13, paisprezece: 14,
  cincisprezece: 15, saisprezece: 16, saptesprezece: 17, optsprezece: 18, nouasprezece: 19,
};
const TENS: Record<string, number> = {
  douazeci: 20, treizeci: 30, patruzeci: 40, cincizeci: 50, saizeci: 60, saptezeci: 70, optzeci: 80, nouazeci: 90,
};

export function parseAmount(norm: string): number | null {
  const digits = norm.match(/(\d+(?:\s\d{2})?)\s*(?:de\s)?lei\b/);
  if (digits) return Number(digits[1].replace(" ", "."));

  const m = norm.match(/((?:[a-z]+\s){1,6})(?:de\s)?lei\b/);
  if (!m) return null;
  const words = m[1].trim().split(" ").filter((w) => w !== "si" && w !== "de");
  let total = 0, current = 0, matched = false;
  for (const w of words) {
    if (w === "suta" || w === "sute") { current = (current || 1) * 100; matched = true; }
    else if (w === "mie" || w === "mii") { total += (current || 1) * 1000; current = 0; matched = true; }
    else if (w in TENS) { current += TENS[w]; matched = true; }
    else if (w in UNITS) { current += UNITS[w]; matched = true; }
    else if (matched) break; // alt cuvânt după număr
    else { current = 0; } // cuvinte dinaintea numărului („platește”)
  }
  return matched ? total + current : null;
}
