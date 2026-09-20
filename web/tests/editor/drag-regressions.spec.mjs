import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
});

test('document drag feedback keeps one blue insertion line', async ({ page }) => {
  const source = page.locator('.doc-item').filter({ hasText: 'Beta' }).first();
  const target = page.locator('.doc-item').filter({ hasText: 'Alpha' }).first();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer: transfer });
  const box = await target.boundingBox();
  await target.dispatchEvent('dragover', { dataTransfer: transfer, clientX: (box?.x ?? 0) + 8, clientY: (box?.y ?? 0) + 2 });
  await expect(page.locator('.doc-node.drop-before, .doc-node.drop-after, .doc-drop-zone.active')).toHaveCount(1);
  await expect(page.locator('.doc-node.drop-before, .doc-node.drop-after, .doc-drop-zone.active')).toHaveCount(1);
  await source.dispatchEvent('dragend', { dataTransfer: transfer });
});

test('dragging a normal block never duplicates an inline reference shell', async ({ page }) => {
  await page.locator('#add-paragraph').click();
  const added = page.locator('#blocks > [data-own-block][data-type="paragraph"]').last();
  await added.locator('.block-text').fill('拖拽触发重绘');
  const referenceId = 'ar1';
  await expect(page.locator(`[data-own-block][data-id="${referenceId}"]`)).toHaveCount(1);
  const target = page.locator('[data-own-block][data-id="a1"]');
  const box = await target.locator('.block-text').boundingBox();
  await added.locator('.grip').dragTo(target.locator('.block-text'), {
    targetPosition: { x: Math.floor((box?.width ?? 100) / 2), y: 2 }
  });
  await expect(page.locator(`[data-own-block][data-id="${referenceId}"]`)).toHaveCount(1);
});
