/**
 * The few class recipes every screen shares. Colours come only from the
 * tokens in index.css; nothing here names a colour of its own.
 */

/** A translucent dark panel with a faint warm edge: the app's only kind of card. */
export const panel = "rounded-panel border border-line bg-panel shadow-panel backdrop-blur-md";

/** The one loud button: sindoor. Quick Play, Throw, Play. */
export const buttonPrimary =
  "rounded-control bg-sindoor px-4 py-2.5 font-semibold text-ink shadow-glow-sindoor transition-colors duration-200 hover:bg-sindoor-bright disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none disabled:hover:bg-sindoor";

/** A brass-edged button for the second choice on a screen. */
export const buttonBrass =
  "rounded-control border border-brass/60 px-3 py-2 font-semibold text-brass transition-colors duration-200 hover:border-brass-bright hover:text-brass-bright disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-brass/60 disabled:hover:text-brass";

/** A quiet text button: secondary actions that should not draw the eye. */
export const buttonQuiet =
  "rounded-control border border-line px-3 py-1.5 text-ink-muted transition-colors duration-200 hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

export const input =
  "rounded-control border border-line-strong bg-bg/70 px-3 py-2 text-ink placeholder:text-ink-muted focus:border-brass focus:outline-none";

/** Small uppercase-feeling label above a group. */
export const eyebrow = "text-xs font-semibold tracking-wide text-ink-muted";
