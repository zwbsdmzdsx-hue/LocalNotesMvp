import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  await expect(page.locator('#title')).toHaveValue('Alpha');
});

test('document CSS cards save and notebook CSS has a toolbar entry', async ({ page }) => {
  await page.locator('[data-pane-btn="styles"]').click();
  await expect(page.locator('[data-slot="styles"] .style-add')).toHaveCount(1);
  await page.locator('.style-add').click();
  const card = page.locator('.style-card').last();
  await card.locator('.style-card-body input').nth(0).fill('Callout');
  await card.locator('.style-card-body input').nth(1).fill('文档提示块');
  await card.locator('textarea').fill('.callout { color: rgb(200, 30, 30); }');
  await card.getByRole('button', { name: '保存' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.mockHost.state('alpha').documentStyles)).length).toBe(1);
  await expect(page.locator('.style-preview').first()).toContainText('Callout');

  await page.locator('#notebook-styles').click();
  await expect(page.locator('.style-scope-switch button.active')).toHaveText('当前笔记本');
});

test('system CSS scope is available and propagates to another document', async ({ page }) => {
  await page.locator('[data-pane-btn="styles"]').click();
  await page.getByRole('button', { name: '系统' }).click();
  await expect(page.locator('.style-add')).toHaveText('+ 新建系统样式');
  await page.locator('.style-add').click();
  const card = page.locator('.style-card').last();
  await card.locator('textarea').fill('.system-callout { color: rgb(11, 99, 182); }');
  await card.getByRole('button', { name: '保存' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.mockHost.state('alpha').systemStyles)).length).toBe(1);
  await page.locator('nav button[data-doc="beta"]').click();
  await expect.poll(async () => (await page.evaluate(() => window.mockHost.state('beta').systemStyles)).length).toBe(1);
});

test('applies a managed CSS class to the selected rich text and preserves it after save', async ({ page }) => {
  await page.locator('[data-pane-btn="styles"]').click();
  await page.locator('.style-add').click();
  const card = page.locator('.style-card').last();
  await card.locator('textarea').fill('.callout { color: rgb(200, 30, 30); }');
  await card.getByRole('button', { name: '保存' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.mockHost.state('alpha').documentStyles)).length).toBe(1);

  await page.evaluate(() => {
    const editable = document.querySelector('.block-text.rich-editor');
    if (!editable || !editable.firstChild) throw new Error('editable text not found');
    const text = editable.firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(4, text.textContent?.length ?? 0));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.locator('.style-apply').click();
  await expect(page.locator('.block-text.rich-editor .callout')).toHaveCount(1);
  await expect.poll(async () => (await page.evaluate(() => window.mockHost.state('alpha').blocks[0].content.html))).toContain('class="callout"');
  await expect.poll(async () => (await page.evaluate(() => window.mockHost.state('alpha').blocks[0].content.markdown))).toContain('<span class="callout">');
  await expect(page.locator('[data-own-block][data-id="a1"] .block-text.rich-editor .callout')).toContainText('浏览器编');

  await page.locator('[data-editor-mode="source"]').click();
  await expect(page.locator('[data-own-block][data-id="a1"] .markdown-source')).toContainText('<span class="callout">浏览器编</span>');
  await page.locator('[data-editor-mode="rich"]').click();
  await expect(page.locator('[data-own-block][data-id="a1"] .block-text.rich-editor .callout')).toContainText('浏览器编');
});

test('style card preview follows the first selector instead of a fixed sample class', async ({ page }) => {
  await page.locator('[data-pane-btn="styles"]').click();
  await page.locator('.style-add').click();
  const card = page.locator('.style-card').last();
  await card.locator('textarea').fill('h2.notice { color: rgb(12, 120, 45); padding: 4px; }');
  await card.getByRole('button', { name: '保存' }).click();
  const sample = page.locator('.style-preview h2.notice');
  await expect(sample).toHaveCount(1);
  await expect.poll(() => sample.evaluate(element => getComputedStyle(element).color)).toBe('rgb(12, 120, 45)');
});
