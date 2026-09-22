import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(process.cwd(), "../editor"),
  base: process.env.VITE_BASE_PATH ?? "/",
  resolve: {
    alias: {
      dompurify: resolve(process.cwd(), "node_modules/dompurify/dist/purify.es.mjs"),
      marked: resolve(process.cwd(), "node_modules/marked/lib/marked.esm.js"),
      turndown: resolve(process.cwd(), "node_modules/turndown/lib/turndown.browser.es.js"),
      leaflet: resolve(process.cwd(), "node_modules/leaflet/dist/leaflet-src.esm.js")
    }
  },
  server: { host: "localhost", port: 4173, strictPort: true },
  build: { outDir: resolve(process.cwd(), "../editor/dist"), emptyOutDir: true }
});
