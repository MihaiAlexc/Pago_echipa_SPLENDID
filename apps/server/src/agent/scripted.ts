import type Anthropic from "@anthropic-ai/sdk";
import { formatLei, type BillCategory, type Product, type ProductType } from "@pago/shared";
import { normalize } from "../payments/intent.ts";
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
 *  - călătorii: spune cinstit că nu are încă reguli (vin la Pasul 4).
 *
 * Siguranța NU depinde de el: confirmarea plăților se face în cod (payments/confirmation.ts).
 */

type Block = Anthropic.Beta.BetaContentBlock;
type ToolCall = { name: string; input: Record<string, unknown> };

type BillView = {
  id: string; category: BillCategory; categoryRo: string; provider: string; amount: number;
  dueDate: string; daysUntilDue: number; status: "unpaid" | "paid" | "overdue";
};
type Vehicle = { id: string; plate: string; make: string; model: string };
type PolicyView = { validUntil: string; daysLeft: number; countries: string[] };
type VignetteView = { country: string; validUntil: string; daysLeft: number };

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
  rca: "RCA", vignette: "rovinietă", roaming: "roaming", sim: "cartelă",
};

const COUNTRY_WORDS: Record<string, string> = {
  bulgaria: "BG", bulgariei: "BG", turcia: "TR", turciei: "TR", romania: "RO", romaniei: "RO",
};

const PAY_WORDS = new Set(["plateste", "platesc", "platesti", "plati", "platim", "platiti", "plateasca", "platesteo", "plateste-o"]);
const BUY_WORDS = new Set(["cumpara", "cumpar", "cumparam", "cumpere", "reinnoieste", "reinnoiesc", "reinnoi", "reinnoim", "prelungeste", "prelungesc", "ia", "fa", "oferte", "ofertele", "oferta", "arata", "vreau"]);
const GREETINGS = new Set(["buna", "salut", "hei", "hello", "neata", "servus"]);
const THANKS = new Set(["multumesc", "mersi", "multumim", "merci"]);
const YES_WORDS = new Set(["da", "vreau", "sigur", "ok", "bine", "te", "rog", "arata", "mi", "le", "ofertele", "dami", "da-mi"]);

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
  lastAssistantText: string;
  lastAssistantNorm: string;
  /** Ultima verificare de călătorie din conversație (ca să știm la ce țară ne referim mai târziu). */
  tripInput: Record<string, unknown> | null;
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
  const turn: Turn = { userText: "", norm: "", words: [], event: null, results: [], lastAssistantText: "", lastAssistantNorm: "", tripInput: null };
  for (const m of messages) {
    for (const b of blocks(m)) if (b.type === "tool_use" && b.name === "run_trip_checklist") turn.tripInput = b.input ?? null;
  }
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
    if (messages[i].role === "assistant") {
      turn.lastAssistantText = blocks(messages[i]).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
      break;
    }
  }
  turn.lastAssistantNorm = normalize(turn.lastAssistantText);
  return turn;
}

// ---------- decizia ----------

type Action = { tool: ToolCall } | { text: string };

