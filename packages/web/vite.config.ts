/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";
import wasm from "vite-plugin-wasm";
import { defineConfig, loadEnv, type Plugin, type Rollup } from "vite";

/** Cloudflare's documented always-pass test site key. Public, and useless in production. */
const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
const GAME_SERVER = process.env.KAUDA_GAME_SERVER ?? "http://127.0.0.1:3000";
const DEV_PORT = 5173;

/** three.js and React Three Fiber/drei: the 3D board's code. */
const THREE_MODULE = /[\\/]node_modules[\\/](?:three|@react-three)[\\/]/;

/**
 * Sign-in and the lobby must never download three.js: it belongs only in the
 * lazily loaded 3D board chunk (components/table/BoardStage.tsx). This fails
 * the build if any three.js module lands in an entry chunk or in anything an
 * entry imports statically (what the browser fetches before the first
 * screen), and fails if the 3D chunk has vanished. It prints the 3D chunk's
 * size on every build.
 */
export function keepThreeOutOfEntry(): Plugin {
  return {
    name: "kauda:keep-three-out-of-entry",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((c): c is Rollup.OutputChunk => c.type === "chunk");
      const byFile = new Map(chunks.map((c) => [c.fileName, c]));
      const eager = new Set<string>();
      const stack = chunks.filter((c) => c.isEntry).map((c) => c.fileName);
      for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
        if (eager.has(file)) continue;
        eager.add(file);
        stack.push(...(byFile.get(file)?.imports ?? []));
      }
      const offenders = [...eager].flatMap((file) =>
        Object.keys(byFile.get(file)?.modules ?? {})
          .filter((id) => THREE_MODULE.test(id))
          .map((id) => `${file} <- ${id.replace(/^.*node_modules[\\/]/, "")}`),
      );
      if (offenders.length > 0) {
        this.error(`three.js reached the entry chunk, so sign-in and the lobby would download it:\n  ${offenders.slice(0, 10).join("\n  ")}`);
      }
      const board = chunks.filter((c) => !eager.has(c.fileName) && Object.keys(c.modules).some((id) => THREE_MODULE.test(id)));
      if (board.length === 0) this.error("no lazily loaded chunk holds three.js: the 3D board chunk is missing");
      for (const c of board) {
        const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
        console.log(`  3D board chunk ${c.fileName}: ${kb(Buffer.byteLength(c.code))}, ${kb(gzipSync(c.code).length)} gzipped`);
      }
    },
  };
}

/** Text assets, and the physics' WebAssembly, are served precompressed. */
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|webmanifest|txt|wasm)$/;

/**
 * Writes a brotli (.br) and a gzip (.gz) copy beside every compressible file
 * in the build, at the strongest settings (it is done once, at build time),
 * keeping a copy only when it is smaller. The game server serves the copy
 * that matches the request's Accept-Encoding (packages/server/src/webClient.ts).
 * Then prints what the browser really downloads for the parts that matter.
 */
