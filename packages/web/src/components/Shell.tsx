/**
 * One cowrie shell, drawn in SVG units around (0, 0), about 11 long. Face up
 * shows the underside: the toothed slit. Face down shows the smooth ivory
 * dome. Our own drawing; colours come from the shell tokens via the
 * .shell-* classes in index.css.
 */

const TEETH = [-3, -2, -1, 0, 1, 2, 3].map((i) => i * 0.95);

export interface ShellProps {
  readonly up: boolean;
  readonly x: number;
  readonly y: number;
  /** Degrees. */
  readonly angle: number;
  readonly scale?: number;
  readonly state?: "up" | "down" | "pending" | undefined;
  readonly className?: string | undefined;
}

export function Shell({ up, x, y, angle, scale = 1, state, className }: ShellProps) {
  return (
    <g
      transform={`translate(${x} ${y}) rotate(${angle}) scale(${scale})`}
      data-shell={state}
      className={className}
    >
      <ellipse className="shell-shadow" cx={0.7} cy={1.1} rx={5.7} ry={3.6} />
      {up ? (
        <>
          <ellipse className="shell-base" rx={5.6} ry={3.5} />
          <ellipse className="shell-lip" rx={4.8} ry={2.6} />
          {TEETH.map((tx) => (
            <g key={tx}>
              <line className="shell-tooth" x1={tx} y1={-1.75} x2={tx * 1.02} y2={-0.55} />
              <line className="shell-tooth" x1={tx} y1={1.75} x2={tx * 1.02} y2={0.55} />
            </g>
          ))}
          <path className="shell-slit" d="M -4.4 0.1 Q -2 -0.75 0 -0.5 Q 2 -0.75 4.4 0.1 Q 2 0.7 0 0.55 Q -2 0.7 -4.4 0.1 Z" />
        </>
      ) : (
        <>
          <ellipse className="shell-back" rx={5.6} ry={3.6} />
          <ellipse className="shell-sheen" cx={-1.6} cy={-1.3} rx={2.8} ry={1.1} />
        </>
      )}
    </g>
  );
}

/** A few shells as a quiet ornament (sign-in, lobby). Decorative only. */
export function ShellRow({ className = "" }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 54 14" className={className} aria-hidden="true" focusable="false">
      <Shell up={false} x={9} y={7} angle={-14} />
      <Shell up x={27} y={7} angle={6} />
      <Shell up={false} x={45} y={7} angle={18} />
    </svg>
  );
}
