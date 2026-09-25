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
      leaflet: resolve(process.cwd(), "node_modules/leaflet/dist/leaflet-src.esm.js"),
      "maplibre-gl": resolve(process.cwd(), "node_modules/maplibre-gl/dist/maplibre-gl.mjs")
    }
  },
  optimizeDeps: { exclude: ["maplibre-gl"] },
  server: { host: "localhost", port: 4173, strictPort: true, fs: { allow: [resolve(process.cwd(), "../editor"), resolve(process.cwd(), "node_modules")] } },
  build: { outDir: resolve(process.cwd(), "../editor/dist"), emptyOutDir: true }
});
