import { test, expect } from "@playwright/test";

async function createTable(page) {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept("引用与列宽"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建数据表" }).click();
  const table = page.locator('[data-own-block][data-type="database_table"]');
  await table.locator(".database-add-row").click();
  return table;
}

test("cell wiki suggestion advances through each level and renders the chosen block", async ({ page }) => {
  const table = await createTable(page);
  const cell = table.locator('.database-cell[data-field-key="name"]');
  await cell.fill("[[");
  const suggestions = page.getByRole("listbox", { name: "插入引用" });
  await suggestions.getByRole("option", { name: "默认笔记本" }).click();
  await expect(cell).toBeFocused();
  await expect(suggestions.getByRole("option", { name: "Alpha" })).toBeVisible();
  await suggestions.getByRole("option", { name: "Alpha" }).click();
  await expect(cell).toBeFocused();
  await expect(suggestions.locator('[data-block-id="a1"]')).toBeVisible();
  await suggestions.locator('[data-block-id="a1"]').click();
  await expect(table.locator('.database-cell-display .wiki-link')).toHaveAttribute("data-target-block-id", "a1");
  await table.screenshot({ path: "test-results/database-cell-reference.png" });
  await table.locator('.database-cell-display .wiki-link').hover();
  await expect(page.locator(".link-preview")).toContainText("浏览器编辑器核心", { timeout: 1500 });
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.locator('.doc-item', { hasText: "引用与列宽" }).click();
  await expect(table.locator('.database-cell-display .wiki-link')).toHaveAttribute("data-target-block-id", "a1");
  await table.locator('td[data-field-key="name"] .database-cell-edit').click();
  await cell.fill("[[默认笔记本/Beta#^b1|自定义标题]]");
  await cell.press("Enter");
  await expect(table.locator('.database-cell-display .wiki-link')).toHaveText("自定义标题");
  await expect(table.locator('.database-cell-display .wiki-link')).toHaveAttribute("data-target-block-id", "b1");
});

test("dragging a header divider persists column width in its view", async ({ page }) => {
  const table = await createTable(page);
  const header = table.locator('th[data-field-key="name"]');
  const before = await header.boundingBox();
  const handle = header.locator(".database-column-resize");
  const rect = await handle.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 80, rect.y + rect.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await header.boundingBox()).width).toBeGreaterThan(before.width + 50);
  await table.screenshot({ path: "test-results/database-column-resize.png" });
  const changed = (await header.boundingBox()).width;
  await table.locator(".database-view-add").selectOption("table");
  await expect.poll(async () => (await header.boundingBox()).width).toBeLessThan(changed - 40);
  await table.locator(".database-view-picker").selectOption({ index: 0 });
  await expect.poll(async () => (await header.boundingBox()).width).toBeGreaterThan(changed - 5);
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.locator('.doc-item', { hasText: "引用与列宽" }).click();
  await expect.poll(async () => (await header.boundingBox()).width).toBeGreaterThan(changed - 5);
});
