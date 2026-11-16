import { describe, expect, it } from "vitest";
import { resolveDueDate } from "./tools.ts";

describe("resolveDueDate", () => {
  const today = "2026-11-16";
  it.each([
    ["2026-12-01", undefined, "2026-12-01"],
    ["25.11", undefined, "2026-11-25"],
    ["5.1", undefined, "2027-01-05"], // ianuarie a trecut demult anul ăsta → anul viitor
    ["10.11", undefined, "2026-11-10"], // a trecut de curând → rămâne (factură întârziată)
    [undefined, 3, "2026-11-19"],
    [undefined, undefined, "2026-11-30"], // implicit 14 zile
    ["32.13", undefined, "2026-11-30"], // invalid → implicit
  ])("%s / %s → %s", (dueDate, dueInDays, expected) => {
    expect(resolveDueDate(today, dueDate, dueInDays)).toBe(expected);
  });
});
