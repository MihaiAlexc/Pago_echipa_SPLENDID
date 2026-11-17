import type Anthropic from "@anthropic-ai/sdk";
import { addDays, formatLei, type BillCategory, type Product, type ProductType } from "@pago/shared";
import { normalize } from "../payments/intent.ts";
import { HELP_TEXT, UNCLEAR_OFFER, UNCLEAR_PENDING, WAIT_PENDING_TEXT, WAIT_TEXT, isTransparent, staticAnswer, withoutQuestion } from "./knowledge.ts";
import { EVENT_TAG, type LlmClient, type LlmRequest, type LlmResponse } from "./llm.ts";

/**
 * MODEL SIMULAT — răspunsuri scriptate, fără cheie API.
 *
 * Imită un LLM: citește conversația, cere tool-uri în același format ca Claude și scrie răspunsul.
 * Nu înțelege limba; recunoaște INTENȚII după cuvinte-cheie (cu toleranță la greșeli mici de recunoaștere
 * vocală) și ține minte ultima întrebare pe care a pus-o, ca să înțeleagă răspunsuri scurte („cea la gaz”,
 * „a doua”, „cea de 12 luni”).
 *
 * Ce știe:
 *  - plăți de facturi: una, mai multe („curentul și apa”), toate, doar cele întârziate;
 *  - întrebări despre facturi: cât am de plată, cât e / când e scadentă factura la X, ce e întârziat;
 *  - mașina: cât mai e valabil RCA-ul / rovinieta, oferte RCA / rovinietă / vinietă / roaming / cartelă,
 *    alegerea unei oferte („a doua”, „cea mai ieftină”, „12 luni”, „cu Turcia”);
 *  - corecturi („nu, factura de apă”), salut, mulțumesc, „ce poți face?”;
 *  - călătorii: „plec în Turcia”, „ce îmi trebuie pentru Bulgaria?”, „în ce țări mă poți ajuta?”;
 *  - întrebări despre cont: cum mă cheamă, ce zi e azi, ce mașină am, ce am plătit, ce expiră în curând,
 *    care e situația mea, ce e mai urgent, cea mai mare factură, cine e furnizorul, ce țări acoperă RCA-ul;
 *  - întrebări generale (ce e RCA-ul, e sigur, cum confirm) — răspunsuri fixe din knowledge.ts;
 *  - „repetă”, „stai puțin”, „anulează”, „ce plătesc?” (când o plată așteaptă confirmarea).
 *
 * Siguranța NU depinde de el: confirmarea plăților se face în cod (payments/confirmation.ts).
 */

type Block = Anthropic.Beta.BetaContentBlock;
type ToolCall = { name: string; input: Record<string, unknown> };

type BillView = {
  id: string; category: BillCategory; categoryRo: string; provider: string; amount: number;
  dueDate: string; daysUntilDue: number; status: "unpaid" | "paid" | "overdue";
};
type Vehicle = { id: string; plate: string; make: string; model: string; vin?: string };
type PolicyView = { validUntil: string; daysLeft: number; countries: string[] };
type VignetteView = { country: string; validUntil: string; daysLeft: number };
type ServiceView = { type: "roaming" | "sim"; country: string; validUntil: string; daysLeft: number };
type ExpiringView = { kind: "rca" | "vignette" | "bill"; label: string; daysLeft: number; refId: string };
type PaymentView = { total: number; date: string; lines: { kind: string; label: string; amount: number }[] };
type PendingView = { lines: { label: string; amount: number }[]; total: number; requiresScreenConfirm: boolean };
type ProfileView = { name: string; phone: string; today: string; weekday: string; time: string };

// ---------- vocabular ----------

const CATEGORY_WORDS: Record<string, BillCategory> = {
  curent: "electricity", curentul: "electricity", curentului: "electricity", electricitate: "electricity",
  electricitatea: "electricity", lumina: "electricity", luminii: "electricity", energie: "electricity",
  energia: "electricity", electrica: "electricity",
  gaz: "gas", gazul: "gas", gaze: "gas", gazele: "gas", gazului: "gas",
  apa: "water", apei: "water", apa_calda: "water",
  internet: "internet", internetul: "internet", internetului: "internet", net: "internet", netul: "internet", wifi: "internet",
  telefon: "phone", telefonul: "phone", telefonului: "phone", mobil: "phone", mobilul: "phone", abonament: "phone", abonamentul: "phone",
};

const CAT_RO: Record<BillCategory, string> = {
  electricity: "curent", gas: "gaz", water: "apă", internet: "internet", phone: "telefon",
};

/** „gazul și apa” */
const ARTICULATED: Record<BillCategory, string> = {
  electricity: "curentul", gas: "gazul", water: "apa", internet: "internetul", phone: "telefonul",
};

const PRODUCT_WORDS: Record<string, ProductType> = {
  rca: "rca", asigurare: "rca", asigurarea: "rca", asigurarii: "rca", polita: "rca", polita_rca: "rca",
  rovinieta: "vignette", rovinietei: "vignette", rovinete: "vignette", vinieta: "vignette", vinieta_bg: "vignette", vigneta: "vignette",
  roaming: "roaming", romingul: "roaming", roamingul: "roaming", roming: "roaming",
  cartela: "sim", cartele: "sim", sim: "sim", cartelei: "sim",
};

const PRODUCT_RO: Record<ProductType, string> = {
  rca: "RCA", vignette: "rovinietă", roaming: "roaming", sim: "cartelă", travel: "asigurare de călătorie",
};

/** Țările pe care le recunoaște după nume (pentru RCA / Carte Verde, viniete și roaming). */
const COUNTRIES: { code: string; name: string; words: string[] }[] = [
  { code: "RO", name: "România", words: ["romania", "romaniei"] },
  { code: "BG", name: "Bulgaria", words: ["bulgaria", "bulgariei"] },
  { code: "TR", name: "Turcia", words: ["turcia", "turciei"] },
  { code: "GR", name: "Grecia", words: ["grecia", "greciei"] },
  { code: "HU", name: "Ungaria", words: ["ungaria", "ungariei"] },
  { code: "MD", name: "Republica Moldova", words: ["moldova", "moldovei"] },
  { code: "AT", name: "Austria", words: ["austria", "austriei"] },
  { code: "DE", name: "Germania", words: ["germania", "germaniei"] },
  { code: "IT", name: "Italia", words: ["italia", "italiei"] },
  { code: "FR", name: "Franța", words: ["franta", "frantei"] },
  { code: "ES", name: "Spania", words: ["spania", "spaniei"] },
];

const COUNTRY_WORDS: Record<string, string> = Object.fromEntries(COUNTRIES.flatMap((c) => c.words.map((w) => [w, c.code])));

/** Cuvinte care seamănă cu un produs, dar nu sunt: „cartea (verde)” nu e „cartela”. */
const NOT_A_PRODUCT = new Set(["carte", "cartea", "cartii", "carti"]);

/** Întrebarea mea de confirmare a unei plăți („O plătesc acum?”, „Îl cumpăr?”…). */
const CONFIRM_QUESTION = /\b(o platesc acum|le platesc acum|il cumpar|o cumpar|o platesc pe cea de|confirmi cu butonul|ca s o fac|se confirma cu butonul)\b/;

/** Cuvinte după „în / la / pentru” care nu sunt o țară („plec în vacanță în Grecia”). */
const NOT_A_PLACE = new Set([
  "vacanta", "concediu", "concediul", "excursie", "calatorie", "calatoria", "strainatate", "weekend", "drum", "drumul",
  "vizita", "delegatie", "afara", "tara", "plata", "masina", "mine", "tine", "asta", "aceasta", "acum", "factura",
  "facturi", "plecare", "saptamana", "luna", "vara", "iarna", "timp", "cateva", "doua", "trei", "patru", "cinci",
]);

const MONTH_NAMES = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie"];
const WEEKDAY_NORM = ["duminica", "luni", "marti", "miercuri", "joi", "vineri", "sambata"];
const WEEKDAY_RO = ["duminică", "luni", "marți", "miercuri", "joi", "vineri", "sâmbătă"];

const PAY_WORDS = new Set(["plateste", "platesc", "platesti", "plati", "platim", "platiti", "plateasca", "platesteo", "plateste-o"]);
const BUY_WORDS = new Set(["cumpara", "cumpar", "cumparam", "cumpere", "reinnoieste", "reinnoiesc", "reinnoi", "reinnoim", "prelungeste", "prelungesc", "ia", "fa", "oferte", "ofertele", "oferta", "arata", "vreau"]);
const GREETINGS = new Set(["buna", "salut", "hei", "hello", "neata", "servus"]);
const THANKS = new Set(["multumesc", "mersi", "multumim", "merci"]);
/** Verbe care cer clar o cumpărare (spre deosebire de „vreau” / „arată”, care pot fi și întrebări). */
const BUY_VERBS = new Set(["cumpara", "cumpar", "cumparam", "cumpere", "reinnoieste", "reinnoiesc", "prelungeste", "prelungesc", "ia"]);
const YES_WORDS = new Set(["da", "vreau", "sigur", "ok", "bine", "te", "rog", "arata", "mi", "le", "ofertele", "dami", "da-mi", "verifica", "verific", "hai", "desigur"]);

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
  userText: string;
  norm: string;
  words: string[];
  event: Record<string, unknown> | null;
  results: { name: string; input: Record<string, unknown>; data: unknown; ok: boolean }[];
  /** Ultima mea replică ce a pus o întrebare / a schimbat subiectul (sar peste răspunsurile „transparente”). */
  lastAssistantText: string;
  lastAssistantNorm: string;
  /** Chiar ultima mea replică, cuvânt cu cuvânt (pentru „repetă”). */
  lastSaid: string;
  /** O plată pregătită mai devreme încă așteaptă „da” / „nu” (dedus din istoric: pregătită și nici confirmată, nici anulată). */
  pendingPayment: boolean;
  /** Ultima verificare de călătorie din conversație (ca să știm la ce țară ne referim mai târziu). */
  tripInput: Record<string, unknown> | null;
  /** Mesajul anterior al utilizatorului (normalizat), pentru cereri în mai mulți pași. */
  prevUserNorm: string;
  /** Ultimele mesaje ale utilizatorului dinaintea celui curent (cel mai vechi primul). */
  recentUserNorms: string[];
}

type TripItem = {
  id: string; short: string; status: "ok" | "missing"; reasons: string[]; currentDaysLeft?: number;
  productType: ProductType; alternatives?: ProductType[]; suggestedProduct?: { id: string; name: string; price: number };
};
type TripCheck =
  | { known: false; country: string }
  | { known: true; country: string; name: string; inName: string; withCar: boolean | null; items: TripItem[] };

/** Vedere simplă asupra blocurilor unui mesaj: doar câmpurile de care are nevoie simularea. */
interface LooseBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

function blocks(m: Anthropic.Beta.BetaMessageParam): LooseBlock[] {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown as LooseBlock[]);
}