function decide(t: Turn): Action {
  if (t.event) return afterEvent(t);

  const w = t.words;
  const has = (...xs: string[]) => xs.some((x) => w.includes(x));
  const categories = findCategories(w);
  const productType = findProductType(w);
  const wantsToPay = w.some((x) => PAY_WORDS.has(x) || x.startsWith("achit")) || /\bscap de\b/.test(t.norm);
  const wantsToBuy = w.some((x) => BUY_WORDS.has(x));
  const asked = t.lastAssistantNorm;

  // Salut / mulțumesc / ajutor (doar mesaje scurte, ca să nu acopere o cerere reală).
  if (w.length <= 4 && w.some((x) => THANKS.has(x))) return { text: "Cu plăcere! Mai am ceva de făcut pentru tine?" };
  if (w.length <= 4 && w.some((x) => GREETINGS.has(x)) && categories.length === 0 && !productType) {
    return { text: "Bună! Pot să plătesc facturi, să-ți spun ce ai de plată sau să verific RCA-ul și rovinieta. Cu ce încep?" };
  }
  if (/\b(ce (poti|stii) (face|sa faci)|ajutor|ajuta ma|cum functionezi)\b/.test(t.norm)) {
    return { text: "Pot să-ți plătesc facturile, să-ți spun ce ai de plată și când e scadența, să verific RCA-ul și rovinieta și să-ți arăt oferte de RCA, viniete sau roaming. Plățile le fac doar după ce îmi spui „da”." };
  }

  // ---------- Călătorii (D3): regulile decid, eu doar povestesc ----------
  const trip = t.norm.match(/\b(?:plec|plecam|merg|mergem|calatoresc|calatorim|zbor|zburam|duc)\b.*?\b(?:in|spre|catre|la) ([a-z]+)/);
  if (trip && !categories.length) {
    const withCar = /\bcu masina\b/.test(t.norm) ? true : /\b(avion|avionul|autocar|autocarul|trenul|tren|fara masina)\b/.test(t.norm) ? false : undefined;
    return startTrip(t, { country: trip[1], startInDays: startInDays(t.norm), ...(withCar === undefined ? {} : { withCar }) }, trip[1]);
  }
  if (t.tripInput && /\bmasina o iei\b/.test(asked)) {
    const no = w[0] === "nu" || has("avion", "avionul", "autocar", "autocarul", "tren", "trenul", "fara");
    const yes = w[0] === "da" || has("iau", "sigur", "masina");
    if (no || yes) return startTrip(t, { ...t.tripInput, withCar: !no }, String(t.tripInput.country));
  }
  if (t.tripInput && w.length <= 5 && w[0] === "da" && /\bincepem cu\b/.test(asked)) return nextTripStep(t, "");
  if (/\bpachetele de roaming\b/.test(asked)) {
    const country = countryIn(normalize(String(t.tripInput?.country ?? ""))) ?? countryIn(asked);
    if (has("cartela", "cartele", "locala", "sim")) return offers(t, "sim", country);
    if (w[0] === "da" || has("roaming", "pachet", "pachetele", "pachetul", "roamingul")) return offers(t, "roaming", country);
  }

  // Răspuns scurt la o întrebare de-a mea („Vrei să-l reînnoiesc?” → „da”).
  const shortYes = w.length > 0 && w.length <= 5 && w[0] === "da" && w.every((x) => YES_WORDS.has(x));
  if (shortYes && /\b(reinnoiesc|ofertele|oferte)\b/.test(asked)) {
    return offers(t, typeFromText(asked) ?? "rca", countryIn(asked));
  }
  // „Vrei s-o plătesc?” / „Vrei să le plătesc?” → „da”
  if (shortYes && /\bvrei s(a)? ?(o|le) platesc\b/.test(asked)) {
    if (/\bintarziat/.test(asked)) return payBills(t, { overdue: true });
    const cats = findCategories(asked.split(" "));
    if (cats.length) return payBills(t, { categories: cats });
  }
  if (w.length <= 3 && (w[0] === "nu" || w[0] === "lasa") && !categories.length && !productType) {
    return { text: "Bine. Spune-mi dacă mai ai nevoie de ceva." };
  }

  // Alegerea unei oferte, după ce le-am listat („a doua”, „cea de 12 luni”, „cea mai ieftină”).
  if (/\bcare te intereseaza\b/.test(asked) && !wantsToPay) {
    const type = productType ?? typeFromText(asked);
    if (type) return chooseOffer(t, type, countryIn(asked) ?? countryIn(t.norm));
  }

  // Mașina: cât mai e valabil RCA-ul / rovinieta (întrebare, nu cumpărare).
  const statusQuestion = has("cand", "mai", "valabil", "valabila", "expira", "am", "ce", "pana", "status");
  if (productType && !wantsToBuy && !wantsToPay && statusQuestion) {
    if (productType === "rca") return rcaStatus(t);
    if (productType === "vignette") return vignetteStatus(t, countryIn(t.norm));
  }

  // Oferte / cumpărare de produse.
  if (productType && (wantsToBuy || wantsToPay)) return offers(t, productType, countryIn(t.norm));

  // „Ce e întârziat?” (înaintea lui „ce facturi am”, care e mai general)
  if (has("intarziate", "intarziata", "restante", "restanta") && !wantsToPay) {
    const bills = result<BillView[]>(t, "list_bills");
    if (!bills) return call("list_bills", { status: "overdue" });
    if (!bills.length) return { text: "Nu ai nicio factură întârziată." };
    return { text: `Ai ${countFacturi(bills.length, "întârziate")}: ${listBillsSpoken(bills)}. ${bills.length === 1 ? "Vrei s-o plătesc?" : "Vrei să le plătesc?"}` };
  }

  // „Cât am de plată?” / „Ce facturi am?”
  if (/\b(cat|ce)\b.*\bde plata\b/.test(t.norm) || /\bce facturi\b/.test(t.norm) || /\bfacturile mele\b/.test(t.norm) && !wantsToPay) {
    return summary(t);
  }

  // „Cât e factura la apă?” / „Când e scadentă factura la gaz?”
  if (categories.length && !wantsToPay && has("cat", "cand", "scadenta", "scadent", "suma", "costa", "e")) {
    if (!(categories.length === 1 && /\bplatesc\b/.test(asked))) return billInfo(t, categories);
  }

  // Plăți de facturi.
  if (wantsToPay) {
    if (has("toate", "tot", "totul", "toata")) return payBills(t, { all: true });
    if (has("intarziate", "intarziata", "restante", "restanta")) return payBills(t, { overdue: true });
    if (categories.length) return payBills(t, { categories, spokenAmount: parseAmount(t.norm) });
    if (/\b(de la|la)$/.test(t.norm) || t.norm.endsWith(" de")) {
      return { text: "Nu am înțeles bine. Ce factură vrei să plătesc?" };
    }
    if (/\b(pe care|ce factura) vrei\b/.test(asked)) {
      const idx = ordinal(w);
      if (idx !== null) return payBills(t, { index: idx });
    }
    return askWhichBill(t);
  }

  // Răspuns scurt / corectură după „O plătesc acum?” sau „Pe care vrei s-o plătesc?”
  if (categories.length && /\bplat/.test(asked)) return payBills(t, { categories, spokenAmount: parseAmount(t.norm) });
  if (/\bpe care vrei\b/.test(asked)) {
    const idx = ordinal(w);
    if (idx !== null) return payBills(t, { index: idx });
  }

  if (productType) return offers(t, productType, countryIn(t.norm));
  if (categories.length) return billInfo(t, categories);

  return { text: "Nu am înțeles bine. Pot să plătesc o factură, să-ți spun ce ai de plată sau să verific RCA-ul. Ce vrei să fac?" };
}

