import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

export const TERMS = ["teeya", "chauka", "panja", "chakka", "thini", "hate", "chyakhe", "maryo", "tiryo", "ghanti"] as const;
export type TermId = (typeof TERMS)[number];

/**
 * A Kauda term in Nepali with its English gloss. `title` gives the desktop
 * tooltip; a tap toggles the same gloss on touch screens, which have no hover.
 * `quiet` drops the dotted underline, for display text such as the result word.
 */
export function Term({ id, quiet = false }: { readonly id: TermId; readonly quiet?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const tip = t(`terms.${id}.tip`);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        title={tip}
        aria-describedby={tipId}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        className={
          quiet
            ? "cursor-help font-semibold"
            : "cursor-help font-semibold underline decoration-current/40 decoration-dotted underline-offset-4"
        }
      >
        {t(`terms.${id}.label`)}
      </button>
      <span
        id={tipId}
        role="tooltip"
        lang="en"
        className={
          open
            ? "absolute left-0 top-full z-30 mt-1 w-max max-w-56 rounded-control border border-line bg-panel-strong px-2 py-1 text-xs font-normal text-ink shadow-panel"
            : "sr-only"
        }
      >
        {tip}
      </span>
    </span>
  );
}
