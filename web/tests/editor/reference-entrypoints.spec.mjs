import { test, expect } from '@playwright/test';

test('[[ insertion is the only new relation flow and does not open a conversion menu', async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  const paragraph = page.locator('[data-id="a1"] > .block-row > .block-text');
  await page.locator('[data-editor-mode="source"]').click();
  await paragraph.fill('Before [[默认笔记本/Beta#^b1]]');
  await page.locator('[data-editor-mode="rich"]').click();
  await expect(paragraph.locator('.wiki-link')).toHaveAttribute('data-target-id', 'beta');
  await expect(page.locator('.link-mode-menu')).toHaveCount(0);
  await expect(page.getByText('嵌入为实时引用', { exact: true })).toHaveCount(0);
});

test('the block menu only copies a stable [[...#^block]] link', async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  await page.locator('[data-id="a1"] .grip').click();
  await page.getByRole('menu').getByText('复制块链接', { exact: true }).click();
  await expect(page.locator('#status')).toContainText('块链接已复制');
  await expect(page.getByText('插入块链接', { exact: true })).toHaveCount(0);
  await expect(page.getByText('嵌入为实时引用', { exact: true })).toHaveCount(0);
});
