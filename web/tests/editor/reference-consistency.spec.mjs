import { test, expect } from '@playwright/test';

const ownOrder = page => page.locator('#blocks [data-own-block]').evaluateAll(nodes => nodes.map(node => node.dataset.id));

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  await expect(page.locator('#title')).toHaveValue('Alpha');
});

test('undo and redo restore the exact block order without transient reordering', async ({ page }) => {
  const initial = await ownOrder(page);
  await page.locator('#add-heading').click();
  await expect(page.locator('#status')).toContainText('已保存');
  const heading = page.locator('#blocks [data-type="heading"]');
  const headingId = await heading.getAttribute('data-id');
  await heading.locator('.block-text').click();
  await page.locator('#move-up').click();
  await expect(page.locator('#status')).toContainText('已保存');
  const moved = await ownOrder(page);
  expect(moved).not.toEqual(initial);

  const samples = await page.evaluate(async () => {
    const read = () => [...document.querySelectorAll('#blocks [data-own-block]')].map(node => node.dataset.id).join(',');
    const values = [];
    document.querySelector('#undo').click();
    for (let i = 0; i < 20; i++) { values.push(read()); await new Promise(requestAnimationFrame); }
    return values;
  });
  const undone = await ownOrder(page);
  expect(undone).toEqual([...initial, headingId]);
  const allowed = new Set([moved.join(','), undone.join(',')]);
  expect(samples.every(value => allowed.has(value))).toBe(true);
  const transitions = samples.slice(1).filter((value, index) => value !== samples[index]);
  expect(transitions.length).toBeLessThanOrEqual(1);

  await page.locator('#redo').click();
  await expect.poll(() => ownOrder(page)).toEqual(moved);
});

test('a [[ link remains an ordinary block link with one owning six-dot menu', async ({ page }, info) => {
  await page.locator('#add-paragraph').click();
  const paragraphId = await page.locator('#blocks > [data-own-block][data-type="paragraph"]').last().getAttribute('data-id');
  const paragraph = page.locator(`#blocks [data-own-block][data-id="${paragraphId}"]`);
  const editable = paragraph.locator(':scope > .block-row > .block-text');
  await page.locator('[data-editor-mode="source"]').click();
  await editable.fill('[[默认笔记本/Delta#^d1]]');
  await page.locator('[data-editor-mode="rich"]').click();
  await expect(editable.locator('.wiki-link')).toBeVisible();
  await expect(editable.locator('.embedded-reference')).toHaveCount(0);
  await paragraph.locator('.grip').click();
  await expect(page.getByRole('menu')).toContainText('复制块链接');
  await page.screenshot({ path: info.outputPath('single-reference-menu.png'), fullPage: true });
});