function readTurn(messages: Anthropic.Beta.BetaMessageParam[]): Turn {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && blocks(m).some((b) => b.type === "text")) { start = i; break; }
  }
  const turn: Turn = { userText: "", norm: "", words: [], event: null, results: [], lastAssistantText: "", lastAssistantNorm: "", lastSaid: "", pendingPayment: false, tripInput: null, prevUserNorm: "", recentUserNorms: [] };
  for (const m of messages) {
    for (const b of blocks(m)) if (b.type === "tool_use" && b.name === "run_trip_checklist") turn.tripInput = b.input ?? null;
  }
  if (start < 0) return turn;

  // Mai așteaptă vreo plată? Urmărim istoricul: pregătită → așteaptă; confirmată / anulată / eșuată → nu mai așteaptă.
  const toolNames = new Map<string, string>();
  for (let i = 0; i < start; i++) {
    for (const b of blocks(messages[i])) {
      if (b.type === "tool_use") toolNames.set(b.id ?? "", b.name ?? "");
      if (b.type === "tool_result") {
        const name = toolNames.get(b.tool_use_id ?? "");
        if (name !== "prepare_payment" && name !== "cancel_pending_payment" && name !== "get_pending_payment") continue;
        const parsed = JSON.parse(String(b.content));
        if (name === "prepare_payment") turn.pendingPayment = turn.pendingPayment || Boolean(parsed.ok);
        else if (name === "cancel_pending_payment") turn.pendingPayment = false;
        else turn.pendingPayment = Boolean(parsed.data?.pending);
      }
      if (b.type === "text" && (b.text ?? "").startsWith(`<${EVENT_TAG}>`)) {
        const kind = JSON.parse((b.text ?? "").slice(EVENT_TAG.length + 2, -(EVENT_TAG.length + 3))).kind;
        if (kind === "confirmed" || kind === "cancelled" || kind === "failed") turn.pendingPayment = false;
      }
    }
  }

  for (const b of blocks(messages[start])) {
    if (b.type !== "text") continue;
    const text = b.text ?? "";
    if (text.startsWith(`<${EVENT_TAG}>`)) {
      turn.event = JSON.parse(text.slice(EVENT_TAG.length + 2, -(EVENT_TAG.length + 3)));
    } else {
      turn.userText += text;
    }
  }
  turn.norm = normalize(turn.userText);
  turn.words = turn.norm.split(" ").filter(Boolean);

  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (let i = start + 1; i < messages.length; i++) {
    for (const b of blocks(messages[i])) {
      if (b.type === "tool_use") calls.set(b.id ?? "", { name: b.name ?? "", input: b.input ?? {} });
      if (b.type === "tool_result") {
        const parsed = JSON.parse(String(b.content));
        const call = calls.get(b.tool_use_id ?? "") ?? { name: "?", input: {} };
        turn.results.push({ ...call, ok: parsed.ok, data: parsed.data ?? parsed });
      }
    }
  }

  for (let i = start - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const said = blocks(messages[i]).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
    if (!said) continue;
    if (!turn.lastSaid) turn.lastSaid = said;
    // „E sigur?” → răspuns fix → „da”: „da”-ul se referă tot la întrebarea de dinainte.
    if (isTransparent(said)) continue;
    turn.lastAssistantText = said;
    break;
  }
  turn.lastAssistantNorm = normalize(turn.lastAssistantText);

  for (let i = start - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = blocks(m).filter((b) => b.type === "text" && !(b.text ?? "").startsWith(`<${EVENT_TAG}>`)).map((b) => b.text ?? "").join(" ");
    if (!text.trim()) continue;
    if (!turn.prevUserNorm) turn.prevUserNorm = normalize(text);
    turn.recentUserNorms.unshift(normalize(text));
    if (turn.recentUserNorms.length >= 3) break;
  }
  return turn;
}

// ---------- decizia ----------

type Action = { tool: ToolCall } | { text: string };

function decide(t: Turn): Action {
  if (t.event) return afterEvent(t);
  const action = decideIntent(t);
  // SIGURANȚĂ: cât timp o plată așteaptă „da” / „nu”, nu pun ALTĂ întrebare — un „da” spus la ea ar confirma
  // plata, nu întrebarea mea. Spun doar informația; aplicația adaugă singură că plata încă așteaptă.
  const replacedOrCancelled = t.results.some((r) => r.name === "prepare_payment" || r.name === "cancel_pending_payment");
  if ("text" in action && t.pendingPayment && !replacedOrCancelled
    && action.text.endsWith("?") && !CONFIRM_QUESTION.test(normalize(action.text))) {
    return { text: withoutQuestion(action.text) };
  }
  return action;
}

