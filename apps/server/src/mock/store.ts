import {
  addDays,
  toIsoDate,
  type Bill,
  type BillStatus,
  type IsoDate,
  type PagoData,
  type Payment,
  type PaymentLine,
  type PaymentRequestItem,
  type Product,
  type ProductType,
  type SeedVariant,
} from "@pago/shared";
import { createSeed } from "./seed.ts";

export type PagoErrorCode =
  | "BILL_NOT_FOUND"
  | "BILL_ALREADY_PAID"
  | "PRODUCT_NOT_FOUND"
  | "VEHICLE_NOT_FOUND"
  | "EMPTY_PAYMENT"
  | "DUPLICATE_ITEM";

/** Eroare de business, cu un cod stabil (ușor de testat și de tradus în mesaj). */
export class PagoError extends Error {
  constructor(public code: PagoErrorCode, message: string) {
    super(message);
  }
}

export interface StoreOptions {
  variant?: SeedVariant;
  /** Ceasul; în teste îl fixăm ca rezultatele să fie mereu aceleași. */
  now?: () => Date;
}

/**
 * „API-ul Pago” simulat, în memorie.
 * Metodele de citire nu schimbă nimic. Singura metodă care mută bani este `executePayment`,
 * și ea va fi apelată DOAR de stratul de confirmare (Pasul 2), niciodată direct de LLM.
 */
export class PagoStore {
  private data!: PagoData;
  private readonly now: () => Date;
  private paymentCounter = 0;

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.reset(options.variant ?? "demo");
  }

  today(): IsoDate {
    return toIsoDate(this.now());
  }

  reset(variant: SeedVariant): void {
    // Copie adâncă: modificările dintr-o sesiune nu strică seed-ul.
    this.data = structuredClone(createSeed(variant, this.today()));
    this.paymentCounter = 0;
  }

  // ---------- Citire ----------

  getUser() {
    return this.data.user;
  }

  listBills(status?: BillStatus): Bill[] {
    return status ? this.data.bills.filter((b) => b.status === status) : this.data.bills;
  }

  getVehicles() {
    return this.data.vehicles;
  }

  getPolicies(vehicleId?: string) {
    return vehicleId ? this.data.policies.filter((p) => p.vehicleId === vehicleId) : this.data.policies;
  }

  getVignettes(vehicleId?: string) {
    return vehicleId ? this.data.vignettes.filter((v) => v.vehicleId === vehicleId) : this.data.vignettes;
  }

  getServices() {
    return this.data.services;
  }

  searchProducts(type?: ProductType): Product[] {
    return type ? this.data.products.filter((p) => p.type === type) : this.data.products;
  }

  listPayments(): Payment[] {
    return this.data.payments;
  }

  // ---------- Calculul unei plăți (fără efecte) ----------

  /**
   * Transformă cererea în linii de plată cu sume LUATE DIN DATE.
   * Aruncă PagoError dacă ceva nu e valid. Nu modifică nimic.
   */
  quote(items: PaymentRequestItem[]): { lines: PaymentLine[]; total: number } {
    if (items.length === 0) throw new PagoError("EMPTY_PAYMENT", "Nu e nimic de plătit.");

    const seen = new Set<string>();
    const lines: PaymentLine[] = items.map((item) => {
      const key = item.kind === "bill" ? `bill:${item.billId}` : `product:${item.productId}`;
      if (seen.has(key)) throw new PagoError("DUPLICATE_ITEM", "Același element apare de două ori.");
      seen.add(key);

      if (item.kind === "bill") {
        const bill = this.findBill(item.billId);
        if (bill.status === "paid") {
          throw new PagoError("BILL_ALREADY_PAID", `Factura ${bill.provider} este deja plătită.`);
        }
        return { kind: "bill", refId: bill.id, label: `Factură ${bill.provider}`, amount: bill.amount };
      }

      const product = this.findProduct(item.productId);
      if (product.type === "rca" || product.type === "vignette") this.resolveVehicle(item.vehicleId);
      return { kind: "product", refId: product.id, label: product.name, amount: product.price };
    });

    const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    return { lines, total };
  }

  // ---------- Execuție (MUTĂ BANI — doar din stratul de confirmare) ----------

  /** Totul sau nimic: validăm tot înainte să modificăm ceva. */
  executePayment(items: PaymentRequestItem[]): Payment {
    const { lines, total } = this.quote(items);
    const today = this.today();

    for (const item of items) {
      if (item.kind === "bill") {
        const bill = this.findBill(item.billId);
        bill.status = "paid";
        bill.paidAt = today;
      } else {
        this.deliverProduct(this.findProduct(item.productId), item.vehicleId, today);
      }
    }

    const payment: Payment = {
      id: `pay-${++this.paymentCounter}`,
      lines,
      total,
      status: "completed",
      createdAt: this.now().toISOString(),
    };
    this.data.payments.push(payment);
    return payment;
  }

  // ---------- Ajutoare interne ----------

  private findBill(id: string): Bill {
    const bill = this.data.bills.find((b) => b.id === id);
    if (!bill) throw new PagoError("BILL_NOT_FOUND", "Nu am găsit factura.");
    return bill;
  }

  private findProduct(id: string): Product {
    const product = this.data.products.find((p) => p.id === id);
    if (!product) throw new PagoError("PRODUCT_NOT_FOUND", "Nu am găsit produsul.");
    return product;
  }

  /** Fără vehicleId → prima mașină a utilizatorului. */
  private resolveVehicle(vehicleId?: string) {
    const vehicle = vehicleId
      ? this.data.vehicles.find((v) => v.id === vehicleId)
      : this.data.vehicles[0];
    if (!vehicle) throw new PagoError("VEHICLE_NOT_FOUND", "Nu am găsit mașina.");
    return vehicle;
  }

  /** Ce primești după ce cumperi un produs (poliță, vinietă, roaming...). */
  private deliverProduct(product: Product, vehicleId: string | undefined, today: IsoDate): void {
    const validUntil = addDays(today, product.durationDays);
    const id = `${product.type}-${this.data.payments.length + 1}-${product.id}`;

    switch (product.type) {
      case "rca":
        this.data.policies.push({
          id, type: "RCA", vehicleId: this.resolveVehicle(vehicleId).id,
          validFrom: today, validUntil, countries: [...(product.countries ?? [])],
        });
        break;
      case "vignette":
        this.data.vignettes.push({
          id, vehicleId: this.resolveVehicle(vehicleId).id,
          country: product.country ?? "RO", validFrom: today, validUntil,
        });
        break;
      case "roaming":
      case "sim":
        this.data.services.push({
          id, type: product.type, country: product.country ?? "", validFrom: today, validUntil,
        });
        break;
    }
  }
}
