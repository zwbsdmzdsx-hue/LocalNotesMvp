import { test, expect } from '@playwright/test';

const saved = page => expect(page.locator('#status')).toContainText('已保存', { timeout: 3000 });

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  await expect(page.locator('#title')).toHaveValue('Alpha');
});

test('creates a shared column row from ordinary blocks', async ({ page }) => {
  await page.locator('#add-columns').click();
  await expect(page.locator('.columns-row')).toHaveCount(1);
  await expect(page.locator('.columns-layout, .column-slot, .column-slot-head')).toHaveCount(0);
  await expect(page.locator('.columns-grid > .column-track')).toHaveCount(2);
  await expect(page.locator('.columns-grid [data-own-block]')).toHaveCount(2);
  const columns = await page.evaluate(() => window.mockHost.state('alpha').blocks.filter(block => block.properties.columnGroup));
  expect(columns).toHaveLength(2);
  expect(new Set(columns.map(block => block.properties.columnGroup)).size).toBe(1);
  expect(columns.every(block => block.parentId === null)).toBe(true);
});

test('enter adds another ordinary block in the same column', async ({ page }) => {
  await page.locator('#add-columns').click();
  const first = page.locator('#blocks .column-track').first().locator('.block-text');
  await first.fill('第一行');
  await first.press('End');
  await first.press('Enter');
  await page.keyboard.type('第二行');
  await saved(page);
  await expect(page.locator('.columns-grid > .column-track').first().locator('[data-own-block]')).toHaveCount(2);
  const members = await page.evaluate(() => window.mockHost.state('alpha').blocks.filter(block => block.properties.columnGroup));
  expect(members.filter(block => block.properties.column === 0)).toHaveLength(2);
  expect(new Set(members.map(block => block.parentId)).size).toBe(1);
  expect(members[0].parentId).toBeNull();
});

test('dragging to a side creates a new column without duplicating blocks', async ({ page }) => {
  await page.locator('#add-paragraph').click();
  const added = page.locator('#blocks > [data-own-block][data-type="paragraph"]').last();
  await added.locator('.block-text').fill('第二个块');
  await saved(page);
  const target = page.locator('#blocks > [data-own-block][data-id="a1"]');
  const box = await target.locator('.block-text').boundingBox();
  await added.locator('.grip').dragTo(target.locator('.block-text'), {
    targetPosition: { x: Math.max(2, Math.floor((box?.width ?? 100) - 2)), y: Math.max(2, Math.floor((box?.height ?? 30) / 2)) }
  });
  await saved(page);
  await expect(page.locator('.columns-row')).toHaveCount(1);
  await expect(page.locator('.columns-grid > .column-track')).toHaveCount(2);
  await expect(page.locator('.columns-grid [data-own-block]')).toHaveCount(2);
  const members = await page.evaluate(() => window.mockHost.state('alpha').blocks.filter(block => block.properties.columnGroup));
  expect(members).toHaveLength(2);
  expect(new Set(members.map(block => block.id)).size).toBe(2);
  expect(members.every(block => block.parentId === null)).toBe(true);
});

test('dragging a column block above a normal block restores it to the root flow', async ({ page }) => {
  await page.locator('#add-columns').click();
  const columnBlock = page.locator('.column-track').first().locator('[data-own-block]').first();
  const target = page.locator('[data-own-block][data-id="a1"]');
  const box = await target.locator('.block-text').boundingBox();
  await columnBlock.locator('.grip').dragTo(target.locator('.block-text'), {
    targetPosition: { x: Math.floor((box?.width ?? 100) / 2), y: 2 }
  });
  await saved(page);
  const moved = await page.evaluate(() => window.mockHost.state('alpha').blocks.find(block => block.content.text === ''));
  expect(moved?.parentId).toBeNull();
  expect(moved?.properties.columnGroup).toBeUndefined();
});

test('restore button removes the shared column row and keeps blocks once', async ({ page }) => {
  await page.locator('#add-columns').click();
  await page.locator('.columns-restore').click();
  await saved(page);
  await expect(page.locator('.columns-row')).toHaveCount(0);
  const blocks = await page.evaluate(() => window.mockHost.state('alpha').blocks);
  expect(blocks.filter(block => block.content.text === '').length).toBe(3);
  expect(blocks.every(block => !block.properties.columnGroup && block.parentId === null)).toBe(true);
});

test('column widths are persisted by dragging the divider', async ({ page }) => {
  await page.locator('#add-columns').click();
  const divider = page.locator('.column-divider').first();
  const before = await page.evaluate(() => window.mockHost.state('alpha').blocks.find(block => block.properties.columnGroup)?.properties.columnWidths);
  const box = await divider.boundingBox();
  if (!box) throw new Error('divider is not visible');
  await divider.dispatchEvent('pointerdown', { clientX: box.x + box.width / 2, clientY: box.y + 10, pointerId: 1, bubbles: true });
  await page.mouse.move(box.x + 35, box.y + 10);
  await page.mouse.up();
  await saved(page);
  const after = await page.evaluate(() => window.mockHost.state('alpha').blocks.find(block => block.properties.columnGroup)?.properties.columnWidths);
  expect(after).not.toEqual(before);
});