function decideIntent(t: Turn): Action {
  const w = t.words;
  const n = t.norm;
  const has = (...xs: string[]) => xs.some((x) => w.includes(x));
  const categories = findCategories(w);
  const productType = findProductType(w);
  const wantsToPay = w.some((x) => PAY_WORDS.has(x) || x.startsWith("achit")) || /\bscap de\b/.test(n);
  const wantsToBuy = w.some((x) => BUY_WORDS.has(x));
  const asked = t.lastAssistantNorm;
  /** O plată așteaptă „da” / „nu” (pregătită mai devreme, sau tocmai am întrebat „O plătesc acum?”). */
  const askedConfirm = t.pendingPayment || CONFIRM_QUESTION.test(asked);
  const offersListed = /\bcare te intereseaza\b/.test(asked);
  const country = countryIn(n);
  const greenCard = /\bcart(e|ea|ii) verde\b/.test(n);
  const aboutBills = has("factura", "facturi", "facturile", "facturii", "facturilor");
  /** Mesajul nu pomenește nicio factură și niciun produs. */
  const plain = !categories.length && !productType;

  // ---------- „Repetă”, mulțumesc, întrebări generale, salut ----------
  if (plain && w.length <= 6 && /\b(repeta|repeti|mai spune|mai zi|inca o data|n am (auzit|inteles)|nu am (auzit|inteles)|nu te am (auzit|inteles)|poftim|ce ai (spus|zis))\b/.test(n)) {
    return { text: t.lastSaid || "Încă nu ți-am spus nimic. Cu ce te pot ajuta?" };
  }
  if (w.length <= 4 && w.some((x) => THANKS.has(x))) return { text: "Cu plăcere! Mai am ceva de făcut pentru tine?" };

  // Răspunsuri fixe (knowledge.ts): cine ești, ce e RCA-ul, e sigur, cum confirm, la revedere…
  const fixed = staticAnswer(n);
  if (fixed && !(categories.length && /^cum (platesc|pot plati|se plateste)\b/.test(n))) {
    // După ce am listat oferte, răspund fără întrebarea de la sfârșit: „a doua” se referă tot la oferte.
    return { text: offersListed ? withoutQuestion(fixed) : fixed };
  }

  if (w.length <= 4 && w.some((x) => GREETINGS.has(x)) && plain) {
    return { text: "Bună! Pot să plătesc facturi, să-ți spun ce ai de plată sau să verific RCA-ul și rovinieta. Cu ce încep?" };
  }

  // „Stai puțin” — nu se întâmplă nimic; plata pregătită (dacă e una) rămâne în așteptare.
  if (plain && w.length <= 5 && (/\b(stai|asteapta|o clipa|un moment|o secunda|ma gandesc|mai tarziu|imediat)\b/.test(n)
    || (askedConfirm && /\bnu (stiu|sunt sigur|sunt sigura)\b/.test(n)))) {
    return { text: askedConfirm ? WAIT_PENDING_TEXT : WAIT_TEXT };
  }

  // „Anulează” / „m-am răzgândit” (formulări pe care codul nu le-a prins, sau când nu e nimic în așteptare).
  if (!categories.length && /\b(anuleaza|anulezi|anulam|anulez|renunt|renunta|renuntam)\b|\bnu mai (vreau|platesc|plati|cumpar|cumpara|e nevoie)\b|\bm am razgandit\b/.test(n)) {
    return cancelPending(t);
  }

  // „Ce plătesc?” / „Cât era suma?” când o plată așteaptă confirmarea.
  if (plain && (/\bplata (in asteptare|pregatita)\b/.test(n)
    || (askedConfirm && !/\bde (plata|platit)\b/.test(n) && /\b(cat|ce|care|cum)\b/.test(n) && /\b(suma|platesc|plata|costa|era|cumpar|total|totalul|pret|pretul)\b/.test(n)))) {
    return pendingInfo(t);
  }

  // ---------- Adăugare / ștergere de facturi prin voce ----------
  const wantsAdd = w.some((x) => ADD_WORDS.has(x)) && (has("factura", "facturi") || categories.length > 0);
  const wantsRemove = w.some((x) => REMOVE_WORDS.has(x)) && (has("factura", "facturi") || categories.length > 0);
  if (wantsAdd) {
    return addBill(t, categories[0], parseAmount(n), parseDue(n), providerIn(t));
  }
  if (wantsRemove) return removeBill(t, categories[0], parseAmount(n));
  // Răspuns la „La ce e factura…?” (adăugare în mai mulți pași)
  if (/\bla ce e factura\b/.test(asked) && categories.length) {
    return addBill(t, categories[0], amountLoose(n) ?? parseAmount(t.prevUserNorm), dueFromRecent(t), providerIn(t));
  }
  // Răspuns la „Ce sumă are factura la X?”
  const amountQ = asked.match(/\bce suma are factura la ([a-z]+)/);
  if (amountQ) {
    const amount = amountLoose(n);
    const cat = findCategories([amountQ[1]])[0];
    if (cat && amount !== null) return addBill(t, cat, amount, dueFromRecent(t), null);
  }

  // ---------- Călătorii (D3): regulile decid, eu doar povestesc ----------
  const destination = categories.length ? null
    : tripDestination(n) ?? (plain && !wantsToPay ? needDestination(n) : null);
  if (destination && destination !== "?") {
    const withCar = /\bcu masina\b/.test(n) ? true : /\b(avion|avionul|autocar|autocarul|trenul|tren|fara masina)\b/.test(n) ? false : undefined;
    const days = tripDays(n);
    return startTrip(t, { country: destination, startInDays: startInDays(n), ...(days ? { days } : {}), ...(withCar === undefined ? {} : { withCar }) }, destination);
  }
  if (t.tripInput && /\bmasina o iei\b/.test(asked)) {
    const no = w[0] === "nu" || has("avion", "avionul", "autocar", "autocarul", "tren", "trenul", "fara");
    const yes = w[0] === "da" || has("iau", "sigur", "masina");
    if (no || yes) return startTrip(t, { ...t.tripInput, withCar: !no }, String(t.tripInput.country));
  }
  // „Plec în vacanță” (fără țară) sau „în ce țări mă poți ajuta?”
  if (destination === "?") return tripCountries(t);
  if (productType !== "rca" && !greenCard && /\b(ce|care) tari\b|\bunde pot (merge|calatori|pleca)\b|\bce destinatii\b|\bpentru ce tara\b/.test(n)) {
    return tripCountries(t);
  }
  if (t.tripInput && w.length <= 5 && w[0] === "da" && /\bincepem cu\b/.test(asked)) return nextTripStep(t, "");
  if (/\bpachetele de roaming\b/.test(asked)) {
    const tripCountry = countryIn(normalize(String(t.tripInput?.country ?? ""))) ?? countryIn(asked);
    if (has("cartela", "cartele", "locala", "sim")) return offers(t, "sim", tripCountry);
    if (w[0] === "da" || has("roaming", "pachet", "pachetele", "pachetul", "roamingul")) return offers(t, "roaming", tripCountry);
  }

  // ---------- Răspuns scurt la o întrebare de-a mea („Vrei să-l reînnoiesc?” → „da”) ----------
  const shortYes = w.length > 0 && w.length <= 5 && w[0] === "da" && w.every((x) => YES_WORDS.has(x));
  if (shortYes && /\bverific pana cand e valabil al tau\b/.test(asked)) return rcaStatus(t);
  if (shortYes && /\bverific ce tari acopera\b/.test(asked)) return rcaCoverage(t, null);
  if (shortYes && /\bverific daca a ta e valabila\b/.test(asked)) return vignetteStatus(t, null);
  if (shortYes && /\b(reinnoiesc|ofertele|oferte)\b/.test(asked)) {
    return offers(t, typeFromText(asked) ?? "rca", countryIn(asked));
  }
  // „Vrei s-o plătesc?” / „Vrei să le plătesc?” → „da”
  if (shortYes && /\bvrei s(a)? ?(o|le) platesc\b/.test(asked)) {
    if (/\bfactur[ai] intarziat[ae]\b/.test(asked)) return payBills(t, { overdue: true });
    const cats = findCategories(asked.split(" "));
    // „Am adăugat factura la telefon de 42 de lei…” → plătim exact factura cu suma asta, nu alta de același tip.
    if (cats.length) return payBills(t, { categories: cats, preferAmount: parseAmount(asked) });
  }

  // „Ce RCA îmi recomanzi?” / „Care e diferența?” / „Nu știu” (după ce am listat ofertele).
  if (!categories.length && (offersListed || productType)
    && /\b(recomanzi|recomandare|diferenta|diferente|ce sa aleg|care merita|merita|nu stiu|nu sunt sigur|nu sunt sigura|ajuta ma sa aleg|sfat|sfatuiesti|compara|care e mai (bun|buna|avantajos|avantajoasa))\b/.test(n)) {
    const type = productType ?? typeFromText(asked);
    if (type) return recommendOffer(t, type, country ?? countryIn(asked));
  }

  if (/\b(ce (poti|stii) (sa )?(face|faci)|ce stii|cu ce ma (poti )?ajut[ai]|ajutor|ajuta ma|cum functionezi|cum te folosesc|ce (pot|as putea) (sa )?(te )?(intreb|cer)|exemple|ce optiuni am)\b/.test(n)) {
    return { text: HELP_TEXT };
  }

  if (w.length <= 3 && (w[0] === "nu" || w[0] === "lasa" || has("niciuna", "niciunul", "nimic")) && plain) {
    return { text: "Bine. Spune-mi dacă mai ai nevoie de ceva." };
  }

  // Alegerea unei oferte, după ce le-am listat („a doua”, „cea de 12 luni”, „cea mai ieftină”).
  const picksOffer = ordinal(w) !== null || numbersIn(w).length > 0
    || has("ieftina", "ieftin", "scumpa", "scump", "weekend", "week") || w.some((x) => COUNTRY_WORDS[x] === "TR");
  if (offersListed && !wantsToPay && (picksOffer || productType)) {
    const type = productType ?? typeFromText(asked);
    if (type && picksOffer) return chooseOffer(t, type, countryIn(asked) ?? country);
  }

  // ---------- Întrebări despre cont: nume, telefon, dată, mașină ----------
  if (/\bnumar(ul)? (meu )?de telefon\b/.test(n) && !wantsToPay) return profile(t, "phone");
  if (plain) {
    if (/\bcum ma (cheama|numesc)\b|\b(care e|stii|spune mi) numele meu\b|\bcine sunt( eu)?\b|\bpe ce nume\b/.test(n)) return profile(t, "name");
    if (/\b(ce|in ce|care e) (zi|data)\b.*\b(azi|astazi|e|este|suntem)\b|\bin cat suntem\b|\bdata de azi\b/.test(n)) return profile(t, "date");
    if (/\bcat e ceasul\b|\bce ora e(ste)?\b|\bcat (e|este) ora\b/.test(n)) return profile(t, "time");
  }
  if (!wantsToBuy && !wantsToPay) {
    if (/\b(serie|seria|seriei) (de )?sasiu\b|\bsasiu(l|lui)?\b/.test(n)) return vehicleInfo(t, true);
    if (!productType && /\bce masin[ai] am\b|\bmasina mea\b|\bnumar(ul)? de inmatriculare\b|\bce numar are masina\b|\bam (o |vreo )?masina\b/.test(n)) return vehicleInfo(t, false);
    if (/\b(pot|am voie|e legal|este legal)( sa)? (circul|circula|conduc|conduce|merg cu masina|merge cu masina|ies cu masina)\b|\b(masina|actele|actele masinii) (e|este|sunt) (in regula|la zi|valabile|ok)\b/.test(n)) return carStatus(t);
  }

  // ---------- Ce am plătit ----------
  if (plain) {
    if (/\b(ce|care|cate) facturi (am|sunt|ai) (deja )?(platit|platite|achitat|achitate)\b|\bfacturi(le)? (deja )?platite\b/.test(n)) return paidBills(t);
    if (!/\bde (plata|platit|achitat)\b/.test(n) && /\b(ce|cat|cate|care)\b.*\b(platit|achitat|cheltuit)\b|\bistoric(ul)?\b|\b(ultima|ultimele) plat[ai]\b|\bplatile (mele|facute)\b|\bce plati am\b/.test(n)) return paymentHistory(t);
  }

  // ---------- Mașina: RCA, Carte Verde, rovinietă, roaming ----------
  // „RCA-ul meu e valabil în Bulgaria?” / „Am Carte Verde?” / „Ce țări acoperă?”
  if ((productType === "rca" || greenCard) && !wantsToBuy && !wantsToPay
    && (greenCard || country !== null || /\b(acopera|acoperi|tari|tarile|strainatate|afara|europa|unde)\b/.test(n))) {
    return rcaCoverage(t, country);
  }
  // „Am roaming?” / „Am internet în Turcia?”
  const statusQuestion = has("cand", "mai", "valabil", "valabila", "expira", "am", "ce", "pana", "status");
  const aboutServices = productType === "roaming" || productType === "sim" || (!productType && categories.includes("internet") && country !== null && !aboutBills);
  if (aboutServices && !wantsToBuy && !wantsToPay && has("am", "mai", "valabil", "valabila", "activ", "activa", "expira", "cand", "pana")) {
    return servicesStatus(t, country);
  }
  // Cât mai e valabil RCA-ul / rovinieta (întrebare, nu cumpărare).
  if (productType && !wantsToBuy && !wantsToPay && statusQuestion) {
    if (productType === "rca") return rcaStatus(t);
    if (productType === "vignette") return vignetteStatus(t, country);
  }

  // „Plătește gazul și cumpără rovinietă” → întâi factura (cu confirmarea ei), apoi produsul.
  if (productType && categories.length && wantsToPay && w.some((x) => BUY_VERBS.has(x))) {
    return payBills(t, { categories, spokenAmount: parseAmount(n), extraNote: ` De ${PRODUCT_RO[productType]} ne ocupăm imediat după.` });
  }

  // Oferte / cumpărare de produse.
  if (productType && (wantsToBuy || wantsToPay)) return offers(t, productType, country);

  // ---------- Întrebări despre facturi ----------
  if (!productType && /\bfurnizor(ul|ii|i|ului)?\b|\bde la cine\b|\bcui (ii )?platesc\b|\b(la )?ce firma\b/.test(n)) return providerInfo(t, categories);

  if (!productType && !offersListed && !wantsToPay) {
    if (/\bcate facturi\b/.test(n)) return billCount(t);
    if (/\bcea mai (mare|scumpa)\b|\bcel mai mult\b/.test(n)) return billPick(t, "max");
    if (/\bcea mai (mica|ieftina)\b|\bcel mai putin\b/.test(n)) return billPick(t, "min");
    if (aboutBills && /\b(urgenta|urgent|apropiata)\b|\b(scade|scadenta|expira) prima\b|\bprima (scadenta|factura)\b|\bfactura (e|este|vine) prima\b/.test(n)) return billPick(t, "urgent");
  }

  // „Ce e întârziat?” (înaintea lui „ce facturi am”, care e mai general)
  if (has("intarziate", "intarziata", "restante", "restanta") && !wantsToPay) {
    const bills = result<BillView[]>(t, "list_bills");
    if (!bills) return call("list_bills", { status: "overdue" });
    if (!bills.length) return { text: "Nu ai nicio factură întârziată." };
    return { text: `Ai ${countFacturi(bills.length, "întârziate")}: ${listBillsSpoken(bills)}. ${bills.length === 1 ? "Vrei s-o plătesc?" : "Vrei să le plătesc?"}` };
  }

  // ---------- Privire de ansamblu: termene, situație, ce e mai urgent ----------
  if (plain) {
    if (/\brecomanzi\b|\brecomandare\b|\bsa (fac|incep|platesc) (mai )?intai\b|\bcu ce (sa )?incep\b|\b(ce|care) (e|este) (cel |cea )?mai urgent\b|\bprioritate\b|\bce ma sfatuiesti\b/.test(n)) return priority(t);
    if (/\bce (imi |mi |mai )?expira\b|\btermene(le)?\b|\bce (am|trebuie) (de )?reinnoit\b|\bexpira (ceva|in curand)\b|\bce urmeaza sa expire\b/.test(n)) return deadlines(t);
    if (/\bsituati[ae]\b|\brezumat(ul)?\b|\bsumar\b|\bcum stau\b|\b(e|este) totul (in regula|ok|bine|la zi)\b|\btotul (e|este) (in regula|ok|bine|la zi)\b|\bce am de facut\b|\bce trebuie sa fac\b|\bce e nou\b|\bce noutati\b/.test(n)) return overview(t);
  }

  // „Cât am de plată?” / „Ce facturi am?” / „Am ceva de plată până vineri?” / „Sunt la zi?”
  if (/\b(cat|ce|cate)\b.*\bde (plata|platit|achitat)\b|\bce facturi\b|\bam (ceva|vreo factura|facturi|multe)\b.*\bde (plata|platit|achitat)\b|\bmai am (ceva )?de (plata|platit)\b|\bsunt la zi\b|\bam (datorii|restante)\b|\bcat datorez\b|\bcat trebuie sa platesc\b/.test(n)
    || (/\bfacturile mele\b/.test(n) && !wantsToPay)) {
    return summary(t);
  }

  // „Cât e factura la curent?” → „Și la gaz?” (tot o întrebare, nu o plată)
  const askedToPayInfo = /\bvrei s o platesc\b|\bvrei sa le platesc\b/.test(asked) && !/\bpe care\b/.test(asked);
  if (categories.length && !wantsToPay && askedToPayInfo && /^(si|dar|iar)\b/.test(n)) return billInfo(t, categories);

  // „Cât e factura la apă?” / „Când e scadentă factura la gaz?”
  if (categories.length && !wantsToPay && has("cat", "cand", "scadenta", "scadent", "costa")) return billInfo(t, categories);
  if (categories.length && !wantsToPay && has("suma", "e", "am")) {
    if (!(categories.length === 1 && /\bplatesc\b/.test(asked))) return billInfo(t, categories);
  }

  // Plăți de facturi.
  if (wantsToPay) {
    if (has("toate", "tot", "totul", "toata")) return payBills(t, { all: true });
    if (has("intarziate", "intarziata", "restante", "restanta")) return payBills(t, { overdue: true });
    if (categories.length) return payBills(t, { categories, spokenAmount: parseAmount(n) });
    if (/\b(de la|la)$/.test(n) || n.endsWith(" de")) {
      return { text: "Nu am înțeles bine. Ce factură vrei să plătesc?" };
    }
    if (/\b(pe care|ce factura) vrei\b/.test(asked)) {
      const idx = ordinal(w);
      if (idx !== null) return payBills(t, { index: idx });
    }
    return askWhichBill(t);
  }

  // Răspuns scurt / corectură după „O plătesc acum?” sau „Pe care vrei s-o plătesc?”
  if (categories.length && /\bplat/.test(asked)) return payBills(t, { categories, spokenAmount: parseAmount(n) });
  if (/\bpe care vrei\b/.test(asked)) {
    const idx = ordinal(w);
    if (idx !== null) return payBills(t, { index: idx });
  }

  if (productType) return offers(t, productType, country);
  if (categories.length) return billInfo(t, categories);

  // Răspuns la „Unde pleci?”
  if (/\bunde pleci\b/.test(asked) && w.length <= 5 && w[0] !== "nu" && !has("nicaieri")) {
    const dest = [...w].reverse().find((x) => x.length >= 4 && !NOT_A_PLACE.has(x) && !["plec", "merg", "cred", "poate", "vreau"].includes(x));
    if (dest) return startTrip(t, { country: dest, startInDays: startInDays(n) }, dest);
  }

  // ---------- Nu am înțeles ----------
  if (offersListed) return { text: `${UNCLEAR_OFFER} Poți spune „prima”, „a doua” sau durata, de exemplu „12 luni”.` };
  if (askedConfirm) return { text: UNCLEAR_PENDING }; // aplicația adaugă singură că plata încă așteaptă „da” / „nu”
  const isQuestion = t.userText.includes("?") || /^(ce|cine|care|cum|unde|cand|de ce|cat|cata|cati|cate|stii|poti|spune mi|zi mi)\b/.test(n);
  if (isQuestion) {
    return { text: "La asta nu știu să răspund. Mă pricep la facturi, RCA, rovinietă, roaming și pregătirea unui drum cu mașina. Cu ce te ajut?" };
  }
  // A doua oară la rând: nu mai cer repetarea, ofer alternativa de pe ecran.
  if (/^nu am inteles bine\b/.test(asked)) {
    return { text: "Tot nu am înțeles, îmi pare rău. Poți folosi butoanele de pe ecran sau poți spune „ce poți face” ca să-ți dau exemple." };
  }
  return { text: "Nu am înțeles bine. Pot să plătesc o factură, să-ți spun ce ai de plată sau să verific RCA-ul. Ce vrei să fac?" };
}

