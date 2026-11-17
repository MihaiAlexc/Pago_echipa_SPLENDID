/**
 * RĂSPUNSURI FIXE ale modelului simulat — întrebări la care nu e nevoie de date din cont:
 * cine ești, ce e RCA-ul, cum confirm o plată, e sigur, la revedere etc.
 *
 * Fiecare regulă = un tipar (pe textul normalizat: litere mici, fără diacritice, fără punctuație) + un răspuns.
 * Ca să adaugi o întrebare nouă, adaugi o regulă aici; restul codului nu se schimbă.
 *
 * Răspunsurile care se termină cu „?” propun un pas următor (ex. „Vrei să verific…?”); un „da” la ele
 * este tratat în scripted.ts. Celelalte sunt „transparente”: nu schimbă subiectul conversației
 * (după ele, „a doua” sau „da” se referă tot la întrebarea de dinainte).
 */

interface Rule {
  test: RegExp;
  text: string;
  /** Doar pentru mesaje scurte (ca să nu acopere o cerere reală mai lungă). */
  maxWords?: number;
}

export const UNCLEAR_OFFER = "Nu am înțeles care ofertă.";
export const UNCLEAR_PENDING = "Nu am înțeles.";
export const WAIT_TEXT = "Sigur, nu e nicio grabă. Spune-mi când ești gata.";
export const WAIT_PENDING_TEXT = "Sigur, nu e nicio grabă.";

export const HELP_TEXT =
  "Pot să-ți plătesc facturile, să-ți spun ce ai de plată și când e scadența, să verific RCA-ul și rovinieta și să-ți arăt oferte de RCA, viniete sau roaming. Te pot ajuta și să te pregătești de un drum cu mașina, de exemplu în Turcia. Plățile le fac doar după ce îmi spui „da”.";

const DEFINE = "(?:ce (?:e|este|inseamna|reprezinta|sunt)|la ce (?:e bun|e buna|foloseste|ajuta|imi trebuie)|explica mi|explica|de ce (?:am nevoie de|imi trebuie|trebuie))";
const def = (term: string) => new RegExp(`\\b${DEFINE}\\b.{0,12}\\b(?:${term})`);

