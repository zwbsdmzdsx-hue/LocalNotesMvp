import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const asset = name => readFileSync(new URL(`../dist/${name}`, import.meta.url), 'utf8');
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8')
  .replace('<link rel="stylesheet" href="style.css">', () => `<style>${asset('style.css')}</style>`)
  .replace('<script type="module" src="main.js"></script>', () => `<script>${asset('main.js')}</script>`);
const block = (id, text, parentId = null) => ({ id, parentId, position: id, type: 'paragraph', content: { text, html: text }, properties: {}, revision: 1 });
const fixture = () => ({
  note: { id: 'host', title: 'Host', clientVersion: 0 },
  blocks: [block('b1', 'First paragraph'), block('b2', 'Nested paragraph', 'b1')],
  documents: [{ id: 'host', title: 'Host' }, { id: 'alpha', title: 'Alpha', path: 'Workspace / Notes' }, { id: 'beta', title: 'Beta', path: 'Workspace / Notes' }],
  backlinks: [], overrideNotices: [], references: [],
});
let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('captureMessage', message => JSON.parse(message));
  await page.setContent(html);
  await page.evaluate(next => {
    window.testMessages = [];
    window.chrome = { webview: { postMessage(raw) {
      const message = JSON.parse(raw); window.testMessages.push(message);
      if (message.type === 'save-transaction') window.dispatchEvent(new MessageEvent('message', { data: { ...message, type: 'save-ack' } }));
    } } };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'load-state', state: next } }));
  }, fixture());
});
test.afterEach(() => expect(errors).toEqual([]));

test('deleting a parent preserves its child with a valid parent ID', async ({ page }) => {
  await page.locator('[data-id="b1"] .delete-block').click();
  await expect(page.locator('[data-id="b2"] .block-text')).toHaveText('Nested paragraph');
  const saved = await page.evaluate(() => window.testMessages.filter(m => m.type === 'save-transaction').at(-1));
  expect(saved.blocks).toHaveLength(1);
  expect(saved.blocks[0]).toMatchObject({ id: 'b2', parentId: null });
});

test('typing opens candidates and Enter inserts exactly one stable link', async ({ page }) => {
  const edit = page.locator('.block-text').first();
  await edit.click(); await page.keyboard.press('End'); await page.keyboard.type(' [[');
  await expect(page.locator('#link-suggestions')).toBeVisible();
  await expect(page.locator('.link-suggestion.active')).toContainText('Alpha');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.link-suggestion.active')).toContainText('Beta');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-own-block]')).toHaveCount(2);
  await expect(edit.locator('[data-target-id="beta"]')).toHaveCount(1);
  await expect(page.locator('#link-suggestions')).toBeHidden();
});
test('nested-block suggestions are positioned next to the editable', async ({ page }) => {
  const edit = page.locator('.block-text').nth(1);
  await edit.click(); await page.keyboard.press('End'); await page.keyboard.type('[[');
  const editRect = await edit.boundingBox(); const popup = await page.locator('#link-suggestions').boundingBox();
  expect(popup.y).toBeGreaterThanOrEqual(editRect.y + editRect.height);
  expect(popup.y).toBeLessThan(editRect.y + editRect.height + 20);
});
test('empty results show a message and Escape dismisses it', async ({ page }) => {
  const edit = page.locator('.block-text').first();
  await edit.click(); await page.keyboard.press('End'); await page.keyboard.type('[[no-such-target');
  await expect(page.locator('#link-suggestions')).toBeVisible();
  await expect(page.locator('.link-suggestion-empty')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#link-suggestions')).toBeHidden();
});
test('six-dot menu opens after repeated document renders and creates reference', async ({ page }) => {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'load-state', state: next } })), fixture());
    await page.locator('.grip').first().click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menu').getByText('复制块链接')).toBeVisible();
    await page.locator('#title').click(); await expect(page.getByRole('menu')).toHaveCount(0);
  }
  await page.locator('.grip').first().click(); await page.getByRole('menu').getByText('嵌入为实时引用').click();
  const message = await page.evaluate(() => window.testMessages.find(m => m.type === 'create-reference'));
  expect(message).toMatchObject({ sourceDocumentId: 'host', targetDocumentId: 'host', targetBlockId: 'b1' });
});
test('mouse-selected link survives a render and opens by ID', async ({ page }) => {
  const edit = page.locator('.block-text').first();
  await edit.click(); await page.keyboard.press('End'); await page.keyboard.type(' [[');
  await page.locator('.link-suggestion').filter({ hasText: 'Alpha' }).click();
  const saved = await page.evaluate(() => window.testMessages.filter(m => m.type === 'save-transaction').at(-1));
  expect(saved.blocks[0].content.links?.[0]?.targetDocumentId).toBe('alpha');
  const next = fixture(); next.blocks = saved.blocks; next.documents[1].title = 'Renamed Alpha';
  await page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'load-state', state: next } })), next);
  await edit.locator('[data-target-id="alpha"]').click();
  expect(await page.evaluate(() => window.testMessages.findLast(m => m.type === 'open-document'))).toMatchObject({ type: 'open-document', documentId: 'alpha' });
});

test('Alt+left and Alt+right are forwarded to the desktop navigation host', async ({ page }) => {
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Alt+ArrowRight');
  const messages = await page.evaluate(() => window.testMessages.filter(m => m.type.startsWith('navigate-')));
  expect(messages.map(message => message.type)).toEqual(['navigate-back', 'navigate-forward']);
});