// ---------- facturi ----------

function summary(t: Turn): Action {
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", { status: "due" });
  const upToDate = /\bsunt la zi\b/.test(t.norm); // „Sunt la zi cu facturile?” → răspuns cu da / nu
  if (bills.length === 0) return { text: upToDate ? "Da, ești la zi: nu ai nimic de plată." : "Nu ai nimic de plată acum." };

  // „…până vineri” / „săptămâna asta” → doar facturile scadente până atunci (cele întârziate intră mereu).
  const today = addDays(bills[0].dueDate, -bills[0].daysUntilDue);
  const period = parsePeriod(t.norm, today);
  const inPeriod = period ? bills.filter((b) => b.daysUntilDue <= period.days) : bills;
  if (period && inPeriod.length < bills.length) {
    if (!inPeriod.length) {
      const next = [...bills].sort((a, b) => a.daysUntilDue - b.daysUntilDue)[0];
      return { text: `${capitalize(period.label)} nu ai nimic de plată. Următoarea e factura la ${next.categoryRo}, de ${spokenLei(next.amount)}, ${dueSpoken(next)}.` };
    }
    return { text: `${capitalize(period.label)} ai ${describeDue(inPeriod)}` };
  }
  return { text: `${upToDate ? "Nu chiar. " : ""}Ai ${describeDue(bills)}` };
}

/** „trei facturi de plată, în total 337,60 lei: curent …, gaz … și apă …. Factura la gaz e întârziată.” */
function describeDue(bills: BillView[]): string {
  const total = round2(bills.reduce((s, b) => s + b.amount, 0));
  const overdue = bills.filter((b) => b.status === "overdue");
  const late = overdue.length === 1 ? ` Factura la ${overdue[0].categoryRo} e întârziată.`
    : overdue.length > 1 ? ` Facturile la ${joinRo(overdue.map((b) => b.categoryRo))} sunt întârziate.` : "";
  if (bills.length === 1) return `o factură de plată: ${listBillsSpoken(bills)}.${late}`;
  return `${countFacturi(bills.length)} de plată, în total ${spokenLei(total)}: ${listBillsSpoken(bills)}.${late}`;
}

/** „până vineri”, „azi”, „săptămâna asta”, „luna asta”, „în următoarele 5 zile” → câte zile de azi încolo. */
function parsePeriod(norm: string, today: string): { days: number; label: string } | null {
  const [y, m, d] = today.split("-").map(Number);
  const weekday = new Date(y, m - 1, d).getDay(); // 0 = duminică
  const until = norm.match(/\bpana (luni|marti|miercuri|joi|vineri|sambata|duminica)\b/);
  if (until) {
    const target = WEEKDAY_NORM.indexOf(until[1]);
    return { days: (target - weekday + 7) % 7, label: `până ${WEEKDAY_RO[target]}` };
  }
  if (/\b(azi|astazi)\b/.test(norm)) return { days: 0, label: "azi" };
  if (/\bmaine\b/.test(norm)) return { days: 1, label: "până mâine" };
  if (/\bsaptamana (asta|aceasta|curenta)\b/.test(norm)) return { days: (7 - weekday) % 7, label: "săptămâna asta" };
  if (/\bsaptamana viitoare\b/.test(norm)) return { days: ((7 - weekday) % 7) + 7, label: "până la sfârșitul săptămânii viitoare" };
  if (/\bluna (asta|aceasta|curenta)\b/.test(norm)) return { days: new Date(y, m, 0).getDate() - d, label: "luna asta" };
  const next = norm.match(/\b(?:urmatoarele|in) (\d+) (?:de )?zile\b/);
  if (next) return { days: Number(next[1]), label: `în următoarele ${next[1]} ${zile(Number(next[1]))}` };
  return null;
}

/** „Câte facturi am?” */
function billCount(t: Turn): Action {
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", {});
  const due = bills.filter((b) => b.status !== "paid");
  const paid = bills.length - due.length;
  const paidPart = paid === 0 ? "" : paid === 1 ? "una plătită" : `${COUNT_WORDS[paid] ?? paid} plătite`;
  if (!due.length) return { text: paid ? `Nu ai nicio factură de plată. În listă mai e ${paidPart}.` : "Nu ai nicio factură în listă." };
  return { text: `Ai ${countFacturi(due.length)} de plată${paid ? ` și ${paidPart}` : ""}.` };
}

/** „Care e cea mai mare / cea mai mică / cea mai urgentă factură?” */
function billPick(t: Turn, kind: "max" | "min" | "urgent"): Action {
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", { status: "due" });
  if (!bills.length) return { text: "Nu ai nicio factură de plată." };
  const sorted = [...bills].sort((a, b) => (kind === "max" ? b.amount - a.amount : kind === "min" ? a.amount - b.amount : a.daysUntilDue - b.daysUntilDue));
  const b = sorted[0];
  const details = `${spokenLei(b.amount)}, ${dueSpoken(b)}`;
  if (bills.length === 1) return { text: `Ai o singură factură de plată, cea la ${b.categoryRo}: ${details}. Vrei s-o plătesc?` };
  const lead = kind === "max" ? "Cea mai mare factură de plată e cea la" : kind === "min" ? "Cea mai mică factură de plată e cea la" : "Cea mai urgentă e factura la";
  return { text: `${lead} ${b.categoryRo}: ${details}. Vrei s-o plătesc?` };
}

/** „Cine e furnizorul la gaz?” / „De la cine e factura de curent?” */
function providerInfo(t: Turn, categories: BillCategory[]): Action {
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", {});
  if (categories.length) {
    return {
      text: categories.map((c) => {
        const b = bills.find((x) => x.category === c && x.status !== "paid") ?? bills.find((x) => x.category === c);
        return b ? `Factura la ${b.categoryRo} e de la ${b.provider}.` : `Nu am găsit nicio factură la ${CAT_RO[c]}.`;
      }).join(" "),
    };
  }
  const seen = new Set<string>();
  const list = bills.filter((b) => !seen.has(b.category) && seen.add(b.category));
  if (!list.length) return { text: "Nu ai nicio factură în listă." };
  return { text: `Furnizorii tăi sunt: ${joinRo(list.map((b) => `${b.provider} la ${b.categoryRo}`))}.` };
}

/** „Ce facturi am plătit?” */
function paidBills(t: Turn): Action {
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", { status: "paid" });
  if (!bills.length) return { text: "Nu ai nicio factură plătită în listă." };
  return { text: `Ai ${countFacturi(bills.length, "plătite")}: ${listBillsSpoken(bills)}.` };
}

/** „Ce am plătit până acum?” / „Cât am cheltuit?” — plățile făcute prin asistent. */
function paymentHistory(t: Turn): Action {
  const payments = result<PaymentView[]>(t, "list_payments");
  if (!payments) return call("list_payments", {});
  const what = (p: PaymentView) => joinRo(p.lines.map((l) => l.label));
  if (payments.length === 1) return { text: `Ai făcut o plată prin mine: ${what(payments[0])}, ${spokenLei(payments[0].total)}.` };
  if (payments.length > 1) {
    const total = round2(payments.reduce((s, p) => s + p.total, 0));
    const last = payments[payments.length - 1];
    return { text: `Ai făcut ${COUNT_WORDS[payments.length] ?? payments.length} plăți prin mine, în total ${spokenLei(total)}. Ultima: ${what(last)}, ${spokenLei(last.total)}.` };
  }
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", { status: "paid" });
  const already = bills.length === 0 ? ""
    : bills.length === 1 ? ` În listă apare ca plătită factura la ${bills[0].categoryRo}, de ${spokenLei(bills[0].amount)}.`
    : ` În listă apar ca plătite facturile la ${joinRo(bills.map((b) => b.categoryRo))}.`;
  return { text: `Nu ai făcut încă nicio plată prin mine.${already}` };
}

// ---------- privire de ansamblu ----------

