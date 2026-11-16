import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The theme's guard rails, read straight from src/index.css so the tokens
 * have one home:
 * - every text/background pair the UI uses meets WCAG AA (4.5:1 for text,
 *   3:1 for large text and for focus rings), with translucent panels
 *   composited over the worst case beneath them: the walnut's brightest
 *   grain under the diyo's glow;
 * - no component names a colour of its own: no hex, rgb() or hsl() literal,
 *   and no Tailwind palette class (the palette is switched off anyway).
 */

/** packages/web: vitest runs from the package directory. */
const root = process.cwd();
const css = readFileSync(join(root, "src", "index.css"), "utf8");

type RGB = readonly [number, number, number];
interface Colour {
  readonly rgb: RGB;
  readonly alpha: number;
}

function parseColour(raw: string): Colour {
  const v = raw.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex?.[1] !== undefined) {
    const h = hex[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as RGB, alpha: 1 };
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(v);
  if (rgb !== null) return { rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])], alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  throw new Error(`cannot read colour token value ${raw}`);
}

const tokens: Record<string, Colour> = {};
const theme = /@theme(?:\s+static)?\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
for (const m of theme.matchAll(/--color-([a-z-]+):\s*([^;]+);/g)) {
  const [, name, value] = m;
  if (name === undefined || value === undefined || name === "*" || /^(transparent|currentColor|initial)$/.test(value.trim())) continue;
  tokens[name] = parseColour(value);
}
const glowPercent = Number(/--board-glow:\s*([\d.]+)%/.exec(css)?.[1]);

function token(name: string): Colour {
  const c = tokens[name];
  if (c === undefined) throw new Error(`no --color-${name} in index.css`);
  return c;
}

/** `fg` at `alpha` over an opaque `bg`, in sRGB, as browsers composite. */
function over(fg: RGB, alpha: number, bg: RGB): RGB {
  return fg.map((c, i) => c * alpha + (bg[i] ?? 0) * (1 - alpha)) as unknown as RGB;
}
const layer = (name: string, bg: RGB, alpha = token(name).alpha): RGB => over(token(name).rgb, alpha, bg);

function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// The surfaces text actually sits on, at their brightest.
const bg = token("bg").rgb;
/** The floor (body::before): the walnut's brightest grain under a 35% wash of bg. The vignette only darkens it. */
const floor = layer("bg", token("wood-light").rgb, 0.35);
/** The diyo's pool of light over the floor: behind the shells and the sign-in title. */
const lit = layer("glow", floor, glowPercent / 100);
const SURFACES: Record<string, RGB> = {
  bg,
  "lit floor": lit,
  header: layer("bg", lit, 0.75),
  "panel over bg": layer("panel", bg),
  "panel over lit floor": layer("panel", lit),
  "sheet over lit floor": layer("panel-strong", lit),
  "brass wash in the sheet": over(token("brass").rgb, 0.1, layer("panel-strong", lit)),
  "brass wash on a panel": over(token("brass").rgb, 0.1, layer("panel", lit)),
  "code block in the sheet": layer("bg", layer("panel-strong", lit), 0.6),
  "input on a panel": layer("bg", layer("panel", lit), 0.7),
  sindoor: token("sindoor").rgb,
  "sindoor hover": token("sindoor-bright").rgb,
  "sindoor wash in the sheet": over(token("sindoor").rgb, 0.15, layer("panel-strong", lit)),
  brass: token("brass").rgb,
  "disabled primary on a panel": over(token("sindoor").rgb, 0.25, layer("panel", lit)),
  "disabled primary in the sheet": over(token("sindoor").rgb, 0.25, layer("panel-strong", lit)),
};

const TEXT_AA = 4.5;
const LARGE_AA = 3;

