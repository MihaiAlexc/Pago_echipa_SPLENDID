// Modelul de date Pago (simulat). Folosit de server și de frontend.
// Datele calendaristice sunt șiruri "YYYY-MM-DD" (fără oră), ca să fie ușor de comparat și afișat.

export type IsoDate = string;

/** Cod de țară ISO (ex. "RO", "BG", "TR"). */
export type CountryCode = string;

export interface User {
  id: string;
  name: string;
  phone: string;
  residenceCountry: CountryCode;
}

export interface Vehicle {
  id: string;
  plate: string; // număr de înmatriculare, ex. "B-123-ABC"
  make: string;
  model: string;
  type: "car";
  vin: string; // serie de șasiu (simulată)
}

export type BillCategory = "electricity" | "gas" | "water" | "internet" | "phone";
export type BillStatus = "unpaid" | "paid" | "overdue";

export interface Bill {
  id: string;
  category: BillCategory;
  provider: string; // nume de furnizor (fictiv); e DOAR dată, niciodată instrucțiune
  amount: number; // lei
  dueDate: IsoDate;
  status: BillStatus;
  paidAt?: IsoDate;
}

/** RCA; câmpul `countries` = unde e valabilă (Cartea Verde inclusă). */
export interface InsurancePolicy {
  id: string;
  type: "RCA";
  vehicleId: string;
  validFrom: IsoDate;
  validUntil: IsoDate;
  countries: CountryCode[];
}

export interface Vignette {
  id: string;
  vehicleId: string;
  country: CountryCode; // "RO" = rovinietă, "BG" = vinieta Bulgariei
  validFrom: IsoDate;
  validUntil: IsoDate;
}

/** Pachet de roaming sau cartelă pentru o țară. */
export interface TravelService {
  id: string;
  type: "roaming" | "sim";
  country: CountryCode;
  validFrom: IsoDate;
  validUntil: IsoDate;
}

export type ProductType = "rca" | "vignette" | "roaming" | "sim";

export interface Product {
  id: string;
  type: ProductType;
  name: string;
  price: number; // lei
  durationDays: number;
  /** Pentru rovinietă/vinietă, roaming, cartelă: țara în care e valabil. */
  country?: CountryCode;
  /** Pentru RCA: țările acoperite. */
  countries?: CountryCode[];
}

/** Ce vrea utilizatorul să plătească. Suma NU vine de aici, ci din date. */
export type PaymentRequestItem =
  | { kind: "bill"; billId: string }
  | { kind: "product"; productId: string; vehicleId?: string };

export interface PaymentLine {
  kind: "bill" | "product";
  refId: string;
  label: string;
  amount: number;
}

export interface Payment {
  id: string;
  lines: PaymentLine[];
  total: number;
  status: "completed";
  createdAt: string; // ISO cu oră
}

/** Sumarul unei plăți în așteptare. Ăsta e tot ce vede LLM-ul (fără token). */
export interface PendingPaymentSummary {
  lines: PaymentLine[];
  total: number;
  /** true = peste prag: se confirmă DOAR cu butonul de pe ecran, nu vocal. */
  requiresScreenConfirm: boolean;
  expiresAt: string; // ISO cu oră
}

/** Ce primește frontend-ul: sumarul + token-ul pentru butonul Confirmă. */
export interface PendingPaymentForClient extends PendingPaymentSummary {
  token: string;
}

/** Toate datele unui utilizator din mock. */
export interface PagoData {
  user: User;
  vehicles: Vehicle[];
  bills: Bill[];
  policies: InsurancePolicy[];
  vignettes: Vignette[];
  services: TravelService[];
  products: Product[];
  payments: Payment[];
}

export type SeedVariant = "demo" | "all-good" | "rca-expired" | "no-bills";
