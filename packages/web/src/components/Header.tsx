import { numberFormat } from "../lib/format";
import { useTranslation } from "react-i18next";
import { useMyChips } from "../lib/chips";
import { useSession } from "../lib/session";
import { logout } from "../lib/table";
import { LanguageToggle } from "./LanguageToggle";

export function Header() {
  const { t, i18n } = useTranslation();
  const me = useSession((s) => s.me);
  const chips = useMyChips();
  const format = numberFormat(i18n.language);
  return (
    <header className="sticky top-0 z-10 bg-orange-900 text-amber-50 shadow">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2">
        <h1 className="text-xl font-semibold">{t("app.title")}</h1>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {me !== null && (
            <div className="flex min-w-0 flex-col items-end leading-tight">
              <span className="max-w-32 truncate text-sm" data-testid="my-name">
                {me.name}
              </span>
              <span className="text-xs text-amber-200" title={t("header.chipsTip")} data-testid="my-chips">
                {t("header.chips")}: {chips === null ? "–" : format.format(chips)}
              </span>
            </div>
          )}
          <LanguageToggle />
          {me !== null && (
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded-full bg-amber-50 px-3 py-1 text-sm font-semibold text-orange-900 hover:bg-white"
            >
              {t("header.logout")}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
