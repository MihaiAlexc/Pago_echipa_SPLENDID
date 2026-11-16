import {
  addDays,
  type CountryCode,
  type IsoDate,
  type PagoData,
  type Product,
  type SeedVariant,
} from "@pago/shared";

// TOATE datele de aici sunt fictive (persoană, furnizori, prețuri).
// Datele calendaristice sunt relative la „azi”, ca povestea să fie mereu actuală.

/** Țări acoperite de un RCA obișnuit (exemplu simplificat, fără Turcia). [de verificat] */
export const STANDARD_RCA_COUNTRIES: CountryCode[] = [
  "RO", "BG", "HU", "MD", "GR", "AT", "DE", "IT", "FR", "ES",
];

/** Același RCA, extins și pentru Turcia. */
export const RCA_WITH_TR: CountryCode[] = [...STANDARD_RCA_COUNTRIES, "TR"];

export const CATALOG: Product[] = [
  { id: "rca-6m", type: "rca", name: "RCA 6 luni", price: 230, durationDays: 182, countries: STANDARD_RCA_COUNTRIES },
  { id: "rca-12m", type: "rca", name: "RCA 12 luni", price: 410, durationDays: 365, countries: STANDARD_RCA_COUNTRIES },
  { id: "rca-12m-tr", type: "rca", name: "RCA 12 luni cu Carte Verde valabilă și în Turcia", price: 450, durationDays: 365, countries: RCA_WITH_TR },

  { id: "rovinieta-7z", type: "vignette", name: "Rovinietă 7 zile", price: 16, durationDays: 7, country: "RO" },
  { id: "rovinieta-30z", type: "vignette", name: "Rovinietă 30 de zile", price: 36, durationDays: 30, country: "RO" },
  { id: "rovinieta-12l", type: "vignette", name: "Rovinietă 12 luni", price: 140, durationDays: 365, country: "RO" },

  { id: "vinieta-bg-weekend", type: "vignette", name: "Vinietă Bulgaria week-end", price: 30, durationDays: 3, country: "BG" },
  { id: "vinieta-bg-7z", type: "vignette", name: "Vinietă Bulgaria 7 zile", price: 75, durationDays: 7, country: "BG" },
  { id: "vinieta-bg-30z", type: "vignette", name: "Vinietă Bulgaria 30 de zile", price: 140, durationDays: 30, country: "BG" },

  { id: "roaming-tr-7z", type: "roaming", name: "Pachet roaming Turcia 7 zile", price: 35, durationDays: 7, country: "TR" },
  { id: "roaming-tr-15z", type: "roaming", name: "Pachet roaming Turcia 15 zile", price: 60, durationDays: 15, country: "TR" },
  { id: "cartela-tr", type: "sim", name: "Cartelă prepay Turcia", price: 90, durationDays: 30, country: "TR" },
];

/** Povestea principală: Maria, cu facturi de plată și RCA aproape expirat. */
function demo(today: IsoDate): PagoData {
  return {
    user: { id: "u1", name: "Maria Ionescu", phone: "0700 000 000", residenceCountry: "RO" },
    vehicles: [
      { id: "v1", plate: "B-123-ABC", make: "Dacia", model: "Logan", type: "car", vin: "UU1DEMO0000000001" },
    ],
    bills: [
      { id: "b-curent", category: "electricity", provider: "Lumina Energie", amount: 187.4, dueDate: addDays(today, 3), status: "unpaid" },
      { id: "b-gaz", category: "gas", provider: "Flacăra Gaz", amount: 94.2, dueDate: addDays(today, -2), status: "overdue" },
      { id: "b-apa", category: "water", provider: "Izvor Apă", amount: 56, dueDate: addDays(today, 12), status: "unpaid" },
      { id: "b-internet", category: "internet", provider: "NetFix", amount: 55, dueDate: addDays(today, -10), status: "paid", paidAt: addDays(today, -12) },
    ],
    policies: [
      // Expiră în 6 zile → și în timpul călătoriei din D3. Nu acoperă Turcia.
      { id: "p-rca", type: "RCA", vehicleId: "v1", validFrom: addDays(today, -359), validUntil: addDays(today, 6), countries: STANDARD_RCA_COUNTRIES },
    ],
    vignettes: [
      { id: "vg-ro", vehicleId: "v1", country: "RO", validFrom: addDays(today, -345), validUntil: addDays(today, 20) },
    ],
    services: [],
    products: CATALOG,
    payments: [],
  };
}

export function createSeed(variant: SeedVariant, today: IsoDate): PagoData {
  const data = demo(today);

  switch (variant) {
    case "demo":
      return data;

    case "all-good":
      for (const b of data.bills) {
        b.status = "paid";
        b.paidAt = addDays(today, -1);
      }
      data.policies = [
        { id: "p-rca", type: "RCA", vehicleId: "v1", validFrom: addDays(today, -165), validUntil: addDays(today, 200), countries: RCA_WITH_TR },
      ];
      data.vignettes = [
        { id: "vg-ro", vehicleId: "v1", country: "RO", validFrom: addDays(today, -165), validUntil: addDays(today, 200) },
        { id: "vg-bg", vehicleId: "v1", country: "BG", validFrom: today, validUntil: addDays(today, 30) },
      ];
      return data;

    case "rca-expired":
      data.policies[0].validFrom = addDays(today, -368);
      data.policies[0].validUntil = addDays(today, -3);
      return data;

    case "no-bills":
      data.bills = [];
      return data;
  }
}
