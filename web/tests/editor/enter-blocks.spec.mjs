import { test, expect } from '@playwright/test';

const ownBlocks = page => page.locator('#blocks > [data-own-block]');
const paragraphBlocks = page => page.locator('#blocks > [data-own-block][data-type="paragraph"]');

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
});

test('Enter creates a block and Shift+Enter keeps the line in rich mode', async ({ page }) => {
  const first = page.locator('[data-own-block][data-id="a1"] .block-text');
  await first.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const next = paragraphBlocks(page).nth(1).locator('.block-text');
  await expect(next).toBeFocused();
  await page.keyboard.type('second block');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('same block line');
  await expect(next).toContainText('second block');
  await expect(next).toContainText('same block line');
  expect(await next.evaluate(element => element.innerHTML)).toContain('<br');
  await expect(ownBlocks(page)).toHaveCount(3);
});

test('Enter creates a block and Shift+Enter keeps the line in source mode', async ({ page }) => {
  await page.locator('[data-editor-mode="source"]').click();
  const first = page.locator('[data-own-block][data-id="a1"] .block-text');
  await first.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const next = paragraphBlocks(page).nth(1).locator('.block-text');
  await expect(next).toBeFocused();
  await page.keyboard.type('# source block');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('same source block');
  await expect(next).toHaveText('# source block\nsame source block');
  await expect(next).toHaveClass(/markdown-source/);
  await expect(ownBlocks(page)).toHaveCount(3);
});

test('Enter in the title focuses the first body block', async ({ page }) => {
  const first = page.locator('[data-own-block] .block-text').first();
  await page.locator('#title').press('Enter');
  await expect(first).toBeFocused();
});

test('Enter in an inline reference row adds a same-level local row', async ({ page }) => {
  const reference = page.locator('[data-own-block][data-type="reference"]');
  const sourceRow = reference.locator('.reference-row').first();
  await sourceRow.locator('.block-text').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(reference.locator('.reference-row')).toHaveCount(2);
  await expect(reference.locator('.reference-row').nth(1).locator('.reference-meta')).toContainText('本地新增');
  await expect(reference.locator('.reference-row').nth(1).locator('.block-text')).toBeFocused();
});

test('reference rows created in source mode expose editable Markdown source', async ({ page }) => {
  await page.locator('[data-editor-mode="source"]').click();
  const reference = page.locator('[data-own-block][data-type="reference"]');
  await reference.locator('.reference-row').first().locator('.block-text').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const local = reference.locator('.reference-row').nth(1).locator('.block-text');
  await expect(local).toHaveClass(/markdown-source/);
  await expect(local).toBeFocused();
  await local.fill('**本地引用源码**');
  await expect(local).toHaveText('**本地引用源码**');
});
