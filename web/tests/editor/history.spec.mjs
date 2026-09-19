import { test, expect } from '@playwright/test';
const body = page => page.locator('#blocks [data-id="a1"] > .block-row > .block-text');
const saved = page => expect(page.locator('#status')).toContainText('已保存');
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/'); await expect(page.locator('#title')).toHaveValue('Alpha');
});

test('typing is grouped; undo, redo, title and new branch remain independent', async ({ page }) => {
  const edit = body(page); const initial = await edit.textContent();
  await edit.click(); await page.keyboard.press('End'); await page.keyboard.type(' grouped typing'); await saved(page);
  await page.keyboard.press('Control+z'); await expect(edit).toHaveText(initial);
  await page.keyboard.press('Control+y'); await expect(edit).toHaveText(initial + ' grouped typing');
  await page.locator('#title').fill('Renamed'); await saved(page);
  await page.keyboard.press('Control+z'); await expect(page.locator('#title')).toHaveValue('Alpha');
  await page.keyboard.press('Control+Shift+z'); await expect(page.locator('#title')).toHaveValue('Renamed');
  await page.keyboard.press('Control+z'); await expect(page.locator('#title')).toHaveValue('Alpha');
  await page.locator('#title').fill('New branch'); await saved(page);
  await expect(page.locator('#redo')).toBeDisabled();
  await page.keyboard.press('Control+z'); await expect(page.locator('#title')).toHaveValue('Alpha');
  await page.keyboard.press('Control+z'); await expect(edit).toHaveText(initial);
});

test('preview is read-only; restoring creates an undoable version and keeps abandoned history', async ({ page }, info) => {
  await body(page).fill('First version'); await saved(page);
  await body(page).fill('Second version'); await saved(page);
  await page.keyboard.press('Control+z'); await expect(body(page)).toHaveText('First version');
  await body(page).fill('Third version'); await saved(page);
  await page.locator('#history').click();
  const panel = page.locator('[data-slot=history]');
  await panel.locator('.history-entry').nth(1).click();
  await expect(panel.locator('pre')).toHaveText('Second version\n');
  await expect(body(page)).toHaveText('Third version');
  await panel.getByRole('button', { name: '恢复此版本' }).click();
  await expect(body(page)).toHaveText('Second version');
  await page.locator('#undo').click(); await expect(body(page)).toHaveText('Third version');
  await page.screenshot({ path: info.outputPath('history-panel.png'), fullPage: true });
});

test('failed restore leaves draft, cursor and retry intact; document switches isolate history', async ({ page }) => {
  await body(page).fill('Saved version'); await saved(page);
  await page.locator('#dev-fail').click();
  await page.locator('#undo').click(); await expect(page.locator('#status')).toContainText('失败');
  await expect(body(page)).toHaveText('Saved version'); await expect(page.locator('#undo')).toBeEnabled();
  await page.locator('#undo').click(); await expect(body(page)).toHaveText('浏览器编辑器核心');
  await page.locator('[data-doc="beta"]').click(); await expect(page.locator('#title')).toHaveValue('Beta');
  await expect(page.locator('#undo')).toBeDisabled();
  await page.locator('[data-doc="alpha"]').click(); await expect(page.locator('#title')).toHaveValue('Alpha');
  await page.locator('#redo').click(); await expect(body(page)).toHaveText('Saved version');
});

test('queued shortcuts wait for saves and preserve reference source updates', async ({ page }) => {
  await body(page).fill('One'); await saved(page);
  await body(page).fill('Two'); await saved(page);
  await page.evaluate(() => { const host = window.mockHost; const send = host.send.bind(host); host.send = m => setTimeout(() => send(m), 90); });
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await expect(body(page)).toHaveText('浏览器编辑器核心');
  await page.keyboard.press('Control+y'); await page.keyboard.press('Control+y');
  await expect(body(page)).toHaveText('Two');
  const reference = page.locator('#blocks [data-id="ar1"] .reference-row .block-text');
  await reference.fill('Local override'); await saved(page);
  await page.evaluate(() => window.mockHost.updateSourceBlock('beta', 'b1', 'New source'));
  await page.keyboard.press('Control+z'); await expect(reference).toHaveText('New source');
  expect(await page.evaluate(() => window.mockHost.docs.get('beta').blocks[0].content.text)).toBe('New source');
  await page.keyboard.press('Control+y'); await expect(reference).toHaveText('Local override');
});

test('structural deletion and addition restore stable block IDs', async ({ page }) => {
  await page.locator('#add-heading').click(); await saved(page);
  const heading = page.locator('#blocks [data-type="heading"]'); const id = await heading.getAttribute('data-id');
  await page.locator('#undo').click(); await expect(heading).toHaveCount(0);
  await page.locator('#redo').click(); await expect(heading).toHaveAttribute('data-id', id);
  await heading.locator('.delete-block').click(); await saved(page);
  await page.locator('#undo').click(); await expect(heading).toHaveAttribute('data-id', id);
});
