import { test, expect } from '@playwright/test';

const saved = page => expect(page.locator('#status')).toContainText('已保存', { timeout: 3000 });

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  await expect(page.locator('#title')).toHaveValue('Alpha');
});

test('block comments support add, edit, delete, timeline, undo and redo', async ({ page }) => {
  const block = page.locator('[data-own-block][data-id="a1"]');
  await block.locator('.grip').click();
  await page.getByRole('menu').getByText('添加注释').click();

  const popover = page.locator('.block-comment-popover');
  await expect(popover).toBeVisible();
  await popover.locator('.comment-composer textarea').fill('第一条块注释');
  await popover.getByRole('button', { name: '添加注释' }).click();
  await saved(page);
  await expect(block.locator('.block-comment-bubble')).toHaveText(/1/);
  await expect(popover.locator('.comment-item')).toContainText('第一条块注释');

  await page.locator('[data-pane-btn="comments"]').click();
  const panel = page.locator('[data-slot="comments"]');
  await expect(page.locator('#comments-section')).toBeVisible();
  const card = panel.locator('.comment-block-card[data-block-id="a1"]');
  await expect(card).toContainText('第一条块注释');
  await card.locator('.comment-item').getByRole('button', { name: '编辑' }).click();
  await card.locator('.comment-inline-editor textarea').fill('修改后的块注释');
  await card.locator('.comment-inline-editor').getByRole('button', { name: '保存' }).click();
  await saved(page);
  await expect(card).toContainText('修改后的块注释');

  await card.locator('.comment-item').getByRole('button', { name: '删除' }).click();
  await saved(page);
  await expect(block.locator('.block-comment-bubble')).toHaveCount(0);
  await expect(card.locator('.comment-item')).toHaveCount(0);
  await card.locator('.comment-history').click();
  await expect(card.locator('.comment-history-entry')).toHaveCount(3);
  await expect(card.locator('.comment-history')).toContainText('新增');
  await expect(card.locator('.comment-history')).toContainText('编辑');
  await expect(card.locator('.comment-history')).toContainText('删除');

  await page.locator('#undo').click();
  await expect(block.locator('.block-comment-bubble')).toHaveText(/1/);
  await expect(panel.locator('.comment-block-card[data-block-id="a1"]')).toContainText('修改后的块注释');
  await page.locator('#redo').click();
  await expect(block.locator('.block-comment-bubble')).toHaveCount(0);
});

test('right sidebar can add a comment to the selected block and bubble opens it', async ({ page }, testInfo) => {
  const block = page.locator('[data-own-block][data-id="a1"]');
  await block.locator('.block-text').click();
  await page.locator('[data-pane-btn="comments"]').click();
  const current = page.locator('[data-slot="comments"] .comment-current-card');
  await current.locator('textarea').fill('从右栏添加');
  await current.getByRole('button', { name: '添加注释' }).click();
  await saved(page);
  const bubble = block.locator('.block-comment-bubble');
  await expect(bubble).toHaveText(/1/);
  await bubble.click();
  await expect(page.locator('.block-comment-popover')).toContainText('从右栏添加');
  await page.screenshot({ path: testInfo.outputPath('comments-panel-popover.png'), fullPage: true });
  await page.locator('[data-doc="beta"]').click();
  await expect(page.locator('#title')).toHaveValue('Beta');
  await page.locator('[data-doc="alpha"]').click();
  await expect(page.locator('#title')).toHaveValue('Alpha');
  await expect(page.locator('[data-own-block][data-id="a1"] .block-comment-bubble')).toHaveText(/1/);
});
