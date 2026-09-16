import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', workers: 1, timeout: 15000,
  use: { channel: 'msedge', headless: true, viewport: { width: 1200, height: 800 }, screenshot: 'only-on-failure' },
});
