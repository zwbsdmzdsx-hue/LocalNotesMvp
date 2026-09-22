import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
});

test('a column member dropped on the group top exits before the column row', async ({ page }) => {
  await page.locator('#add-columns').click();
  const member = page.locator('.column-track').first().locator('[data-own-block]').first();
  const movedId = await member.getAttribute('data-id');
  const row = page.locator('.columns-row');
  const box = await row.boundingBox();
  if (!box) throw new Error('column row is not visible');
  await member.locator('.grip').dragTo(row, { targetPosition: { x: 10, y: 2 } });
  await expect(page.locator('.columns-row')).toHaveCount(0);
  await page.waitForTimeout(80);
  const moved = await page.evaluate(id => window.mockHost.state('alpha').blocks.find(block => block.id === id), movedId);
  expect(moved?.properties.columnGroup).toBeUndefined();
  const order = await page.evaluate(() => [...document.querySelectorAll('#blocks > [data-own-block], #blocks > .columns-row')].map(element => element.dataset.id ?? element.dataset.columnGroup));
  expect(order.indexOf(movedId)).toBeLessThan(order.length - 1);
});
