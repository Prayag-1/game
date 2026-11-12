/**
 * Numbers in the UI's language. Nepali uses Devanagari digits, asked for by
 * name: browsers disagree on the default numbering system for "ne".
 *
 * Chrome (desktop and Android) ships ICU data without the Nepali locale at
 * all: "ne-NP-u-nu-deva" resolves to en-US and drops the digits with it,
 * giving "2,008" in a Nepali page. Where "ne" is missing we ask for
 * "en-IN-u-nu-deva" instead, which every browser has: Devanagari digits and
 * the same lakh grouping Nepali uses (१,००,०००), with no Hindi words in
 * dates and times. Safari and Node have "ne" and get it.
 */
export function nepaliLocale(supports: (tag: string) => boolean): string {
  return supports("ne") ? "ne-NP-u-nu-deva" : "en-IN-u-nu-deva";
}

const supportsNumbers = (tag: string): boolean => Intl.NumberFormat.supportedLocalesOf([tag]).length > 0;
const NE = nepaliLocale(supportsNumbers);

export function localeFor(language: string): string {
  return language === "ne" ? NE : "en";
}

export function numberFormat(language: string): Intl.NumberFormat {
  return new Intl.NumberFormat(localeFor(language));
}
