/** Formatează o sumă în stil românesc: 187.4 → "187,40 lei". */
export function formatLei(amount: number): string {
  return `${amount.toFixed(2).replace(".", ",")} lei`;
}