/** „factura la gaz e întârziată cu 2 zile”, „RCA-ul expiră în 6 zile” */
function expiringPhrase(i: ExpiringView, bills: BillView[]): string {
  const d = i.daysLeft;
  if (i.kind === "bill") {
    const bill = bills.find((b) => b.id === i.refId);
    const name = bill ? `factura la ${bill.categoryRo}` : i.label.toLowerCase();
    return d < 0 ? `${name} e întârziată cu ${-d} ${zile(-d)}` : d === 0 ? `${name} e scadentă azi` : d === 1 ? `${name} e scadentă mâine` : `${name} e scadentă în ${d} ${zile(d)}`;
  }
  const name = i.kind === "rca" ? "RCA-ul" : "rovinieta";
  return d < 0 ? `${name} a expirat acum ${-d} ${zile(-d)}` : d === 0 ? `${name} expiră azi` : d === 1 ? `${name} expiră mâine` : `${name} expiră în ${d} ${zile(d)}`;
}

/** Cere (dacă lipsesc) termenele din următoarele 30 de zile și lista de facturi. */
function expiringData(t: Turn): { items: ExpiringView[]; bills: BillView[] } | Action {
  const items = result<ExpiringView[]>(t, "get_expiring_items");
  if (!items) return call("get_expiring_items", { days: 30 });
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", {});
  return { items, bills };
}

/** „Ce expiră în curând?” / „Ce termene am?” */
function deadlines(t: Turn): Action {
  const data = expiringData(t);
  if (!("items" in data)) return data;
  const { items, bills } = data;
  if (!items.length) return { text: "Nu expiră nimic în următoarele 30 de zile și nu ai facturi întârziate." };
  const shown = items.slice(0, 5).map((i) => expiringPhrase(i, bills));
  const more = items.length > 5 ? ` Mai sunt încă ${items.length - 5}.` : "";
  return { text: `În următoarele 30 de zile: ${joinRo(shown)}.${more}` };
}

/** „Care e situația mea?” / „Fă-mi un rezumat” / „Totul e în regulă?” */
function overview(t: Turn): Action {
  const data = expiringData(t);
  if (!("items" in data)) return data;
  const due = data.bills.filter((b) => b.status !== "paid");
  const car = data.items.filter((i) => i.kind !== "bill").map((i) => expiringPhrase(i, data.bills));
  if (!due.length && !car.length) return { text: "Totul e în regulă: nu ai facturi de plată și nimic nu expiră în următoarele 30 de zile." };

  const overdue = due.filter((b) => b.status === "overdue").length;
  const late = overdue === 0 ? "" : overdue === 1 ? ", dintre care una întârziată" : `, dintre care ${COUNT_WORDS[overdue] ?? overdue} întârziate`;
  const billsPart = due.length
    ? `Ai ${countFacturi(due.length)} de plată, în total ${spokenLei(round2(due.reduce((s, b) => s + b.amount, 0)))}${late}.`
    : "Nu ai facturi de plată.";
  const carPart = car.length ? ` ${capitalize(joinRo(car))}.` : "";
  return { text: `${billsPart}${carPart} Cu ce vrei să încep?` };
}

/** „Ce îmi recomanzi?” / „Ce e mai urgent?” → cel mai apropiat termen, cu propunerea potrivită. */
function priority(t: Turn): Action {
  const data = expiringData(t);
  if (!("items" in data)) return data;
  const first = data.items[0];
  if (!first) return { text: "Nu e nimic urgent: nu ai facturi de plată și nimic nu expiră în următoarele 30 de zile." };
  const d = first.daysLeft;
  if (first.kind === "bill") {
    const bill = data.bills.find((b) => b.id === first.refId);
    if (bill) {
      const when = d < 0 ? `e întârziată cu ${-d} ${zile(-d)}` : d === 0 ? "e scadentă azi" : d === 1 ? "e scadentă mâine" : `e scadentă în ${d} ${zile(d)}`;
      return { text: `Cel mai urgent e ${ARTICULATED[bill.category]}: factura de ${spokenLei(bill.amount)} ${when}. Vrei s-o plătesc?` };
    }
  }
  if (first.kind === "vignette") return { text: `Cea mai urgentă e rovinieta: ${expiringPhrase(first, data.bills).replace("rovinieta ", "")}. Vrei să-ți arăt ofertele?` };
  return { text: `Cel mai urgent e RCA-ul: ${expiringPhrase(first, data.bills).replace("RCA-ul ", "")}. Vrei să-l reînnoiesc?` };
}

// ---------- plata care așteaptă confirmarea ----------

/** „Ce plătesc?” / „Cât era suma?” — spune din nou ce e pregătit (din date, fără token). */
function pendingInfo(t: Turn): Action {
  const r = t.results.find((x) => x.name === "get_pending_payment");
  if (!r) return call("get_pending_payment", {});
  const p = (r.data as { pending: PendingView | null }).pending;
  if (!p) return { text: "Nu ai nicio plată în așteptare acum." };
  const what = joinRo(p.lines.map((l) => `${l.label}, ${spokenLei(l.amount)}`));
  const total = p.lines.length > 1 ? `, în total ${spokenLei(p.total)}` : "";
  const how = p.requiresScreenConfirm ? "Se confirmă cu butonul de pe ecran." : "Spune „da” ca s-o fac sau „nu” ca s-o anulez.";
  return { text: `Am pregătit: ${what}${total}. ${how}` };
}

/** „Anulează” / „m-am răzgândit” — anularea e mereu sigură. */
function cancelPending(t: Turn): Action {
  const r = t.results.find((x) => x.name === "cancel_pending_payment");
  if (!r) return call("cancel_pending_payment", {});
  return {
    text: (r.data as { cancelled?: boolean }).cancelled
      ? "Bine, am anulat plata. Nu am plătit nimic."
      : "Nu ai nicio plată în așteptare, deci nu am plătit nimic.",
  };
}

// ---------- contul și mașina ----------

function profile(t: Turn, what: "name" | "phone" | "date" | "time"): Action {
  const p = result<ProfileView>(t, "get_profile");
  if (!p) return call("get_profile", {});
  if (what === "name") return { text: `Te cheamă ${p.name}.` };
  if (what === "phone") return { text: `Numărul tău de telefon din cont este ${p.phone}.` };
  if (what === "time") return { text: `E ora ${p.time}.` };
  const [y, m, d] = p.today.split("-").map(Number);
  return { text: `Azi e ${p.weekday}, ${d} ${MONTH_NAMES[m - 1]} ${y}.` };
}

/** „Ce mașină am?” / „Care e seria de șasiu?” */
function vehicleInfo(t: Turn, vin: boolean): Action {
  const v = vehicleOf(t);
  if (v === "pending") return call("get_vehicles", {});
  if (!v) return { text: "Nu am nicio mașină înregistrată în cont. O poți adăuga din fila „Mașina mea”." };
  if (vin) return { text: v.vin ? `Seria de șasiu a mașinii ${v.plate} este ${v.vin}.` : `Nu am seria de șasiu pentru ${v.plate}.` };
  return { text: `Mașina ta este ${v.make} ${v.model}, cu numărul de înmatriculare ${v.plate}.` };
}

/** „Pot circula cu mașina?” → RCA + rovinietă. */
function carStatus(t: Turn): Action {
  const v = vehicleOf(t);
  if (v === "pending") return call("get_vehicles", {});
  if (!v) return { text: "Nu am nicio mașină înregistrată în cont. O poți adăuga din fila „Mașina mea”." };
  const policies = result<PolicyView[]>(t, "check_policies");
  if (!policies) return call("check_policies", { vehicleId: v.id });
  const vignettes = result<VignetteView[]>(t, "check_vignette");
  if (!vignettes) return call("check_vignette", { vehicleId: v.id });

  const rca = [...policies].sort((a, b) => b.daysLeft - a.daysLeft)[0];
  const ro = vignettes.filter((x) => x.country === "RO").sort((a, b) => b.daysLeft - a.daysLeft)[0];
  if (!rca) return { text: `Nu: nu am găsit niciun RCA pentru ${v.plate}, iar fără RCA nu ai voie să circuli. Vrei să-ți arăt ofertele?` };
  if (rca.daysLeft < 0) return { text: `Nu: RCA-ul pentru ${v.plate} a expirat acum ${-rca.daysLeft} ${zile(-rca.daysLeft)}, iar fără RCA nu ai voie să circuli. Vrei să-l reînnoiesc?` };
  if (!ro || ro.daysLeft < 0) {
    return { text: `Rovinieta lipsește pentru ${v.plate}, deși RCA-ul e valabil încă ${rca.daysLeft} ${zile(rca.daysLeft)}. Vrei să-ți arăt ofertele de rovinietă?` };
  }
  const soon = rca.daysLeft <= 14 ? " RCA-ul expiră curând. Vrei să-l reînnoiesc?" : "";
  return { text: `Da. RCA-ul e valabil încă ${rca.daysLeft} ${zile(rca.daysLeft)}, iar rovinieta încă ${ro.daysLeft} ${zile(ro.daysLeft)}.${soon}` };
}

/** „RCA-ul meu e valabil în Bulgaria?” / „Am Carte Verde?” / „Ce țări acoperă?” */
function rcaCoverage(t: Turn, country: string | null): Action {
  const v = vehicleOf(t);
  if (v === "pending") return call("get_vehicles", {});
  if (!v) return { text: "Nu am nicio mașină înregistrată în cont." };
  const policies = result<PolicyView[]>(t, "check_policies");
  if (!policies) return call("check_policies", { vehicleId: v.id });
  const best = [...policies].sort((a, b) => b.daysLeft - a.daysLeft)[0];
  if (!best) return { text: `Nu am găsit niciun RCA pentru ${v.plate}. Vrei să-ți arăt ofertele?` };
  if (best.daysLeft < 0) return { text: `RCA-ul pentru ${v.plate} a expirat acum ${-best.daysLeft} ${zile(-best.daysLeft)}, deci nu mai e valabil nicăieri. Vrei să-l reînnoiesc?` };

  const until = (p: PolicyView) => `E valabil până pe ${dateSpoken(p.validUntil)}, adică încă ${p.daysLeft} ${zile(p.daysLeft)}.`;
  if (country) {
    const covering = policies.filter((p) => p.daysLeft >= 0 && p.countries.includes(country)).sort((a, b) => b.daysLeft - a.daysLeft)[0];
    if (covering) return { text: `Da, RCA-ul tău acoperă ${countryName(country)}. ${until(covering)}` };
    return { text: `Nu, RCA-ul tău nu acoperă ${countryName(country)}. Vrei să-ți arăt ofertele de RCA?` };
  }
  const noTurkey = best.countries.includes("TR") ? "" : " Nu acoperă Turcia.";
  return { text: `RCA-ul tău e valabil în ${joinRo(best.countries.map(countryName))}.${noTurkey} ${until(best)}` };
}

/** „Am roaming?” / „Am internet în Turcia?” */
function servicesStatus(t: Turn, country: string | null): Action {
  const services = result<ServiceView[]>(t, "check_services");
  if (!services) return call("check_services", {});
  const active = services.filter((s) => s.daysLeft >= 0 && (!country || s.country === country));
  const where = country ? ` pentru ${countryName(country)}` : "";
  if (!active.length) return { text: `Nu ai niciun pachet de roaming sau cartelă activă${where}. Vrei să-ți arăt ofertele de roaming?` };
  return {
    text: active.map((s) => {
      const what = s.type === "roaming" ? "un pachet de roaming" : "o cartelă";
      return `Ai ${what} pentru ${countryName(s.country)}, până pe ${dateSpoken(s.validUntil)}, adică încă ${s.daysLeft} ${zile(s.daysLeft)}.`;
    }).join(" "),
  };
}

