import { defineConfig } from "vitest/config";

export default defineConfig({
  // An inline PostCSS config stops Vite searching parent directories for one.
  // That search parses every package.json above the repo, and a stray one with
  // a BOM breaks the run. This package has no CSS at all.
  css: { postcss: {} },
  test: {
    include: ["test/**/*.test.ts"],
    // @colyseus/testing loads @colyseus/tools, and Colyseus core then loads @pm2/io, which
    // writes to process.send when it exists. In a forked worker that is
    // vitest's own IPC channel, and the run dies. Worker threads have none.
    poolMatchGlobs: [["**/test/room.test.ts", "threads"]],
  },
});
