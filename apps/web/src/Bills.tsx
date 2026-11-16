import { useState } from "react";
import { addDays, formatLei, toIsoDate, type Bill, type BillCategory } from "@pago/shared";

export const CATEGORY_LABEL: Record<BillCategory, string> = {
  electricity: "Curent",
  gas: "Gaz",
  water: "Apă",
  internet: "Internet",
  phone: "Telefon",
};

const STATUS_LABEL: Record<Bill["status"], string> = {
  unpaid: "De plată",
  overdue: "Întârziată",
  paid: "Plătită",
};

function dueText(bill: Bill): string {
  const [y, m, d] = bill.dueDate.split("-");
  return `scadență ${d}.${m}.${y}`;
}

/** Lista de facturi: o vezi, adaugi, ștergi. Asistentul lucrează pe aceeași listă. */
export function Bills(props: { bills: Bill[]; onChanged: () => void; onPayWithAssistant: (bill: Bill) => void }) {
  const [category, setCategory] = useState<BillCategory>("electricity");
  const [provider, setProvider] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(addDays(toIsoDate(new Date()), 7));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const due = props.bills.filter((b) => b.status !== "paid");
  const totalDue = due.reduce((s, b) => s + b.amount, 0);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const r = await fetch("/api/bills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category, provider, amount: Number(amount.replace(",", ".")), dueDate }),
      });
      if (!r.ok) throw new Error((await r.json()).message ?? "Nu am putut adăuga factura.");
      setProvider("");
      setAmount("");
      props.onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(bill: Bill) {
    await fetch(`/api/bills/${encodeURIComponent(bill.id)}`, { method: "DELETE" });
    props.onChanged();
  }

  return (
    <section className="bills" aria-label="Facturile mele">
      <h2>
        Facturile mele
        <span className="muted"> · de plată: {formatLei(Math.round(totalDue * 100) / 100)}</span>
      </h2>

      {props.bills.length === 0 && <p className="muted">Nu ai nicio factură.</p>}

      <ul className="bill-list">
        {props.bills.map((b) => (
          <li key={b.id} className={`bill ${b.status}`}>
            <div className="bill-main">
              <b>{CATEGORY_LABEL[b.category]}</b> · {b.provider}
              <div className="muted small">{dueText(b)}</div>
            </div>
            <div className="bill-side">
              <b>{formatLei(b.amount)}</b>
              <span className={`tag ${b.status}`}>{STATUS_LABEL[b.status]}</span>
            </div>
            <div className="bill-actions">
              {b.status !== "paid" && (
                <button type="button" className="small-btn primary" onClick={() => props.onPayWithAssistant(b)}>
                  Plătește
                </button>
              )}
              <button
                type="button"
                className="small-btn"
                onClick={() => remove(b)}
                aria-label={`Șterge factura ${CATEGORY_LABEL[b.category]} ${b.provider}`}
              >
                Șterge
              </button>
            </div>
          </li>
        ))}
      </ul>

      <details className="add-bill">
        <summary>+ Adaugă o factură</summary>
        <form onSubmit={add}>
          <label>
            Tip
            <select value={category} onChange={(e) => setCategory(e.target.value as BillCategory)}>
              {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Furnizor
            <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="ex. Lumina Energie" required maxLength={60} />
          </label>
          <label>
            Sumă (lei)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="ex. 120,50" required />
          </label>
          <label>
            Scadență
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="wide" disabled={saving}>Adaugă factura</button>
        </form>
      </details>
    </section>
  );
}
