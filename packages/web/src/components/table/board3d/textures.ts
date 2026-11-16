import { CanvasTexture, Color, LinearSRGBColorSpace, SRGBColorSpace } from "three";

/**
 * Colours and small generated textures for the 3D board. Every colour comes
 * from the design tokens in index.css, read at runtime, so the scene and the
 * DOM never disagree and no component names a colour of its own. The masks
 * below are drawn in "white" and "black" only: they are alpha and height, not
 * colour, and a material tints them.
 */

const TOKENS = ["bg", "ink", "glow", "brass", "shell", "shell-light", "shell-shade", "shell-slit"] as const;
export type Token = (typeof TOKENS)[number];

export interface Palette {
  /** The CSS value, for drawing on a 2D canvas. */
  readonly css: Record<Token, string>;
  /** The same colours, converted for three.js (linear). */
  readonly color: Record<Token, Color>;
}

/** Reads the tokens from the page. Throws if one is missing, which drops the board to the 2D stage. */
export function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const css = {} as Record<Token, string>;
  const color = {} as Record<Token, Color>;
  for (const name of TOKENS) {
    const value = style.getPropertyValue(`--color-${name}`).trim();
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--color-${name} is not a hex colour (${value || "missing"})`);
    css[name] = value;
    color[name] = new Color(value);
  }
  return { css, color };
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (ctx === null) throw new Error("no 2D canvas");
  return [c, ctx];
}

/** The slit: a long narrow lens along the middle, slightly sinuous. u and v are 0 to 1. */
function slitPath(ctx: CanvasRenderingContext2D, w: number, h: number, widen = 0): void {
  const half = (u: number) => (0.075 + widen) * Math.sin(Math.PI * Math.min(1, Math.max(0, (u - 0.05) / 0.9))) ** 0.7;
  const mid = (u: number) => 0.5 + 0.018 * Math.sin(u * Math.PI * 2.2);
  ctx.beginPath();
  for (let k = 0; k <= 40; k += 1) {
    const u = 0.05 + (0.9 * k) / 40;
    ctx.lineTo(u * w, (mid(u) - half(u)) * h);
  }
  for (let k = 40; k >= 0; k -= 1) {
    const u = 0.05 + (0.9 * k) / 40;
    ctx.lineTo(u * w, (mid(u) + half(u)) * h);
  }
  ctx.closePath();
}

const TEETH = 13;

/** The teeth: short ridges either side of the slit, reaching out across the lip. */
function teeth(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  for (let k = 0; k < TEETH; k += 1) {
    const u = 0.16 + (0.68 * k) / (TEETH - 1);
    const lean = (u - 0.5) * 0.08;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(u * w, (0.5 + side * 0.06) * h);
      ctx.lineTo((u + lean) * w, (0.5 + side * 0.24) * h);
      ctx.stroke();
    }
  }
}

/**
 * The underside, as colour and as height. Colour: a darker, creamier base
 * than the glossy back, the dark slit and the grooves between the teeth, so
 * a face-up shell reads at a glance even at phone size. Height (bump): the
 * slit sunk, the teeth raised.
 */
export function baseTextures(p: Palette): { map: CanvasTexture; bump: CanvasTexture } {
  const W = 256;
  const H = 176;

  const [mc, m] = canvas(W, H);
  m.fillStyle = p.css["shell-shade"];
  m.fillRect(0, 0, W, H);
  // A paler lip round the slit.
  const lip = m.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
  lip.addColorStop(0, p.css.shell);
  lip.addColorStop(1, p.css["shell-shade"]);
  m.fillStyle = lip;
  m.save();
  m.scale(1, H / W);
  m.beginPath();
  m.arc(W / 2, W / 2, W * 0.45, 0, Math.PI * 2);
  m.fill();
  m.restore();
  m.strokeStyle = p.css["shell-slit"];
  m.lineCap = "round";
  m.lineWidth = 4;
  m.globalAlpha = 0.55;
  teeth(m, W, H);
  m.globalAlpha = 1;
  m.fillStyle = p.css["shell-slit"];
  slitPath(m, W, H);
  m.fill();

  const [bc, b] = canvas(W, H);
  b.fillStyle = "black";
  b.fillRect(0, 0, W, H);
  b.filter = "blur(3px)";
  b.fillStyle = "white";
  b.save();
  b.scale(1, H / W);
  b.beginPath();
  b.arc(W / 2, W / 2, W * 0.47, 0, Math.PI * 2);
  b.fill();
  b.restore();
  b.filter = "blur(1px)";
  b.strokeStyle = "black";
  b.lineCap = "round";
  b.lineWidth = 3;
  b.globalAlpha = 0.6;
  teeth(b, W, H);
  b.globalAlpha = 1;
  b.fillStyle = "black";
  slitPath(b, W, H, 0.012);
  b.fill();

  const map = new CanvasTexture(mc);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 4;
  const bump = new CanvasTexture(bc);
  bump.colorSpace = LinearSRGBColorSpace;
  return { map, bump };
}

/** A soft round spot, white in the middle fading to black: an alpha mask for glows and contact shadows. */
export function softSpot(falloff = 1): CanvasTexture {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "white");
  g.addColorStop(Math.min(0.95, 0.35 * falloff), "white");
  g.addColorStop(1, "black");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const t = new CanvasTexture(c);
  t.colorSpace = LinearSRGBColorSpace;
  return t;
}
