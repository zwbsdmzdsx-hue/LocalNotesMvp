import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
});

test("detaching reference keeps content as plain text in document", async ({ page }) => {
  await page.goto("/");
  // Alpha has a reference to Beta.b1 with content "Beta 的内容"
  await expect(page.locator('[data-own-block][data-type="reference"]')).toBeVisible();
  // Open reference menu via the grip on the reference shell
  await page.locator('[data-own-block][data-type="reference"] .reference-heading .grip').click();
  await page.getByRole("menu").getByText("断开引用", { exact: false }).click();
  // The reference block should be replaced with a plain paragraph containing the source content
  await expect(page.locator('[data-own-block][data-type="reference"]')).toHaveCount(0);
  const plain = page.locator('[data-own-block][data-type="paragraph"]');
  await expect(plain.filter({ hasText: "Beta 的内容" }).first()).toBeVisible();
  // The host document should no longer hold a reference record
  const refs = await page.evaluate(() => (window).mockHost.docs.get("alpha").references.length);
  expect(refs).toBe(0);
});

test("reference row + button adds sibling block, not child", async ({ page }) => {
  await page.goto("/");
  // First expand Beta's reference block to have a child block in source
  await page.locator('[data-doc="beta"]').click();
  const root = page.locator('[data-own-block][data-id="b1"] .block-text');
  await root.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("child of the referenced block");
  await page.keyboard.press("Tab"); // indent as child
  await expect(page.locator("#status")).toContainText("已保存");

  // Back to Alpha; hover the reference card to reveal meta buttons
  await page.locator('[data-doc="alpha"]').click();
  const ref = page.locator('[data-own-block][data-type="reference"]');
  // Add a sibling block (click + button on b1 row)
  const firstRow = ref.locator('.reference-row[data-target-block-id="b1"]');
  await firstRow.locator(".reference-meta").hover();
  await firstRow.locator(".add-sibling").click({ force: true });
  await page.waitForTimeout(500);
  // After adding sibling, we expect a new instance block whose parent is null
  // (b1.parentId is null in Beta source). The new block should NOT have parentId = b1.id
  const newRow = ref.locator('.reference-row[data-scope-type="reference_instance"]').last();
  await expect(newRow).toBeVisible();
  const parentId = await newRow.getAttribute("data-parent-id");
  expect(parentId).not.toBe("b1");
});

test("reference row × (hide) button works on inherited block", async ({ page }) => {
  await page.goto("/");
  const ref = page.locator('[data-own-block][data-type="reference"]');
  // The first inherited row's × button
  const firstRow = ref.locator('.reference-row[data-scope-type="canonical"]').first();
  const rowCountBefore = await ref.locator('.reference-row').count();
  await firstRow.locator(".hide").click({ force: true });
  await page.waitForTimeout(400);
  // After hide, reload — visible row count should drop
  await expect(ref.locator('.reference-row')).toHaveCount(rowCountBefore - 1);
});

test("reference footer no longer has + 引用内新增 button", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('.reference-card .reference-footer .add-root')).toHaveCount(0);
});

test("reference row × button works for local instance blocks too", async ({ page }) => {
  await page.goto("/");
  const ref = page.locator('[data-own-block][data-type="reference"]');
  // First, add a sibling (local instance block)
  const firstRow = ref.locator('.reference-row[data-scope-type="canonical"]').first();
  await firstRow.locator(".reference-meta").hover();
  await firstRow.locator(".add-sibling").click({ force: true });
  await page.waitForTimeout(500);
  // Now we should have at least one local instance block
  const local = ref.locator('.reference-row[data-scope-type="reference_instance"]');
  await expect(local.first()).toBeVisible();
  // Click × on the local block
  await local.first().locator(".hide").click({ force: true });
  await page.waitForTimeout(400);
  // The local block should be removed
  await expect(ref.locator('.reference-row[data-scope-type="reference_instance"]')).toHaveCount(0);
});

test("reference row × button is visible without hover", async ({ page }) => {
  await page.goto("/");
  // Move mouse away from the reference row
  await page.mouse.move(0, 0);
  await page.waitForTimeout(100);
  const meta = page.locator('[data-own-block][data-type="reference"] .reference-row .reference-meta').first();
  await expect(meta).toBeVisible();
  const button = meta.locator("button.hide");
  await expect(button).toBeVisible();
});
