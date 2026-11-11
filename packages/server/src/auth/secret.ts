import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The key that signs session cookies.
 *
 * Always from KAUDA_SESSION_SECRET (64+ hex characters, i.e. 32+ bytes) when
 * it is set, and it must be set in production: the server refuses to start
 * without it. It is never committed. In development only, when it is unset,
 * a random key is made once and kept in a file under .data/ (gitignored), so
 * a dev server restart does not log everyone out. Changing the key logs
 * everyone out.
 */
export function loadSessionSecret(env: NodeJS.ProcessEnv, devKeyFile: string): { secret: Buffer; source: string } {
  const configured = env.KAUDA_SESSION_SECRET;
  if (configured !== undefined && configured.length > 0) {
    if (!/^[0-9a-fA-F]{64,}$/.test(configured) || configured.length % 2 !== 0) {
      throw new Error("KAUDA_SESSION_SECRET must be at least 64 hex characters (32 bytes)");
    }
    return { secret: Buffer.from(configured, "hex"), source: "KAUDA_SESSION_SECRET" };
  }
  if (env.NODE_ENV === "production") {
    throw new Error("KAUDA_SESSION_SECRET is required in production");
  }
  if (existsSync(devKeyFile)) {
    const hex = readFileSync(devKeyFile, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return { secret: Buffer.from(hex, "hex"), source: "a dev key in .data/" };
  }
  mkdirSync(dirname(devKeyFile), { recursive: true });
  const secret = randomBytes(32);
  writeFileSync(devKeyFile, secret.toString("hex"), { mode: 0o600 });
  return { secret, source: "a new dev key in .data/" };
}
