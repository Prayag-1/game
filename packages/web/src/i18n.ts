import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ne from "./locales/ne.json";

export const LANGUAGES = ["ne", "en"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "ne";
const STORAGE_KEY = "kauda.lang";

/** The saved choice, or Nepali. Storage can be missing or throw (private mode). */
export function savedLanguage(): Language {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "en" || value === "ne" ? value : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function setLanguage(lang: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not persisted, but the switch still applies to this page.
  }
  void i18next.changeLanguage(lang);
}

i18next.on("languageChanged", (lang) => {
  document.documentElement.lang = lang;
});

export function initI18n(lang: Language = savedLanguage()) {
  void i18next.use(initReactI18next).init({
    resources: { ne: { translation: ne }, en: { translation: en } },
    lng: lang,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: LANGUAGES,
    // React renders every string as a text node, so i18next must not escape
    // it a second time. No string is ever parsed as HTML (SECURITY.md rule 6).
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  document.documentElement.lang = lang;
  return i18next;
}
