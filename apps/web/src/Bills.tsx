import { useEffect, useState } from "react";
import { addDays, daysBetween, formatLei, toIsoDate, type Bill, type BillCategory, type Payment } from "@pago/shared";
import { api } from "./api.ts";
import { BillIllustration, CoinP, IconPlus } from "./icons.tsx";
import { usePay } from "./pay.tsx";

export const CATEGORY_LABEL: Record<BillCategory, string> = {
  electricity: "Curent",
  gas: "Gaz",
  water: "Apă",
  internet: "Internet",
  phone: "Telefon",
};

function dateRo(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function status(b: Bill) {
  if (b.status === "paid") return { text: "Plătită", cls: "ok" };
  const left = daysBetween(toIsoDate(new Date()), b.dueDate);
  if (left < 0 || b.status === "overdue") return { text: "Întârziată", cls: "bad" };
  if (left <= 3) return { text: left === 0 ? "Scadentă azi" : `În ${left} ${left === 1 ? "zi" : "zile"}`, cls: "warn" };
  return { text: "De plată", cls: "muted" };
}

/** Ecranul Facturi: lista (o vezi, adaugi, ștergi) și istoricul plăților. Asistentul lucrează pe aceeași listă. */
export function Bills(props: {
  bills: Bill[];
  showHistory: boolean;
  onShowHistory: (v: boolean) => void;
  onChanged: () => void;
}) {
  const pay = usePay(); // plata se face direct de aici (amprentă + plată), fără asistent
  const [adding, setAdding] = useState(false);
  const [category, setCategory] = useState<BillCategory>("electricity");
  const [provider, setProvider] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(addDays(toIsoDate(new Date()), 7));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [payments, setPayments] = useState<Payment[]>([]);

  const due = props.bills.filter((b) => b.status !== "paid");
  const totalDue = Math.round(due.reduce((s, b) => s + b.amount, 0) * 100) / 100;

  useEffect(() => {
    if (props.showHistory) api.get<Payment[]>("/api/payments").then(setPayments).catch(() => setPayments([]));
  }, [props.showHistory, props.bills]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post("/api/bills", { category, provider, amount: Number(amount.replace(",", ".")), dueDate });
      setProvider("");
      setAmount("");
      setAdding(false);
      props.onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(bill: Bill) {
    await api.del(`/api/bills/${encodeURIComponent(bill.id)}`).catch(() => {});
    props.onChanged();
  }

  const list = props.showHistory ? props.bills.filter((b) => b.status === "paid") : props.bills.filter((b) => b.status !== "paid");

  return (
    <div className="screen">
      <header className="topbar">
        <span className="points" aria-label="150 puncte Pago"><CoinP size={24} /> 150</span>
        <div className="segmented" role="tablist" aria-label="Facturi">
          <button role="tab" aria-selected={!props.showHistory} className={!props.showHistory ? "on" : ""} onClick={() => props.onShowHistory(false)}>Facturi</button>
          <button role="tab" aria-selected={props.showHistory} className={props.showHistory ? "on" : ""} onClick={() => props.onShowHistory(true)}>Istoric</button>
        </div>
        <button className="round-btn blue" onClick={() => setAdding((x) => !x)} aria-label="Adaugă o factură" aria-expanded={adding}><IconPlus /></button>
      </header>

      {!props.showHistory && due.length > 0 && (
        <div className="total-strip">
          <div>
            <span>Total de plată</span>
            <b>{formatLei(totalDue)}</b>
          </div>
          <button className="btn-green" onClick={() => pay.payBills(due.map((b) => b.id))}>Plătește tot</button>
        </div>
      )}

      {adding && (
        <form className="card form" onSubmit={add}>
          <div className="card-title">Adaugă o factură</div>
          <label>
            Tip
            <select value={category} onChange={(e) => setCategory(e.target.value as BillCategory)}>
              {Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>Furnizor<input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="ex. Lumina Energie" required maxLength={60} /></label>
          <label>Sumă (lei)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="ex. 120,50" required /></label>
          <label>Scadență<input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required /></label>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="btn-green big" disabled={saving}>Adaugă factura</button>
          <button type="button" className="btn-text" onClick={() => setAdding(false)}>Renunță</button>
        </form>
      )}

      {list.length === 0 && !adding && (
        <div className="empty">
          <div className="empty-art" aria-hidden="true">
            <BillIllustration category="electricity" size={64} />
            <BillIllustration category="internet" size={52} />
            <BillIllustration category="water" size={44} />
          </div>
          {props.showHistory ? (
            <>
              <h2>Încă nu ai plătit nimic</h2>
              <p>Plățile făcute prin Pago AI apar aici.</p>
            </>
          ) : (
            <>
              <h2>Adaugă primul furnizor</h2>
              <p>Și descoperă cât de mult timp economisești când ai toate facturile într-un singur loc</p>
              <button className="btn-green big" onClick={() => setAdding(true)}>Adaugă furnizor</button>
            </>
          )}
        </div>
      )}

      <ul className="bill-cards">
        {list.map((b) => {
          const st = status(b);
          return (
            <li key={b.id} className="card bill-card">
              <div className="bc-top">
                <span className="ill"><BillIllustration category={b.category} size={34} /></span>
                <div className="bc-main">
                  <b>{CATEGORY_LABEL[b.category]}</b>
                  <span className="card-sub">{b.provider}</span>
                </div>
                <div className="bc-side">
                  <b className="amount">{formatLei(b.amount)}</b>
                  <span className={`pill ${st.cls}`}>{st.text}</span>
                </div>
              </div>
              <div className="bc-bottom">
                <span className="card-sub">{b.status === "paid" && b.paidAt ? `plătită pe ${dateRo(b.paidAt)}` : `scadență ${dateRo(b.dueDate)}`}</span>
                <div className="bc-actions">
                  <button className="btn-text small" onClick={() => remove(b)} aria-label={`Șterge factura ${CATEGORY_LABEL[b.category]} ${b.provider}`}>Șterge</button>
                  {b.status !== "paid" && <button className="btn-green small" onClick={() => pay.payBills([b.id])}>Plătește</button>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {props.showHistory && payments.length > 0 && (
        <>
          <h2 className="section-label">Plăți făcute</h2>
          <ul className="card list-rows">
            {payments.map((p) => (
              <li key={p.id}>
                <div>
                  <b>{p.lines?.map((l) => l.label).join(", ") ?? "Plată"}</b>
                  <span className="card-sub">{p.createdAt ? new Date(p.createdAt).toLocaleString("ro-RO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}</span>
                </div>
                <b className="amount">{formatLei(p.total)}</b>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
