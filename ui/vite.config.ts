import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // Monaco's lazy chunk is far over the default warning, and is meant to be.
  build: {
    chunkSizeWarningLimit: 5000,
    // The logo files are never inlined as data URIs, whatever their size.
    assetsInlineLimit: (file) => (file.endsWith(".svg") ? false : undefined),
  },
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    setupFiles: "src/test/setup.ts",
    // Real CSS, so tests can read computed styles, with stable class names.
    css: {
      include: /.+/,
      modules: { classNameStrategy: "non-scoped" },
    },
  },
});