const RULES: Rule[] = [
  // ---------- despărțire (înaintea salutului: „noapte bună” conține „bună”) ----------
  {
    test: /\b(la revedere|pa|pa pa|noapte buna|o zi buna|o seara buna|zi buna|seara buna|ne auzim|ne vedem|asta e tot|atat pentru azi|gata atat)\b/,
    maxWords: 5,
    text: "La revedere! Sunt aici când mai ai nevoie.",
  },

  // ---------- cine e asistentul ----------
  {
    test: /\b(cine|ce) esti\b|\bcum te (cheama|numesti)\b|\bcu cine vorbesc\b|\bcare e numele tau\b/,
    text: "Sunt asistentul vocal Pago. Te ajut să plătești facturi și să cumperi RCA, rovinietă sau roaming doar vorbind.",
  },
  {
    test: /\besti (un |o )?(robot|om|persoana|program|ai|inteligenta|masina|real|reala)\b/,
    text: "Sunt un asistent virtual, nu o persoană. Plățile le fac doar după ce spui tu „da”.",
  },
  {
    test: /\bvreau sa vorbesc cu (un |o )?(om|operator|consultant|persoana|cineva)\b|\bda mi (un )?(om|operator)\b/,
    text: "În această versiune sunt doar eu, asistentul virtual. Spune-mi ce ai nevoie și încerc să te ajut.",
  },
  {
    test: /\bce (mai )?faci\b|\bcum (iti merge|o mai duci)\b|\bcum esti\b/,
    maxWords: 5,
    text: "Bine, mulțumesc! Sunt gata să te ajut cu facturile sau cu mașina.",
  },
  {
    test: /\bvorbesti (si )?(in )?(engleza|englezeste|alta limba|alte limbi)\b|\bspeak english\b|\bstii engleza\b/,
    text: "Deocamdată vorbesc doar română.",
  },
  {
    test: /\b(o )?gluma\b|\b(un )?banc\b|\bfa ma sa rad\b/,
    text: "Glumele nu sunt punctul meu forte, mă pricep mai bine la facturi.",
  },
  {
    test: /\bce (e|este) pago\b|\bce face pago\b/,
    text: "Pago este o aplicație prin care îți plătești facturile și cumperi RCA, rovinietă și alte servicii dintr-un singur loc. Eu sunt asistentul ei vocal.",
  },

  // ---------- cum funcționează plățile, siguranță ----------
  {
    test: /\bcum (confirm|se confirma|aprob|anulez|se anuleaza)\b/,
    text: "Îți spun ce plătesc și cât, apoi te întreb. Răspunzi „da” ca să plătesc sau „nu” ca să anulez, ori apeși Confirmă sau Anulează pe ecran. Peste 500 de lei merge doar butonul.",
  },
  {
    test: /\bcum (platesc|se plateste|fac o plata|se face (o )?plata|cumpar|pot plati)\b/,
    text: "Spune-mi ce vrei să plătești, de exemplu „plătește factura la curent”. Îți spun suma și te întreb, iar banii pleacă doar după ce răspunzi „da” sau apeși Confirmă pe ecran.",
  },
  {
    test: /\b(e|este) (in )?sigur(a|anta)?\b|\bpoti plati (singur|fara)\b|\bplatesti (singur|fara)\b|\bma pot (increde|baza)\b|\bdaca (gresesti|intelegi gresit|auzi gresit)\b|\bce se intampla daca (gresesti|intelegi gresit|auzi gresit)\b/,
    text: "Da, e sigur. Nu pot plăti nimic de unul singur: pregătesc plata, îți spun suma, iar banii pleacă doar după „da”-ul tău sau după butonul Confirmă. Suma vine mereu din factură, nu din ce aud eu.",
  },
  {
    test: /\b(limita|pragul?|plafonul?)\b|\bde ce\b.*\b(buton|butonul|ecran|ecranul)\b|\bcat pot plati (cu vocea|vocal|prin voce)\b|\bde ce nu (pot|merge) (cu vocea|vocal)\b/,
    text: "Până la 500 de lei poți confirma cu vocea. Peste 500 de lei, plata se confirmă doar cu butonul de pe ecran, ca o sumă mare să nu plece dintr-o greșeală de auzit.",
  },
  {
    test: /\b(datele|facturile|preturile|banii|platile) (astea |acestea )?(sunt|e) (reale?|adevarate?|fictive|de test)\b|\b(e|este) (un |doar un )?(demo|test|prototip)\b|\bbani reali\b|\bplatesc pe bune\b/,
    text: "Aceasta este o versiune demonstrativă: facturile, prețurile și plățile sunt date de test, nu se mișcă bani reali.",
  },
  {
    test: /\bcomision(ul|ului|ul tau|ane|oane)?\b|\bcat costa (serviciul|aplicatia|pago|sa te folosesc)\b|\btaxe de plata\b/,
    text: "În această versiune demonstrativă nu am informații despre comisioane, așa că nu vreau să-ți spun ceva greșit.",
  },
  {
    test: /\b(reguli|regulile|informatii|informatiile)\b.*\b(verificate|sigure|oficiale|corecte|reale|adevarate)\b|\besti sigur(a)? (ca|de)\b/,
    text: "Regulile mele pentru călătorii sunt orientative, nu oficiale. Te rog să le verifici din surse oficiale înainte de plecare.",
  },

  // ---------- cum folosești asistentul ----------
  {
    test: /\bcum (adaug|pun|introduc|trec)\b.*\bfactur/,
    text: "Spune, de exemplu: „Adaugă o factură la curent de 120 de lei, scadentă pe 25 noiembrie”. O poți adăuga și din lista de pe ecran.",
  },
  {
    test: /\bcum (sterg|scot|elimin)\b.*\bfactur/,
    text: "Spune, de exemplu: „Șterge factura la apă”. O poți șterge și din lista de pe ecran.",
  },
  {
    test: /\bcum (schimb|modific|adaug)\b.*\b(masina|numarul|rca|rovinieta|actele|vinieta)\b/,
    text: "Detaliile mașinii și actele ei le schimbi din fila „Mașina mea” de pe ecran. Eu folosesc exact datele de acolo.",
  },
  {
    test: /\b(nu aud|nu te aud|mai tare|mai incet|mai rar|mai repede|schimba vocea|alta voce)\b/,
    text: "Vocea o poți alege din lista de voci de pe ecran, iar volumul îl reglezi de la telefon. Dacă n-ai auzit ceva, spune „repetă”.",
  },

  // ---------- ce înseamnă termenii ----------
  {
    test: def("carte(a)? verde"),
    text: "Cartea Verde este documentul care arată că RCA-ul tău e valabil și în alte țări. Țările acoperite depind de poliță. Vrei să verific ce țări acoperă RCA-ul tău?",
  },
  {
    test: def("(rca|asigurare(a)? (auto|obligatorie))"),
    text: "RCA-ul este asigurarea auto obligatorie: acoperă pagubele pe care le produci altora într-un accident. Vrei să verific până când e valabil al tău?",
  },
  {
    test: def("roviniet"),
    text: "Rovinieta este taxa pentru folosirea drumurilor naționale din România. Vrei să verific dacă a ta e valabilă?",
  },
  {
    test: def("viniet"),
    text: "Vinieta este taxa de drum din alte țări, de exemplu Bulgaria, și se cumpără pe o perioadă. Vrei să-ți arăt ofertele de vinietă pentru Bulgaria?",
  },
  {
    test: def("ro(a)?ming"),
    text: "Roamingul îți lasă telefonul să meargă în străinătate, pe rețeaua altui operator. Am pachete de roaming pentru Turcia. Vrei să-ți arăt ofertele?",
  },
  {
    test: def("cartel|sim\\b"),
    text: "O cartelă locală este un SIM din țara în care mergi, cu internet inclus. Am o cartelă pentru Turcia. Vrei să-ți arăt ofertele?",
  },
  {
    test: def("scadent"),
    text: "Scadența este ultima zi în care poți plăti o factură fără întârziere.",
  },
];

