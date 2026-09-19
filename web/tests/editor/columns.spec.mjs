import { test, expect } from '@playwright/test';

const firstBlock = page => page.locator('#blocks [data-id="a1"] > .block-row > .block-text');
const saved = page => expect(page.locator('#status')).toContainText('已保存', { timeout: 3000 });

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  await expect(page.locator('#title')).toHaveValue('Alpha');
});

test('creates a two-column block layout with independent child blocks', async ({ page }) => {
  await page.locator('#add-columns').click();
  const layout = page.locator('.columns-layout');
  await expect(layout).toHaveCount(1);
  await expect(layout.locator(':scope > .column-slot')).toHaveCount(2);
  await expect(layout.locator(':scope > .column-slot [data-own-block]')).toHaveCount(2);
  await layout.locator(':scope > .column-slot').nth(0).locator('.block-text').fill('左列内容');
  await saved(page);
  const columns = await page.evaluate(() => window.mockHost.state('alpha').blocks.filter(block => block.properties.column !== undefined));
  expect(columns).toHaveLength(2);
  expect(columns.map(block => block.properties.column).sort()).toEqual([0, 1]);
  expect(columns.every(block => block.parentId && block.properties.column !== undefined)).toBe(true);
});

test('column grip reorders columns and restore keeps child blocks', async ({ page }) => {
  await page.locator('#add-columns').click();
  const layout = page.locator('.columns-layout');
  const slots = layout.locator(':scope > .column-slot');
  await slots.nth(0).locator('.block-text').fill('左列');
  await slots.nth(1).locator('.block-text').fill('右列');
  await saved(page);

  await slots.nth(0).locator('.column-grip').dragTo(slots.nth(1));
  await saved(page);
  await expect(layout.locator(':scope > .column-slot').nth(0).locator('.block-text')).toHaveText('右列');
  await expect(layout.locator(':scope > .column-slot').nth(1).locator('.block-text')).toHaveText('左列');

  await page.locator('[data-own-block]:has(.columns-layout) > .block-row .delete-block').click();
  await saved(page);
  await expect(page.locator('.columns-layout')).toHaveCount(0);
  const restored = await page.evaluate(() => window.mockHost.state('alpha').blocks.filter(block => block.content.text === '左列' || block.content.text === '右列'));
  expect(restored).toHaveLength(2);
  expect(restored.every(block => block.parentId === null && block.properties.column === undefined)).toBe(true);
});

test('adding a child from a column slot preserves its column parent', async ({ page }) => {
  await page.locator('#add-columns').click();
  const layout = page.locator('.columns-layout');
  await layout.locator(':scope > .column-slot').nth(1).locator('.column-add-child').click();
  await saved(page);
  await expect(layout.locator(':scope > .column-slot').nth(1).locator('[data-own-block]')).toHaveCount(2);
  const child = await page.evaluate(() => window.mockHost.state('alpha').blocks.find(block => block.properties.column === 1 && block.content.text === ''));
  expect(child.parentId).not.toBeNull();
  expect(child.properties.column).toBe(1);
});

test('dragging an existing block into a column makes it a column child', async ({ page }) => {
  await page.locator('#add-columns').click();
  const layout = page.locator('.columns-layout');
  const targetSlot = layout.locator(':scope > .column-slot').nth(1);
  await page.locator('[data-own-block][data-id="a1"] .grip').dragTo(targetSlot, { targetPosition: { x: 12, y: 12 } });
  await saved(page);
  await expect(targetSlot.locator('[data-own-block][data-id="a1"]')).toHaveCount(1);
  const moved = await page.evaluate(() => window.mockHost.state('alpha').blocks.find(block => block.id === 'a1'));
  expect(moved.parentId).not.toBeNull();
  expect(moved.properties.column).toBe(1);
});

test('column layout creation is restored by undo and redo', async ({ page }) => {
  await page.locator('#add-columns').click();
  await saved(page);
  await expect(page.locator('.columns-layout')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.columns-layout')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(page.locator('.columns-layout')).toHaveCount(1);
});

test('ordinary blocks stay at the root when reordered through the middle', async ({ page }) => {
  await page.locator('#add-paragraph').click();
  const added = page.locator('[data-own-block][data-type="paragraph"]').last();
  await added.locator('.block-text').fill('第二个块');
  await saved(page);

  const first = page.locator('[data-own-block][data-type="paragraph"]').first();
  const firstBox = await first.locator('.block-text').boundingBox();
  await added.locator('.grip').dragTo(first.locator('.block-text'), {
    targetPosition: { x: Math.max(1, Math.floor((firstBox?.width ?? 100) / 2)), y: Math.max(1, Math.floor((firstBox?.height ?? 30) / 2)) }
  });
  await saved(page);

  const blocks = await page.evaluate(() => window.mockHost.state('alpha').blocks.filter(block => block.content.text === '第二个块'));
  expect(blocks).toHaveLength(1);
  expect(blocks[0].parentId).toBeNull();
});

test('alignment menu applies and persists alignment for the selected block', async ({ page }) => {
  const text = page.locator('[data-own-block][data-id="a1"] .block-text');
  await text.selectText();
  await page.locator('#align').click();
  await page.locator('#align-menu [data-align="center"]').click();
  await saved(page);

  await expect(text).toHaveCSS('text-align', 'center');
  const block = await page.evaluate(() => window.mockHost.state('alpha').blocks.find(item => item.id === 'a1'));
  expect(block.properties.textAlign).toBe('center');
});

test('document descendant count decreases when a child is moved back to the root', async ({ page }) => {
  await page.evaluate(() => {
    const host = window.mockHost;
    host.createDocument('父文档', 'parent-doc', 'bk-inbox', null);
    host.createDocument('子文档', 'child-doc', 'bk-inbox', null);
    window.shell.refresh();
  });

  const parent = page.locator('.doc-item').filter({ hasText: '父文档' });
  const child = page.locator('.doc-item').filter({ hasText: '子文档' });
  await expect(parent.locator('.doc-count')).toHaveCount(0);

  await child.dragTo(parent, { targetPosition: { x: 80, y: 18 } });
  await expect(parent.locator('.doc-count')).toHaveText('1');

  await child.dragTo(parent, { targetPosition: { x: 80, y: 2 } });
  await expect(parent.locator('.doc-count')).toHaveCount(0);
});
