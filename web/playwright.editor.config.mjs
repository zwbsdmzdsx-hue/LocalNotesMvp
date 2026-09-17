import { defineConfig } from "@playwright/test";

const port = Number(process.env.EDITOR_TEST_PORT ?? 4273);
const baseURL = `http://localhost:${port}`;
export default defineConfig({
  testDir: "./tests/editor",
  workers: 1,
  timeout: 15000,
  webServer: { command: `npm run dev:editor -- --port ${port}`, cwd: ".", url: baseURL, reuseExistingServer: false },
  use: { channel: "msedge", headless: true, baseURL, viewport: { width: 1200, height: 800 }, screenshot: "only-on-failure" }
});
