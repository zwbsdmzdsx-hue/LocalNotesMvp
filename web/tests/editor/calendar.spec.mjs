import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
});

test('calendar creates a month diary with an H1 day heading and previews it', async ({ page }) => {
  await page.locator('[data-pane-btn="calendar"]').click();
  const panel = page.locator('[data-slot="calendar"]');
  await expect(panel).toBeVisible();
  await panel.locator('.calendar-create').click();
  await expect(page.locator('.calendar-create-popup')).toBeVisible();
  await page.locator('.calendar-create-popup input').fill('当天记录');
  await page.locator('.calendar-create-popup .primary').click();
  await expect.poll(() => page.evaluate(() => [...window.mockHost.docs.values()].some(state => state.note.title.match(/^\d{4}-\d{1,2}月$/)))).toBe(true);
  await expect.poll(() => page.evaluate(() => [...window.mockHost.docs.values()].some(state => state.blocks.some(block => block.type === 'heading' && block.content.markdown?.startsWith('# '))))).toBe(true);
  await expect(panel.locator('.calendar-preview-block')).toHaveCount(1);
  await expect(panel.locator('.calendar-preview-block')).toContainText('当天记录');
});

test('calendar inserts a normal diary wiki link with a calendar icon at the saved caret', async ({ page }) => {
  await page.locator('[data-pane-btn="calendar"]').click();
  const panel = page.locator('[data-slot="calendar"]');
  await panel.locator('.calendar-create').click();
  await page.locator('.calendar-create-popup .primary').click();
  await expect.poll(() => page.evaluate(() => [...window.mockHost.docs.values()].some(state => state.note.title.match(/^\d{4}-\d{1,2}月$/)))).toBe(true);
  await page.locator('[data-doc="alpha"]').click();
  const body = page.locator('#blocks [data-id="a1"] .block-text');
  await body.click();
  await page.keyboard.press('End');
  await page.locator('[data-pane-btn="calendar"]').click();
  await panel.locator('.calendar-insert-link').click();
  await expect.poll(() => page.evaluate(() => window.mockHost.state('alpha').blocks.find(block => block.id === 'a1').content.markdown)).toContain('📅');
  await expect(body.locator('.calendar-link')).toContainText('📅');
});

test('calendar reloads the matching H1 section when switching between diary dates', async ({ page }) => {
  await page.locator('[data-pane-btn="calendar"]').click();
  const panel = page.locator('[data-slot="calendar"]');
  const selectedDate = await panel.locator('.calendar-day.selected').getAttribute('data-date');
  await panel.locator('.calendar-create').click();
  await page.locator('.calendar-create-popup input').fill('第一天记录');
  await page.locator('.calendar-create-popup .primary').click();
  await expect(panel.locator('.calendar-preview-block')).toContainText('第一天记录');
  const firstDay = Number(selectedDate.slice(-2));
  const secondDate = `${selectedDate.slice(0, 8)}${String(firstDay + 1).padStart(2, '0')}`;
  await panel.locator(`.calendar-day[data-date="${secondDate}"]`).click();
  await panel.locator('.calendar-create').click();
  await page.locator('.calendar-create-popup input').fill('第二天记录');
  await page.locator('.calendar-create-popup .primary').click();
  await expect(panel.locator('.calendar-preview-block')).toContainText('第二天记录');
  await panel.locator(`.calendar-day[data-date="${selectedDate}"]`).click();
  await expect(panel.locator('.calendar-preview-block')).toContainText(selectedDate);
  await expect(panel.locator('.calendar-preview-block')).not.toContainText('第二天记录');
});
