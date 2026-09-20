import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
});

test('wiki suggestions narrow from notebook to document to block', async ({ page }) => {
  const editable = page.locator('[data-id="a1"] .block-text').first();
  await editable.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' [[研');
  await expect(page.locator('.link-suggestion[data-kind="notebook"]')).toHaveCount(1);
  await expect(page.locator('.link-suggestion[data-kind="notebook"]')).toContainText('研究');
  await expect(page.locator('.link-suggestion[data-kind="notebook"]')).not.toContainText('Beta');

  await page.locator('.link-suggestion[data-kind="notebook"]').filter({ hasText: '研究' }).click();
  await expect(page.locator('.link-suggestion[data-kind="document"]').filter({ hasText: 'Zeta' })).toBeVisible();
  await expect(page.locator('.link-suggestion[data-kind="document"] strong').filter({ hasText: /^Eta$/ })).toBeVisible();
  await expect(page.locator('.link-suggestion[data-kind="document"]').filter({ hasText: 'Beta' })).toHaveCount(0);

  await page.locator('.link-suggestion[data-kind="document"]').filter({ hasText: 'Zeta' }).click();
  await expect(page.locator('.link-suggestion[data-kind="target"]').filter({ hasText: 'Zeta 参考资料' })).toBeVisible();
  await expect(page.locator('.link-suggestion[data-kind="target"]').filter({ hasText: '目标标题 可搜索正文' })).toBeVisible();
  await expect(page.locator('.link-suggestion[data-kind="target"]').filter({ hasText: '.secret' })).toHaveCount(0);
  await expect(page.locator('.link-suggestion[data-kind="target"]').filter({ hasText: 'color: red' })).toHaveCount(0);

  await page.locator('.link-suggestion[data-kind="target"]').filter({ hasText: '目标标题' }).click();
  await expect(editable.locator('.wiki-link')).toHaveAttribute('data-target-id', 'zeta');
  await expect(editable.locator('.wiki-link')).toHaveAttribute('data-target-block-id', 'z2');
});
