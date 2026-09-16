import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(process.cwd(), "../editor"),
  server: { host: "localhost", port: 4173, strictPort: true },
  build: { outDir: resolve(process.cwd(), "../editor/dist"), emptyOutDir: true }
});
