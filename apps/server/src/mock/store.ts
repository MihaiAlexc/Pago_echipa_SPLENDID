import {
  addDays,
  isValidPersons,
  MAX_PERSONS,
  priceForPersons,
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
import { createSeed, RCA_WITH_TR, STANDARD_RCA_COUNTRIES } from "./seed.ts";

export type PagoErrorCode =
  | "BILL_NOT_FOUND"
  | "BILL_ALREADY_PAID"
  | "PRODUCT_NOT_FOUND"
  | "VEHICLE_NOT_FOUND"
  | "EMPTY_PAYMENT"
  | "DUPLICATE_ITEM"
  | "INVALID_BILL"
  | "INVALID_CAR"
  | "INVALID_DOCUMENT"
  | "INVALID_PERSONS"
  | "INVALID_NAME"
  | "DOCUMENT_NOT_FOUND";

/** Detaliile mașinii, editate de utilizator. */
export interface VehicleInput {
  plate: string;
  make: string;
  model: string;
  vin?: string;
}

/** Un act adăugat manual: RCA, rovinietă / vinietă, ITP, roaming sau cartelă. */
export type DocumentInput =
  | { kind: "itp"; vehicleId?: string; validUntil: IsoDate }
  | { kind: "rca"; vehicleId?: string; validUntil: IsoDate; coversTurkey?: boolean }
  | { kind: "vignette"; vehicleId?: string; country: "RO" | "BG"; validUntil: IsoDate }
  | { kind: "roaming" | "sim"; country: string; validUntil: IsoDate };

const isIsoDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Ce trimite utilizatorul când adaugă o factură. */
export interface NewBillInput {
  category: Bill["category"];
  provider: string;
  amount: number;
  dueDate: IsoDate;
}

const BILL_CATEGORIES: Bill["category"][] = ["electricity", "gas", "water", "internet", "phone"];

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

  /** Ora curentă, „HH:MM” (ceasul poate fi fixat în teste). */
  timeNow(): string {
    const d = this.now();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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

  /** Schimbă numele utilizatorului (din Setări). Asistentul îl folosește imediat (salut, „cum mă cheamă?”). */
  updateUserName(name: unknown) {
    const clean = String(name ?? "").trim().replace(/\s+/g, " ");
    if (clean.length < 2 || clean.length > 40 || !/^\p{L}[\p{L} .'-]*$/u.test(clean)) {
      throw new PagoError("INVALID_NAME", "Numele trebuie să aibă 2–40 de caractere: litere, spații sau cratimă.");
    }
    this.data.user.name = clean;
    return this.data.user;
  }

  listBills(status?: BillStatus): Bill[] {
    return status ? this.data.bills.filter((b) => b.status === status) : this.data.bills;
  }

  // ---------- Facturile, editate de utilizator din pagină ----------

  /** Adaugă o factură nouă (neplătită; „întârziată” dacă scadența a trecut). */
  addBill(input: NewBillInput): Bill {
    const provider = String(input.provider ?? "").trim().slice(0, 60);
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (!BILL_CATEGORIES.includes(input.category)) throw new PagoError("INVALID_BILL", "Tip de factură necunoscut.");
    if (!provider) throw new PagoError("INVALID_BILL", "Lipsește furnizorul.");
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) throw new PagoError("INVALID_BILL", "Suma trebuie să fie între 0 și 100.000 lei.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate))) throw new PagoError("INVALID_BILL", "Data scadenței nu e validă.");

    const bill: Bill = {
      id: `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      category: input.category,
      provider,
      amount,
      dueDate: input.dueDate,
      status: input.dueDate < this.today() ? "overdue" : "unpaid",
    };
    this.data.bills.push(bill);
    return bill;
  }

  /** Șterge o factură. */
  removeBill(id: string): void {
    const i = this.data.bills.findIndex((b) => b.id === id);
    if (i < 0) throw new PagoError("BILL_NOT_FOUND", "Nu am găsit factura.");
    this.data.bills.splice(i, 1);
  }

  // ---------- Mașina și actele ei, editate de utilizator din pagină ----------

  private cleanVehicle(input: VehicleInput) {
    const plate = String(input.plate ?? "").trim().toUpperCase().slice(0, 15);
    const make = String(input.make ?? "").trim().slice(0, 30);
    const model = String(input.model ?? "").trim().slice(0, 30);
    const vin = String(input.vin ?? "").trim().toUpperCase().slice(0, 17);
    if (!plate) throw new PagoError("INVALID_CAR", "Lipsește numărul de înmatriculare.");
    if (!make || !model) throw new PagoError("INVALID_CAR", "Completează marca și modelul.");
    return { plate, make, model, vin };
  }

  /** Adaugă o mașină (dacă utilizatorul nu are încă una). */
  addVehicle(input: VehicleInput) {
    const v = { id: `v-${Date.now().toString(36)}`, type: "car" as const, ...this.cleanVehicle(input) };
    this.data.vehicles.push(v);
    return v;
  }

  /** Modifică detaliile mașinii. */
  updateVehicle(id: string, input: VehicleInput) {
    const v = this.data.vehicles.find((x) => x.id === id);
    if (!v) throw new PagoError("VEHICLE_NOT_FOUND", "Nu am găsit mașina.");
    Object.assign(v, this.cleanVehicle(input));
    return v;
  }

  /** Adaugă un act pe care utilizatorul îl are deja (cumpărat în altă parte). */
  addDocument(input: DocumentInput) {
    if (!isIsoDate(input.validUntil)) throw new PagoError("INVALID_DOCUMENT", "Data de valabilitate nu e validă.");
    const today = this.today();
    const id = `${input.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

    if (input.kind === "rca") {
      const vehicle = this.resolveVehicle(input.vehicleId);
      const countries = input.coversTurkey ? RCA_WITH_TR : STANDARD_RCA_COUNTRIES;
      const policy = { id, type: "RCA" as const, vehicleId: vehicle.id, validFrom: today, validUntil: input.validUntil, countries: [...countries] };
      this.data.policies.push(policy);
      return policy;
    }
    if (input.kind === "vignette") {
      if (input.country !== "RO" && input.country !== "BG") throw new PagoError("INVALID_DOCUMENT", "Țara vinietei trebuie să fie RO sau BG.");
      const vehicle = this.resolveVehicle(input.vehicleId);
      const vignette = { id, vehicleId: vehicle.id, country: input.country, validFrom: today, validUntil: input.validUntil };
      this.data.vignettes.push(vignette);
      return vignette;
    }
    if (input.kind === "itp") {
      const vehicle = this.resolveVehicle(input.vehicleId);
      // Un singur ITP pe mașină: cel nou îl înlocuiește pe cel vechi (actualizare după inspecție).
      this.data.inspections = this.data.inspections.filter((x) => x.vehicleId !== vehicle.id);
      const inspection = { id, vehicleId: vehicle.id, validFrom: today, validUntil: input.validUntil };
      this.data.inspections.push(inspection);
      return inspection;
    }
    if (input.kind === "roaming" || input.kind === "sim") {
      const country = String(input.country ?? "").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw new PagoError("INVALID_DOCUMENT", "Țara trebuie dată ca cod de 2 litere (ex. TR).");
      const service = { id, type: input.kind, country, validFrom: today, validUntil: input.validUntil };
      this.data.services.push(service);
      return service;
    }
    throw new PagoError("INVALID_DOCUMENT", "Tip de act necunoscut.");
  }

  /** Șterge un act (RCA, vinietă, roaming sau cartelă) după id. */
  removeDocument(id: string): void {
    for (const list of [this.data.policies, this.data.vignettes, this.data.services, this.data.inspections] as { id: string }[][]) {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) {
        list.splice(i, 1);
        return;
      }
    }
    throw new PagoError("DOCUMENT_NOT_FOUND", "Nu am găsit actul.");
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

  getInspections(vehicleId?: string) {
    return vehicleId ? this.data.inspections.filter((x) => x.vehicleId === vehicleId) : this.data.inspections;
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
      if (product.perPerson) {
        // Suma tot din date: prețul din catalog × persoane (cu reducerea de grup), calculată aici, nu primită.
        const persons = item.persons ?? 1;
        if (!isValidPersons(persons)) throw new PagoError("INVALID_PERSONS", `Numărul de persoane trebuie să fie între 1 și ${MAX_PERSONS}.`);
        const label = `${product.name} · ${persons} ${persons === 1 ? "persoană" : "persoane"}`;
        return { kind: "product", refId: product.id, label, amount: priceForPersons(product.price, persons) };
      }
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
        this.deliverProduct(this.findProduct(item.productId), item.vehicleId, today, item.persons);
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
  private deliverProduct(product: Product, vehicleId: string | undefined, today: IsoDate, persons?: number): void {
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
      case "travel":
        this.data.services.push({ id, type: "insurance", country: "EU+TR", validFrom: today, validUntil, persons: persons ?? 1 });
        break;
    }
  }
}