// ---------- facturi ----------

function summary(t: Turn): Action {
  const bills = result<BillView[]>(t, "list_bills");
  if (!bills) return call("list_bills", { status: "due" });
  if (bills.length === 0) return { text: "Nu ai nimic de plată acum." };
  const total = round2(bills.reduce((s, b) => s + b.amount, 0));
  const overdue = bills.filter((b) => b.status === "overdue");
  const late = overdue.length === 1 ? ` Factura la ${overdue[0].categoryRo} e întârziată.`
    : overdue.length > 1 ? ` Facturile la ${joinRo(overdue.map((b) => b.categoryRo))} sunt întârziate.` : "";
  return { text: `Ai ${countFacturi(bills.length)} de plată, în total ${spokenLei(total)}: ${listBillsSpoken(bills)}.${late}` };
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
    if (!b) return `Nu am nicio factură la ${ARTICULATED[c]}.`;
    if (b.status === "paid") return `Factura la ${b.categoryRo} de ${spokenLei(b.amount)} e deja plătită.`;
    return `Factura la ${b.categoryRo} e de ${spokenLei(b.amount)}, ${dueSpoken(b)}.`;
  });
  const anyDue = categories.some((c) => bills.some((x) => x.category === c && x.status !== "paid"));
  return { text: parts.join(" ") + (anyDue ? " Vrei s-o plătesc?" : "") };
}

function payBills(
  t: Turn,
  sel: { all?: boolean; overdue?: boolean; categories?: BillCategory[]; index?: number; spokenAmount?: number | null },
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
      const b = due.find((x) => x.category === c);
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

function offers(t: Turn, type: ProductType, country: string | null): Action {
  const list = productsFor(t, type, country);
  if (!list) return call("search_products", { type });
  if (!list.length) return { text: `Nu am oferte de ${PRODUCT_RO[type]}${country ? " pentru " + countryName(country) : ""} acum.` };
  if (list.length === 1) return chooseOffer(t, type, country, list[0]);
  const what = type === "vignette" && country === "BG" ? "vinietă pentru Bulgaria" : PRODUCT_RO[type];
  return { text: `Am ${COUNT_WORDS[list.length] ?? list.length} oferte de ${what}: ${joinRo(list.map((p) => `${shortName(p)} ${spokenLei(p.price)}`))}. Care te interesează?` };
}

function chooseOffer(t: Turn, type: ProductType, country: string | null, forced?: Product): Action {
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
  if (!pick) return { text: `Nu am înțeles care ofertă. Poți spune „prima”, „a doua” sau durata, de exemplu „12 luni”.` };

  const prepared = t.results.find((r) => r.name === "prepare_payment");
  if (!prepared) return call("prepare_payment", { items: [{ kind: "product", productId: pick.id }] });
  if (!prepared.ok) return { text: "Nu am putut pregăti plata. Mai încerci o dată?" };
  const pronoun = type === "rca" || type === "roaming" ? "Îl" : "O";
  const screen = pick.price > 500 ? " E peste 500 de lei, așa că o confirmi cu butonul de pe ecran." : "";
  return { text: `${pick.name} costă ${spokenLei(pick.price)}.${screen} ${pronoun} cumpăr?` };
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

/** „săptămâna viitoare” → 7, „mâine” → 1, „peste 10 zile” → 10. Implicit 7. */
function startInDays(norm: string): number {
  if (/\bpoimaine\b/.test(norm)) return 2;
  if (/\bmaine\b/.test(norm)) return 1;
  if (/\bluna viitoare\b/.test(norm)) return 30;
  const peste = norm.match(/\bpeste (\d+) zile\b/);
  if (peste) return Number(peste[1]);
  return 7;
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
    const c = words[i] === "apa" && words[i + 1] === "calda" ? "water" : lookup(CATEGORY_WORDS, words[i]);
    if (c && !found.includes(c)) found.push(c);
  }
  return found;
}

function findProductType(words: string[]): ProductType | null {
  for (const w of words) {
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
  const adjForm = adj ? (n === 1 ? ` ${adj === "neplătite" ? "neplătită" : adj === "întârziate" ? "întârziată" : adj}` : ` ${adj}`) : "";
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
  return code === "BG" ? "Bulgaria" : code === "TR" ? "Turcia" : code === "RO" ? "România" : code;
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
