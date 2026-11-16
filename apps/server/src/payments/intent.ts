/**
 * Recunoaștere DETERMINISTĂ a lui „da” / „nu” pentru o plată în așteptare.
 * Nu folosește LLM-ul: doar o listă fixă de expresii, potrivite pe TOATĂ fraza.
 * Orice altceva („poate”, „hmm”, „da, arată-mi ofertele”) → "other": nu confirmă nimic.
 */

export type ConfirmIntent = "yes" | "no" | "other";

const YES = new Set([
  "da",
  "da da",
  "confirm",
  "confirma",
  "confirm plata",
  "confirma plata",
  "da confirm",
  "da confirma",
  "da plateste",
  "plateste",
  "plateste o",
  "da plateste o",
  "da te rog",
  "da sigur",
  "sigur",
  "sigur ca da",
  "da vreau",
  "da cumpara",
  "cumpara",
  "da cumpara l",
  "da cumpara o",
]);

const NO = new Set([
  "nu",
  "nu nu",
  "nu multumesc",
  "nu acum",
  "nu vreau",
  "nu plati",
  "nu plati nimic",
  "anuleaza",
  "anuleaza plata",
  "nu anuleaza",
  "renunt",
  "renunta",
  "stop",
  "opreste",
  "lasa",
  "las o",
  "lasa o",
]);

/** Litere mici, fără diacritice și fără punctuație: „Da, plătește-o!” → "da plateste o". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // scoate diacriticele (ă→a, ș→s, ț→t...)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyConfirmation(text: string): ConfirmIntent {
  const t = normalize(text);
  if (YES.has(t)) return "yes";
  if (NO.has(t)) return "no";
  return "other";
}
