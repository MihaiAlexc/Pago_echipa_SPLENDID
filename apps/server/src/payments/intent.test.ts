import { describe, expect, it } from "vitest";
import { classifyConfirmation, normalize } from "./intent.ts";

describe("normalize", () => {
  it("scoate diacritice, punctuație și majuscule", () => {
    expect(normalize("  Da, plătește-o! ")).toBe("da plateste o");
    expect(normalize("Anulează.")).toBe("anuleaza");
  });
});

describe("classifyConfirmation", () => {
  it.each(["da", "Da.", "DA!", "confirm", "Confirmă", "da, plătește", "Da, te rog", "sigur"])(
    "„%s” → yes",
    (t) => expect(classifyConfirmation(t)).toBe("yes"),
  );

  it.each(["nu", "Nu.", "nu, mulțumesc", "anulează", "renunț", "stop"])(
    "„%s” → no",
    (t) => expect(classifyConfirmation(t)).toBe("no"),
  );

  it.each([
    "poate",
    "hmm",
    "",
    "da, arată-mi ofertele",
    "da, dar cât costă?",
    "nu știu",
    "plătește o sută de lei la gaz",
    "da și factura la apă",
  ])("„%s” → other (nu confirmă)", (t) => expect(classifyConfirmation(t)).toBe("other"));
});
