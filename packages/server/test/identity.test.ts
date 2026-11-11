import { describe, expect, it } from "vitest";
import { normaliseDisplayName } from "../src/index.js";

describe("display names", () => {
  it("accepts Latin and Devanagari names with digits, space, _ and -", () => {
    for (const ok of ["Hari", "हरि बहादुर", "Sita_99", "maya-k", "राम 2"]) expect(normaliseDisplayName(ok)).toBe(ok);
    expect(normaliseDisplayName("  Hari   Bahadur ")).toBe("Hari Bahadur");
  });

  it("refuses markup, invisible and direction-changing characters, and bad lengths", () => {
    const bad = [
      "<img src=x onerror=alert(1)>",
      "Ha​ri", // zero-width space
      "Hari‍", // zero-width joiner
      "‮irah", // right-to-left override
      "ab",
      "x".repeat(21),
      "Hari!",
      "Χάρης", // Greek: outside the allowed scripts
      42,
      null,
    ];
    for (const raw of bad) expect(normaliseDisplayName(raw), JSON.stringify(raw)).toBeNull();
  });

  it("normalises to NFC", () => {
    expect(normaliseDisplayName("Ramésh")).toBe("Ramésh");
  });
});
