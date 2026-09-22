import { test, expect } from '@playwright/test';

const firstBlock = page => page.locator('#blocks [data-id="a1"] > .block-row > .block-text');
const switchMode = (page, mode) => page.locator(`[data-editor-mode="${mode}"]`).click();
const saved = page => expect(page.locator('#status')).toContainText('已保存', { timeout: 3000 });

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  await expect(page.locator('#title')).toHaveValue('Alpha');
});

test('source and preview modes preserve Markdown and render common GFM syntax safely', async ({ page }, info) => {
  const markdown = '# Markdown 标题\n\n**粗体**、_斜体_、~~删除~~、==高亮== 和 `code`\n\n> 引用\n\n- 第一项\n- 第二项\n- [x] 已完成\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[官网](https://example.com)\n\n![示例](/example.png)\n\n<script>window.markdownInjected = true</script>';
  await switchMode(page, 'source');
  await expect(firstBlock(page)).toHaveClass(/markdown-source/);
  await firstBlock(page).fill(markdown);
  await saved(page);

  await switchMode(page, 'preview');
  const preview = firstBlock(page);
  await expect(preview).toHaveClass(/markdown-preview/);
  await expect(preview).not.toHaveAttribute('contenteditable');
  await expect(preview.locator('h1')).toHaveText('Markdown 标题');
  await expect(preview.locator('strong')).toHaveText('粗体');
  await expect(preview.locator('em')).toHaveText('斜体');
  await expect(preview.locator('blockquote')).toContainText('引用');
  await expect(preview.locator('del')).toHaveText('删除');
  await expect(preview.locator('mark')).toHaveText('高亮');
  await expect(preview.locator('li')).toHaveCount(3);
  await expect(preview.locator('input[type="checkbox"]')).toBeChecked();
  await expect(preview.locator('table')).toBeVisible();
  await expect(preview.getByRole('link', { name: '官网' })).toHaveAttribute('href', 'https://example.com');
  await expect(preview.getByRole('img', { name: '示例' })).toHaveAttribute('src', '/example.png');
  await expect(preview.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => window.markdownInjected)).toBeUndefined();
  await expect(page.locator('#add-paragraph')).toBeDisabled();
  await page.screenshot({ path: info.outputPath('markdown-preview.png'), fullPage: true });

  await switchMode(page, 'source');
  await expect(firstBlock(page)).toHaveText(markdown);
  expect(await page.evaluate(() => window.mockHost.state('alpha').blocks.find(block => block.id === 'a1').content.markdown)).toBe(markdown);
});

test('full-width Markdown heading punctuation is normalized in preview', async ({ page }) => {
  await switchMode(page, 'source');
  await firstBlock(page).fill('＃ title');
  await saved(page);

  await switchMode(page, 'preview');
  await expect(firstBlock(page).locator('h1')).toHaveText('title');

  await switchMode(page, 'source');
  await expect(firstBlock(page)).toHaveText('＃ title');
});

test('rich editing and preview use the same rendered block metrics', async ({ page }) => {
  const source = '# 标题\n\n正文 **加粗**\n\n> 引用\n\n- 一项\n- 二项';
  await switchMode(page, 'source');
  await firstBlock(page).fill(source);
  await saved(page);
  await switchMode(page, 'rich');
  const richHeight = await firstBlock(page).evaluate(element => element.getBoundingClientRect().height);
  const richRowHeight = await firstBlock(page).locator('..').evaluate(element => element.getBoundingClientRect().height);
  await switchMode(page, 'preview');
  const previewHeight = await firstBlock(page).evaluate(element => element.getBoundingClientRect().height);
  const previewRowHeight = await firstBlock(page).locator('..').evaluate(element => element.getBoundingClientRect().height);
  expect(Math.abs(richHeight - previewHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(richRowHeight - previewRowHeight)).toBeLessThanOrEqual(1);
});

test('source mode renders raw HTML and CSS while keeping scripts and unsafe CSS inert', async ({ page }) => {
  const markdown = '<div class="html-callout" style="color: rgb(180, 20, 24); padding: 6px">HTML <strong>内容</strong></div>\n\n<style>.html-callout { border: 2px solid rgb(180, 20, 24); }</style>\n\n<div class="unsafe-style" style="background-image: url(javascript:alert(1))">不应加载</div>\n\n<script>window.htmlInjected = true</script>';
  await switchMode(page, 'source');
  await firstBlock(page).fill(markdown);
  await saved(page);

  await switchMode(page, 'preview');
  const preview = firstBlock(page);
  const callout = preview.locator('.html-callout');
  await expect(callout).toHaveText('HTML 内容');
  await expect(callout).toHaveAttribute('style', /color/);
  await expect(callout).toHaveCSS('border-top-width', '2px');
  await expect(preview.locator('style')).toHaveCount(1);
  await expect(preview.locator('.unsafe-style')).not.toHaveAttribute('style', /url/);
  await expect(preview.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => window.htmlInjected)).toBeUndefined();
});

test('Markdown wikilinks keep stable targets and appear in live references', async ({ page }) => {
  await switchMode(page, 'source');
  await firstBlock(page).fill('源码中的普通双链：[[Gamma]]');
  await saved(page);
  await switchMode(page, 'preview');

  const link = firstBlock(page).locator('.wiki-link');
  await expect(link).toHaveText('Gamma');
  await expect(link).toHaveAttribute('data-target-id', 'gamma');
  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  await expect(page.locator('#reference-sidebar .linked-reference-entry').filter({ hasText: 'Gamma' })).toBeVisible();
});

test('source edits participate in persistent undo and redo history', async ({ page }) => {
  await switchMode(page, 'source');
  await firstBlock(page).fill('Markdown 第一版');
  await saved(page);
  await page.waitForTimeout(950);
  await firstBlock(page).fill('Markdown 第二版');
  await saved(page);

  await page.keyboard.press('Control+z');
  await expect(firstBlock(page)).toHaveText('Markdown 第一版');
  await page.keyboard.press('Control+y');
  await expect(firstBlock(page)).toHaveText('Markdown 第二版');
  await switchMode(page, 'preview');
  await expect(firstBlock(page)).toHaveText('Markdown 第二版');
});

test('legacy rich content converts to Markdown and rich mode can continue editing', async ({ page }) => {
  const rich = firstBlock(page);
  await rich.fill('兼容旧正文');
  await rich.selectText();
  await page.locator('#bold').click();
  await saved(page);

  await switchMode(page, 'source');
  await expect(firstBlock(page)).toHaveText('**兼容旧正文**');
  await switchMode(page, 'rich');
  await expect(firstBlock(page).locator('strong')).toHaveText('兼容旧正文');
  await expect(firstBlock(page)).toHaveAttribute('contenteditable', 'true');
});

test('ordinary wiki links round-trip through Markdown source without creating reference instances', async ({ page }) => {
  const owner = firstBlock(page);
  await switchMode(page, 'source');
  await owner.fill('保留位置 [[默认笔记本/Beta#^b1]]');
  await saved(page);
  await switchMode(page, 'rich');
  await expect(owner.locator('.wiki-link')).toHaveAttribute('data-target-id', 'beta');
  expect(await page.evaluate(() => window.mockHost.state('alpha').references.filter(reference => reference.id !== 'ref1'))).toHaveLength(0);
});
