import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
});

test("Beta doc shows Alpha as backlink (because Alpha embeds Beta)", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-doc="beta"]').click();
  await page.locator('[data-pane-btn="backlinks"]').click();
  // Backlink card from Alpha must exist
  const card = page.locator(".backlink-card").first();
  await expect(card).toBeVisible();
  await expect(card.locator(".backlink-title")).toContainText("Alpha");
  await expect(card.locator(".backlink-excerpt")).toBeVisible();
});

test("Reference sidebar lists inline-mode refs as fallback when no sidebar ref", async ({ page }) => {
  await page.goto("/");
  // Alpha embeds a reference to Beta (inline mode, default)
  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  // Should show intro and at least one reference card
  await expect(page.locator(".ref-sidebar-intro")).toContainText("实时引用");
  const cards = page.locator(".relations-slot .reference-card");
  await expect(cards.first()).toBeVisible();
});

test("Override notice appears after remote override and source update", async ({ page }) => {
  await page.goto("/");
  // Alpha embeds a reference to Beta; override that block from Alpha.
  const ref = page.locator('[data-own-block][data-type="reference"] .reference-row');
  await ref.locator(".block-text").fill("覆写后的副本");
  await expect(page.locator("#status")).toContainText("已保存");
  // Now go to Beta and modify source
  await page.locator('[data-doc="beta"]').click();
  await page.locator('[data-own-block][data-id="b1"] .block-text').fill("Beta 源内容也已更新");
  await expect(page.locator("#status")).toContainText("已保存");
  // Stay on Beta and open override panel
  await page.locator('[data-pane-btn="overrides"]').click();
  await expect(page.locator(".notice-card").first()).toBeVisible();
  const card = page.locator(".notice-card").first();
  await expect(card.locator(".notice-title")).toContainText("Alpha");
  // A "恢复继承" reset button should exist
  await expect(card.getByRole("button", { name: "恢复继承" })).toBeVisible();
});

test("Backlink has working open button", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-doc="beta"]').click();
  await page.locator('[data-pane-btn="backlinks"]').click();
  await page.locator(".backlink-card .backlink-open").first().click();
  // Should jump to Alpha
  await expect(page.locator("#title")).toHaveValue("Alpha");
});

test("Reference sidebar empty state shows copy", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-doc="gamma"]').click();
  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  // Should show empty state
  await expect(page.locator(".relations-slot .empty").first()).toBeVisible();
});

test("Hide notices appear with 取消隐藏 action", async ({ page }) => {
  await page.goto("/");
  // Start fresh on a doc that hosts a reference (alpha)
  const ref = page.locator('[data-own-block][data-type="reference"]');
  const hideBtn = ref.locator(".hide").first();
  await hideBtn.click({ force: true });
  await page.waitForTimeout(400);
  // Switch to beta (target) and check override panel
  await page.locator('[data-doc="beta"]').click();
  await page.locator('[data-pane-btn="overrides"]').click();
  // The hide card specifically (badge = 隐)
  const hideCard = page.locator(".notice-card").filter({ has: page.locator(".notice-badge.kind-hide") });
  await expect(hideCard).toBeVisible();
  await expect(hideCard.locator(".notice-badge")).toHaveText("隐");
  // "取消隐藏" button lives inside it
  await expect(hideCard.getByRole("button", { name: "取消隐藏" })).toBeVisible();
});

test("Insert-block notice appears with delete action", async ({ page }) => {
  await page.goto("/");
  // Add a local instance block via the per-row + (add-sibling) button
  const ref = page.locator('[data-own-block][data-type="reference"]');
  const firstRow = ref.locator('.reference-row[data-scope-type="canonical"]').first();
  await firstRow.locator(".reference-meta").hover();
  await firstRow.locator(".add-sibling").click({ force: true });
  await page.waitForTimeout(500);
  const localRow = ref.locator('.reference-row[data-scope-type="reference_instance"]');
  await expect(localRow).toHaveCount(1);
  // Switch to beta, view override panel — notice of insert should appear
  await page.locator('[data-doc="beta"]').click();
  await page.locator('[data-pane-btn="overrides"]').click();
  const insertCard = page.locator(".notice-card").filter({ has: page.locator(".notice-badge.kind-insert") });
  await expect(insertCard).toBeVisible();
  await expect(insertCard.getByRole("button", { name: "删除专属块" })).toBeVisible();
});