/** [text token, surface, minimum]. Every pairing the components use. */
const PAIRS: [string, string, number][] = [];
const panels = ["panel over bg", "panel over lit floor", "sheet over lit floor"];
for (const text of ["ink", "ink-muted", "brass", "brass-bright", "sindoor-ink", "ok", "bad"]) {
  for (const surface of panels) PAIRS.push([text, surface, TEXT_AA]);
}
PAIRS.push(
  // Straight on the board: small text is ivory only; the result word is large.
  ["ink", "lit floor", TEXT_AA],
  ["ink", "bg", TEXT_AA],
  ["ink-muted", "bg", TEXT_AA],
  ["brass", "lit floor", LARGE_AA],
  ["sindoor-ink", "lit floor", LARGE_AA],
  ["ink", "header", TEXT_AA],
  ["ink-muted", "header", TEXT_AA],
  ["brass", "header", TEXT_AA],
  ["brass", "header", TEXT_AA],
  // Controls and washes.
  ["brass", "brass wash in the sheet", TEXT_AA],
  ["brass-bright", "brass wash in the sheet", TEXT_AA],
  ["ink", "brass wash on a panel", TEXT_AA],
  ["ink-muted", "brass wash on a panel", TEXT_AA],
  ["ink-muted", "code block in the sheet", TEXT_AA],
  ["ink", "input on a panel", TEXT_AA],
  ["ink-muted", "input on a panel", TEXT_AA],
  ["brass", "input on a panel", TEXT_AA],
  ["sindoor-ink", "sindoor wash in the sheet", TEXT_AA],
  ["ink", "sindoor", TEXT_AA],
  ["ink", "sindoor hover", TEXT_AA],
  // Disabled buttons keep readable text: muted, on a faint sindoor wash or a panel.
  ["ink-muted", "disabled primary on a panel", TEXT_AA],
  ["ink-muted", "disabled primary in the sheet", TEXT_AA],
  // The thrower's mark: dark text on brass.
  ["bg", "brass", TEXT_AA],
);

describe("design tokens", () => {
  it("are all in index.css, and readable", () => {
    for (const name of ["bg", "wood", "wood-light", "panel", "panel-strong", "line", "ink", "ink-muted", "brass", "brass-bright", "sindoor", "sindoor-bright", "sindoor-ink", "ok", "bad", "glow", "shell", "shell-slit"]) {
      expect(tokens[name], `--color-${name}`).toBeDefined();
    }
    expect(glowPercent).toBeGreaterThan(0);
    expect(css).toMatch(/--color-\*:\s*initial/); // Tailwind's own palette is off
  });

  it.each(PAIRS)("%s on %s meets %d:1 (WCAG AA)", (text, surface, minimum) => {
    const s = SURFACES[surface];
    if (s === undefined) throw new Error(`no surface ${surface}`);
    const ratio = contrast(token(text).rgb, s);
    expect(ratio, `${text} on ${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum);
  });

  it("gives the brass focus ring 3:1 against everything it can sit on", () => {
    for (const surface of ["bg", "lit floor", ...panels]) {
      const s = SURFACES[surface] as RGB;
      expect(contrast(token("brass").rgb, s), `focus ring on ${surface}`).toBeGreaterThanOrEqual(LARGE_AA);
    }
  });

  it("matches the browser theme colour in index.html to the background token", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    const meta = /<meta name="theme-color" content="(#[0-9a-f]{6})"/i.exec(html)?.[1];
    expect(meta?.toLowerCase()).toBe(`#${bg.map((c) => c.toString(16).padStart(2, "0")).join("")}`);
  });
});

describe("components", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(join(root, "src"));

  const PALETTE =
    /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|accent|decoration|divide|placeholder|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)\b/;
  const LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i;

  it("found the component sources", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("name no colour of their own: tokens only", () => {
    const offences: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (PALETTE.test(line) || LITERAL.test(line)) offences.push(`${file.slice(root.length)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offences).toEqual([]);
  });

  it("never fade a disabled control with opacity, which made its label unreadable", () => {
    const offences = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => (/disabled:opacity-/.test(line) ? [`${file.slice(root.length)}:${i + 1}`] : [])),
    );
    expect(offences).toEqual([]);
  });
});
