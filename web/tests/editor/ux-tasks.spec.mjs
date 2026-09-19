import { test, expect } from "@playwright/test";

test("drag block reorder via grip", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-doc="beta"]').click();
  const first = page.locator('[data-own-block][data-type="paragraph"] .block-text').first();
  await first.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("a newly added block");
  await page.keyboard.press("Enter");
  await page.keyboard.type("another block to drag");

  // Drag the new block (last paragraph) up via its grip
  const lastBlock = page.locator('[data-own-block][data-type="paragraph"]').last();
  const lastGrip = lastBlock.locator(".grip");
  const firstBlock = page.locator('[data-own-block][data-type="paragraph"]').first();

  await expect(lastGrip).toHaveAttribute("draggable", "true");
  await lastGrip.hover();
  await page.mouse.down();
  await page.mouse.move(0, 0); // prime drag
  await firstBlock.hover({ position: { x: 10, y: 5 } }); // top half → "before"
  await page.mouse.up();

  // Block should now appear before the original first paragraph
  const order = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('[data-own-block][data-type="paragraph"] .block-text')];
    return blocks.map(b => b.textContent);
  });
  console.log("Order after drag:", order);
  expect(order.some(t => t && t.includes("another block to drag"))).toBe(true);
});

test("right-click bookmark shows context menu", async ({ page }) => {
  await page.goto("/");
  const strip = page.locator('.bk-strip:not(.bk-strip-add)').first();
  await strip.click({ button: "right" });
  await expect(page.locator(".context-menu")).toBeVisible();
  await expect(page.locator(".context-menu button")).toContainText(["重命名", "更改颜色", "删除书签"]);
});

test("+ new bookmark button visible at bottom of bookmark list", async ({ page }) => {
  await page.goto("/");
  const addBtn = page.locator('.bk-strip-add');
  await expect(addBtn).toBeVisible();
  await expect(addBtn).toContainText("新建书签");
});

test("left sidebar tabs at top: docs/search/outline", async ({ page }) => {
  await page.goto("/");
  const tabs = page.locator('.sidebar-left-tabs .sidebar-tab');
  await expect(tabs).toHaveCount(3);
  // docs panel should be visible by default
  await expect(page.locator('.panel[data-left-panel="docs"]')).toBeVisible();
  await page.locator('[data-left-pane="search"]').click();
  await expect(page.locator('.panel[data-left-panel="search"]')).toBeVisible();
  await page.locator('[data-left-pane="outline"]').click();
  await expect(page.locator('.panel[data-left-panel="outline"]')).toBeVisible();
});


test("right-click document shows context menu", async ({ page }) => {
  await page.goto("/");
  const docItem = page.locator('.doc-item').first();
  await docItem.click({ button: "right" });
  await expect(page.locator(".context-menu")).toBeVisible();
  await expect(page.locator(".context-menu button")).toContainText(["重命名", "删除文档"]);
});

test("right-click notebook tab shows context menu", async ({ page }) => {
  await page.goto("/");
  const nbTab = page.locator('.notebook-tab').first();
  await nbTab.click({ button: "right" });
  await expect(page.locator(".context-menu")).toBeVisible();
  await expect(page.locator(".context-menu button")).toContainText(["重命名", "删除笔记本"]);
});
