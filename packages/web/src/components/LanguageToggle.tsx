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
      className="rounded-full border border-line-strong px-3 py-1 text-sm text-ink-muted transition-colors hover:border-brass/60 hover:text-ink"
    >
      {t("header.language")}
    </button>
  );
}