test('hover highlights only the nearest column divider', async ({ page }) => {
  await page.locator('#add-columns').click();
  const dragged = page.locator('#blocks > [data-own-block][data-id="a1"]');
  const target = page.locator('.columns-grid > .column-track').nth(1).locator('[data-own-block]').first();
  const box = await target.locator('.block-text').boundingBox();
  if (!box) throw new Error('column target is not visible');
  await dragged.locator('.grip').dragTo(target.locator('.block-text'), {
    targetPosition: { x: Math.max(2, Math.floor(box.width - 2)), y: Math.max(2, Math.floor(box.height / 2)) }
  });
  await saved(page);
  const dividers = page.locator('.column-divider');
  await expect(dividers).toHaveCount(2);
  await dividers.nth(0).hover();
  await expect.poll(() => page.locator('.column-divider').evaluateAll(elements => elements.map(element => getComputedStyle(element, '::after').backgroundColor)))
    .toEqual(['rgb(132, 173, 255)', 'rgba(0, 0, 0, 0)']);
  await dividers.nth(1).hover();
  await expect.poll(() => page.locator('.column-divider').evaluateAll(elements => elements.map(element => getComputedStyle(element, '::after').backgroundColor)))
    .toEqual(['rgba(0, 0, 0, 0)', 'rgb(132, 173, 255)']);
});

test('column creation can be undone and redone without changing block order', async ({ page }) => {
  await page.locator('#add-columns').click();
  await saved(page);
  await expect(page.locator('.columns-row')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.columns-row')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(page.locator('.columns-row')).toHaveCount(1);
  const members = await page.evaluate(() => window.mockHost.state('alpha').blocks.filter(block => block.properties.columnGroup));
  expect(members).toHaveLength(2);
});

test('column layout survives source preview and rich mode switches', async ({ page }) => {
  await page.locator('#add-columns').click();
  const tracks = page.locator('.columns-grid > .column-track');
  await tracks.nth(0).locator('.block-text').fill('左列正文');
  await tracks.nth(1).locator('.block-text').fill('右列正文');
  await saved(page);
  const before = await page.evaluate(() => window.mockHost.state('alpha').blocks
    .filter(block => block.properties.columnGroup)
    .map(block => ({ id: block.id, group: block.properties.columnGroup, column: block.properties.column })));

  await page.locator('[data-editor-mode="source"]').click();
  await expect(page.locator('.columns-row')).toHaveCount(1);
  await expect(page.locator('.columns-row .markdown-source')).toHaveCount(2);
  await page.locator('[data-editor-mode="preview"]').click();
  await expect(page.locator('.columns-row')).toHaveCount(1);
  await expect(page.locator('.columns-row .markdown-preview')).toHaveCount(2);
  await page.locator('[data-editor-mode="rich"]').click();
  await expect(page.locator('.columns-row')).toHaveCount(1);
  await expect(page.locator('.columns-row .rich-editor')).toHaveCount(2);

  const after = await page.evaluate(() => window.mockHost.state('alpha').blocks
    .filter(block => block.properties.columnGroup)
    .map(block => ({ id: block.id, group: block.properties.columnGroup, column: block.properties.column })));
  expect(after).toEqual(before);
});

test('column drop zones are narrow and mark only the active side', async ({ page }) => {
  await page.locator('#add-paragraph').click();
  const dragged = page.locator('#blocks > [data-own-block][data-type="paragraph"]').last();
  const target = page.locator('[data-own-block][data-id="a1"]');
  const box = await target.locator('.block-text').boundingBox();
  if (!box) throw new Error('target block is not visible');
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await dragged.locator('.grip').dispatchEvent('dragstart', { dataTransfer });

  await target.dispatchEvent('dragover', { dataTransfer, clientX: box.x + Math.min(10, box.width * .05), clientY: box.y + box.height / 2 });
  await expect(target).toHaveClass(/drop-column-left/);
  await expect(target).not.toHaveClass(/drop-column-right/);
  await expect.poll(() => target.evaluate(el => ({
    before: getComputedStyle(el, '::before').content,
    after: getComputedStyle(el, '::after').content
  }))).toEqual({ before: '""', after: 'none' });

  await target.dispatchEvent('dragover', { dataTransfer, clientX: box.x + Math.min(48, box.width * .2), clientY: box.y + box.height / 2 });
  await expect(target).not.toHaveClass(/drop-column-side/);

  await target.dispatchEvent('dragover', { dataTransfer, clientX: box.x + box.width - Math.min(10, box.width * .05), clientY: box.y + box.height / 2 });
  await expect(target).toHaveClass(/drop-column-right/);
  await expect(target).not.toHaveClass(/drop-column-left/);
  await expect.poll(() => target.evaluate(el => ({
    before: getComputedStyle(el, '::before').content,
    after: getComputedStyle(el, '::after').content
  }))).toEqual({ before: 'none', after: '""' });
  await dragged.locator('.grip').dispatchEvent('dragend', { dataTransfer });
});
