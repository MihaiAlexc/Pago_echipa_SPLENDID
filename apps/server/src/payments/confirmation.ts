import { randomUUID } from "node:crypto";
import type {
  Payment,
  PaymentLine,
  PaymentRequestItem,
  PendingPaymentForClient,
  PendingPaymentSummary,
} from "@pago/shared";
import type { PagoStore } from "../mock/store.ts";
import { classifyConfirmation } from "./intent.ts";

/** Peste acest total, plata se confirmă doar cu butonul de pe ecran. */
export const SCREEN_CONFIRM_THRESHOLD = 500;

/** Cât e valabil un token de confirmare. */
export const TOKEN_TTL_MS = 5 * 60 * 1000;

export type ConfirmErrorCode =
  | "NO_PENDING_PAYMENT"
  | "TOKEN_INVALID"
  | "TOKEN_USED"
  | "TOKEN_EXPIRED"
  | "AMOUNT_CHANGED"
  | "SCREEN_CONFIRM_REQUIRED";

export class ConfirmError extends Error {
  constructor(public code: ConfirmErrorCode, message: string) {
    super(message);
  }
}

export type ConfirmVia = "button" | "voice";

interface Pending {
  token: string;
  sessionId: string;
  items: PaymentRequestItem[];
  lines: PaymentLine[];
  total: number;
  expiresAt: number; // ms
}

/** Ce s-a întâmplat cu un mesaj al utilizatorului, înainte de LLM. */
export type TurnOutcome =
  | { kind: "confirmed"; payment: Payment }
  | { kind: "cancelled" }
  | { kind: "needs_screen"; summary: PendingPaymentSummary }
  | { kind: "failed"; code: string; message: string }
  | { kind: "pass" }; // nu e un „da”/„nu” clar (sau nu e nimic în așteptare) → mesajul merge la LLM

/**
 * STRATUL DE CONFIRMARE — singurul loc din aplicație care apelează `store.executePayment`.
 *
 * Reguli:
 * - o singură plată în așteptare per sesiune; o nouă `prepare` o înlocuiește pe cea veche;
 * - token valabil o singură dată, expiră după TOKEN_TTL_MS, legat de sesiune, sumă și produse;
 * - dacă datele s-au schimbat între pregătire și confirmare (ex. altă sumă) → token invalid;
 * - peste SCREEN_CONFIRM_THRESHOLD lei → doar butonul de pe ecran confirmă.
 */
export class PaymentConfirmation {
  private pendingBySession = new Map<string, Pending>();
  private usedTokens = new Set<string>();
  private readonly nowMs: () => number;

