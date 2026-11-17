import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatLei, priceForPersons, type PaymentRequestItem, type PendingPaymentForClient, type Product, type ProductType } from "@pago/shared";
import { api } from "./api.ts";
import { verifyBiometric } from "./biometric.ts";
import { CheckoutCard, SuccessScreen } from "./cards.tsx";
import { IconClose, IllGlobeSim, IllPlane, IllRoad, IllShieldCar } from "./icons.tsx";

/**
 * Plăți făcute direct din ecrane (Facturi, Acasă, Mașina, Alte plăți, cardul de călătorie), FĂRĂ asistent:
 * alegi (dacă e cazul) → vezi sumarul → amprentă / Face Unlock → plata. Suma o calculează mereu serverul.
 * Folosim o sesiune separată de cea a asistentului, ca plățile directe să nu-i anuleze plata pregătită în conversație.
 */
const uiSession = `ui-${crypto.randomUUID()}`;

type PickerFilter = { type: ProductType; country?: string; title: string; vehicleId?: string };

type State =
  | { step: "closed" }
  | { step: "pick"; title: string; products: Product[]; vehicleId?: string }
  | { step: "checkout"; pending: PendingPaymentForClient }
  | { step: "error"; message: string };

interface PayApi {
  /** Plătește una sau mai multe facturi. */
  payBills(billIds: string[]): void;
  /** Cumpără un produs anume (ex. asigurare pentru 3 persoane). */
  buyProduct(productId: string, opts?: { persons?: number; vehicleId?: string }): void;
  /** Arată ofertele de un anumit tip (RCA, rovinietă...) și cumpără oferta aleasă. */
  openPicker(filter: PickerFilter): void;
  /** Mesaj scurt jos pe ecran (ex. „Funcție indisponibilă în demo”). */
  toast(text: string): void;
}

const PayContext = createContext<PayApi | null>(null);

export function usePay(): PayApi {
  const ctx = useContext(PayContext);
  if (!ctx) throw new Error("usePay() trebuie folosit în <PayProvider>");
  return ctx;
}

function productIcon(type: ProductType) {
  if (type === "rca") return <IllShieldCar size={30} />;
  if (type === "vignette") return <IllRoad size={30} />;
  if (type === "travel") return <IllPlane size={30} />;
  return <IllGlobeSim size={30} />;
}

export function PayProvider({ children, onPaid }: { children: ReactNode; onPaid: () => void }) {
  const [state, setState] = useState<State>({ step: "closed" });
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<{ total: number; lines: PendingPaymentForClient["lines"] } | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const confirmingRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const toast = useCallback((text: string) => {
    setToastText(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(null), 2600);
  }, []);

  const prepare = useCallback(async (items: PaymentRequestItem[]) => {
    setBusy(true);
    try {
      const pending = await api.post<PendingPaymentForClient>("/api/payments/prepare", { sessionId: uiSession, items });
      setState({ step: "checkout", pending });
    } catch (e) {
      setState({ step: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, []);

  const payBills = useCallback((billIds: string[]) => {
    if (billIds.length) prepare(billIds.map((billId) => ({ kind: "bill" as const, billId })));
  }, [prepare]);

  const buyProduct = useCallback((productId: string, opts?: { persons?: number; vehicleId?: string }) => {
    prepare([{ kind: "product", productId, persons: opts?.persons, vehicleId: opts?.vehicleId }]);
  }, [prepare]);

  const openPicker = useCallback(async (filter: PickerFilter) => {
    setBusy(true);
    try {
      const all = await api.get<Product[]>(`/api/products?type=${filter.type}`);
      const products = filter.country ? all.filter((p) => p.country === filter.country) : all;
      setState({ step: "pick", title: filter.title, products, vehicleId: filter.vehicleId });
    } catch (e) {
      setState({ step: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, []);

  /** Închide fără să plătească; o plată pregătită se anulează (fără asistent). */
  const close = useCallback(() => {
    if (state.step === "checkout") {
      api.post("/api/payments/cancel", { sessionId: uiSession, token: state.pending.token, quiet: true }).catch(() => {});
    }
    setState({ step: "closed" });
  }, [state]);

  async function confirm() {
    if (state.step !== "checkout" || confirmingRef.current) return;
    const p = state.pending;
    confirmingRef.current = true;
    setBusy(true);
    try {
      // BARIERĂ DE SECURITATE: amprentă / Face Unlock înainte de cererea de plată (doar pe telefon).
      const bio = await verifyBiometric(`Plătești ${formatLei(p.total)}`);
      if (bio === "cancelled") {
        toast("Nu te-am putut verifica. Nu am plătit nimic.");
        return;
      }
      const r = await api.post<{ payment: { total: number } }>("/api/payments/confirm", { sessionId: uiSession, token: p.token, quiet: true });
      setState({ step: "closed" });
      setSuccess({ total: r.payment.total, lines: p.lines });
      onPaid();
    } catch (e) {
      setState({ step: "error", message: (e as Error).message });
      onPaid();
    } finally {
      confirmingRef.current = false;
      setBusy(false);
    }
  }

  const closeSuccess = useCallback(() => setSuccess(null), []);
  const apiValue = useMemo<PayApi>(() => ({ payBills, buyProduct, openPicker, toast }), [payBills, buyProduct, openPicker, toast]);
  const open = state.step !== "closed";

  // Butonul Înapoi / Escape închide foaia de plată.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <PayContext.Provider value={apiValue}>
      {children}

      <div className={`pay-wrap ${open ? "open" : ""}`} aria-hidden={!open}>
        <div className="sheet-backdrop" onClick={close} />
        <section className="pay-sheet" role="dialog" aria-modal="true" aria-label="Plată" inert={!open}>
          <div className="sheet-grip" aria-hidden="true" />
          <header className="pay-head">
            <h2>{state.step === "pick" ? state.title : state.step === "error" ? "Nu am putut continua" : "Plată"}</h2>
            <button className="round-btn" onClick={close} aria-label="Închide"><IconClose /></button>
          </header>

          {state.step === "pick" && (
            <ul className="offers pay-list">
              {state.products.length === 0 && <li className="card-sub">Nu sunt oferte pentru asta acum.</li>}
              {state.products.map((p) => (
                <li key={p.id}>
                  <button className="offer" disabled={busy} onClick={() => buyProduct(p.id, { vehicleId: state.vehicleId, persons: p.perPerson ? 1 : undefined })}>
                    <span className="offer-ico">{productIcon(p.type)}</span>
                    <span className="offer-body">
                      <b>{p.name}</b>
                      <span>{p.coverage ?? `${p.durationDays} ${p.durationDays === 1 ? "zi" : "zile"}`}</span>
                    </span>
                    <b className="amount">{p.perPerson ? `${formatLei(priceForPersons(p.price, 1))}/pers.` : formatLei(p.price)}</b>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {state.step === "checkout" && (
            <CheckoutCard pending={state.pending} busy={busy} onConfirm={confirm} onCancel={close} screenOnly />
          )}

          {state.step === "error" && (
            <div className="pay-error">
              <p>{state.message}</p>
              <button className="btn-green big" onClick={() => setState({ step: "closed" })}>Am înțeles</button>
            </div>
          )}
        </section>
      </div>

      {busy && state.step === "closed" && <div className="pay-loading" aria-live="polite">Pregătesc plata…</div>}
      {toastText && <div className="toast" role="status">{toastText}</div>}
      {success && <SuccessScreen total={success.total} lines={success.lines} onClose={closeSuccess} />}
    </PayContext.Provider>
  );
}
