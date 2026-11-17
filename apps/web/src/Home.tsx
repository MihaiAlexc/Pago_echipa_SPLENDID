import { useRef, useState } from "react";
import { daysBetween, formatLei, toIsoDate, type Bill } from "@pago/shared";
import type { CarData } from "./Car.tsx";
import { Orb } from "./Assistant.tsx";
import {
  BillIllustration, CoinP, IconChevron, IconGear, IconHistory, IllCalendar, IllGlobeSim, IllPlane, IllRoad, IllShieldCar, IllSparkle,
} from "./icons.tsx";
import { CATEGORY_LABEL } from "./Bills.tsx";
import { usePay } from "./pay.tsx";

export type Screen = "home" | "bills" | "other" | "car" | "settings";

function daysLeftText(validUntil: string) {
  const left = daysBetween(toIsoDate(new Date()), validUntil);
  if (left < 0) return { text: "Expirat", cls: "bad" };
  if (left <= 14) return { text: `${left} ${left === 1 ? "zi" : "zile"}`, cls: "warn" };
  return { text: "Valabil", cls: "ok" };
}

const TRIPS = [
  { code: "TR", name: "Turcia", flag: "🇹🇷" },
  { code: "BG", name: "Bulgaria", flag: "🇧🇬" },
  { code: "GR", name: "Grecia", flag: "🇬🇷" },
];