test('deleting a reference host block removes its live-reference entry and undo restores both', async ({ page }) => {
  await expect(page.locator('#reference-sidebar .reference-card[data-reference-id="ref1"]')).toHaveCount(1);
  const orderBefore = await ownOrder(page);
  await page.locator('[data-id="ar1"] .reference-heading .grip').click();
  await page.getByRole('menu').getByText('删除引用', { exact: true }).click();
  await expect(page.locator('#status')).toContainText('已保存');
  await expect(page.locator('#reference-sidebar .reference-card[data-reference-id="ref1"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.mockHost.state('alpha').references.some(reference => reference.id === 'ref1'))).toBe(false);

  await page.locator('#undo').click();
  await expect(page.locator('#reference-sidebar .reference-card[data-reference-id="ref1"]')).toHaveCount(1);
  await expect.poll(() => ownOrder(page)).toEqual(orderBefore);
});

test('deleting a paragraph containing a wiki link removes that block only', async ({ page }) => {
  await page.locator('#add-paragraph').click();
  const paragraphId = await page.locator('#blocks > [data-own-block][data-type="paragraph"]').last().getAttribute('data-id');
  const paragraph = page.locator(`#blocks [data-own-block][data-id="${paragraphId}"]`);
  const editable = paragraph.locator(':scope > .block-row > .block-text');
  await page.locator('[data-editor-mode="source"]').click();
  await editable.fill('删除这个段落 [[默认笔记本/Delta#^d1]]');
  await page.locator('[data-editor-mode="rich"]').click();
  await paragraph.locator(':scope > .block-row > .delete-block').click();
  await expect(page.locator('#status')).toContainText('已保存');
  const persisted = await page.evaluate(() => window.mockHost.state('alpha'));
  expect(persisted.blocks.some(block => block.id === paragraphId)).toBe(false);
});

test('ordinary wikilinks are listed in live references and disappear with their source link', async ({ page }) => {
  const paragraph = page.locator('[data-id="a1"] > .block-row > .block-text');
  await page.locator('[data-editor-mode="source"]').click();
  await paragraph.fill('来自当前段落 [[默认笔记本/Gamma#^g1]]');
  await page.locator('[data-editor-mode="rich"]').click();
  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  const entry = page.locator('#reference-sidebar .linked-reference-entry').filter({ hasText: 'Gamma' });
  await expect(entry).toBeVisible();
  await expect(entry).toHaveClass(/reference-card/);
  await expect(entry.locator('.reference-card-summary')).toBeVisible();
  await expect(entry).toContainText('来自当前段落');
  await expect(page.locator('#reference-sidebar .reference-document-group[data-document-id="gamma"]')).toHaveCount(1);
  await entry.locator('.reference-title').click();
  await expect(page.locator('#reference-sidebar')).toContainText('Gamma 日记');
  const previewMode = page.locator('#reference-sidebar .link-display-mode');
  await expect(previewMode).toBeVisible();
  await expect(previewMode).toHaveText('显示方式');
  await previewMode.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menu').getByText('正文直显', { exact: true })).toBeVisible();
  await page.getByRole('menu').getByText('仅标题链接', { exact: true }).click();

  await paragraph.fill('链接已删除');
  await expect(page.locator('#status')).toContainText('已保存');
  await expect(page.locator('#reference-sidebar .linked-reference-entry').filter({ hasText: 'Gamma' })).toHaveCount(0);
});

test('a [[ link can choose a display mode and remains grouped by its target document', async ({ page }) => {
  const paragraph = page.locator('[data-id="a1"] > .block-row > .block-text');
  await page.locator('[data-editor-mode="source"]').click();
  await paragraph.fill('引用 Gamma [[默认笔记本/Gamma#^g1]]');
  await page.locator('[data-editor-mode="rich"]').click();
  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  const entry = page.locator('#reference-sidebar .linked-reference-entry').filter({ hasText: 'Gamma' });
  await expect(entry).toBeVisible();
  await entry.locator('.reference-mode-menu').click();
  await page.getByRole('menu').getByText('右侧分栏', { exact: true }).click();
  await expect(page.locator('#status')).toContainText('已保存');
  await expect(page.locator('#reference-sidebar .reference-document-group[data-document-id="gamma"] .reference-card[data-reference-id]')).toHaveCount(1);
  await expect(page.locator('#reference-sidebar .reference-document-group[data-document-id="gamma"] .reference-mode-menu')).toBeVisible();
  const card = page.locator('#reference-sidebar .reference-document-group[data-document-id="gamma"] .reference-card[data-reference-id]');
  await expect(card.locator(':scope > .reference-card-summary .reference-title')).toHaveCount(0);
  await card.locator('.reference-mode-menu').click();
  await page.getByRole('menu').getByText('仅标题链接', { exact: true }).click();
  await expect(page.locator('#reference-sidebar .reference-document-group[data-document-id="gamma"] .linked-reference-entry')).toHaveCount(1);
});

test('selecting quoted content opens the display mode menu', async ({ page }) => {
  const quoted = page.locator('[data-own-block][data-type="reference"] .reference-card:not(.sidebar) .reference-row .block-text').first();
  await expect(quoted).toBeVisible();
  await quoted.evaluate(element => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menu').getByText('右侧分栏', { exact: true })).toBeVisible();
});
