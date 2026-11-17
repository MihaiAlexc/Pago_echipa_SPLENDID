import type { ReactNode } from "react";
import {
  IllBridge, IllCarReport, IllCredit, IllDonate, IllGaming, IllGlobeSim, IllLoto, IllPlane, IllRoad, IllSuggest, IllTaxes, IllTopUp,
} from "./icons.tsx";
import { usePay } from "./pay.tsx";
import type { Screen } from "./Home.tsx";

type Tile = { id: string; label: string; icon: ReactNode; onClick: () => void; disabled?: boolean };

/** Ecranul „Alte plăți”, după aplicația Pago: o grilă de servicii. */
export function OtherPayments({ onGo }: { onGo: (s: Screen) => void }) {
  const pay = usePay();
  const notInDemo = (what: string) => () => pay.toast(`${what} nu e inclus în demo. Încearcă Roviniete, eSIM sau Asigurare călătorie.`);

  const tiles: Tile[] = [
    { id: "topup", label: "Reîncărcări", icon: <IllTopUp />, onClick: notInDemo("Reîncărcarea") },
    { id: "donate", label: "Donații", icon: <IllDonate />, onClick: notInDemo("Donațiile") },
    { id: "gaming", label: "Gaming", icon: <IllGaming />, onClick: notInDemo("Gaming-ul") },
    { id: "taxes", label: "Taxe și impozite", icon: <IllTaxes />, onClick: notInDemo("Plata taxelor") },
    { id: "suggest", label: "Sugerează tip de plată", icon: <IllSuggest />, onClick: () => pay.toast("Mulțumim! Am notat sugestia ta (demo).") },
    { id: "vignette", label: "Roviniete", icon: <IllRoad size={44} />, onClick: () => pay.openPicker({ type: "vignette", title: "Roviniete și viniete" }) },
    { id: "credit", label: "Credit", icon: <IllCredit />, onClick: notInDemo("Creditul") },
    { id: "loto", label: "Loto", icon: <IllLoto />, onClick: notInDemo("Loto") },
    { id: "bridge", label: "Trecere de pod", icon: <IllBridge />, onClick: () => pay.toast("Trecerea de pod e momentan indisponibilă."), disabled: true },
    { id: "report", label: "Raport auto", icon: <IllCarReport />, onClick: () => onGo("car") },
    { id: "esim", label: "eSIM", icon: <IllGlobeSim size={44} />, onClick: () => pay.openPicker({ type: "roaming", title: "eSIM și roaming" }) },
    { id: "travel", label: "Asigurare călătorie", icon: <IllPlane size={44} />, onClick: () => pay.openPicker({ type: "travel", title: "Asigurare de călătorie" }) },
  ];

  return (
    <div className="screen other">
      <h1 className="page-title tight">Alte plăți</h1>
      <p className="page-sub">Descoperă și alte funcționalități ale aplicației</p>
      <ul className="tiles">
        {tiles.map((t) => (
          <li key={t.id}>
            <button className={`tile ${t.disabled ? "disabled" : ""}`} onClick={t.onClick} aria-disabled={t.disabled || undefined}>
              <span className="tile-box">{t.icon}</span>
              <span className="tile-label">{t.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
