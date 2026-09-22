import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
});

test('Enter splits source content at the caret and moves the suffix to the new block', async ({ page }) => {
  await page.locator('[data-editor-mode="source"]').click();
  const first = page.locator('[data-own-block][data-id="a1"] .block-text');
  await first.fill('abcdef');
  await first.evaluate(element => {
    const range = document.createRange();
    const text = element.firstChild;
    range.setStart(text, 3); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await first.press('Enter');
  await expect(first).toHaveText('abc');
  await expect(page.locator('#blocks > [data-own-block][data-type="paragraph"]').nth(1).locator('.block-text')).toHaveText('def');
});

test('Enter in rich content carries an inline CSS class to both split fragments', async ({ page }) => {
  const first = page.locator('[data-own-block][data-id="a1"] .block-text');
  await first.evaluate(element => {
    element.innerHTML = '<span class="callout">abcdef</span>';
    const range = document.createRange();
    const text = element.querySelector('span').firstChild;
    range.setStart(text, 3); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  await first.press('Enter');
  const blocks = page.locator('#blocks > [data-own-block][data-type="paragraph"] .block-text');
  await expect(blocks.nth(0).locator('.callout')).toHaveText('abc');
  await expect(blocks.nth(1).locator('.callout')).toHaveText('def');
});
