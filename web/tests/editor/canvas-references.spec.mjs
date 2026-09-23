import { test, expect } from "@playwright/test";

async function openCanvas(page, title = "引用画布") {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept(title));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Canvas" }).click();
  await expect(page.locator(".canvas-view")).toBeVisible();
}

test("canvas text blocks offer [[ suggestions and render a selected document link", async ({ page }) => {
  await openCanvas(page);
  await page.locator('[data-canvas-action="add"]').click();
  const card = page.locator(".canvas-node-text");
  const input = card.locator("textarea");
  await input.fill("查看 [[Bet");
  await expect(page.locator(".canvas-link-suggestions")).toBeVisible();
  await page.locator(".canvas-link-suggestion").filter({ hasText: "Beta" }).first().click();
  await expect(input).toHaveValue("查看 [[Beta]]");
  await input.blur();
  await expect(card.locator(".canvas-note-preview .wiki-link")).toHaveText("Beta");
  await card.locator(".canvas-note-preview .wiki-link").click();
  await expect(page.locator("#title")).toHaveValue("Beta");
});

test("blank canvas context menu creates a block, document, or reference composer", async ({ page }) => {
  await openCanvas(page, "菜单画布");
  const viewport = page.locator(".canvas-viewport");
  await viewport.click({ button: "right", position: { x: 460, y: 340 } });
  await expect(page.locator(".canvas-context-menu")).toBeVisible();
  await expect(page.locator(".canvas-context-menu")).toContainText("新建块");
  await expect(page.locator(".canvas-context-menu")).toContainText("插入文档");
  await expect(page.locator(".canvas-context-menu")).toContainText("插入引用");
  await page.locator(".canvas-context-menu button", { hasText: "插入引用" }).click();
  await expect(page.locator(".canvas-link-suggestions")).toBeVisible();
  await page.locator(".canvas-link-suggestion").filter({ hasText: "Beta" }).first().click();
  await expect(page.locator(".canvas-node-text .canvas-note-preview .wiki-link")).toHaveText("Beta");
});
