import { describe, expect, it } from "vitest";
import { addDays, daysBetween } from "./dates.ts";

describe("date", () => {
  it("adună zile și trece peste lună/an", () => {
    expect(addDays("2026-11-16", 3)).toBe("2026-11-19");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-11-16", -2)).toBe("2026-11-14");
  });

  it("numără zilele dintre două date", () => {
    expect(daysBetween("2026-11-16", "2026-11-22")).toBe(6);
    expect(daysBetween("2026-11-16", "2026-11-14")).toBe(-2);
  });
});