function askWhichBill(t: Turn): Action {
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", { status: "due" });
  if (bills.length === 0) return { text: "Nu ai nicio factură de plată. Totul e în regulă." };
  if (bills.length === 1) return payBills(t, { categories: [bills[0].category] });
  return { text: `Ai ${countFacturi(bills.length, "neplătite")}: ${listBillsSpoken(bills)}. Pe care vrei s-o plătesc? Pot să le plătesc și pe toate.` };
}

function billInfo(t: Turn, categories: BillCategory[]): Action {
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", {});
  const parts = categories.map((c) => {
    const b = bills.find((x) => x.category === c && x.status !== "paid") ?? bills.find((x) => x.category === c);
    if (!b) return `Nu am găsit nicio factură la ${CAT_RO[c]}.`;
    if (b.status === "paid") return `Factura la ${b.categoryRo} de ${spokenLei(b.amount)} e deja plătită.`;
    return `Factura la ${b.categoryRo} e de ${spokenLei(b.amount)}, ${dueSpoken(b)}.`;
  });
  const due = categories.map((c) => bills.find((x) => x.category === c && x.status !== "paid")).filter((b): b is BillView => Boolean(b));
  // „Am plătit gazul?” → răspuns cu da / nu în față.
  const askedIfPaid = /\bam (platit|achitat)\b/.test(t.norm) && categories.length === 1;
  const lead = !askedIfPaid || !parts[0].startsWith("Factura") ? "" : due.length ? "Nu încă. " : "Da. ";
  const tail = due.length === 0 ? ""
    : due.length === 1 ? " Vrei s-o plătesc?"
    : ` Împreună fac ${spokenLei(round2(due.reduce((s, b) => s + b.amount, 0)))}. Vrei să le plătesc?`;
  return { text: lead + parts.join(" ") + tail };
}

function payBills(
  t: Turn,
  sel: {
    all?: boolean; overdue?: boolean; categories?: BillCategory[]; index?: number; spokenAmount?: number | null; preferAmount?: number | null;
    /** O propoziție în plus, înainte de întrebarea de confirmare. */
    extraNote?: string;
  },
): Action {
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", {});
  const due = bills.filter((b) => b.status !== "paid");

  let chosen: BillView[] = [];
  const missing: string[] = [];
  const alreadyPaid: string[] = [];
  if (sel.all) chosen = due;
  else if (sel.overdue) chosen = due.filter((b) => b.status === "overdue");
  else if (sel.index !== undefined) chosen = due[sel.index === -1 ? due.length - 1 : sel.index] ? [due[sel.index === -1 ? due.length - 1 : sel.index]] : [];
  else {
    for (const c of sel.categories ?? []) {
      const pref = sel.preferAmount;
      const b = (pref != null ? due.find((x) => x.category === c && Math.abs(x.amount - pref) < 0.01) : undefined)
        ?? due.find((x) => x.category === c);
      if (b) chosen.push(b);
      else if (bills.some((x) => x.category === c)) alreadyPaid.push(CAT_RO[c]);
      else missing.push(CAT_RO[c]);
    }
  }

  if (!chosen.length) {
    if (alreadyPaid.length && !missing.length) {
      return { text: alreadyPaid.length === 1 ? `Factura la ${alreadyPaid[0]} este deja plătită.` : `Facturile la ${joinRo(alreadyPaid)} sunt deja plătite.` };
    }
    if (missing.length) return { text: `Nu am găsit nicio factură la ${joinRo(missing)}.` };
    if (sel.overdue) return { text: "Nu ai nicio factură întârziată." };
    return { text: "Nu ai nicio factură de plată. Totul e în regulă." };
  }

  const prepared = t.results.find((r) => r.name === "prepare_payment");
  if (!prepared) return call("prepare_payment", { items: chosen.map((b) => ({ kind: "bill", billId: b.id })) });
  if (!prepared.ok) return { text: "Nu am putut pregăti plata. Mai încerci o dată?" };

  const note = [
    alreadyPaid.length ? ` ${alreadyPaid.length === 1 ? `Factura la ${alreadyPaid[0]} e` : `Facturile la ${joinRo(alreadyPaid)} sunt`} deja plătit${alreadyPaid.length === 1 ? "ă" : "e"}.` : "",
    missing.length ? ` Nu am găsit factură la ${joinRo(missing)}.` : "",
    sel.extraNote ?? "",
  ].join("");

  if (chosen.length === 1) {
    const b = chosen[0];
    // D6: suma spusă de utilizator nu contează; plătim suma din date și o spunem clar.
    if (sel.spokenAmount != null && Math.abs(sel.spokenAmount - b.amount) > 0.009) {
      return { text: `Factura la ${b.categoryRo} este de ${formatLei(b.amount)}, nu ${formatNumber(sel.spokenAmount)}. O plătesc pe cea de ${formatNumber(b.amount)}?` };
    }
    const when = b.status === "overdue" || b.daysUntilDue < 0 ? " și e întârziată" : `, ${dueSpoken(b)}`;
    return { text: `Factura la ${b.categoryRo} este de ${spokenLei(b.amount)}${when}.${note} O plătesc acum?` };
  }

  const total = round2(chosen.reduce((s, b) => s + b.amount, 0));
  const intro = sel.all ? `Toate cele ${COUNT_WORDS[chosen.length] ?? chosen.length} facturi` : capitalize(joinRo(chosen.map((b) => ARTICULATED[b.category])));
  return { text: `${intro}: ${listBillsSpoken(chosen)}, în total ${spokenLei(total)}.${note} Le plătesc acum?` };
}

// ---------- adăugare / ștergere facturi ----------

const ADD_WORDS = new Set(["adauga", "adaug", "adaugam", "adaugi", "introdu", "introduc", "inregistreaza", "noteaza", "trece"]);
const REMOVE_WORDS = new Set(["sterge", "sterg", "stergi", "elimina", "elimin", "scoate", "scot"]);

const MONTHS: Record<string, number> = {
  ianuarie: 1, februarie: 2, martie: 3, aprilie: 4, mai: 5, iunie: 6, iulie: 7,
  august: 8, septembrie: 9, octombrie: 10, noiembrie: 11, decembrie: 12,
};

type DueInput = { dueDate?: string; dueInDays?: number };

/** „pe 25 noiembrie” → 25.11; „pe 25.11” → 25.11; „mâine” → 1 zi; „peste 10 zile” → 10. */
function parseDue(norm: string): DueInput {
  const named = norm.match(/\b(?:pe|la|scadenta|scadent[a-z]*|pana pe|pana la)\s+(\d{1,2})\s+([a-z]+)/);
  if (named && MONTHS[named[2]]) return { dueDate: `${Number(named[1])}.${MONTHS[named[2]]}` };
  const numeric = norm.match(/\b(?:pe|scadenta|scadent[a-z]*|pana pe)\s+(\d{1,2})\s(\d{1,2})\b(?!\s*(?:de\s)?lei)/);
  if (numeric) return { dueDate: `${Number(numeric[1])}.${Number(numeric[2])}` };
  if (/\bpoimaine\b/.test(norm)) return { dueInDays: 2 };
  if (/\bmaine\b/.test(norm)) return { dueInDays: 1 };
  if (/\bazi\b/.test(norm)) return { dueInDays: 0 };
  const peste = norm.match(/\bpeste (\d+) (zile|saptamani)\b/);
  if (peste) return { dueInDays: Number(peste[1]) * (peste[2] === "saptamani" ? 7 : 1) };
  if (/\bsaptamana viitoare\b/.test(norm)) return { dueInDays: 7 };
  if (/\bluna viitoare\b/.test(norm)) return { dueInDays: 30 };
  return {};
}

/** Scadența spusă oriunde în ultimele mesaje ale cererii (cea mai recentă câștigă). */
function dueFromRecent(t: Turn): DueInput {
  return [...t.recentUserNorms, t.norm].reduce<DueInput>((acc, n) => {
    const d = parseDue(n);
    return d.dueDate || d.dueInDays !== undefined ? d : acc;
  }, {});
}

/** O sumă spusă și fără „lei” (ca răspuns la „Ce sumă are factura?”): „42”, „42 50”, „patruzeci și doi”. */
function amountLoose(norm: string): number | null {
  return parseAmount(norm) ?? parseAmount(`${norm} lei`);
}

/** „…de la Orange…” → „Orange” (furnizorul, dacă e spus). */
function providerIn(t: Turn): string | null {
  const m = t.norm.match(/\bde la ([a-z]+)/);
  if (!m || CATEGORY_WORDS[m[1]] || /^\d/.test(m[1]) || UNITS[m[1]] || TENS[m[1]]) return null;
  return originalWord(t.userText, m[1]);
}

function addBill(t: Turn, category: BillCategory | undefined, amount: number | null, due: DueInput, provider: string | null): Action {
  const added = t.results.find((r) => r.name === "add_bill");
  if (added) {
    if (!added.ok) return { text: `Nu am putut adăuga factura: ${String((added.data as { message?: string }).message ?? "date greșite")}` };
    const b = added.data as BillView;
    const when = b.daysUntilDue < 0 ? `cu scadența pe ${dateSpoken(b.dueDate)}, deci deja întârziată` : `scadentă pe ${dateSpoken(b.dueDate)}`;
    return { text: `Am adăugat factura la ${b.categoryRo} de ${spokenLei(b.amount)}, ${when}. Vrei s-o plătesc?` };
  }
  if (!category) return { text: "La ce e factura: curent, gaz, apă, internet sau telefon?" };
  if (amount === null) return { text: `Ce sumă are factura la ${CAT_RO[category]}?` };
  return call("add_bill", { category, amount, ...(provider ? { provider } : {}), ...due });
}

function removeBill(t: Turn, category: BillCategory | undefined, amount: number | null): Action {
  const removed = t.results.find((r) => r.name === "remove_bill");
  if (removed) {
    const b = (removed.data as { removed: BillView | null }).removed;
    return { text: b ? `Am șters factura la ${b.categoryRo} de ${spokenLei(b.amount)}.` : "Am șters factura." };
  }
  if (!category) return { text: "Ce factură vrei să șterg? Spune-mi tipul, de exemplu „factura la telefon”." };
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", {});
  const matching = bills.filter((b) => b.category === category);
  if (!matching.length) return { text: `Nu am găsit nicio factură la ${CAT_RO[category]}.` };
  // Dacă a spus suma, o alegem pe aceea; altfel pe cea mai nouă (ultima adăugată).
  const pick = (amount !== null ? matching.find((b) => Math.abs(b.amount - amount) < 0.01) : undefined) ?? matching[matching.length - 1];
  return call("remove_bill", { billId: pick.id });
}

// ---------- mașina și produse ----------

function vehicleOf(t: Turn): Vehicle | null | "pending" {
  const vehicles = result<Vehicle[]>(t, "get_vehicles");
  if (!vehicles) return "pending";
  return vehicles[0] ?? null;
}

