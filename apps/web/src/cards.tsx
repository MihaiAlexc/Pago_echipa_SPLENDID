import { useEffect, useState } from "react";
import { formatLei, GROUP_DISCOUNT, GROUP_MIN_PERSONS, MAX_PERSONS, priceForPersons, type PendingPaymentForClient, type Product } from "@pago/shared";
import { usePay } from "./pay.tsx";
import {
  BillIllustration, IconCheck, IconFingerprint, IllGlobeSim, IllPlane, IllRoad, IllShieldCar,
} from "./icons.tsx";
import { isNative } from "./api.ts";

/* Aceleași forme ca în apps/server/src/agent/cards.ts (datele vin din rezultatele tool-urilor). */
type BillRow = { id: string; categoryRo: string; provider: string; amount: number; dueDate: string; daysUntilDue: number; status: string };
type ChecklistItem = {
  id: string; label: string; short: string; status: "ok" | "missing";
  reasons: string[]; currentDaysLeft?: number; productType: string;
  suggestedProduct?: { id: string; name: string; price: number };
};
type Checklist = {
  country: string; name: string; inName: string; verified: boolean; withCar: boolean | null;
  trip: { start: string; end: string }; items: ChecklistItem[]; missingCount: number;
  info?: { documents: string; roadTolls: string; tollEstimate?: string; roaming?: string };
};
export type ChatCard =
  | { type: "bills"; bills: BillRow[] }
  | { type: "trip"; checklist: Checklist }
  | { type: "trip_offers"; country: string; countryName: string; days: number; withCar: boolean | null; insurance: Product[]; vignettes: Product[] }
  | { type: "products"; products: Product[] };

const CATEGORY_KEY: Record<string, string> = { curent: "electricity", gaz: "gas", apă: "water", internet: "internet", telefon: "phone" };

const REASON_RO: Record<string, string> = {
  missing: "lipsește",
  expired: "a expirat",
  expires_before_trip: "expiră înainte de plecare",
  expires_during_trip: "expiră în timpul călătoriei",
  not_covered: "nu acoperă țara",
};

function dateRo(iso: string) {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}

function dueLabel(days: number, status: string) {
  if (status === "paid") return { text: "Plătită", cls: "ok" };
  if (days < 0) return { text: `Întârziată ${-days} ${-days === 1 ? "zi" : "zile"}`, cls: "bad" };
  if (days === 0) return { text: "Scadentă azi", cls: "warn" };
  return { text: `Scadentă în ${days} ${days === 1 ? "zi" : "zile"}`, cls: days <= 3 ? "warn" : "muted" };
}

