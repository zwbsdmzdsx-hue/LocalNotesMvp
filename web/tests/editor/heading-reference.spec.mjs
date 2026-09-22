import { test, expect } from '@playwright/test';

test('heading suggestions preview rendered content and retain the heading section', async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  const editable = page.locator('[data-id="a1"] .block-text').first();
  await editable.fill('引用标题 [[');
  await page.keyboard.type('研究/Zeta#目标');

  const heading = page.locator('.link-suggestion[data-kind="heading"]').filter({ hasText: '目标标题' });
  await expect(heading).toBeVisible();
  await expect(heading.locator('.link-suggestion-block-line h1')).toContainText('目标标题');

  await heading.click();
  const link = editable.locator('.wiki-link');
  await expect(link).toHaveAttribute('data-target-id', 'zeta');
  await expect(link).toHaveAttribute('data-target-block-id', 'z2');
  await expect(link).toHaveAttribute('data-target-scope', 'heading');
  await expect(link).toHaveText('目标标题');
  await page.getByRole('button', { name: '嵌入实时引用 · 正文直显', exact: true }).click();
  await expect(page.locator('.embedded-reference')).toContainText('目标标题');
  await expect(page.locator('.embedded-reference')).toContainText('可搜索正文');
});

test('source mode writes a complete heading wikilink', async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  const source = page.locator('[data-id="a1"] .block-text').first();
  await page.locator('[data-editor-mode="source"]').click();
  await source.fill('源码引用 [[');
  await page.keyboard.type('研究/Zeta#目标');
  await page.locator('.link-suggestion[data-kind="heading"]').filter({ hasText: '目标标题' }).click();
  await expect(source).toContainText('[[研究/Zeta#目标标题]]');
});

test('a bare hash in the block stage lists headings and keeps block rows compact', async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  const editable = page.locator('[data-id="a1"] .block-text').first();
  await editable.fill('[[');
  await page.keyboard.type('研究/Zeta/#');
  const heading = page.locator('.link-suggestion[data-kind="heading"]').filter({ hasText: '目标标题' });
  await expect(heading).toBeVisible();
  const height = await heading.evaluate(element => element.getBoundingClientRect().height);
  expect(height).toBeLessThanOrEqual(24);
});

test('a heading-type block without Markdown hashes is available to the H1 filter', async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  await page.evaluate(() => {
    const block = window.mockHost.docs.get('zeta').blocks.find(item => item.id === 'z1');
    block.type = 'heading';
    block.content = { text: '类型标题', html: '类型标题' };
    window.mockHost.emitLoaded();
  });
  const editable = page.locator('[data-id="a1"] .block-text').first();
  await editable.fill('[[');
  await page.keyboard.type('研究/Zeta/#类型');
  await expect(page.locator('.link-suggestion[data-kind="heading"]').filter({ hasText: '类型标题' })).toBeVisible();
});
