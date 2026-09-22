import { test, expect } from "@playwright/test";

async function createCanvas(page, title) {
  page.once("dialog", dialog => dialog.accept(title));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Canvas" }).click();
  await expect(page.locator(".canvas-view")).toBeVisible();
  await expect(page.locator(".canvas-title")).toHaveValue(title);
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#title")).toHaveValue("Alpha");
});

test("bookmark plus creates a Canvas with movable resizable cards and history", async ({ page }) => {
  await createCanvas(page, "项目画布");
  await expect(page.locator('.doc-item .list-label', { hasText: "项目画布" })).toBeVisible();

  await page.locator('[data-canvas-action="add"]').click();
  const card = page.locator(".canvas-node-text");
  await expect(card).toBeVisible();
  await card.locator("textarea").fill("可以自由摆放的卡片内容");
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  await page.locator('[data-canvas-action="undo"]').click();
  await expect(page.locator(".canvas-node-text")).toHaveCount(0);
  await page.locator('[data-canvas-action="redo"]').click();
  await expect(card.locator("textarea")).toHaveValue("可以自由摆放的卡片内容");

  const before = await card.boundingBox();
  const grip = card.locator(".canvas-node-grip");
  const gripBox = await grip.boundingBox();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + 120, gripBox.y + 80, { steps: 6 });
  await page.mouse.up();
  const moved = await card.boundingBox();
  expect(moved.x).toBeGreaterThan(before.x + 70);
  expect(moved.y).toBeGreaterThan(before.y + 40);

  const handle = card.locator(".canvas-resize-handle");
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + 5, handleBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 90, handleBox.y + 65, { steps: 5 });
  await page.mouse.up();
  const resized = await card.boundingBox();
  expect(resized.width).toBeGreaterThan(moved.width + 50);
  expect(resized.height).toBeGreaterThan(moved.height + 35);

  await page.keyboard.press("Control+z");
  await expect(card).toBeVisible();
  await page.keyboard.press("Control+y");
  await expect(card).toBeVisible();

  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await expect(page.locator("#title")).toBeVisible();
  await page.locator('.doc-item .list-label', { hasText: "项目画布" }).click();
  await expect(page.locator(".canvas-node-text textarea")).toHaveValue("可以自由摆放的卡片内容");
});

test("documents can be dragged into a Canvas as resizable live previews", async ({ page }) => {
  await createCanvas(page, "资料板");
  await page.dragAndDrop('[data-document-id="beta"] > .doc-item', ".canvas-viewport", { targetPosition: { x: 430, y: 300 } });
  const preview = page.locator(".canvas-node-document");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Beta 文档中的其他块");

  const before = await preview.boundingBox();
  const handleBox = await preview.locator(".canvas-resize-handle").boundingBox();
  await page.mouse.move(handleBox.x + 4, handleBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 75, handleBox.y + 55, { steps: 5 });
  await page.mouse.up();
  const after = await preview.boundingBox();
  expect(after.width).toBeGreaterThan(before.width + 40);
  expect(after.height).toBeGreaterThan(before.height + 30);

  await preview.getByRole("button", { name: "打开Beta" }).click();
  await expect(page.locator("#title")).toHaveValue("Beta");
});

test("nested Canvas links support preview and icon modes without recursive cycles", async ({ page }) => {
  await createCanvas(page, "Canvas A");
  await createCanvas(page, "Canvas B");

  await page.dragAndDrop('.doc-item:has(.list-label:text-is("Canvas A"))', ".canvas-viewport", { targetPosition: { x: 390, y: 280 } });
  const nested = page.locator(".canvas-node-canvas");
  await expect(nested).toBeVisible();
  await expect(nested.locator(".canvas-miniature")).toBeVisible();
  await nested.locator(".canvas-node-mode").click();
  await expect(nested).toHaveClass(/icon-mode/);
  const iconBox = await nested.boundingBox();
  expect(Math.round(iconBox.width)).toBe(112);
  expect(Math.round(iconBox.height)).toBe(112);

  await nested.getByRole("button", { name: "打开Canvas A" }).click();
  await expect(page.locator(".canvas-title")).toHaveValue("Canvas A");
  await page.dragAndDrop('.doc-item:has(.list-label:text-is("Canvas B"))', ".canvas-viewport", { targetPosition: { x: 360, y: 260 } });
  await expect(page.locator(".canvas-node-canvas")).toHaveCount(0);
});
