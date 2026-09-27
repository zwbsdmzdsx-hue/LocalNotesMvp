import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#title")).toHaveValue("Alpha");
});

test("creates a Dashboard, renders widget blocks, and persists layout changes", async ({ page }) => {
  page.once("dialog", dialog => dialog.accept("项目监控"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Dashboard" }).click();
  await expect(page.locator(".dashboard-view")).toBeVisible();
  await expect(page.locator(".dashboard-title")).toHaveValue("项目监控");
  await expect(page.locator(".dashboard-widget")).toHaveCount(3);
  await expect(page.locator(".dashboard-widget", { hasText: "实时引用" })).toBeVisible();

  await page.locator('[data-dashboard-action="add"]').click();
  await page.locator(".dashboard-add-menu button", { hasText: "history" }).click();
  await expect(page.locator('.dashboard-widget[data-widget-id]').filter({ hasText: "history" })).toBeVisible();
  await page.locator('.dashboard-widget[data-widget-id]').filter({ hasText: "history" }).locator(".dashboard-widget-controls button").last().click();
  await expect(page.locator(".dashboard-save-state")).toHaveText("已保存");

  await page.locator('.doc-item .list-label', { hasText: "Alpha" }).click();
  await expect(page.locator("#title")).toHaveValue("Alpha");
  await page.locator('.doc-item .list-label', { hasText: "项目监控" }).click();
  await expect(page.locator(".dashboard-view")).toBeVisible();
  await expect(page.locator('.dashboard-widget[data-widget-id]').filter({ hasText: "history" })).toHaveCount(0);
});

test("a failed Dashboard save blocks navigation and keeps the current layout", async ({ page }) => {
  page.once("dialog", dialog => dialog.accept("失败恢复面板"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Dashboard" }).click();
  await page.locator("#dev-fail").click();
  await page.locator('.dashboard-widget').first().locator(".dashboard-widget-controls button").first().click();
  await page.locator('.doc-item .list-label', { hasText: "Alpha" }).click();
  await expect(page.locator(".dashboard-view")).toBeVisible();
  await expect(page.locator(".dashboard-save-state")).toHaveText("保存失败");
  await page.locator('[data-doc="beta"]').click();
  await expect(page.locator(".dashboard-view")).toBeVisible();
  await expect(page.locator('.dashboard-widget')).toHaveCount(3);
});

test("Dashboard history restores its own document instead of the source document", async ({ page }) => {
  page.once("dialog", dialog => dialog.accept("原始看板"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Dashboard" }).click();
  const title = page.locator(".dashboard-title");
  await title.fill("修订看板");
  await title.blur();
  await expect(page.locator(".dashboard-save-state")).toHaveText("已保存");
  await page.locator('[data-pane-btn="history"]').click();
  const panel = page.locator('[data-slot="history"]');
  await expect(panel.locator(".history-entry")).toHaveCount(2);
  await panel.locator(".history-entry").last().click();
  await expect(panel.locator(".history-preview strong")).toHaveText("原始看板");
  await panel.getByRole("button", { name: "恢复此版本" }).click();
  await expect(title).toHaveValue("原始看板");
  await expect(page.locator("#title")).toHaveValue("Alpha");
});

test("registered external widgets keep their own settings and lifecycle", async ({ page }) => {
  await page.evaluate(async () => {
    const { registerDashboardExternalWidget } = await import("/src/main.ts");
    window.externalMounts = 0;
    window.externalDisposals = 0;
    window.unregisterExternal = registerDashboardExternalWidget({
      kind: "example.external-feed", title: "外部信息", icon: "◎",
      settings: [{ key: "address", label: "信息地址", control: "url", defaultValue: "https://example.test/feed" }],
      async mount(container, context) {
        window.externalMounts += 1;
        window.refreshExternal = context.refresh;
        container.textContent = `来源：${context.settings.address}`;
        return () => { window.externalDisposals += 1; };
      }
    });
  });
  page.once("dialog", dialog => dialog.accept("外部组件测试"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Dashboard" }).click();
  await page.locator('[data-dashboard-action="add"]').click();
  await page.locator(".dashboard-add-menu").getByRole("button", { name: "外部信息" }).click();
  const widget = page.locator(".dashboard-widget", { hasText: "外部信息" });
  const settings = page.locator('[data-slot="dashboard-config"]');
  await expect(widget).toContainText("https://example.test/feed");
  await expect(settings.getByLabel("数据范围")).toHaveCount(0);
  await settings.getByLabel("信息地址").fill("https://example.test/news");
  await settings.getByLabel("信息地址").blur();
  await expect(widget).toContainText("https://example.test/news");
  await page.locator('[data-dashboard-action="add"]').click();
  await page.locator(".dashboard-add-menu").getByRole("button", { name: "文档范围筛选" }).click();
  await page.getByLabel("筛选文档：演示中心").check();
  await expect(widget).toContainText("https://example.test/news");
  expect(await page.evaluate(() => window.externalMounts)).toBe(2);
  await page.evaluate(() => window.refreshExternal());
  await expect.poll(() => page.evaluate(() => window.externalMounts)).toBe(3);
  await expect(page.locator(".dashboard-save-state")).toHaveText("已保存");
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.locator('.doc-item .list-label', { hasText: "外部组件测试" }).click();
  await expect(widget).toContainText("https://example.test/news");
  await widget.click();
  await expect(settings.getByLabel("信息地址")).toHaveValue("https://example.test/news");
  await page.evaluate(() => window.unregisterExternal());
  await expect(widget).toContainText("组件尚未注册");
  await expect(settings.getByLabel("数据范围")).toHaveCount(0);
  expect(await page.evaluate(() => window.externalDisposals)).toBeGreaterThan(0);
});
