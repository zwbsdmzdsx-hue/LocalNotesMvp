import { test, expect } from '@playwright/test';

test('dragging across rich text blocks keeps a multi-block style selection', async ({ page }) => {
  await page.goto('/');
  await page.locator('#add-paragraph').click();
  const blocks = page.locator('#blocks > [data-own-block][data-type="paragraph"]');
  const second = blocks.last();
  await second.locator('.block-text').fill('第二个块');
  await expect(second.locator('.block-text')).toHaveText('第二个块');

  await page.locator('[data-pane-btn="styles"]').click();
  await page.locator('.style-add').click();
  const card = page.locator('.style-card').last();
  await card.locator('textarea').fill('.callout { color: rgb(200, 30, 30); }');
  await card.getByRole('button', { name: '保存' }).click();

  const points = await page.evaluate(() => [document.querySelector('[data-own-block][data-id="a1"] .block-text'), [...document.querySelectorAll('#blocks > [data-own-block][data-type="paragraph"] .block-text')].at(-1)].map(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  }));
  await page.mouse.move(points[0].left + 4, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].right - 2, points[1].y, { steps: 12 });
  await page.mouse.up();

  await expect(page.locator('[data-own-block].block-selected')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => CSS.highlights?.has('cross-block-selection'))).toBe(true);
  const copied = await page.evaluate(() => new Promise(resolve => {
    document.addEventListener('copy', event => resolve(event.clipboardData?.getData('text/plain')), { once: true });
    document.execCommand('copy');
  }));
  expect(copied).toContain('浏览器编辑器核心');
  expect(copied).toContain('第二个块');

  await page.locator('.style-apply').click();
  await expect(page.locator('[data-own-block][data-id="a1"] .block-text.rich-editor .callout')).toHaveCount(1);
  await expect(page.locator('#blocks > [data-own-block][data-type="paragraph"]:last-child .callout')).toHaveCount(1);
  await expect(page.locator('[data-own-block][data-id="a1"] .callout')).toContainText('核心');
  await expect(page.locator('#blocks > [data-own-block][data-type="paragraph"]:last-child .callout')).toContainText('第二个块');
});

test('reverse dragging across blocks keeps the selected text copyable', async ({ page }) => {
  await page.goto('/');
  await page.locator('#add-paragraph').click();
  const second = page.locator('#blocks > [data-own-block][data-type="paragraph"]').last().locator('.block-text');
  await second.fill('反向选择终点');
  const points = await page.evaluate(() => [document.querySelector('[data-own-block][data-id="a1"] .block-text'), [...document.querySelectorAll('#blocks > [data-own-block][data-type="paragraph"] .block-text')].at(-1)].map(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  }));
  await page.mouse.move(points[1].right - 2, points[1].y);
  await page.mouse.down();
  await page.mouse.move(points[0].left + 4, points[0].y, { steps: 12 });
  await page.mouse.up();
  const copied = await page.evaluate(() => new Promise(resolve => {
    document.addEventListener('copy', event => resolve(event.clipboardData?.getData('text/plain')), { once: true });
    document.execCommand('copy');
  }));
  expect(copied).toContain('浏览器编辑器核心');
  expect(copied).toContain('反向选择终点');
});

test('dragging one selected block moves the whole selection in order', async ({ page }) => {
  await page.goto('/');
  await page.locator('.browser-devbar [data-doc="beta"]').click();
  await expect(page.locator('#title')).toHaveValue('Beta');
  await page.locator('#add-paragraph').click();
  const paragraphs = page.locator('#blocks > [data-own-block][data-type="paragraph"]');
  await paragraphs.nth(2).locator('.block-text').fill('第三个块');

  const points = await page.evaluate(() => [...document.querySelectorAll('#blocks > [data-own-block][data-type="paragraph"] .block-text')]
    .slice(0, 2)
    .map(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    }));
  await page.mouse.move(points[0].left + 3, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].right - 3, points[1].y, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('[data-own-block].block-selected')).toHaveCount(2);

  const target = paragraphs.nth(2).locator('.block-text');
  const box = await target.boundingBox();
  if (!box) throw new Error('drop target is not visible');
  await paragraphs.nth(0).locator('.grip').dragTo(target, {
    targetPosition: { x: Math.floor(box.width / 2), y: Math.max(2, Math.floor(box.height - 2)) }
  });

  await expect.poll(() => page.evaluate(() => window.mockHost.state('beta').blocks.map(block => block.content.text))).toEqual([
    '第三个块',
    'Beta 的内容',
    'Beta 文档中的其他块'
  ]);
});

test('dragging multiple selected blocks shows every block in the drag preview', async ({ page }) => {
  await page.goto('/');
  await page.locator('#add-paragraph').click();
  const blocks = page.locator('#blocks > [data-own-block][data-type="paragraph"]');
  const first = blocks.nth(0);
  const second = blocks.nth(1);
  const firstText = await first.locator('.block-text').innerText();
  const secondText = await second.locator('.block-text').innerText();
  const firstBox = await first.locator('.block-text').boundingBox();
  const secondBox = await second.locator('.block-text').boundingBox();
  if (!firstBox || !secondBox) throw new Error('selection blocks are not visible');
  await page.mouse.move(firstBox.x + 4, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + 4, secondBox.y + secondBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(first).toHaveClass(/block-selected/);
  await expect(second).toHaveClass(/block-selected/);

  const result = await first.locator('.grip').evaluate((grip, values) => {
    const dataTransfer = new DataTransfer();
    grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    const ghost = document.querySelector('.drag-ghost-multi');
    return {
      count: ghost?.querySelectorAll('.drag-ghost-item').length ?? 0,
      text: ghost?.textContent ?? '',
      expected: values
    };
  }, [firstText, secondText]);
  expect(result.count).toBeGreaterThanOrEqual(2);
  expect(result.text).toContain(firstText.trim());
  expect(result.text).toContain(secondText.trim());
  await first.locator('.grip').dispatchEvent('dragend', { bubbles: true });
});
