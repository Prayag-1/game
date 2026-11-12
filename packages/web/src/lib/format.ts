/**
 * Numbers in the UI's language. Nepali uses Devanagari digits, asked for by
 * name: browsers disagree on the default numbering system for "ne" (Chrome
 * picks Latin digits, Node's ICU Devanagari).
 */
export function localeFor(language: string): string {
  return language === "ne" ? "ne-NP-u-nu-deva" : "en";
}

export function numberFormat(language: string): Intl.NumberFormat {
  return new Intl.NumberFormat(localeFor(language));
}