function rcaStatus(t: Turn): Action {
  const v = vehicleOf(t);
  if (v === "pending") return call("get_vehicles", {});
  if (!v) return { text: "Nu am nicio mașină înregistrată în cont." };
  const policies = result<PolicyView[]>(t, "check_policies");
  if (!policies) return call("check_policies", { vehicleId: v.id });
  const best = [...policies].sort((a, b) => b.daysLeft - a.daysLeft)[0];
  if (!best) return { text: `Nu am găsit niciun RCA pentru ${v.plate}. Vrei să-ți arăt ofertele?` };
  if (best.daysLeft < 0) return { text: `RCA-ul pentru ${v.plate} a expirat acum ${-best.daysLeft} ${zile(-best.daysLeft)}. Fără RCA nu ai voie să circuli. Vrei să-l reînnoiesc?` };
  const tr = best.countries.includes("TR") ? "" : " Nu acoperă Turcia.";
  const soon = best.daysLeft <= 30 ? " Vrei să-l reînnoiesc?" : "";
  return { text: `RCA-ul pentru ${v.plate} e valabil până pe ${dateSpoken(best.validUntil)}, adică încă ${best.daysLeft} ${zile(best.daysLeft)}.${tr}${soon}` };
}

function vignetteStatus(t: Turn, country: string | null): Action {
  const v = vehicleOf(t);
  if (v === "pending") return call("get_vehicles", {});
  if (!v) return { text: "Nu am nicio mașină înregistrată în cont." };
  const vignettes = result<VignetteView[]>(t, "check_vignette");
  if (!vignettes) return call("check_vignette", { vehicleId: v.id });
  const c = country ?? "RO";
  const name = c === "RO" ? "Rovinieta" : c === "BG" ? "Vinieta pentru Bulgaria" : `Vinieta pentru ${c}`;
  const found = vignettes.filter((x) => x.country === c).sort((a, b) => b.daysLeft - a.daysLeft)[0];
  if (!found || found.daysLeft < 0) return { text: `${name} lipsește pentru ${v.plate}. Vrei să-ți arăt ofertele?` };
  return { text: `${name} pentru ${v.plate} e valabilă până pe ${dateSpoken(found.validUntil)}, adică încă ${found.daysLeft} ${zile(found.daysLeft)}.` };
}

function productsFor(t: Turn, type: ProductType, country: string | null): Product[] | null {
  const all = result<Product[]>(t, "search_products");
  if (!all) return null;
  let list = all.filter((p) => p.type === type);
  if (type === "vignette") list = list.filter((p) => p.country === (country ?? "RO"));
  else if (country && type !== "rca") list = list.filter((p) => p.country === country);
  return list;
}

/** „RCA”, „rovinietă”, „vinietă pentru Bulgaria”… */
function offerKind(type: ProductType, country: string | null): string {
  return type === "vignette" && country === "BG" ? "vinietă pentru Bulgaria" : PRODUCT_RO[type];
}

/** `prefix` = ce spun înainte (ex. „Gata, am plătit gazul. ”). */
function offers(t: Turn, type: ProductType, country: string | null, prefix = ""): Action {
  const list = productsFor(t, type, country);
  if (!list) return call("search_products", { type });
  if (!list.length) return { text: `${prefix}Nu am oferte de ${PRODUCT_RO[type]}${country ? " pentru " + countryName(country) : ""} acum.` };
  if (list.length === 1) return chooseOffer(t, type, country, list[0], prefix);
  return { text: `${prefix}Am ${COUNT_WORDS[list.length] ?? list.length} oferte de ${offerKind(type, country)}: ${joinRo(list.map((p) => `${shortName(p)} ${spokenLei(p.price)}`))}. Care te interesează?` };
}

/** „Ce RCA îmi recomanzi?” / „Care e diferența?” — compară ofertele din catalog, fără să aleagă în locul utilizatorului. */
function recommendOffer(t: Turn, type: ProductType, country: string | null): Action {
  const list = productsFor(t, type, country);
  if (!list) return call("search_products", { type });
  if (list.length < 2) return offers(t, type, country);
  const cheapest = [...list].sort((a, b) => a.price - b.price)[0];
  const perDay = (p: Product) => p.price / Math.max(1, p.durationDays);
  const bestValue = [...list].sort((a, b) => perDay(a) - perDay(b))[0];
  const turkey = type === "rca" ? list.find((p) => p.countries?.includes("TR")) : undefined;

  const parts = [`Dintre ofertele de ${offerKind(type, country)}, cea mai ieftină este cea de ${shortName(cheapest)}, ${spokenLei(cheapest.price)}.`];
  if (bestValue !== cheapest) parts.push(`Cea de ${shortName(bestValue)} costă ${spokenLei(bestValue.price)}, dar iese mai ieftin pe zi.`);
  if (turkey && turkey !== cheapest && turkey !== bestValue) parts.push(`Cea cu Turcia, ${spokenLei(turkey.price)}, îți trebuie doar dacă mergi cu mașina acolo.`);
  return { text: `${parts.join(" ")} Care te interesează?` };
}

function chooseOffer(t: Turn, type: ProductType, country: string | null, forced?: Product, prefix = ""): Action {
  const list = productsFor(t, type, country);
  if (!list) return call("search_products", { type });

  let pick = forced ?? null;
  if (!pick) {
    const w = t.words;
    const idx = ordinal(w);
    const nums = numbersIn(w);
    if (w.includes("ieftina") || w.includes("ieftin")) pick = [...list].sort((a, b) => a.price - b.price)[0];
    else if (w.includes("scumpa") || w.includes("scump")) pick = [...list].sort((a, b) => b.price - a.price)[0];
    else if (w.some((x) => COUNTRY_WORDS[x] === "TR") && type === "rca") pick = list.find((p) => p.countries?.includes("TR")) ?? null;
    else if (w.includes("weekend") || (w.includes("week") && w.includes("end"))) pick = list.find((p) => normalize(p.name).includes("week")) ?? null;
    else if (idx !== null && !w.includes("luni") && !w.includes("zile") && !w.includes("luna")) pick = list[idx === -1 ? list.length - 1 : idx] ?? null;
    else if (nums.length) {
      const matching = list.filter((p) => nums.some((n) => normalize(p.name).split(" ").includes(String(n))));
      pick = matching.sort((a, b) => a.name.length - b.name.length)[0] ?? null;
    }
  }
  if (!pick) return { text: `${UNCLEAR_OFFER} Poți spune „prima”, „a doua” sau durata, de exemplu „12 luni”.` };

  const prepared = t.results.find((r) => r.name === "prepare_payment");
  if (!prepared) return call("prepare_payment", { items: [{ kind: "product", productId: pick.id }] });
  if (!prepared.ok) return { text: "Nu am putut pregăti plata. Mai încerci o dată?" };
  const pronoun = type === "rca" || type === "roaming" ? "Îl" : "O";
  const screen = pick.price > 500 ? " E peste 500 de lei, așa că o confirmi cu butonul de pe ecran." : "";
  return { text: `${prefix}${pick.name} costă ${spokenLei(pick.price)}.${screen} ${pronoun} cumpăr?` };
}

// ---------- călătorii ----------

function tripResult(t: Turn): TripCheck | null {
  const r = [...t.results].reverse().find((x) => x.name === "run_trip_checklist");
  return r && r.ok ? (r.data as TripCheck) : null;
}

function startTrip(t: Turn, input: Record<string, unknown>, spokenCountry: string): Action {
  const check = tripResult(t);
  if (!check || (check.known && input.withCar !== undefined && check.withCar !== input.withCar)) {
    return call("run_trip_checklist", input);
  }
  if (!check.known) {
    const country = originalWord(t.userText, spokenCountry);
    return { text: `Pentru ${country} nu am încă informații despre ce acte sunt necesare, deci nu vreau să-ți dau indicații greșite. Te pot ajuta cu facturile sau cu roamingul.` };
  }
  if (check.withCar === null) return { text: "Pot să te ajut să te pregătești. Mașina o iei cu tine?" };

  const missing = check.items.filter((i) => i.status === "missing");
  if (!missing.length) return { text: `Am verificat: ai tot ce-ți trebuie ${check.inName}. Drum bun!` };

  // Fără mașină sau doar internetul lipsește → direct la internet.
  const carMissing = missing.filter((i) => i.id !== "internet");
  if (!carMissing.length) {
    return { text: `${check.withCar === false ? "Atunci ai" : "Ai"} nevoie în principal de internet ${check.inName}. Îți arăt pachetele de roaming sau o cartelă locală?` };
  }

  const sentences = carMissing.map((i) => describeMissing(i, check.name));
  const n = check.items.length;
  return { text: `Am verificat ${COUNT_WORDS[n] ?? n} lucruri. ${sentences.join(" ")} Începem cu ${carMissing[0].short}?` };
}

function describeMissing(i: TripItem, countryName: string): string {
  if (i.id === "rca") {
    const d = i.currentDaysLeft ?? 0;
    const parts: string[] = [];
    if (i.reasons.includes("missing")) parts.push("nu ai RCA");
    if (i.reasons.includes("expired")) parts.push("RCA-ul tău a expirat");
    if (i.reasons.includes("expires_before_trip")) parts.push(`RCA-ul tău expiră în ${d} ${zile(d)}, înainte de plecare`);
    if (i.reasons.includes("expires_during_trip")) parts.push(`RCA-ul tău expiră în ${d} ${zile(d)}, deci în timpul călătoriei`);
    if (i.reasons.includes("not_covered")) parts.push(`Cartea Verde actuală nu acoperă ${countryName}`);
    return capitalize(parts.join(", iar ")) + ".";
  }
  return `Îți lipsește și ${i.short}.`;
}

/** Propune următorul lucru care lipsește din călătorie. `prefix` = „Gata. ” după o cumpărare. */
function nextTripStep(t: Turn, prefix: string): Action {
  const check = tripResult(t);
  if (!check) return call("run_trip_checklist", { ...t.tripInput });
  if (!check.known) return { text: `${prefix}Spune-mi dacă mai ai nevoie de ceva.`.trim() };

  const next = check.items.find((i) => i.status === "missing");
  if (!next) return { text: `${prefix}Acum ai tot ce-ți trebuie ${check.inName}. Drum bun!` };

  if (next.alternatives?.length || !next.suggestedProduct) {
    return { text: `${prefix}Mai ai nevoie și de internet ${check.inName}. Îți arăt pachetele de roaming sau o cartelă locală?` };
  }

  const p = next.suggestedProduct;
  const prepared = t.results.find((r) => r.name === "prepare_payment");
  if (!prepared) return call("prepare_payment", { items: [{ kind: "product", productId: p.id }] });
  if (!prepared.ok) return { text: "Nu am putut pregăti plata. Mai încerci o dată?" };
  const pronoun = next.productType === "rca" || next.productType === "roaming" ? "Îl" : "O";
  const screen = p.price > 500 ? " E peste 500 de lei, așa că o confirmi cu butonul de pe ecran." : "";
  if (prefix) return { text: `${prefix}Urmează ${next.short}: ${shortName({ ...p, type: next.productType, durationDays: 0 })} costă ${spokenLei(p.price)}.${screen} ${pronoun} cumpăr?` };
  return { text: `${p.name} costă ${spokenLei(p.price)}.${screen} ${pronoun} cumpăr?` };
}

