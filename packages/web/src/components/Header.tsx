import { numberFormat } from "../lib/format";
import { useTranslation } from "react-i18next";
import { useMyChips } from "../lib/chips";
import { useSession } from "../lib/session";
import { logout } from "../lib/table";
import { LanguageToggle } from "./LanguageToggle";
import { ShellRow } from "./Shell";

/** A quiet bar: the name of the game, who I am and my chips, language, logout. Fixed at h-14. */
export function Header() {
  const { t, i18n } = useTranslation();
  const me = useSession((s) => s.me);
  const chips = useMyChips();
  const format = numberFormat(i18n.language);
  return (
    <header className="sticky top-0 z-20 h-14 border-b border-line bg-bg/75 backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-7xl items-center gap-3 px-4 lg:px-6">
        <ShellRow className="hidden h-4 sm:block" />
        <h1 className="text-2xl leading-none font-semibold text-brass">{t("app.title")}</h1>
        <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
          {me !== null && (
            <div className="flex min-w-0 flex-col items-end leading-tight">
              <span className="max-w-32 truncate text-sm text-ink" data-testid="my-name">
                {me.name}
              </span>
              <span className="text-xs text-ink-muted tabular-nums" title={t("header.chipsTip")} data-testid="my-chips">
                {t("header.chips")}: <span className="font-semibold text-brass">{chips === null ? "–" : format.format(chips)}</span>
              </span>
            </div>
          )}
          <LanguageToggle />
          {me !== null && (
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded-full px-2 py-1 text-sm text-ink-muted transition-colors hover:text-ink"
            >
              {t("header.logout")}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
