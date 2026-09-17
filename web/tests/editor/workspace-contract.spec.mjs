import { test, expect } from "@playwright/test";

async function rename(page, title) {
  await page.locator(".doc-item").filter({ hasText: "Alpha" }).click({ button: "right" });
  page.once("dialog", dialog => dialog.accept(title));
  await page.locator(".context-menu").getByRole("button", { name: "重命名", exact: true }).click();
}

test("sidebar rename stays consistent after editing and navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#title")).toHaveValue("Alpha");
  await rename(page, "Renamed");
  await expect(page.locator("#title")).toHaveValue("Renamed");
  await page.locator('[data-id="a1"] .block-text').fill("text after rename");
  await expect(page.locator("#status")).toContainText("已保存");
  await page.locator('[data-doc="beta"]').click();
  await page.locator('[data-doc="alpha"]').click();
  await expect(page.locator("#title")).toHaveValue("Renamed");
  await expect(page.locator('[data-id="a1"] .block-text')).toHaveText("text after rename");
  await expect(page.locator(".doc-item").filter({ hasText: "Renamed" })).toHaveCount(1);
});

test("failed save prevents sidebar rename and navigation until retry", async ({ page }) => {
  await page.goto("/");
  await page.locator("#dev-fail").click();
  await page.locator('[data-id="a1"] .block-text').fill("recoverable draft");
  await expect(page.locator("#status")).toContainText("保存失败");
  await rename(page, "Must not apply");
  await page.locator('[data-doc="beta"]').click();
  await expect(page.locator("#title")).toHaveValue("Alpha");
  await expect(page.locator('[data-id="a1"] .block-text')).toHaveText("recoverable draft");
  await page.locator("#dev-retry").click();
  await expect(page.locator("#status")).toContainText("已保存");
  await rename(page, "Recovered");
  await expect(page.locator("#title")).toHaveValue("Recovered");
});

test("deleting current document selects a live document and clears dead history", async ({ page }) => {
  await page.goto("/");
  await page.locator(".doc-item").filter({ hasText: "Alpha" }).click({ button: "right" });
  page.once("dialog", dialog => dialog.accept());
  await page.locator(".context-menu").getByRole("button", { name: "删除文档" }).click();
  await expect(page.locator("#title")).toHaveValue("Beta");
  await page.locator("#dev-back").click();
  await expect(page.locator("#title")).toHaveValue("Beta");
  await page.locator('[data-doc="alpha"]').click();
  await expect(page.locator("#status")).toContainText("目标文档已不存在");
  await expect(page.locator("#title")).toHaveValue("Beta");
  await page.locator('[data-id="b1"] .block-text').fill("live after delete");
  await expect(page.locator("#status")).toContainText("已保存");
});

test("deleting a parent promotes its child and saves a valid tree", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-doc="beta"]').click();
  await page.locator('[data-id="b2"] .block-text').click();
  await page.locator("#indent").click();
  await expect(page.locator('[data-id="b2"]')).toHaveAttribute("data-parent-id", "b1");
  await expect(page.locator("#status")).toContainText("已保存");
  await page.locator('[data-id="b1"] .delete-block').click();
  await expect(page.locator("#status")).toContainText("已保存");
  await page.locator('[data-doc="alpha"]').click();
  await page.locator('[data-doc="beta"]').click();
  await expect(page.locator('[data-id="b1"]')).toHaveCount(0);
  await expect(page.locator('[data-id="b2"]')).toHaveAttribute("data-parent-id", "");
  await expect(page.locator('[data-id="b2"] .block-text')).toHaveText("Beta 文档中的其他块");
});
