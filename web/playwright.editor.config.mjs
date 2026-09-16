import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/editor",
  workers: 1,
  timeout: 15000,
  webServer: { command: "npm run dev:editor", cwd: ".", url: "http://localhost:4173", reuseExistingServer: true },
  use: { channel: "msedge", headless: true, baseURL: "http://localhost:4173", viewport: { width: 1200, height: 800 }, screenshot: "only-on-failure" }
});
