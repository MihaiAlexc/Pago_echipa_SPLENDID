import { useState } from "react";
import { addDays, daysBetween, toIsoDate, type InsurancePolicy, type TravelService, type Vehicle, type Vignette } from "@pago/shared";

export interface CarData {
  vehicle: Vehicle | null;
  policies: InsurancePolicy[];
  vignettes: Vignette[];
  services: TravelService[];
}

type DocRow = { id: string; title: string; detail: string; validUntil: string };

const COUNTRY_RO: Record<string, string> = { RO: "România", BG: "Bulgaria", TR: "Turcia", GR: "Grecia" };

function dateRo(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function validity(validUntil: string) {
  const left = daysBetween(toIsoDate(new Date()), validUntil);
  if (left < 0) return { text: `expirat pe ${dateRo(validUntil)}`, cls: "overdue" };
  if (left <= 14) return { text: `expiră în ${left} ${left === 1 ? "zi" : "zile"}`, cls: "unpaid" };
  return { text: `valabil până pe ${dateRo(validUntil)}`, cls: "paid" };
}

async function send(method: string, url: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json()).message ?? "Nu am putut salva.");
  return r.json();
}

/** Secțiunea „Mașina mea”: detaliile mașinii și actele ei. Asistentul folosește exact aceste date. */
export function Car(props: { data: CarData | null; onChanged: () => void }) {
  const v = props.data?.vehicle ?? null;
  const [editing, setEditing] = useState(false);
  const [car, setCar] = useState({ plate: "", make: "", model: "", vin: "" });
  const [carError, setCarError] = useState<string | null>(null);

  const [kind, setKind] = useState("rca");
  const [validUntil, setValidUntil] = useState(addDays(toIsoDate(new Date()), 365));
  const [coversTurkey, setCoversTurkey] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);

  function startEdit() {
    setCar({ plate: v?.plate ?? "", make: v?.make ?? "", model: v?.model ?? "", vin: v?.vin ?? "" });
    setCarError(null);
    setEditing(true);
  }

  async function saveCar(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (v) await send("PUT", `/api/vehicles/${encodeURIComponent(v.id)}`, car);
      else await send("POST", "/api/vehicles", car);
      setEditing(false);
      props.onChanged();
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
      : kind === "roaming-tr" ? { kind: "roaming", country: "TR", validUntil }
      : { kind: "sim", country: "TR", validUntil };
    try {
      await send("POST", "/api/documents", body);
      props.onChanged();
    } catch (err) {
      setDocError((err as Error).message);
    }
  }

  async function removeDoc(id: string) {
    await send("DELETE", `/api/documents/${encodeURIComponent(id)}`).catch(() => {});
    props.onChanged();
  }

  const docs: DocRow[] = props.data
    ? [
        ...props.data.policies.map((p) => ({
          id: p.id,
          title: "RCA",
          detail: p.countries.includes("TR") ? "Carte Verde inclusiv Turcia" : "Carte Verde fără Turcia",
          validUntil: p.validUntil,
        })),
        ...props.data.vignettes.map((x) => ({
          id: x.id,
          title: x.country === "RO" ? "Rovinietă" : `Vinietă ${COUNTRY_RO[x.country] ?? x.country}`,
          detail: COUNTRY_RO[x.country] ?? x.country,
          validUntil: x.validUntil,
        })),
        ...props.data.services.map((s) => ({
          id: s.id,
          title: s.type === "roaming" ? "Roaming" : "Cartelă",
          detail: COUNTRY_RO[s.country] ?? s.country,
          validUntil: s.validUntil,
        })),
      ]
    : [];

  return (
    <section className="panel" aria-label="Mașina mea">
      <h2>Mașina mea</h2>

      {!editing && v && (
        <div className="car-card">
          <div>
            <div className="plate">{v.plate}</div>
            <div>{v.make} {v.model}</div>
            {v.vin && <div className="muted small">Serie șasiu: {v.vin}</div>}
          </div>
          <button type="button" className="small-btn" onClick={startEdit}>Modifică</button>
        </div>
      )}
      {!editing && !v && (
        <button type="button" className="wide" onClick={startEdit}>+ Adaugă mașina</button>
      )}

      {editing && (
        <form className="form" onSubmit={saveCar}>
          <label>Număr de înmatriculare<input value={car.plate} onChange={(e) => setCar({ ...car, plate: e.target.value })} placeholder="ex. B-123-ABC" required maxLength={15} /></label>
          <label>Marcă<input value={car.make} onChange={(e) => setCar({ ...car, make: e.target.value })} placeholder="ex. Dacia" required maxLength={30} /></label>
          <label>Model<input value={car.model} onChange={(e) => setCar({ ...car, model: e.target.value })} placeholder="ex. Logan" required maxLength={30} /></label>
          <label>Serie șasiu (opțional)<input value={car.vin} onChange={(e) => setCar({ ...car, vin: e.target.value })} maxLength={17} /></label>
          {carError && <p className="error">{carError}</p>}
          <div className="row">
            <button type="submit" className="wide">Salvează</button>
            <button type="button" className="small-btn" onClick={() => setEditing(false)}>Renunță</button>
          </div>
        </form>
      )}

      <h3>Acte</h3>
      {docs.length === 0 && <p className="muted">Nu ai niciun act înregistrat.</p>}
      <ul className="bill-list">
        {docs.map((d) => {
          const val = validity(d.validUntil);
          return (
            <li key={d.id} className="bill">
              <div className="bill-main">
                <b>{d.title}</b> · {d.detail}
                <div className="muted small">{val.text}</div>
              </div>
              <div className="bill-side">
                <span className={`tag ${val.cls}`}>{val.cls === "overdue" ? "Expirat" : val.cls === "unpaid" ? "Expiră curând" : "Valabil"}</span>
                <button type="button" className="small-btn" onClick={() => removeDoc(d.id)} aria-label={`Șterge ${d.title} ${d.detail}`}>Șterge</button>
              </div>
            </li>
          );
        })}
      </ul>

      <details className="add-bill">
        <summary>+ Adaugă un act pe care îl ai deja</summary>
        <form className="form" onSubmit={addDoc}>
          <label>
            Tip
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="rca">RCA</option>
              <option value="ro">Rovinietă (România)</option>
              <option value="bg">Vinietă Bulgaria</option>
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
          <button type="submit" className="wide">Adaugă actul</button>
        </form>
      </details>
    </section>
  );
}
