/**
 * Prețul produselor „pe persoană” (asigurarea de călătorie). Aceeași funcție o folosesc serverul (care calculează
 * suma plătită) și interfața (care arată estimarea), ca ce vezi pe ecran să fie exact ce plătești.
 */
export const MAX_PERSONS = 9;
/** De la câte persoane se aplică reducerea de grup și cât e ea. */
export const GROUP_MIN_PERSONS = 4;
export const GROUP_DISCOUNT = 0.1;

export function isValidPersons(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_PERSONS;
}

/** Total pentru `persons` persoane: preț × persoane, cu 10% reducere de la 4 persoane. */
export function priceForPersons(pricePerPerson: number, persons: number): number {
  const gross = pricePerPerson * persons;
  const total = persons >= GROUP_MIN_PERSONS ? gross * (1 - GROUP_DISCOUNT) : gross;
  return Math.round(total * 100) / 100;
}