export function precompress(): Plugin {
  let outDir = "dist";
  return {
    name: "kauda:precompress",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const sizes = new Map<string, { raw: number; br: number; gz: number }>();
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (COMPRESSIBLE.test(name)) {
            const body = readFileSync(full);
            const br = brotliCompressSync(body, {
              params: { [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length },
            });
            const gz = gzipSync(body, { level: 9 });
            if (br.length < body.length) writeFileSync(`${full}.br`, br);
            if (gz.length < body.length) writeFileSync(`${full}.gz`, gz);
            sizes.set(name, { raw: body.length, br: Math.min(br.length, body.length), gz: Math.min(gz.length, body.length) });
          }
        }
      };
      walk(outDir);
      const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`.padStart(10);
      const row = (label: string, test: RegExp) => {
        const total = { raw: 0, br: 0, gz: 0 };
        for (const [name, s] of sizes) {
          if (!test.test(name)) continue;
          total.raw += s.raw;
          total.br += s.br;
          total.gz += s.gz;
        }
        if (total.raw > 0) console.log(`  ${label.padEnd(26)} ${kb(total.raw)} raw ${kb(total.gz)} gzip ${kb(total.br)} brotli`);
      };
      // The entry is the module script index.html names; other index-*.js chunks load lazily.
      const entry = /src="\/assets\/([^"]+\.js)"/.exec(readFileSync(join(outDir, "index.html"), "utf8"))?.[1] ?? "";
      const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      console.log("\n  What the browser downloads (precompressed copies):");
      row("entry script", new RegExp(`^${escaped}$`));
      row("network client (lazy)", new RegExp(`^(?!${escaped}$)index-.*\\.js$`));
      row("entry styles", /^index-.*\.css$/);
      row("3D board chunk", /^Stage3D-.*\.js$/);
      row("physics worker (JS)", /^throw\.worker-.*\.js$/);
      row("Rapier WebAssembly", /\.wasm$/);
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  // SECURITY.md rule 7: everything VITE_* ends up in the bundle, so nothing
  // that looks like a secret may be named VITE_* (SECURITY.md, "Secrets in the
  // client"). The Turnstile site key is the one public key, by design.
  for (const name of Object.keys(env)) {
    if (name !== "VITE_TURNSTILE_SITE_KEY" && /SECRET|PASSWORD|DATABASE|PRIVATE|TOKEN|KEY/i.test(name)) {
      throw new Error(`${name} looks like a secret, and every VITE_* variable is shipped to browsers`);
    }
  }
  // The public Turnstile site key, fixed at build time. The secret key lives
  // only on the game server and never enters this package.
  let siteKey = env.VITE_TURNSTILE_SITE_KEY ?? "";
  if (siteKey === "") {
    if (command === "build") {
      console.warn(`\n  VITE_TURNSTILE_SITE_KEY is unset: building with Cloudflare's TEST site key (always passes).\n`);
    }
    siteKey = TURNSTILE_TEST_SITE_KEY;
  }

  return {
    // vite-plugin-wasm: Rapier's WebAssembly, imported by the physics worker,
    // is emitted as its own same-origin .wasm file (never inlined).
    plugins: [react(), tailwindcss(), keepThreeOutOfEntry(), wasm(), precompress()],
    // The physics worker is an ES module worker (iOS Safari 15+), with the same wasm loading.
    worker: { format: "es", plugins: () => [wasm()] },
    define: { "import.meta.env.VITE_TURNSTILE_SITE_KEY": JSON.stringify(siteKey) },
    // An inline PostCSS config stops Vite searching parent directories for
    // one (see packages/server/vitest.config.ts). Tailwind runs as a Vite
    // plugin, so PostCSS has nothing to do.
    css: { postcss: {} },
    build: {
      // Never inline assets as data: URIs, so the production CSP can stay at
      // font-src 'self' and img-src 'self' (no data:).
      assetsInlineLimit: 0,
      sourcemap: false,
      // The one big chunk is the 3D board (three.js and React Three Fiber),
      // fetched only at a table; keepThreeOutOfEntry prints its size.
      chunkSizeWarningLimit: 1000,
    },
    server: {
      host: "127.0.0.1",
      port: DEV_PORT,
      strictPort: true,
      // ONE ORIGIN, ON PURPOSE. The session cookie is host-only and
      // SameSite=Lax, and the browser sends it on the WebSocket upgrade only
      // when the upgrade goes to the page's own origin. So in dev the page,
      // the HTTP routes and the Colyseus socket must all appear to live on
      // this Vite server: it proxies them to the game server. Production has
      // no proxy because the game server serves the built dist/ itself. No
      // CORS anywhere. The game server is told to accept this server's
      // Origin through KAUDA_PROXY_ORIGINS (scripts/dev.mjs sets it); the
      // Origin header is passed through untouched, so its CSRF and
      // cross-origin WebSocket checks still apply.
      proxy: {
        "/session": { target: GAME_SERVER, changeOrigin: true },
        "/tables": { target: GAME_SERVER, changeOrigin: true },
        // The Colyseus client connects to /ws/<processId>/<roomId>; the
        // server's transport reads only the last two path segments.
        "/ws": { target: GAME_SERVER, changeOrigin: true, ws: true },
      },
      // Vite's HMR and React Fast Refresh need inline scripts and injected
      // <style> tags, so dev relaxes the CSP. The production build is served
      // by the game server under the strict policy (no unsafe-inline, no
      // unsafe-eval) in packages/server/src/webClient.ts, and the Playwright
      // test runs against that build under that policy.
      headers: {
        "Content-Security-Policy": [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
          "worker-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          `connect-src 'self' ws://127.0.0.1:${DEV_PORT} ws://localhost:${DEV_PORT}`,
          "frame-src https://challenges.cloudflare.com",
          "img-src 'self' data:",
          "font-src 'self' data:",
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      },
    },
    test: {
      // Rapier's package names only a "module" entry, which Node-side
      // resolution ignores; point tests at it, and let Vite transform it so
      // vite-plugin-wasm loads its .wasm as it does in the browser.
      alias: { "@dimforge/rapier3d": fileURLToPath(new URL("./node_modules/@dimforge/rapier3d/rapier.js", import.meta.url)) },
      server: { deps: { inline: [/@dimforge[\\/]rapier3d/] } },
      environment: "jsdom",
      include: ["test/**/*.test.{ts,tsx}"],
      setupFiles: ["test/setup.ts"],
      css: false,
    },
  };
});