const STATIC_TEXTS = new Set(RULES.map((r) => r.text));

/** Răspunsul fix pentru o întrebare cunoscută, sau null dacă nu e una dintre ele. */
export function staticAnswer(norm: string): string | null {
  const words = norm.split(" ").filter(Boolean).length;
  for (const r of RULES) {
    if (r.maxWords !== undefined && words > r.maxWords) continue;
    if (r.test.test(norm)) return r.text;
  }
  return null;
}

/**
 * Un răspuns care NU schimbă subiectul: un răspuns fix fără întrebare la sfârșit, „stai puțin” sau
 * „nu am înțeles care ofertă”. După el, răspunsul utilizatorului se referă la întrebarea de dinainte.
 */
export function isTransparent(text: string): boolean {
  if (text.startsWith(UNCLEAR_OFFER) || text === UNCLEAR_PENDING || text === WAIT_TEXT || text === WAIT_PENDING_TEXT) return true;
  if (STATIC_TEXTS.has(text)) return !text.endsWith("?");
  // Același răspuns fix, dar cu întrebarea de la sfârșit scoasă (când o plată aștepta confirmarea).
  return [...STATIC_TEXTS].some((s) => s.endsWith("?") && withoutQuestion(s) === text);
}

/** Scoate întrebarea de la sfârșit: „… Vrei să verific?” → „…”. */
export function withoutQuestion(text: string): string {
  if (!text.endsWith("?")) return text;
  const cut = text.lastIndexOf(". ");
  return cut < 0 ? text : text.slice(0, cut + 1);
}
