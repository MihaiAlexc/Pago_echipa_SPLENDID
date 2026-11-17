import { useEffect, useState, type ReactNode } from "react";
import {
  addDays, daysBetween, formatLei, toIsoDate,
  type Inspection, type InsurancePolicy, type Payment, type ProductType, type TravelService, type Vehicle, type Vignette,
} from "@pago/shared";
import { api } from "./api.ts";
import { IconPlus, IllCalendar, IllGlobeSim, IllPlane, IllRoad, IllShieldCar } from "./icons.tsx";
import { usePay } from "./pay.tsx";

export interface CarData {
  vehicle: Vehicle | null;
  policies: InsurancePolicy[];
  vignettes: Vignette[];
  services: TravelService[];
  inspections: Inspection[];
}

const COUNTRY_RO: Record<string, string> = { RO: "România", BG: "Bulgaria", TR: "Turcia", GR: "Grecia", "EU+TR": "Europa și Turcia" };

function dateRo(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

type Status = { text: string; tag: string; cls: "ok" | "warn" | "bad" | "muted" };
function validity(validUntil?: string): Status {
  if (!validUntil) return { text: "Nu ai acest act înregistrat", tag: "Lipsește", cls: "muted" };
  const left = daysBetween(toIsoDate(new Date()), validUntil);
  if (left < 0) return { text: `a expirat pe ${dateRo(validUntil)}`, tag: "Expirat", cls: "bad" };
  if (left <= 30) return { text: `expiră în ${left} ${left === 1 ? "zi" : "zile"} (${dateRo(validUntil)})`, tag: "Expiră curând", cls: "warn" };
  return { text: `valabil până pe ${dateRo(validUntil)}`, tag: "Valabil", cls: "ok" };
}

const latest = <T extends { validUntil: string }>(xs: T[]) => [...xs].sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0];

/** Un rând de act: iconiță, nume, stare și acțiunile lui. */
function DocRow(props: { icon: ReactNode; title: string; detail?: string; status: Status; children?: ReactNode }) {
  return (
    <li className="card doc">
      <span className="doc-ico">{props.icon}</span>
      <div className="doc-body">
        <div className="doc-top">
          <b>{props.title}</b>
          <span className={`pill ${props.status.cls}`}>{props.status.tag}</span>
        </div>
        {props.detail && <span className="card-sub">{props.detail}</span>}
        <span className="card-sub">{props.status.text}</span>
        {props.children && <div className="doc-actions">{props.children}</div>}
      </div>
    </li>
  );
}

