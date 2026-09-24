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
