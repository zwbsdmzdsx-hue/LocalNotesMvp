import { test, expect } from "@playwright/test";

test("database cells take the caret and rows reorder without block controls", async ({ page }) => {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept("可编辑表"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建数据表" }).click();
  const table = page.locator('[data-own-block][data-type="database_table"]');
  await expect(table.locator(":scope > .database-row > .grip, :scope > .database-row > .delete-block")).toHaveCount(0);
  await table.locator(".database-add-row").click();
  await table.locator(".database-add-row").click();
  const rows = table.locator("tbody tr[data-record-id]");
  await expect(rows).toHaveCount(2);
  const first = rows.nth(0).locator('.database-cell[data-field-key="name"]');
  await first.click();
  await expect(first).toBeFocused();
  await first.fill("甲行");
  await first.press("Tab");
  const second = rows.nth(1).locator('.database-cell[data-field-key="name"]');
  await second.fill("乙行");
  await second.press("Tab");
  await expect(rows.nth(0).locator('.database-cell[data-field-key="name"]')).toHaveValue("甲行");
  expect(await rows.nth(0).evaluate(row => row.getBoundingClientRect().height)).toBeLessThan(40);
  await rows.nth(1).locator(".database-row-handle").dragTo(rows.nth(0).locator(".database-row-controls"), { targetPosition: { x: 8, y: 3 } });
  await expect(rows.nth(0).locator('.database-cell[data-field-key="name"]')).toHaveValue("乙行");
  await expect(rows.nth(1).locator('.database-cell[data-field-key="name"]')).toHaveValue("甲行");
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.locator('.doc-item', { hasText: '可编辑表' }).click();
  await expect(rows.nth(0).locator('.database-cell[data-field-key="name"]')).toHaveValue("乙行");
  await table.screenshot({ path: "test-results/database-row-layout.png" });
});

test("database text cells keep focus through continuous typing and another cell's save ACK", async ({ page }) => {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept("连续输入表"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建数据表" }).click();
  const table = page.locator('[data-own-block][data-type="database_table"]');
  await table.locator(".database-add-row").click();
  const name = table.locator('tbody tr .database-cell[data-field-key="name"]');
  await name.click();
  await page.keyboard.insertText("甲");
  await expect(name).toBeFocused();
  await page.keyboard.insertText("乙丙");
  await expect(name).toHaveValue("甲乙丙");

  await page.evaluate(() => {
    const host = window.mockHost;
    const send = host.send.bind(host);
    host.send = request => request.kind === "executeCommand" && request.payload?.operation === "upsert-database-record"
      ? setTimeout(() => send(request), 100) : send(request);
  });
  await name.press("Tab");
  const status = table.locator('tbody tr .database-cell[data-field-key="status"]');
  await status.click();
  await status.pressSequentially("持续输入", { delay: 45 });
  await expect(status).toBeFocused();
  await expect(status).toHaveValue("持续输入");
  await status.press("Tab");
  await expect(table.locator('tbody tr .database-cell[data-field-key="name"]')).toHaveValue("甲乙丙");
  await expect(table.locator('tbody tr .database-cell[data-field-key="status"]')).toHaveValue("持续输入");
  await status.click();
  await status.fill("[[");
  await expect(status).toBeFocused();
  await expect(page.getByRole("listbox", { name: "插入引用" })).toBeVisible();
});