/** Ecranul „Mașina mea”: mașina, actele ei și plățile auto. Totul funcțional, iar asistentul folosește aceleași date. */
export function Car(props: { data: CarData | null; onChanged: () => void }) {
  const pay = usePay();
  const v = props.data?.vehicle ?? null;
  const [editing, setEditing] = useState(false);
  const [car, setCar] = useState({ plate: "", make: "", model: "", vin: "" });
  const [carError, setCarError] = useState<string | null>(null);

  const [addingDoc, setAddingDoc] = useState(false);
  const [kind, setKind] = useState("rca");
  const [validUntil, setValidUntil] = useState(addDays(toIsoDate(new Date()), 365));
  const [coversTurkey, setCoversTurkey] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);

  const [itpEditing, setItpEditing] = useState(false);
  const [itpDate, setItpDate] = useState(addDays(toIsoDate(new Date()), 730));
  const [payments, setPayments] = useState<Payment[]>([]);

  // Plățile auto (RCA, rovinietă, viniete), pentru istoricul de jos. Se reîncarcă după fiecare schimbare.
  useEffect(() => {
    api.get<Payment[]>("/api/payments").then(setPayments).catch(() => setPayments([]));
  }, [props.data]);

  function startEdit() {
    setCar({ plate: v?.plate ?? "", make: v?.make ?? "", model: v?.model ?? "", vin: v?.vin ?? "" });
    setCarError(null);
    setEditing(true);
  }

  async function saveCar(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (v) await api.put(`/api/vehicles/${encodeURIComponent(v.id)}`, car);
      else await api.post("/api/vehicles", car);
      setEditing(false);
      props.onChanged();
      pay.toast(v ? "Am salvat datele mașinii." : "Am adăugat mașina.");
    } catch (err) {
      setCarError((err as Error).message);
    }
  }

  async function addDoc(e: React.FormEvent) {
    e.preventDefault();
    setDocError(null);
    const body =
      kind === "rca" ? { kind: "rca", validUntil, coversTurkey }
      : kind === "ro" ? { kind: "vignette", country: "RO", validUntil }
      : kind === "bg" ? { kind: "vignette", country: "BG", validUntil }
      : kind === "itp" ? { kind: "itp", validUntil }
      : kind === "roaming-tr" ? { kind: "roaming", country: "TR", validUntil }
      : { kind: "sim", country: "TR", validUntil };
    try {
      await api.post("/api/documents", body);
      setAddingDoc(false);
      props.onChanged();
      pay.toast("Am adăugat actul.");
    } catch (err) {
      setDocError((err as Error).message);
    }
  }

  async function saveItp(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/documents", { kind: "itp", validUntil: itpDate });
      setItpEditing(false);
      props.onChanged();
      pay.toast("Am actualizat ITP-ul.");
    } catch (err) {
      pay.toast((err as Error).message);
    }
  }

  async function removeDoc(id: string, what: string) {
    try {
      await api.del(`/api/documents/${encodeURIComponent(id)}`);
      props.onChanged();
      pay.toast(`Am șters ${what}.`);
    } catch (err) {
      pay.toast((err as Error).message);
    }
  }

  /** Cumpărare directă (oferte → sumar → amprentă → plată). Pentru acte auto, întâi trebuie o mașină. */
  function buy(type: ProductType, title: string, country?: string) {
    if ((type === "rca" || type === "vignette") && !v) {
      pay.toast("Adaugă întâi mașina, apoi poți cumpăra RCA sau rovinietă.");
      startEdit();
      return;
    }
    pay.openPicker({ type, country, title, vehicleId: v?.id });
  }

  const d = props.data;
  const rca = d ? latest(d.policies) : undefined;
  const rov = d ? latest(d.vignettes.filter((x) => x.country === "RO")) : undefined;
  const bg = d ? latest(d.vignettes.filter((x) => x.country === "BG")) : undefined;
  const itp = d ? latest(d.inspections ?? []) : undefined;
  const rcaSt = validity(rca?.validUntil);
  const rovSt = validity(rov?.validUntil);
  const itpSt = validity(itp?.validUntil);
  const autoPayments = payments.filter((p) => p.lines.some((l) => /^(rca|rovinieta|vinieta)/.test(l.refId)));

  return (
    <div className="screen">
      <h1 className="page-title">Mașina mea</h1>

      {!editing && v && (
        <div className="card car-hero">
          <IllShieldCar size={64} />
          <div className="car-hero-body">
            <span className="plate">{v.plate}</span>
            <b>{v.make} {v.model}</b>
            {v.vin && <span className="card-sub">Serie șasiu: {v.vin}</span>}
          </div>
          <button className="btn-text small" onClick={startEdit}>Modifică</button>
        </div>
      )}
      {!editing && !v && (
        <div className="card row-cta">
          <div>
            <div className="card-title">Adaugă mașina</div>
            <div className="card-sub">Preluăm automat toate datele de expirare ✨</div>
          </div>
          <button className="btn-green" onClick={startEdit}>Continuă</button>
        </div>
      )}

      {editing && (
        <form className="card form" onSubmit={saveCar}>
          <div className="card-title">{v ? "Modifică mașina" : "Adaugă mașina"}</div>
          <label>Număr de înmatriculare<input value={car.plate} onChange={(e) => setCar({ ...car, plate: e.target.value })} placeholder="ex. B-123-ABC" required maxLength={15} autoCapitalize="characters" /></label>
          <label>Marcă<input value={car.make} onChange={(e) => setCar({ ...car, make: e.target.value })} placeholder="ex. Dacia" required maxLength={30} /></label>
          <label>Model<input value={car.model} onChange={(e) => setCar({ ...car, model: e.target.value })} placeholder="ex. Logan" required maxLength={30} /></label>
          <label>Serie șasiu (opțional)<input value={car.vin} onChange={(e) => setCar({ ...car, vin: e.target.value })} maxLength={17} autoCapitalize="characters" /></label>
          {carError && <p className="error">{carError}</p>}
          <button type="submit" className="btn-green big">Salvează</button>
          <button type="button" className="btn-text" onClick={() => setEditing(false)}>Renunță</button>
        </form>
      )}

      <div className="section-row">
        <h2 className="section-label">Acte</h2>
        <button className="pill-btn" onClick={() => setAddingDoc((x) => !x)} aria-expanded={addingDoc}><IconPlus size={16} /> Am deja un act</button>
      </div>

      {addingDoc && (
        <form className="card form" onSubmit={addDoc}>
          <div className="card-title">Un act pe care îl ai deja</div>
          <label>
            Tip
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="rca">RCA</option>
              <option value="ro">Rovinietă (România)</option>
              <option value="bg">Vinietă Bulgaria</option>
              <option value="itp">ITP</option>
              <option value="roaming-tr">Roaming Turcia</option>
              <option value="sim-tr">Cartelă Turcia</option>
            </select>
          </label>
          <label>Valabil până pe<input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} required /></label>
          {kind === "rca" && (
            <label className="check">
              <input type="checkbox" checked={coversTurkey} onChange={(e) => setCoversTurkey(e.target.checked)} />
              Cartea Verde acoperă și Turcia
            </label>
          )}
          {docError && <p className="error">{docError}</p>}
          <button type="submit" className="btn-green big">Adaugă actul</button>
          <button type="button" className="btn-text" onClick={() => setAddingDoc(false)}>Renunță</button>
        </form>
      )}

      <ul className="doc-list">
        <DocRow
          icon={<IllShieldCar size={34} />}
          title="RCA"
          detail={rca ? (rca.countries.includes("TR") ? "Carte Verde inclusiv Turcia" : "Carte Verde fără Turcia") : undefined}
          status={rcaSt}
        >
          <button className="btn-green small" onClick={() => buy("rca", "Oferte RCA")}>{rca ? "Reînnoiește" : "Cumpără RCA"}</button>
          {rca && <button className="btn-text small" onClick={() => removeDoc(rca.id, "RCA-ul")}>Șterge</button>}
        </DocRow>

        <DocRow icon={<IllRoad size={34} />} title="Rovinietă" detail="România" status={rovSt}>
          <button className="btn-green small" onClick={() => buy("vignette", "Rovinietă", "RO")}>{rov ? "Reînnoiește" : "Cumpără rovinietă"}</button>
          {rov && <button className="btn-text small" onClick={() => removeDoc(rov.id, "rovinieta")}>Șterge</button>}
        </DocRow>

        <DocRow icon={<IllCalendar size={34} />} title="ITP" detail="Inspecția tehnică periodică" status={itpSt}>
          {!itpEditing ? (
            <>
              <button className="btn-green small" onClick={() => { setItpDate(addDays(toIsoDate(new Date()), 730)); setItpEditing(true); }}>
                {itp ? "Am făcut ITP-ul" : "Adaugă ITP"}
              </button>
              {itp && <button className="btn-text small" onClick={() => removeDoc(itp.id, "ITP-ul")}>Șterge</button>}
            </>
          ) : (
            <form className="inline-form" onSubmit={saveItp}>
              <label>Valabil până pe<input type="date" value={itpDate} onChange={(e) => setItpDate(e.target.value)} required /></label>
              <button type="submit" className="btn-green small">Salvează</button>
              <button type="button" className="btn-text small" onClick={() => setItpEditing(false)}>Renunță</button>
            </form>
          )}
        </DocRow>

        <DocRow icon={<IllRoad size={34} />} title="Vinietă Bulgaria" detail="Pentru drumul spre Bulgaria, Grecia, Turcia" status={validity(bg?.validUntil)}>
          <button className="btn-green small" onClick={() => buy("vignette", "Vinietă Bulgaria", "BG")}>{bg ? "Reînnoiește" : "Cumpără"}</button>
          {bg && <button className="btn-text small" onClick={() => removeDoc(bg.id, "vinieta")}>Șterge</button>}
        </DocRow>

        {d?.services.map((s) => {
          const title = s.type === "insurance" ? "Asigurare de călătorie" : s.type === "roaming" ? "Roaming" : "Cartelă";
          const detail = `${COUNTRY_RO[s.country] ?? s.country}${s.persons ? ` · ${s.persons} ${s.persons === 1 ? "persoană" : "persoane"}` : ""}`;
          return (
            <DocRow key={s.id} icon={s.type === "insurance" ? <IllPlane size={34} /> : <IllGlobeSim size={34} />} title={title} detail={detail} status={validity(s.validUntil)}>
              <button className="btn-text small" onClick={() => removeDoc(s.id, title.toLowerCase())}>Șterge</button>
            </DocRow>
          );
        })}
      </ul>

      <h2 className="section-label">Plăți auto</h2>
      {autoPayments.length === 0 ? (
        <p className="card card-sub">Încă nu ai plătit nimic pentru mașină prin Pago.</p>
      ) : (
        <ul className="card list-rows">
          {autoPayments.map((p) => (
            <li key={p.id}>
              <div>
                <b>{p.lines.map((l) => l.label).join(", ")}</b>
                <span className="card-sub">{new Date(p.createdAt).toLocaleString("ro-RO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <b className="amount">{formatLei(p.total)}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
