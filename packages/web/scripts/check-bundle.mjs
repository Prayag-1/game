#!/usr/bin/env node
/**
 * SECURITY.md rule 7: no secret may reach the browser. Fails (exit 1) if the
 * built bundle in dist/ contains any of:
 *   - the values of TURNSTILE_SECRET_KEY, KAUDA_SESSION_SECRET and
 *     DATABASE_URL from the environment, when set (CI sets the real ones);
 *   - the dev session key kept in packages/server/.data/, if there is one;
 *   - Cloudflare's test Turnstile secret;
 *   - those variable names themselves (code that reads them has no place in
 *     the client), or anything that looks like a postgres:// URL.
 * Run after `vite build`; `pnpm build` and CI both do.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const devKeyFile = join(here, "..", "..", "server", ".data", "session-secret");

if (!existsSync(join(dist, "index.html"))) {
  console.error("check-bundle: no dist/index.html. Run vite build first.");
  process.exit(1);
}

/** [label, needle] pairs. Labels are printed; needles never are. */
const needles = [];
const fromEnv = (name) => {
  const v = process.env[name];
  if (v !== undefined && v.length >= 8) needles.push([`the value of ${name}`, v]);
};
fromEnv("TURNSTILE_SECRET_KEY");
fromEnv("KAUDA_SESSION_SECRET");
fromEnv("DATABASE_URL");
if (process.env.KAUDA_SESSION_SECRET) {
  // The bundle could hold the key in another encoding than the hex it is configured in.
  try {
    needles.push(["KAUDA_SESSION_SECRET as base64", Buffer.from(process.env.KAUDA_SESSION_SECRET, "hex").toString("base64")]);
  } catch {
    /* not hex: the server refuses it anyway */
  }
}
if (existsSync(devKeyFile)) needles.push(["the dev session key in packages/server/.data", readFileSync(devKeyFile, "utf8").trim()]);
needles.push(["Cloudflare's test Turnstile secret", "1x0000000000000000000000000000000AA"]);
for (const name of ["TURNSTILE_SECRET_KEY", "KAUDA_SESSION_SECRET", "DATABASE_URL"]) needles.push([`the name ${name}`, name]);
const patterns = [["a postgres:// URL", /postgres(?:ql)?:\/\/[^\s"'`]+/i]];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

let failures = 0;
let scanned = 0;
for (const file of files(dist)) {
  scanned += 1;
  const text = readFileSync(file).toString("latin1");
  const rel = relative(dist, file);
  for (const [label, needle] of needles) {
    if (needle.length > 0 && text.includes(needle)) {
      console.error(`check-bundle: ${rel} contains ${label}`);
      failures += 1;
    }
  }
  for (const [label, re] of patterns) {
    if (re.test(text)) {
      console.error(`check-bundle: ${rel} contains ${label}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`check-bundle: FAILED, ${failures} finding(s). A secret must never reach the browser (SECURITY.md rule 7).`);
  process.exit(1);
}
console.log(`check-bundle: ${scanned} files in dist/ clean (${needles.length} secrets and names, ${patterns.length} patterns checked).`);
