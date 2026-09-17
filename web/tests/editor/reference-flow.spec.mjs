import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
});

async function insertLink(page) {
  const paragraph = page.locator('[data-id="a1"] > .block-row > .block-text');
  await paragraph.fill('Before [[');
  await page.locator('.link-suggestion').filter({ hasText: 'Beta' }).first().click();
  await page.getByRole('button', { name: '保持普通双链', exact: true }).click();
  return paragraph.locator('.wiki-link');
}

test('title links preview on hover, single click opens a pane, double click opens source', async ({ page }, info) => {
  const link = await insertLink(page);
  await link.hover();
  const preview = page.getByRole('tooltip');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Beta 文档中的其他块');
  const bounds = await preview.boundingBox();
  expect(bounds.width).toBe(320); expect(bounds.height).toBe(220);
  await page.screenshot({ path: info.outputPath('hover-preview.png'), fullPage: true });
  await link.click();
  await expect(page.locator('#title')).toHaveValue('Alpha');
  await expect(page.locator('#reference-sidebar')).toContainText('Beta 文档中的其他块');
  await expect(preview).toHaveCount(0);
  await expect(page.locator('[data-id="a1"] .reference-card')).toHaveCount(0);
  await link.dblclick();
  await expect(page.locator('#title')).toHaveValue('Beta');
});

test('embedding replaces the link inside its paragraph and saves only an anchor', async ({ page }, info) => {
  const link = await insertLink(page);
  // Place trailing text after the link, then convert that exact occurrence.
  const paragraph = page.locator('[data-id="a1"] > .block-row > .block-text');
  await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.type(' After');
  await link.click({ button: 'right' });
  await page.getByRole('button', { name: '嵌入实时引用 · 正文直显', exact: true }).click();
  const embedded = paragraph.locator('.embedded-reference');
  await expect(embedded.locator('.reference-card')).toBeVisible();
  await expect(paragraph).toContainText('Before');
  await expect(paragraph).toContainText('After');
  await expect(paragraph.locator('.wiki-link')).toHaveCount(0);
  await expect(embedded.locator('.reference-row')).toHaveCount(2);
  const saved = await page.evaluate(() => window.mockHost.state('alpha'));
  const owner = saved.blocks.find(block => block.id === 'a1');
  expect(owner.content.html).toContain('data-reference-host-id');
  expect(owner.content.html).not.toContain('Beta 的内容');
  expect(owner.content.text).not.toContain('Beta 的内容');
  expect(saved.blocks.find(block => block.id !== 'ar1' && block.type === 'reference').parentId).toBe('a1');
  await page.screenshot({ path: info.outputPath('embedded-reference.png'), fullPage: true });
  await page.locator('[data-doc="beta"]').click();
  await page.locator('[data-doc="alpha"]').click();
  await expect(paragraph.locator('.embedded-reference .reference-row')).toHaveCount(2);
  // Local editing is an override and must not enter the parent paragraph snapshot.
  await embedded.locator('.block-text').first().fill('Local instance only');
  await expect(page.locator('#status')).toContainText('已保存');
  await page.locator('[data-doc="beta"]').click();
  await expect(page.locator('[data-id="b1"] .block-text')).toHaveText('Beta 的内容');
  await page.locator('[data-doc="alpha"]').click();
  await expect(embedded.locator('.block-text').first()).toHaveText('Local instance only');
});

test('body collapse persists and differs from title-only mode', async ({ page }, info) => {
  const shell = page.locator('[data-id="ar1"]');
  await shell.getByRole('button', { name: '收起', exact: true }).click();
  await expect(shell.locator('.reference-card')).toHaveClass(/is-collapsed/);
  await page.locator('[data-doc="beta"]').click();
  await page.locator('[data-doc="alpha"]').click();
  await expect(shell.locator('.reference-card')).toHaveClass(/is-collapsed/);
  await expect(shell.getByRole('button', { name: '展开', exact: true })).toBeVisible();
  await shell.locator('.reference-title').click({ button: 'right' });
  await page.getByRole('button', { name: '仅标题链接', exact: true }).click();
  await expect(shell.locator('.reference-card, .reference-expand')).toHaveCount(0);
  await shell.locator('.reference-title').hover();
  await expect(page.getByRole('tooltip')).toContainText('Beta 的内容');
  await expect(page.getByRole('tooltip')).not.toContainText('Beta 文档中的其他块');
  await shell.locator('.reference-title').click();
  await expect(page.locator('#title')).toHaveValue('Alpha');
  await expect(page.locator('#reference-sidebar .reference-row')).toHaveCount(1);
  await page.getByRole('button', { name: '嵌入正文', exact: true }).click();
  await expect(shell.locator('.reference-card')).toHaveClass(/is-expanded/);
  await expect(page.locator('#reference-sidebar-section')).toBeVisible();
  await expect(page.locator('#reference-sidebar-section > .panel-head')).toHaveText('实时引用');
  await shell.getByRole('button', { name: '收起', exact: true }).click();
  await page.screenshot({ path: info.outputPath('collapsed-reference.png'), fullPage: true });
});
