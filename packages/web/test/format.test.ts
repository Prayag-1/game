import { describe, expect, it } from "vitest";
import { localeFor, nepaliLocale, numberFormat } from "../src/lib/format";

describe("Nepali numbers", () => {
  it("use the Nepali locale with Devanagari digits where the browser has it", () => {
    expect(nepaliLocale(() => true)).toBe("ne-NP-u-nu-deva");
  });

  it("still get Devanagari digits and lakh grouping where it does not (Chrome)", () => {
    const tag = nepaliLocale((t) => t !== "ne");
    expect(tag).toBe("en-IN-u-nu-deva");
    const fmt = new Intl.NumberFormat(tag);
    expect(fmt.format(2008)).toBe("२,००८");
    expect(fmt.format(100000)).toBe("१,००,०००");
  });

  it("format in Devanagari in Nepali and Latin in English", () => {
    expect(numberFormat("ne").format(1500)).toBe("१,५००");
    expect(numberFormat("en").format(1500)).toBe("1,500");
    expect(localeFor("en")).toBe("en");
  });
});