  constructor(private store: PagoStore, options: { nowMs?: () => number } = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /** Pregătește plata. NU mută bani. Întoarce sumarul (pentru LLM) și token-ul (doar pentru frontend). */
  prepare(sessionId: string, items: PaymentRequestItem[]): PendingPaymentForClient {
    const { lines, total } = this.store.quote(items); // aruncă PagoError dacă cererea nu e validă
    const old = this.pendingBySession.get(sessionId);
    if (old) this.discard(old); // tokenul vechi nu mai poate fi folosit
    const pending: Pending = {
      token: randomUUID(),
      sessionId,
      items: structuredClone(items),
      lines,
      total,
      expiresAt: this.nowMs() + TOKEN_TTL_MS,
    };
    this.pendingBySession.set(sessionId, pending); // înlocuiește orice plată veche
    return { ...this.summarize(pending), token: pending.token };
  }

  /** Plata în așteptare, cu token (pentru cardul Confirmă / Anulează din frontend). */
  getPendingForClient(sessionId: string): PendingPaymentForClient | null {
    const p = this.activePending(sessionId);
    return p ? { ...this.summarize(p), token: p.token } : null;
  }

  /** Plata în așteptare, FĂRĂ token (pentru LLM). */
  getPendingSummary(sessionId: string): PendingPaymentSummary | null {
    const p = this.activePending(sessionId);
    return p ? this.summarize(p) : null;
  }

  /** Confirmă cu token (butonul de pe ecran, sau intern după un „da” vocal). Aici se mută banii. */
  confirm(sessionId: string, token: string, via: ConfirmVia): Payment {
    if (this.usedTokens.has(token)) throw new ConfirmError("TOKEN_USED", "Plata asta a fost deja confirmată sau anulată.");

    const pending = this.pendingBySession.get(sessionId);
    if (!pending || pending.token !== token) throw new ConfirmError("TOKEN_INVALID", "Nu există o plată în așteptare cu acest token.");

    if (this.nowMs() > pending.expiresAt) {
      this.discard(pending);
      throw new ConfirmError("TOKEN_EXPIRED", "Confirmarea a expirat. Te rog să pregătim plata din nou.");
    }

    if (via === "voice" && pending.total > SCREEN_CONFIRM_THRESHOLD) {
      // Nu ardem token-ul: utilizatorul poate apăsa butonul.
      throw new ConfirmError("SCREEN_CONFIRM_REQUIRED", `Plățile de peste ${SCREEN_CONFIRM_THRESHOLD} lei se confirmă cu butonul de pe ecran.`);
    }

    // Sumele trebuie să fie exact cele arătate utilizatorului.
    let current: { lines: PaymentLine[]; total: number };
    try {
      current = this.store.quote(pending.items);
    } catch (e) {
      this.discard(pending);
      throw e; // ex. factura a fost plătită între timp
    }
    if (!sameLines(current.lines, pending.lines) || current.total !== pending.total) {
      this.discard(pending);
      throw new ConfirmError("AMOUNT_CHANGED", "Suma s-a schimbat de când ți-am arătat-o. Te rog să verificăm din nou.");
    }

    this.discard(pending); // marcăm token-ul ca folosit ÎNAINTE de execuție: nu poate fi refolosit
    return this.store.executePayment(pending.items);
  }

  /** Anulează plata în așteptare. Fără token = anulează ce e în așteptare (anularea e mereu sigură). */
  cancel(sessionId: string, token?: string): boolean {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending) return false;
    if (token && pending.token !== token) throw new ConfirmError("TOKEN_INVALID", "Token necunoscut.");
    this.discard(pending);
    return true;
  }

  /**
   * Rulează ÎNAINTE ca mesajul să ajungă la LLM.
   * Dacă e o plată în așteptare și mesajul e un „da” / „nu” clar, decidem aici, în cod.
   */
  handleUserMessage(sessionId: string, text: string): TurnOutcome {
    const pending = this.activePending(sessionId);
    if (!pending) return { kind: "pass" };

    const intent = classifyConfirmation(text);
    if (intent === "no") {
      this.discard(pending);
      return { kind: "cancelled" };
    }
    if (intent === "other") return { kind: "pass" };

    try {
      return { kind: "confirmed", payment: this.confirm(sessionId, pending.token, "voice") };
    } catch (e) {
      if (e instanceof ConfirmError && e.code === "SCREEN_CONFIRM_REQUIRED") {
        return { kind: "needs_screen", summary: this.summarize(pending) };
      }
      const err = e as { code?: string; message?: string };
      return { kind: "failed", code: err.code ?? "UNKNOWN", message: err.message ?? "Plata nu a reușit." };
    }
  }

  /** La resetarea poveștii: nicio plată veche nu mai rămâne în așteptare. */
  clearAll(): void {
    for (const p of this.pendingBySession.values()) this.usedTokens.add(p.token);
    this.pendingBySession.clear();
  }

  // ---------- intern ----------

  private activePending(sessionId: string): Pending | null {
    const p = this.pendingBySession.get(sessionId);
    if (!p) return null;
    if (this.nowMs() > p.expiresAt) {
      this.discard(p);
      return null;
    }
    return p;
  }

  private discard(p: Pending) {
    this.usedTokens.add(p.token);
    if (this.pendingBySession.get(p.sessionId)?.token === p.token) this.pendingBySession.delete(p.sessionId);
  }

  private summarize(p: Pending): PendingPaymentSummary {
    return {
      lines: p.lines,
      total: p.total,
      requiresScreenConfirm: p.total > SCREEN_CONFIRM_THRESHOLD,
      expiresAt: new Date(p.expiresAt).toISOString(),
    };
  }
}

function sameLines(a: PaymentLine[], b: PaymentLine[]): boolean {
  return a.length === b.length && a.every((l, i) => l.refId === b[i].refId && l.amount === b[i].amount && l.kind === b[i].kind);
}
