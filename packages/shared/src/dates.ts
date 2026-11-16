import type { IsoDate } from "./types.ts";

/** Data (fără oră) în format "YYYY-MM-DD", în ora locală. */
export function toIsoDate(d: Date): IsoDate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Adaugă (sau scade, cu număr negativ) zile la o dată. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number);
  return toIsoDate(new Date(y, m - 1, d + days));
}

/** Câte zile sunt de la `from` până la `to` (negativ dacă `to` e în trecut). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}
