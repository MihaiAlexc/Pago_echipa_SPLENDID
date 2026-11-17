import { describe, expect, it } from "vitest";
import { isValidPersons, priceForPersons } from "./pricing.ts";

describe("prețul pe persoană (asigurarea de călătorie)", () => {
  it("preț × persoane, cu 10% reducere de la 4 persoane", () => {
    expect(priceForPersons(45, 1)).toBe(45);
    expect(priceForPersons(45, 3)).toBe(135);
    expect(priceForPersons(45, 4)).toBe(162); // 180 − 10%
    expect(priceForPersons(29, 5)).toBe(130.5);
  });
  it("persoane valide: întreg între 1 și 9", () => {
    expect(isValidPersons(1)).toBe(true);
    expect(isValidPersons(9)).toBe(true);
    expect(isValidPersons(0)).toBe(false);
    expect(isValidPersons(10)).toBe(false);
    expect(isValidPersons(2.5)).toBe(false);
    expect(isValidPersons("3")).toBe(false);
  });
});