/** Caruselul de sus: 3 secțiuni, cu swipe stânga-dreapta (scroll-snap) și buline care arată unde ești. */
function Carousel(props: {
  first: string;
  proactive: string | null;
  totalDue: number;
  dueCount: number;
  onAsk: (text?: string) => void;
  onPayAll: () => void;
  onTravel: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const SLIDES = 3;

  // Poziția fiecărei secțiuni, măsurată din DOM (lățimea slide-ului + spațiul dintre ele).
  const slideStep = (el: HTMLDivElement) => {
    const [a, b] = Array.from(el.children) as HTMLElement[];
    return b ? b.offsetLeft - a.offsetLeft : el.clientWidth;
  };
  function onScroll() {
    const el = track.current;
    if (el) setIndex(Math.min(SLIDES - 1, Math.round(el.scrollLeft / slideStep(el))));
  }
  function goTo(i: number) {
    const el = track.current;
    if (!el) return;
    const left = i * slideStep(el);
    el.scrollTo({ left, behavior: "smooth" });
    setIndex(i);
    // Unele WebView-uri ignoră derularea lină (ex. când economisesc animațiile): ajungem oricum la secțiune.
    setTimeout(() => {
      if (Math.abs(el.scrollLeft - left) > 4) el.scrollLeft = left;
    }, 600);
  }

  return (
    <section className="carousel" aria-roledescription="carusel" aria-label="Noutăți">
      <div className="carousel-track" ref={track} onScroll={onScroll}>
        <article className="hero slide-ai" aria-roledescription="slide" aria-label={`1 din ${SLIDES}`}>
          <div className="hero-art"><Orb state="idle" tick={0} size={88} /></div>
          <div className="hero-body">
            <h1>{props.first ? `Bună, ${props.first}!` : "Bună!"}</h1>
            <p>{props.proactive ? props.proactive.replace(/^Bună, [^!]+! /, "") : "Plătește facturi și cumpără RCA doar vorbind."}</p>
            <button className="hero-btn" onClick={() => props.onAsk()}>Vorbește cu Pago AI</button>
          </div>
        </article>

        <article className="hero slide-bills" aria-roledescription="slide" aria-label={`2 din ${SLIDES}`}>
          <div className="hero-art big-ill"><BillIllustration category="electricity" size={70} /></div>
          <div className="hero-body">
            {props.dueCount > 0 ? (
              <>
                <h1>{formatLei(props.totalDue)}</h1>
                <p>{props.dueCount === 1 ? "O factură de plată." : `${props.dueCount} facturi de plată.`} Le plătești pe toate dintr-o atingere.</p>
                <button className="hero-btn" onClick={props.onPayAll}>Plătește tot</button>
              </>
            ) : (
              <>
                <h1>Ești la zi!</h1>
                <p>Nicio factură de plată. Adaugă primul furnizor ca să nu uiți nimic.</p>
              </>
            )}
          </div>
        </article>

        <article className="hero slide-travel" aria-roledescription="slide" aria-label={`3 din ${SLIDES}`}>
          <div className="hero-art big-ill"><IllPlane size={70} /></div>
          <div className="hero-body">
            <h1>Pleci în vacanță?</h1>
            <p>Asigurare de călătorie de la 29 lei de persoană, plus rovinietă și viniete.</p>
            <button className="hero-btn" onClick={props.onTravel}>Vezi pachetele</button>
          </div>
        </article>
      </div>
      <div className="dots" role="tablist" aria-label="Alege secțiunea">
        {Array.from({ length: SLIDES }, (_, i) => (
          <button key={i} role="tab" aria-selected={i === index} aria-label={`Secțiunea ${i + 1}`} className={i === index ? "on" : ""} onClick={() => goTo(i)} />
        ))}
      </div>
    </section>
  );
}

export function Home(props: {
  userName: string;
  bills: Bill[];
  car: CarData | null;
  proactive: string | null;
  onAsk: (text?: string) => void;
  onGo: (s: Screen, opts?: { history?: boolean }) => void;
}) {
  const pay = usePay();
  const due = props.bills.filter((b) => b.status !== "paid").sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const totalDue = Math.round(due.reduce((s, b) => s + b.amount, 0) * 100) / 100;
  const v = props.car?.vehicle ?? null;
  // Dacă sunt mai multe acte de același fel (ex. ai cumpărat un RCA nou), arătăm pe cel valabil cel mai mult.
  const latest = <T extends { validUntil: string }>(xs: T[] = []) => [...xs].sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0];
  const rca = latest(props.car?.policies);
  const rov = latest(props.car?.vignettes.filter((x) => x.country === "RO"));
  const bg = latest(props.car?.vignettes.filter((x) => x.country === "BG"));
  const first = props.userName.split(" ")[0] || "";
  const payAll = () => pay.payBills(due.map((b) => b.id));

  return (
    <div className="screen">
      <header className="topbar">
        <span className="points" aria-label="150 puncte Pago"><CoinP size={24} /> 150</span>
        <div className="topbar-actions">
          <button className="pill-btn" onClick={() => props.onGo("bills", { history: true })}><IconHistory /> Istoric</button>
          <button className="round-btn blue" onClick={() => props.onGo("settings")} aria-label="Setări"><IconGear /></button>
        </div>
      </header>

      <Carousel
        first={first}
        proactive={props.proactive}
        totalDue={totalDue}
        dueCount={due.length}
        onAsk={props.onAsk}
        onPayAll={payAll}
        onTravel={() => pay.openPicker({ type: "travel", title: "Asigurare de călătorie" })}
      />

      <h2 className="section-label">Facturi</h2>
      <div className="card">
        {due.length === 0 ? (
          <div className="row-cta">
            <div>
              <div className="card-title">Ești la zi cu facturile</div>
              <div className="card-sub">Adaugă un furnizor sau o factură nouă.</div>
            </div>
            <button className="btn-green" onClick={() => props.onGo("bills")}>Adaugă</button>
          </div>
        ) : (
          <>
            <div className="row-cta">
              <div>
                <div className="card-sub">De plată</div>
                <div className="big-amount">{formatLei(totalDue)}</div>
              </div>
              <button className="btn-green" onClick={payAll}>Plătește</button>
            </div>
            <ul className="mini-bills">
              {due.slice(0, 3).map((b) => {
                const left = daysBetween(toIsoDate(new Date()), b.dueDate);
                return (
                  <li key={b.id}>
                    {/* Atingi factura → o plătești direct (amprentă + plată), fără asistent. */}
                    <button onClick={() => pay.payBills([b.id])} aria-label={`Plătește factura ${CATEGORY_LABEL[b.category]}, ${formatLei(b.amount)}`}>
                      <span className="ill"><BillIllustration category={b.category} size={28} /></span>
                      <span className="mb-body">
                        <b>{CATEGORY_LABEL[b.category]}</b>
                        <span className={left < 0 ? "bad" : left <= 3 ? "warn" : ""}>
                          {left < 0 ? `întârziată ${-left} ${-left === 1 ? "zi" : "zile"}` : left === 0 ? "scadentă azi" : `scadentă în ${left} ${left === 1 ? "zi" : "zile"}`}
                        </span>
                      </span>
                      <b className="amount">{formatLei(b.amount)}</b>
                      <IconChevron size={18} />
                    </button>
                  </li>
                );
              })}
            </ul>
            {due.length > 3 && <button className="see-all" onClick={() => props.onGo("bills")}>Vezi toate facturile <IconChevron size={16} /></button>}
          </>
        )}
      </div>

      <h2 className="section-label">Acțiuni rapide</h2>
      <div className="quick">
        <button onClick={() => props.onAsk("Cât am de plată?")}><IllCalendar size={36} /><span>Cât am de plată?</span></button>
        <button onClick={() => props.onAsk("Ce expiră în curând?")}><IllSparkle size={36} /><span>Ce expiră în curând?</span></button>
        <button onClick={() => props.onGo("other")}><IllGlobeSim size={36} /><span>Alte plăți</span></button>
      </div>

      <h2 className="section-label">Zona auto</h2>
      <div className="card">
        {v ? (
          <button className="row-cta plain" onClick={() => props.onGo("car")}>
            <div className="car-id">
              <span className="plate">{v.plate}</span>
              <span className="card-sub">{v.make} {v.model}</span>
            </div>
            <IconChevron />
          </button>
        ) : (
          <div className="row-cta">
            <div>
              <div className="card-title">Adaugă mașina</div>
              <div className="card-sub">Îți amintim când expiră RCA-ul și rovinieta ✨</div>
            </div>
            <button className="btn-green" onClick={() => props.onGo("car")}>Continuă</button>
          </div>
        )}
        <div className="auto-grid">
          {[
            { label: "RCA", icon: <IllShieldCar size={24} />, doc: rca, open: () => pay.openPicker({ type: "rca", title: "Oferte RCA" }) },
            { label: "Rovinietă", icon: <IllRoad size={24} />, doc: rov, open: () => pay.openPicker({ type: "vignette", country: "RO", title: "Rovinietă" }) },
            { label: "Vinietă BG", icon: <IllRoad size={24} />, doc: bg, open: () => pay.openPicker({ type: "vignette", country: "BG", title: "Vinietă Bulgaria" }) },
            { label: "Roaming", icon: <IllGlobeSim size={24} />, doc: latest(props.car?.services.filter((s) => s.type !== "insurance")), open: () => pay.openPicker({ type: "roaming", title: "Roaming" }) },
          ].map((x) => {
            const st = x.doc ? daysLeftText(x.doc.validUntil) : { text: "Lipsește", cls: "muted" };
            return (
              <button key={x.label} className="auto-tile" onClick={x.open}>
                {x.icon}
                <span className="at-label">{x.label}</span>
                <span className={`pill ${st.cls}`}>{st.text}</span>
              </button>
            );
          })}
        </div>
      </div>

      <h2 className="section-label">Călătorii</h2>
      <div className="card">
        <div className="card-title">Pleci în vacanță?</div>
        <div className="card-sub">Pago AI verifică ce acte îți lipsesc și îți arată pachetele de asigurare.</div>
        <div className="trip-chips">
          {TRIPS.map((t) => (
            <button key={t.code} onClick={() => props.onAsk(`Plec în ${t.name} săptămâna viitoare.`)}>
              <span aria-hidden="true">{t.flag}</span> {t.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