/** Factura explicată + comparația sumelor (bare proporționale cu suma fiecărei facturi). */
export function BillsCard({ bills, onPay }: { bills: BillRow[]; onPay: (b: BillRow) => void }) {
  const due = bills.filter((b) => b.status !== "paid");
  const shown = due.length ? due : bills;
  const max = Math.max(...shown.map((b) => b.amount), 1);
  const total = due.reduce((s, b) => s + b.amount, 0);
  return (
    <div className="ai-card">
      <div className="ai-card-head">
        <span className="ai-card-kicker">{due.length ? "De plată" : "Facturi"}</span>
        {due.length > 0 && <span className="ai-card-total">{formatLei(Math.round(total * 100) / 100)}</span>}
      </div>
      <ul className="cmp" aria-label="Comparația facturilor">
        {shown.map((b) => {
          const d = dueLabel(b.daysUntilDue, b.status);
          return (
            <li key={b.id}>
              <span className="cmp-ico"><BillIllustration category={CATEGORY_KEY[b.categoryRo] ?? b.categoryRo} size={26} /></span>
              <div className="cmp-body">
                <div className="cmp-top">
                  <b>{b.categoryRo[0].toUpperCase() + b.categoryRo.slice(1)}</b>
                  <b className="amount">{formatLei(b.amount)}</b>
                </div>
                <div className="cmp-bar" aria-hidden="true"><span className={d.cls} style={{ width: `${Math.max(6, (b.amount / max) * 100)}%` }} /></div>
                <div className="cmp-sub"><span>{b.provider}</span><span className={`pill ${d.cls}`}>{d.text}</span></div>
              </div>
              {b.status !== "paid" && <button className="link-btn" onClick={() => onPay(b)}>Plătește</button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function tripIcon(type: string) {
  if (type === "rca") return <IllShieldCar size={28} />;
  if (type === "vignette") return <IllRoad size={28} />;
  return <IllGlobeSim size={28} />;
}

/** Pachetul de călătorie: ce ai deja, ce lipsește, cât costă. Cumpărarea rămâne pas cu pas, cu confirmare. */
export function TripCard({ checklist, onStart }: { checklist: Checklist; onStart: () => void }) {
  const missing = checklist.items.filter((i) => i.status === "missing");
  const total = missing.reduce((s, i) => s + (i.suggestedProduct?.price ?? 0), 0);
  return (
    <div className="ai-card trip">
      <div className="trip-hero">
        <IllPlane size={34} />
        <div>
          <div className="trip-title">Pachet {checklist.name}</div>
          <div className="trip-sub">
            {dateRo(checklist.trip.start)} – {dateRo(checklist.trip.end)} · {checklist.withCar ? "cu mașina" : "fără mașină"}
          </div>
        </div>
      </div>
      {checklist.info && (
        <dl className="trip-info">
          <div><dt>Acte</dt><dd>{checklist.info.documents}</dd></div>
          <div><dt>Drumuri</dt><dd>{checklist.info.roadTolls}{checklist.info.tollEstimate && <span className="estimate">{checklist.info.tollEstimate}</span>}</dd></div>
          {checklist.info.roaming && <div><dt>Telefon</dt><dd>{checklist.info.roaming}</dd></div>}
        </dl>
      )}
      <ul className="trip-list">
        {checklist.items.map((i) => (
          <li key={i.id} className={i.status}>
            <span className="trip-ico">{tripIcon(i.productType)}</span>
            <div className="trip-body">
              <b>{i.short}</b>
              <span>{i.status === "ok" ? "Ai deja, e valabil" : i.reasons.map((r) => REASON_RO[r] ?? r).join(", ") || "lipsește"}</span>
            </div>
            {i.status === "ok" ? (
              <span className="pill ok"><IconCheck size={14} /> OK</span>
            ) : i.suggestedProduct ? (
              <b className="amount">{formatLei(i.suggestedProduct.price)}</b>
            ) : (
              <span className="pill warn">De ales</span>
            )}
          </li>
        ))}
      </ul>
      {missing.length > 0 && (
        <>
          <div className="trip-total"><span>Estimat pentru ce lipsește</span><b>{total > 0 ? formatLei(total) : "—"}</b></div>
          <button className="btn-green" onClick={onStart}>Începem, pe rând</button>
          <p className="fine">Îți propun fiecare act separat și îl plătești doar după ce confirmi.</p>
        </>
      )}
      {!checklist.verified && <p className="fine">Regulile pentru {checklist.name} sunt orientative (date de test).</p>}
    </div>
  );
}

/** Ofertele (RCA, rovinietă, roaming...). Atingi una → i-o ceri asistentului, care o pregătește cu confirmare. */
export function ProductsCard({ products, onPick }: { products: Product[]; onPick: (p: Product) => void }) {
  const cheapest = Math.min(...products.map((p) => p.price));
  return (
    <div className="ai-card">
      <div className="ai-card-head"><span className="ai-card-kicker">Oferte</span></div>
      <ul className="offers">
        {products.map((p) => (
          <li key={p.id}>
            <button className="offer" onClick={() => onPick(p)}>
              <span className="offer-ico">{tripIcon(p.type)}</span>
              <span className="offer-body">
                <b>{p.name}</b>
                <span>{p.durationDays} {p.durationDays === 1 ? "zi" : "zile"}{p.price === cheapest && products.length > 1 ? " · cel mai mic preț" : ""}</span>
              </span>
              <b className="amount">{formatLei(p.price)}</b>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Cardul de plată (Checkout): ce plătești, totalul, Confirmă (cu amprentă pe telefon) / Anulează. */
export function CheckoutCard(props: { pending: PendingPaymentForClient; busy: boolean; onConfirm: () => void; onCancel: () => void; screenOnly?: boolean }) {
  const { pending } = props;
  return (
    <div className="checkout" role="group" aria-label="Confirmare plată">
      <div className="checkout-head">
        <span className="ai-card-kicker">Confirmă plata</span>
        <span className="secure">Plată securizată</span>
      </div>
      <ul>
        {pending.lines.map((l) => (
          <li key={l.refId}><span>{l.label}</span><b>{formatLei(l.amount)}</b></li>
        ))}
      </ul>
      <div className="checkout-total"><span>Total</span><b>{formatLei(pending.total)}</b></div>
      <p className="fine">
        {props.screenOnly
          ? isNative ? "Confirmi cu amprenta sau cu fața, apoi plătim." : "Apasă Confirmă plata ca să plătești."
          : pending.requiresScreenConfirm
            ? "Peste 500 de lei: confirmă doar cu butonul."
            : "Poți spune „da” sau apăsa butonul."}
      </p>
      <button className="btn-green big" onClick={props.onConfirm} disabled={props.busy}>
        {isNative && <IconFingerprint size={26} />} Confirmă plata
      </button>
      <button className="btn-text" onClick={props.onCancel} disabled={props.busy}>Anulează</button>
    </div>
  );
}

/** Ecranul de plată reușită, animat. Se închide singur după câteva secunde sau cu „Gata”. */
export function SuccessScreen({ total, lines, onClose }: { total: number; lines: { label: string; amount: number; refId: string }[]; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4500);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className="success" role="alertdialog" aria-label="Plată reușită" aria-live="assertive">
      <div className="success-burst" aria-hidden="true">
        {Array.from({ length: 12 }, (_, i) => <i key={i} style={{ ["--a" as string]: `${i * 30}deg` }} />)}
      </div>
      <div className="success-check">
        <svg viewBox="0 0 52 52" width="96" height="96" aria-hidden="true">
          <circle className="success-circle" cx="26" cy="26" r="24" />
          <path className="success-tick" d="M15 27l7 7 15-16" />
        </svg>
      </div>
      <h2>Plată reușită</h2>
      <div className="success-amount">{formatLei(total)}</div>
      <ul>{lines.map((l) => <li key={l.refId}>{l.label}</li>)}</ul>
      <button className="btn-green big" onClick={onClose} autoFocus>Gata</button>
    </div>
  );
}

const COUNTRY_VIGNETTE: Record<string, string> = { RO: "Rovinietă România", BG: "Vinietă Bulgaria" };

/**
 * Pachetele pentru călătorie, direct în conversație: alegi câte persoane merg, iar prețurile se recalculează pe loc
 * (aceeași regulă ca pe server: preț × persoane, −10% de la 4). „Alege” deschide plata directă (amprentă + plată).
 */
export function TripOffersCard({ card }: { card: Extract<ChatCard, { type: "trip_offers" }> }) {
  const pay = usePay();
  const [persons, setPersons] = useState(1);
  const discount = persons >= GROUP_MIN_PERSONS;
  const minPerCountry = Object.entries(
    card.vignettes.reduce<Record<string, number>>((acc, p) => {
      const c = p.country ?? "";
      acc[c] = Math.min(acc[c] ?? Infinity, p.price);
      return acc;
    }, {}),
  );
  const cheapest = Math.min(...card.insurance.map((p) => p.price));

  return (
    <div className="ai-card offers-card">
      <div className="trip-hero">
        <IllPlane size={34} />
        <div>
          <div className="trip-title">Pachete pentru {card.countryName}</div>
          <div className="trip-sub">Asigurare de călătorie {card.insurance[0]?.durationDays ?? card.days} zile{card.withCar === false ? "" : " · rovinietă și viniete"}</div>
        </div>
      </div>

      <div className="persons" role="group" aria-label="Număr de persoane">
        <span className="persons-label">Câte persoane călătoresc?</span>
        <div className="stepper">
          <button onClick={() => setPersons((n) => Math.max(1, n - 1))} disabled={persons <= 1} aria-label="Mai puține persoane">−</button>
          <output aria-live="polite">{persons}</output>
          <button onClick={() => setPersons((n) => Math.min(MAX_PERSONS, n + 1))} disabled={persons >= MAX_PERSONS} aria-label="Mai multe persoane">+</button>
        </div>
      </div>
      <div className="persons-chips">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} className={persons === n ? "on" : ""} onClick={() => setPersons(n)} aria-pressed={persons === n}>{n}{n === 5 ? "+" : ""}</button>
        ))}
      </div>
      {discount && <p className="discount-note">Reducere de grup: −{Math.round(GROUP_DISCOUNT * 100)}% de la {GROUP_MIN_PERSONS} persoane</p>}

      <ul className="tiers">
        {card.insurance.map((p) => (
          <li key={p.id} className={p.tier === "Standard" ? "featured" : ""}>
            <div className="tier-top">
              <b>{p.tier}</b>
              {p.tier === "Standard" && <span className="pill ok">Recomandat</span>}
            </div>
            <span className="tier-cov">{p.coverage}</span>
            <span className="tier-from">de la <b>{formatLei(p.price)}</b> / persoană{p.price === cheapest ? " · cel mai mic preț" : ""}</span>
            <div className="tier-bottom">
              <span className="tier-total">
                <span>Total {persons} {persons === 1 ? "persoană" : "persoane"}</span>
                <b>{formatLei(priceForPersons(p.price, persons))}</b>
                {discount && <s>{formatLei(p.price * persons)}</s>}
              </span>
              <button className="btn-green small" onClick={() => pay.buyProduct(p.id, { persons })}>Alege</button>
            </div>
          </li>
        ))}
      </ul>

      {minPerCountry.length > 0 && (
        <>
          <div className="ai-card-head sub"><span className="ai-card-kicker">Pentru mașină</span></div>
          <ul className="offers">
            {minPerCountry.map(([country, min]) => (
              <li key={country}>
                <button className="offer" onClick={() => pay.openPicker({ type: "vignette", country, title: COUNTRY_VIGNETTE[country] ?? "Viniete" })}>
                  <span className="offer-ico"><IllRoad size={28} /></span>
                  <span className="offer-body">
                    <b>{COUNTRY_VIGNETTE[country] ?? `Vinietă ${country}`}</b>
                    <span>de la {formatLei(min)} · pe mașină, nu pe persoană</span>
                  </span>
                  <span className="link-btn">Alege</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="fine">Prețuri de test. Suma finală o calculează aplicația și o confirmi cu amprenta.</p>
    </div>
  );
}
