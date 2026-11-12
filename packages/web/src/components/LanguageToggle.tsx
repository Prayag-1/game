import { useTranslation } from "react-i18next";
import { setLanguage } from "../i18n";

/** Switches between Nepali and English. The choice is saved in this browser. */
export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const next = i18n.language === "en" ? "ne" : "en";
  return (
    <button
      type="button"
      onClick={() => setLanguage(next)}
      aria-label={t("header.languageLabel")}
      lang={next}
      className="rounded-full border border-amber-200/60 px-3 py-1 text-sm text-amber-50 hover:bg-amber-50/10"
    >
      {t("header.language")}
    </button>
  );
}
