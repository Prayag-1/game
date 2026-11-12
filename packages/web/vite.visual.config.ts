import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Builds the visual-baseline fixture (e2e/visual), never the app. Same root,
 * plugins and CSS as vite.config.ts, so Tailwind scans exactly what it scans
 * for the app and the screenshots show the real styling. Only the entry page
 * differs. Output goes to e2e/visual/dist (gitignored), and the page is at
 * /e2e/visual/ under `vite preview`, for playwright.visual.config.ts.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: { postcss: {} },
  build: {
    outDir: "e2e/visual/dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: { input: "e2e/visual/index.html" },
  },
  preview: { host: "127.0.0.1", port: 4317, strictPort: true },
});