const SMALL_NUMBERS: Record<string, number> = { o: 1, un: 1, una: 1, doua: 2, doi: 2, trei: 3, patru: 4, cinci: 5, sase: 6, sapte: 7, opt: 8, noua: 9, zece: 10 };
const NUM = "(\\d+|o|un|una|doua|doi|trei|patru|cinci|sase|sapte|opt|noua|zece)";
const UNIT = "(zi|zile|saptamana|saptamani|luna|luni)";
const START_IN = new RegExp(`\\b(?:peste|in) ${NUM} (?:de )?${UNIT}\\b`);
const STAY_FOR = new RegExp(`(?<!\\bpeste )(?<!\\bin )\\b${NUM} (?:de )?${UNIT}\\b`);

/** „10” + „zile” → 10; „două” + „săptămâni” → 14; „o” + „lună” → 30. */
function spanDays(count: string, unit: string): number {
  const k = /^\d+$/.test(count) ? Number(count) : SMALL_NUMBERS[count] ?? 1;
  return k * (unit.startsWith("sapt") ? 7 : unit.startsWith("lun") ? 30 : 1);
}

/** „săptămâna viitoare” → 7, „mâine” → 1, „peste 10 zile” → 10, „peste două săptămâni” → 14. Implicit 7. */
function startInDays(norm: string): number {
  if (/\bpoimaine\b/.test(norm)) return 2;
  if (/\bmaine\b/.test(norm)) return 1;
  if (/\bluna viitoare\b/.test(norm)) return 30;
  const m = norm.match(START_IN);
  if (m) return spanDays(m[1], m[2]);
  if (/\b(azi|astazi|diseara)\b/.test(norm)) return 0;
  return 7;
}

/** Cât durează călătoria, dacă a spus: „pentru 10 zile”, „două săptămâni”. Altfel nimic (motorul presupune 7 zile). */
function tripDays(norm: string): number | undefined {
  const m = norm.match(STAY_FOR);
  return m ? spanDays(m[1], m[2]) : undefined;
}

const TRIP_VERB = /\b(?:plec|plecam|merg|mergem|calatoresc|calatorim|zbor|zburam|duc|ducem|conduc|ajung|vizitez|vizitam|vacanta|concediu|concediul|excursie|excursia|calatorie|calatoria)\b(.*)$/;
const TRAVEL_WORDS = new Set(["vacanta", "concediu", "concediul", "excursie", "excursia", "calatorie", "calatoria", "strainatate", "drum", "drumul", "plecare"]);

/** Primul loc de după „în / la / spre…” care nu e un cuvânt obișnuit. „?” = vorbește de plecare, dar nu spune unde. */
function placeAfterPreposition(text: string): string | "?" | null {
  let travel = false;
  for (const p of text.matchAll(/\b(?:in|spre|catre|la|pentru|prin) ([a-z]+)/g)) {
    const word = p[1];
    if (TRAVEL_WORDS.has(word)) { travel = true; continue; }
    if (word.length < 4 || NOT_A_PLACE.has(word) || MONTH_NAMES.includes(word) || WEEKDAY_NORM.includes(word)) continue;
    return word;
  }
  return travel ? "?" : null;
}

/** „Plec în Turcia” → „turcia”; „Plec în vacanță” → „?”; altceva → null. */
function tripDestination(norm: string): string | "?" | null {
  const m = norm.match(TRIP_VERB);
  if (!m) return null;
  return placeAfterPreposition(m[1]) ?? (/\b(plec|plecam|calatoresc|calatorim)\b/.test(norm) ? "?" : null);
}

/** „Ce îmi trebuie pentru Turcia?” / „Ce acte îmi trebuie în Bulgaria?” → „turcia” / „bulgaria”. */
function needDestination(norm: string): string | "?" | null {
  if (!/\b(trebuie|nevoie|acte|actele|documente|documentele|pregatesc|pregatim)\b/.test(norm)) return null;
  return placeAfterPreposition(norm);
}

/** „În ce țări mă poți ajuta?” / „Plec în vacanță” (fără țară) → țările pentru care există reguli. */
function tripCountries(t: Turn): Action {
  const list = result<{ name: string }[]>(t, "list_trip_countries");
  if (!list) return call("list_trip_countries", {});
  if (!list.length) return { text: "Nu am încă reguli de călătorie pentru nicio țară." };
  // Citită cu voce, o listă lungă obosește: până la 5 țări le spunem pe toate, altfel câteva exemple.
  const names = list.map((c) => c.name);
  const which = names.length <= 5 ? joinRo(names) : `${names.length} de țări, de exemplu ${joinRo(names.slice(0, 5))}`;
  return { text: `Am reguli de călătorie pentru ${which}. Sunt orientative, de verificat din surse oficiale înainte de drum. Unde pleci?` };
}

// ---------- după o decizie luată în cod ----------

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
      // În mijlocul pregătirii unei călătorii → propunem următorul lucru (D3).
      if (t.tripInput && payment.lines.some((l) => l.kind === "product")) return nextTripStep(t, "Gata. ");
      const bills = result<BillView[]>(t, "list_bills");
      if (!bills) return call("list_bills", {});
      const what = joinRo(payment.lines.map((l) => (l.kind === "bill" ? bills.find((b) => b.id === l.refId)?.categoryRo ?? l.label : l.label)));
      // „Plătește gazul și cumpără rovinietă”: factura e plătită → trecem la produsul cerut în aceeași frază.
      const request = t.prevUserNorm.split(" ");
      const alsoWanted = findProductType(request);
      if (alsoWanted && payment.lines.every((l) => l.kind === "bill") && findCategories(request).length && request.some((x) => BUY_VERBS.has(x))) {
        return offers(t, alsoWanted, countryIn(request.join(" ")), `Gata, am plătit ${spokenLei(payment.total)} pentru ${what}. `);
      }
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

// ---------- recunoaștere ----------

/** Potrivire cu toleranță: o literă greșită/lipsă în cuvinte de cel puțin 5 litere (greșeli de recunoaștere vocală). */
function lookup<T>(dict: Record<string, T>, word: string): T | undefined {
  if (word in dict) return dict[word];
  if (word.length < 5) return undefined;
  for (const key of Object.keys(dict)) {
    if (key.length >= 5 && Math.abs(key.length - word.length) <= 1 && editDistance(key, word) <= 1) return dict[key];
  }
  return undefined;
}

function findCategories(words: string[]): BillCategory[] {
  const found: BillCategory[] = [];
  for (let i = 0; i < words.length; i++) {
    if (NOT_A_CATEGORY.has(words[i])) continue;
    const c = words[i] === "apa" && words[i + 1] === "calda" ? "water" : lookup(CATEGORY_WORDS, words[i]);
    if (c && !found.includes(c)) found.push(c);
  }
  return found;
}

/** Cuvinte care seamănă cu o factură, dar nu sunt: „luna curentă”, „în cazul ăsta”. */
const NOT_A_CATEGORY = new Set(["curenta", "curente", "cazul", "mobila"]);

function findProductType(words: string[]): ProductType | null {
  for (const w of words) {
    if (NOT_A_PRODUCT.has(w)) continue;
    const p = lookup(PRODUCT_WORDS, w);
    if (p) return p;
  }
  return null;
}

function typeFromText(norm: string): ProductType | null {
  return findProductType(norm.split(" "));
}

function countryIn(norm: string): string | null {
  for (const w of norm.split(" ")) if (COUNTRY_WORDS[w]) return COUNTRY_WORDS[w];
  return null;
}

/** „prima” → 0, „a doua” → 1, „a treia” → 2, „ultima” → -1 */
function ordinal(words: string[]): number | null {
  if (words.some((x) => ["prima", "primul", "1"].includes(x))) return 0;
  if (words.some((x) => ["doua", "doilea", "2"].includes(x)) && !words.includes("sute")) return 1;
  if (words.some((x) => ["treia", "treilea", "3"].includes(x))) return 2;
  if (words.some((x) => ["patra", "patrulea", "4"].includes(x))) return 3;
  if (words.some((x) => ["ultima", "ultimul"].includes(x))) return -1;
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  doi: 2, doua: 2, trei: 3, patru: 4, cinci: 5, sase: 6, sapte: 7, opt: 8, noua: 9, zece: 10,
  douasprezece: 12, doisprezece: 12, cincisprezece: 15, treizeci: 30,
};

/** Numerele dintr-o frază (cifre sau cuvinte): „12 luni”, „șase luni”, „30 de zile”. */
function numbersIn(words: string[]): number[] {
  const out: number[] = [];
  for (const w of words) {
    if (/^\d+$/.test(w)) out.push(Number(w));
    else if (w in NUMBER_WORDS) out.push(NUMBER_WORDS[w]);
  }
  return out;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// ---------- ajutoare ----------

function call(name: string, input: Record<string, unknown>): Action {
  return { tool: { name, input } };
}

function result<T>(t: Turn, name: string): T | null {
  const r = t.results.find((x) => x.name === name);
  return r && r.ok ? (r.data as T) : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const zile = (n: number) => (n === 1 ? "zi" : n >= 20 ? "de zile" : "zile");

/** 187.4 → „187,40 lei”; 56 → „56 de lei”; 15 → „15 lei” (regula lui „de” în română). */
export function spokenLei(n: number): string {
  if (!Number.isInteger(n)) return formatLei(n);
  const lastTwo = n % 100;
  return (lastTwo === 0 && n > 0) || lastTwo >= 20 ? `${n} de lei` : `${n} lei`;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ",");
}

function dateSpoken(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function dueSpoken(b: BillView): string {
  if (b.status === "overdue" || b.daysUntilDue < 0) return `era scadentă pe ${dateSpoken(b.dueDate)}, deci e întârziată`;
  if (b.daysUntilDue === 0) return "scadentă azi";
  if (b.daysUntilDue === 1) return "scadentă mâine";
  return `scadentă în ${b.daysUntilDue} ${zile(b.daysUntilDue)}`;
}

function countFacturi(n: number, adj?: string): string {
  const word = n === 1 ? "factură" : "facturi";
  const adjForm = adj ? ` ${n === 1 ? adj.replace(/e$/, "ă") : adj}` : ""; // „neplătite” → „neplătită”
  return `${n <= 10 ? COUNT_WORDS[n] : n} ${word}${adjForm}`;
}

function listBillsSpoken(bills: BillView[]): string {
  return joinRo(bills.map((b) => `${b.categoryRo} ${spokenLei(b.amount)}`));
}

function joinRo(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} și ${parts.at(-1)}`;
}

/** „RCA 12 luni cu Carte Verde valabilă și în Turcia” → „12 luni cu Turcia”; „Rovinietă 7 zile” → „7 zile”. */
function shortName(p: Product): string {
  let s = p.name
    .replace(/^(RCA|Rovinietă|Vinietă Bulgaria|Pachet roaming Turcia|Cartelă prepay Turcia)\s*/i, "")
    .replace("cu Carte Verde valabilă și în Turcia", "cu Turcia");
  if (!s) s = p.name;
  return s;
}

function countryName(code: string): string {
  return COUNTRIES.find((c) => c.code === code)?.name ?? code;
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
    else if (matched) break;
    else { current = 0; }
  }
  return matched ? total + current : null;
}
