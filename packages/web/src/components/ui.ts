/**
 * The few class recipes every screen shares. Colours come only from the
 * tokens in index.css; nothing here names a colour of its own.
 */

/** A translucent dark panel with a faint warm edge: the app's only kind of card. */
export const panel = "rounded-panel border border-line bg-panel shadow-panel backdrop-blur-md";

/**
 * The one loud button: sindoor. Quick Play, Throw, Play. Disabled, it keeps
 * a faint sindoor wash and muted text: readable (AA, see theme.test.ts) but
 * plainly not pressable, with no glow.
 */
export const buttonPrimary =
  "rounded-control bg-sindoor px-4 py-2.5 font-semibold text-ink shadow-glow-sindoor transition-colors duration-200 hover:bg-sindoor-bright disabled:cursor-not-allowed disabled:bg-sindoor/25 disabled:text-ink-muted disabled:shadow-none disabled:hover:bg-sindoor/25";

/** A brass-edged button for the second choice on a screen. */
export const buttonBrass =
  "rounded-control border border-brass/60 px-3 py-2 font-semibold text-brass transition-colors duration-200 hover:border-brass-bright hover:text-brass-bright disabled:cursor-not-allowed disabled:border-line-strong disabled:text-ink-muted disabled:hover:border-line-strong disabled:hover:text-ink-muted";

/** A quiet text button: secondary actions that should not draw the eye. */
export const buttonQuiet =
  "rounded-control border border-line px-3 py-1.5 text-ink-muted transition-colors duration-200 hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:border-dashed disabled:hover:border-line disabled:hover:text-ink-muted";

export const input =
  "rounded-control border border-line-strong bg-bg/70 px-3 py-2 text-ink placeholder:text-ink-muted focus:border-brass focus:outline-none";

/** Small uppercase-feeling label above a group. */
export const eyebrow = "text-xs font-semibold tracking-wide text-ink-muted";
