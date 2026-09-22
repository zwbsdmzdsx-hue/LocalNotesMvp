import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
});

const saved = page => expect(page.locator('#status')).toHaveText(/已保存|已同步本地数据库/);

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

test('extracting a column member keeps the normal row below the former column position', async ({ page }) => {
  await page.locator('#add-columns').click();
  await page.locator('#add-paragraph').click();
  const normal = page.locator('#blocks > [data-own-block][data-type="paragraph"]').last();
  await normal.locator('.block-text').fill('分列下方普通行');
  await saved(page);
  const member = page.locator('.column-track').first().locator('[data-own-block]').first();
  const movedId = await member.getAttribute('data-id');
  const row = page.locator('.columns-row');
  await member.locator('.grip').dragTo(row, { targetPosition: { x: 10, y: 2 } });
  await saved(page);
  const order = await page.evaluate(() => window.mockHost.state('alpha').blocks
    .filter(block => block.parentId === null)
    .sort((a, b) => a.position.localeCompare(b.position))
    .map(block => ({ id: block.id, text: block.content.text })));
  expect(order.findIndex(block => block.id === movedId)).toBeLessThan(order.findIndex(block => block.text === '分列下方普通行'));
  expect(order.at(-1)?.text).toBe('分列下方普通行');
});

test('restoring columns keeps the normal row below all restored members', async ({ page }) => {
  await page.locator('#add-columns').click();
  const tracks = page.locator('.column-track');
  await tracks.nth(0).locator('.block-text').fill('左列');
  await tracks.nth(1).locator('.block-text').fill('右列');
  await page.locator('#add-paragraph').click();
  await page.locator('#blocks > [data-own-block][data-type="paragraph"]').last().locator('.block-text').fill('分列下方普通行');
  await saved(page);
  await page.locator('.columns-restore').click();
  await saved(page);
  const order = await page.evaluate(() => window.mockHost.state('alpha').blocks
    .filter(block => block.parentId === null)
    .sort((a, b) => a.position.localeCompare(b.position))
    .map(block => block.content.text));
  expect(order.slice(-3)).toEqual(['左列', '右列', '分列下方普通行']);
});
