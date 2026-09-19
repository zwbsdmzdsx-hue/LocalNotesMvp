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

test('an embedded reference exposes one six-dot menu instead of three', async ({ page }, info) => {
  await page.locator('#add-paragraph').click();
  const paragraphId = await page.locator('#blocks > [data-own-block][data-type="paragraph"]').last().getAttribute('data-id');
  const paragraph = page.locator(`#blocks [data-own-block][data-id="${paragraphId}"]`);
  const editable = paragraph.locator(':scope > .block-row > .block-text');
  await editable.fill('[[');
  await page.locator('.link-suggestion').filter({ hasText: 'Delta' }).click();
  await page.getByRole('button', { name: '嵌入实时引用 · 正文直显', exact: true }).click();
  await expect(editable.locator('.embedded-reference')).toBeVisible();
  await expect(editable.locator('.reference-row > .grip')).toHaveCount(0);
  await editable.locator('.embedded-reference').hover();
  const visibleGrips = await paragraph.locator('.grip').evaluateAll(nodes => nodes.filter(node => {
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }).length);
  expect(visibleGrips).toBe(1);
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

test('deleting a paragraph that owns an embedded reference removes the reference relation', async ({ page }) => {
  await page.locator('#add-paragraph').click();
  const paragraphId = await page.locator('#blocks > [data-own-block][data-type="paragraph"]').last().getAttribute('data-id');
  const paragraph = page.locator(`#blocks [data-own-block][data-id="${paragraphId}"]`);
  const editable = paragraph.locator(':scope > .block-row > .block-text');
  await editable.fill('删除这个段落 [[');
  await page.locator('.link-suggestion').filter({ hasText: 'Delta' }).click();
  await page.getByRole('button', { name: '嵌入实时引用 · 正文直显', exact: true }).click();
  const referenceId = await editable.locator('.reference-card').getAttribute('data-reference-id');
  await paragraph.locator(':scope > .block-row > .delete-block').click();
  await expect(page.locator('#status')).toContainText('已保存');
  await expect(page.locator(`#reference-sidebar [data-reference-id="${referenceId}"]`)).toHaveCount(0);
  const persisted = await page.evaluate(() => window.mockHost.state('alpha'));
  expect(persisted.blocks.some(block => block.id === paragraphId)).toBe(false);
  expect(persisted.references.some(reference => reference.id === referenceId)).toBe(false);
});

test('ordinary wikilinks are listed in live references and disappear with their source link', async ({ page }) => {
  const paragraph = page.locator('[data-id="a1"] > .block-row > .block-text');
  await paragraph.fill('来自当前段落 [[');
  await page.locator('.link-suggestion').filter({ hasText: 'Gamma' }).click();
  await page.getByRole('button', { name: '保持普通双链', exact: true }).click();
  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  const entry = page.locator('#reference-sidebar .linked-reference-entry').filter({ hasText: 'Gamma' });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('来自当前段落');
  await entry.locator('.reference-title').click();
  await expect(page.locator('#reference-sidebar')).toContainText('Gamma 日记');
  await page.getByRole('button', { name: '关闭分栏' }).click();

  await paragraph.fill('链接已删除');
  await expect(page.locator('#status')).toContainText('已保存');
  await expect(page.locator('#reference-sidebar .linked-reference-entry').filter({ hasText: 'Gamma' })).toHaveCount(0);
});
