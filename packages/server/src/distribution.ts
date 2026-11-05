/**
 * Distribution check: `pnpm --filter @kauda/server distribution`.
 *
 * Runs real throws through the production path (crypto seed, sha256
 * commitment, faces from the seed) and compares what comes out with the
 * exact distribution. THROWS sets the count; default 200,000.
 *
 * Verdict is SUSPICIOUS if any seat share, the mean face-up count or any
 * single shell is more than 4 standard errors out, or if a chi-square test
 * fails at p = 0.001. A fair source trips this well under 1% of the time.
 */
import { SHELL_COUNT, TURN_ORDER, seatForFaceCount, type SeatId } from "@kauda/rules";
import { cryptoCommitment, facesFromSeed, verifyThrow } from "./fairness.js";

const raw = process.env.THROWS ?? "200000";
const n = Number(raw);
if (!Number.isSafeInteger(n) || n < 1000) {
  process.stderr.write(`THROWS must be an integer of at least 1000, got "${raw}"\n`);
  process.exit(2);
}

const Z_LIMIT = 4;
// Chi-square critical values at p = 0.001.
const CHI2_CRIT: Readonly<Record<number, number>> = { 3: 16.266, 14: 36.123 };

// Exact expectations, from the binomial coefficients.
const binom: number[] = [1];
for (let k = 1; k <= SHELL_COUNT; k += 1) binom.push(((binom[k - 1] ?? 0) * (SHELL_COUNT - k + 1)) / k);
const ALL = 2 ** SHELL_COUNT;
const pFace = binom.map((w) => w / ALL);
const pSeat: Record<SeatId, number> = { teeya: 0, chauka: 0, panja: 0, chakka: 0 };
binom.forEach((w, k) => (pSeat[seatForFaceCount(k)] += w / ALL));

// Throw.
const seatCount: Record<SeatId, number> = { teeya: 0, chauka: 0, panja: 0, chakka: 0 };
const faceCount = new Array<number>(SHELL_COUNT + 1).fill(0);
const shellUp = new Array<number>(SHELL_COUNT).fill(0);
let upTotal = 0;
let badCommitments = 0;
const started = process.hrtime.bigint();
for (let i = 0; i < n; i += 1) {
  const c = cryptoCommitment();
  const faces = facesFromSeed(c.seed);
  if (i < 1000 && !verifyThrow(c.seed, c.commitHash, faces)) badCommitments += 1;
  let up = 0;
  faces.forEach((f, s) => {
    if (f) {
      up += 1;
      shellUp[s] = (shellUp[s] ?? 0) + 1;
    }
  });
  upTotal += up;
  faceCount[up] = (faceCount[up] ?? 0) + 1;
  seatCount[seatForFaceCount(up)] += 1;
}
const seconds = Number(process.hrtime.bigint() - started) / 1e9;

const pct = (x: number, d = 4): string => `${(x * 100).toFixed(d)}%`;
const signed = (x: number, d: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const flags: string[] = [];

console.log(`Kauda distribution check: ${n.toLocaleString("en-US")} cryptographic throws in ${seconds.toFixed(2)}s`);
console.log("");

// Seat shares.
console.log("seat     expected     observed     deviation     z");
let chiSeat = 0;
for (const seat of TURN_ORDER) {
  const p = pSeat[seat];
  const obs = seatCount[seat] / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  const z = (obs - p) / se;
  chiSeat += (seatCount[seat] - n * p) ** 2 / (n * p);
  if (Math.abs(z) > Z_LIMIT) flags.push(`${seat} share is ${z.toFixed(2)} standard errors out`);
  console.log(
    `${seat.padEnd(8)} ${pct(p).padStart(9)}    ${pct(obs).padStart(9)}    ${signed((obs - p) * 100, 4).padStart(8)}pp   ${signed(z, 2).padStart(6)}`,
  );
}
console.log("");

// Mean face-up count: each shell is Bernoulli(1/2), so the variance of the count is 16/4 = 4.
const mean = upTotal / n;
const zMean = (mean - 8) / Math.sqrt(4 / n);
if (Math.abs(zMean) > Z_LIMIT) flags.push(`mean face-up count is ${zMean.toFixed(2)} standard errors out`);
console.log(`mean face-up   expected 8.0000   observed ${mean.toFixed(4)}   deviation ${signed(mean - 8, 4)}   z ${signed(zMean, 2)}`);

// Each shell on its own, so a stuck or biased byte cannot hide inside the totals.
const shellZ = shellUp.map((u) => (u / n - 0.5) / Math.sqrt(0.25 / n));
const worstShell = shellZ.reduce((w, z, i) => (Math.abs(z) > Math.abs(shellZ[w] ?? 0) ? i : w), 0);
const worstZ = shellZ[worstShell] ?? 0;
if (Math.abs(worstZ) > Z_LIMIT) flags.push(`shell ${worstShell} is face up ${worstZ.toFixed(2)} standard errors off half`);
console.log(`per shell      worst is shell ${worstShell}, face up ${pct((shellUp[worstShell] ?? 0) / n, 3)}, z ${signed(worstZ, 2)}`);

// Chi-square on seats (3 df) and on face counts, pooling the thin tails 0+1 and 15+16 (14 df).
const crit3 = CHI2_CRIT[3] ?? 0;
if (chiSeat > crit3) flags.push(`seat chi-square ${chiSeat.toFixed(2)} exceeds ${crit3}`);
const bins: { obs: number; p: number }[] = [];
for (let k = 1; k <= SHELL_COUNT - 1; k += 1) {
  let obs = faceCount[k] ?? 0;
  let p = pFace[k] ?? 0;
  if (k === 1) {
    obs += faceCount[0] ?? 0;
    p += pFace[0] ?? 0;
  }
  if (k === SHELL_COUNT - 1) {
    obs += faceCount[SHELL_COUNT] ?? 0;
    p += pFace[SHELL_COUNT] ?? 0;
  }
  bins.push({ obs, p });
}
const chiFace = bins.reduce((acc, b) => acc + (b.obs - n * b.p) ** 2 / (n * b.p), 0);
const crit14 = CHI2_CRIT[14] ?? 0;
if (chiFace > crit14) flags.push(`face-count chi-square ${chiFace.toFixed(2)} exceeds ${crit14}`);
console.log(`chi-square     seats ${chiSeat.toFixed(2)} (3 df, limit ${crit3})   face counts ${chiFace.toFixed(2)} (14 df, limit ${crit14})`);

if (badCommitments > 0) flags.push(`${badCommitments} commitments failed verification`);
console.log(`commitments    first 1000 re-verified, ${badCommitments} failed`);
console.log("");

if (flags.length === 0) {
  console.log("Verdict: PASS");
} else {
  console.log("Verdict: SUSPICIOUS");
  for (const f of flags) console.log(`  ! ${f}`);
  process.exitCode = 1;
}
