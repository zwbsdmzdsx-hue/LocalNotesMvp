import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
});

async function insertLink(page) {
  const paragraph = page.locator('[data-id="a1"] > .block-row > .block-text');
  await page.locator('[data-editor-mode="source"]').click();
  await paragraph.fill('Before [[默认笔记本/Beta#^b1]]');
  await page.locator('[data-editor-mode="rich"]').click();
  return paragraph.locator('.wiki-link');
}

test('title links preview on hover, single click opens a pane, double click opens source', async ({ page }, info) => {
  const link = await insertLink(page);
  await link.hover();
  const preview = page.getByRole('tooltip');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Beta 的内容');
  const bounds = await preview.boundingBox();
  expect(bounds.width).toBe(320); expect(bounds.height).toBe(220);
  await page.screenshot({ path: info.outputPath('hover-preview.png'), fullPage: true });
  await link.click();
  await expect(page.locator('#title')).toHaveValue('Alpha');
  await expect(page.locator('#reference-sidebar')).toContainText('Beta 的内容');
  await expect(preview).toHaveCount(0);
  await expect(page.locator('[data-id="a1"] .reference-card')).toHaveCount(0);
  await link.dblclick();
  await expect(page.locator('#title')).toHaveValue('Beta');
});

test('ordinary links stay in their paragraph and never become embedded reference instances', async ({ page }, info) => {
  const link = await insertLink(page);
  const paragraph = page.locator('[data-id="a1"] > .block-row > .block-text');
  await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.type(' After');
  await expect(paragraph).toContainText('Before');
  await expect(paragraph).toContainText('After');
  await expect(paragraph.locator('.wiki-link')).toHaveCount(1);
  await expect(paragraph.locator('.embedded-reference')).toHaveCount(0);
  const saved = await page.evaluate(() => window.mockHost.state('alpha'));
  expect(saved.blocks.filter(block => block.type === 'reference')).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('embedded-reference.png'), fullPage: true });
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
  await expect(page.locator('#reference-sidebar-section')).toBeVisible();
  await expect(page.locator('#reference-sidebar-section > .panel-head')).toHaveText('实时引用');
  await page.screenshot({ path: info.outputPath('collapsed-reference.png'), fullPage: true });
});
