import { describe, expect, it } from "vitest";
import { formatLei } from "./format.ts";

describe("formatLei", () => {
  it("folosește virgulă și două zecimale", () => {
    expect(formatLei(187.4)).toBe("187,40 lei");
    expect(formatLei(56)).toBe("56,00 lei");
  });
});
