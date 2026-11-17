/**
 * The seeded generator behind every starting value of a throw.
 *
 * It decides nothing about the game: the faces come from the server's seed.
 * It only fixes how the shells fly, so that every player at the table, and
 * every replay of a round, sees the same tumble. No Math.random here.
 *
 * Bit-identical on every browser: integer arithmetic only, then floats built
 * with + - * / and Math.sqrt, which IEEE 754 requires to be correctly
 * rounded. Never Math.sin, Math.cos, Math.pow or Math.exp: engines are free
 * to differ in their last bit, and a throw is chaotic enough for one bit to
 * change where a shell lands.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Uniform in [0, n), an integer. */
  int(n: number): number;
}

/** cyrb128: a string to four 32-bit words. */
function hash128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i += 1) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** sfc32, seeded from a string. */
export function seededRng(key: string): Rng {
  let [a, b, c, d] = hash128(key);
  const u32 = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
  // Warm up, so similar keys diverge.
  for (let i = 0; i < 15; i += 1) u32();
  const next = () => u32() / 4294967296;
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (n) => Math.floor(next() * n),
  };
}

/** A uniformly random unit quaternion [x, y, z, w] (Marsaglia's method: square roots only). */
export function randomQuaternion(rng: Rng): [number, number, number, number] {
  let x1: number, y1: number, s1: number;
  do {
    x1 = rng.range(-1, 1);
    y1 = rng.range(-1, 1);
    s1 = x1 * x1 + y1 * y1;
  } while (s1 >= 1);
  let x2: number, y2: number, s2: number;
  do {
    x2 = rng.range(-1, 1);
    y2 = rng.range(-1, 1);
    s2 = x2 * x2 + y2 * y2;
  } while (s2 >= 1 || s2 === 0);
  const k = Math.sqrt((1 - s1) / s2);
  return [x1, y1, x2 * k, y2 * k];
}

/** A uniformly random unit vector (rejection from the cube: square roots only). */
export function randomUnitVector(rng: Rng): [number, number, number] {
  for (;;) {
    const x = rng.range(-1, 1);
    const y = rng.range(-1, 1);
    const z = rng.range(-1, 1);
    const s = x * x + y * y + z * z;
    if (s > 1e-6 && s <= 1) {
      const k = 1 / Math.sqrt(s);
      return [x * k, y * k, z * k];
    }
  }
}
