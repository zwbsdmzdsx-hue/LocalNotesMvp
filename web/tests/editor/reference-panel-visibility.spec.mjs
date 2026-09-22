import { test, expect } from "@playwright/test";

const panel = page => page.locator('#reference-sidebar-section');
const bodyReference = page => page.locator('#blocks [data-id="ar1"]');

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  await expect(page.locator('#title')).toHaveValue('Alpha');
  await page.getByRole('button', { name: '实时引用', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  // Exercise real UI operations with delayed ACKs; observe what can actually paint,
  // not merely card counts in a hidden subtree.
  await page.evaluate(() => {
    const host = window.mockHost;
    const send = host.send.bind(host);
    host.send = message => setTimeout(() => send(message), 90);
    window.panelFailures = [];
    window.panelFrames = 0;
    window.watchReferencePanel = true;
    const sample = () => {
      if (!window.watchReferencePanel) return;
      window.panelFrames++;
      const section = document.querySelector('#reference-sidebar-section');
      const slot = document.querySelector('#reference-sidebar');
      const title = section?.querySelector('.panel-head');
      if (!section?.checkVisibility() || !title?.checkVisibility() || !slot?.checkVisibility() || !slot.textContent.trim()) {
        window.panelFailures.push({ hidden: section?.hidden, text: slot?.textContent, frame: window.panelFrames });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
});

test('live references share one document header per source document', async ({ page }) => {
  const groups = page.locator('#reference-sidebar .reference-document-group');
  await expect(groups).toHaveCount(1);
  await expect(groups.first().locator('.reference-document-head')).toContainText('Beta');
  await expect(groups.first().locator('.reference-card[data-reference-id="ref1"]')).toHaveCount(1);
});

async function assertPanel(page) {
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.panel-head')).toBeVisible();
  await expect(panel(page).locator('.panel-head')).toHaveText('实时引用');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.panelFailures)).toEqual([]);
  expect(await page.evaluate(() => window.panelFrames)).toBeGreaterThan(0);
}

test('body add/delete/hide/reset reference rows keeps selected panel visible throughout ACKs', async ({ page }, info) => {
  const ref = bodyReference(page);
  await ref.locator('.add-sibling').first().click();
  await expect(ref.locator('[data-scope-type="reference_instance"]')).toHaveCount(1);
  await expect(page.locator('#status')).toContainText('已保存');
  await assertPanel(page);
  await ref.locator('[data-scope-type="reference_instance"] .hide').click();
  await expect(ref.locator('[data-scope-type="reference_instance"]')).toHaveCount(0);
  await assertPanel(page);
  await ref.locator('.hide').first().click();
  await expect(ref.locator('.reference-row')).toHaveCount(0);
  await assertPanel(page);
  await ref.locator('.reference-heading .grip').click();
  await page.getByRole('menu').getByText('恢复全部继承内容', { exact: true }).click();
  await expect(ref.locator('.reference-row')).toHaveCount(1);
  await assertPanel(page);
  await page.screenshot({ path: info.outputPath('reference-panel-after-row-operations.png'), fullPage: true });
});

for (const action of ['删除引用', '断开引用（保留为正文）']) {
  test(`${action}: empty state and title remain visible after removal`, async ({ page }, info) => {
    await bodyReference(page).locator('.reference-heading .grip').click();
    await page.getByRole('menu').getByText(action, { exact: true }).click();
    await expect(page.locator('#reference-sidebar .reference-card')).toHaveCount(0);
    await expect(panel(page).locator('.empty')).toBeVisible();
    await assertPanel(page);
    await page.screenshot({ path: info.outputPath('reference-panel-empty.png'), fullPage: true });
    await page.reload();
    await page.getByRole('button', { name: '实时引用', exact: true }).click();
    await expect(page.locator('#reference-sidebar .reference-card')).toHaveCount(1);
  });
}

test('existing reference mode changes preserve the active panel and title', async ({ page }) => {
  await expect(page.locator('#reference-sidebar .reference-card')).toHaveCount(1);
  await assertPanel(page);
  for (const mode of ['右侧分栏', '正文直显', '折叠卡片', '仅标题链接']) {
    await bodyReference(page).locator('.reference-heading .grip').click();
    await page.getByRole('menu').getByText(mode, { exact: true }).click();
    await expect(page.locator('#status')).toContainText('已保存');
    await assertPanel(page);
  }
});

test('an open title-link preview survives unrelated reference ACKs and closes into the reference list', async ({ page }) => {
  const paragraph = page.locator('#blocks [data-id="a1"] > .block-row > .block-text');
  await page.locator('[data-editor-mode="source"]').click();
  await expect(page.locator('button[data-editor-mode="source"]')).toHaveAttribute('aria-pressed', 'true');
  await paragraph.fill('Before [[默认笔记本/Beta#^b2]]');
  await expect(page.locator('#status')).toContainText('正在保存');
  await expect(page.locator('#status')).toContainText('已保存');
  await page.locator('button[data-editor-mode="rich"]').click();
  await expect(page.locator('button[data-editor-mode="rich"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(paragraph.locator('.wiki-link')).toBeVisible();
  await paragraph.locator('.wiki-link').click();
  await expect(panel(page)).toContainText('Beta 文档中的其他块');
  await bodyReference(page).locator('.add-sibling').first().click();
  await expect(bodyReference(page).locator('[data-scope-type="reference_instance"]')).toHaveCount(1);
  await expect(panel(page)).toContainText('Beta 文档中的其他块');
  await expect(panel(page).getByRole('button', { name: '关闭分栏', exact: true })).toBeVisible();
  await assertPanel(page);
  await panel(page).getByRole('button', { name: '关闭分栏', exact: true }).click();
  await expect(page.locator('#reference-sidebar .reference-card')).toHaveCount(2);
  await assertPanel(page);
});

test('reference ACKs do not reopen the panel or steal the selected backlinks tab', async ({ page }) => {
  await bodyReference(page).locator('.reference-heading .grip').click();
  await page.getByRole('menu').getByText('右侧分栏', { exact: true }).click();
  await expect(page.locator('#reference-sidebar .reference-card')).toBeVisible();
  await page.evaluate(() => { window.watchReferencePanel = false; });
  await page.getByRole('button', { name: '反向链接', exact: true }).click();
  // External source changes refresh the sidebar-mode instance in the background.
  await page.evaluate(() => window.mockHost.updateSourceBlock('beta', 'b1', 'new source text'));
  await expect(page.locator('#reference-sidebar .block-text').first()).toHaveText('new source text');
  await expect(page.locator('#backlinks-section')).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await page.getByRole('button', { name: '实时引用', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText('new source text');
});

test('command failure leaves the selected references panel visible and usable', async ({ page }) => {
  await page.evaluate(() => {
    const send = window.mockHost.send.bind(window.mockHost);
    let fail = true;
    window.mockHost.send = message => {
      if (fail && message.kind === 'executeCommand') { fail = false; throw new Error('reference command rejected'); }
      return send(message);
    };
  });
  await bodyReference(page).locator('.hide').first().click();
  await expect(page.locator('#status')).toContainText('reference command rejected');
  await assertPanel(page);
  await expect(panel(page).locator('.reference-row')).toHaveCount(1);
  await bodyReference(page).locator('.hide').first().click();
  await expect(bodyReference(page).locator('.reference-row')).toHaveCount(0);
  await expect(page.locator('#status')).toContainText('已保存');
  await assertPanel(page);
});

test('ordinary preview refresh does not steal the selected tab', async ({ page }) => {
  const paragraph = page.locator('#blocks [data-id="a1"] > .block-row > .block-text');
  await page.locator('[data-editor-mode="source"]').click();
  await expect(page.locator('button[data-editor-mode="source"]')).toHaveAttribute('aria-pressed', 'true');
  await paragraph.fill('Before [[默认笔记本/Beta#^b2]]');
  await expect(page.locator('#status')).toContainText('正在保存');
  await expect(page.locator('#status')).toContainText('已保存');
  await page.locator('button[data-editor-mode="rich"]').click();
  await expect(page.locator('button[data-editor-mode="rich"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(paragraph.locator('.wiki-link')).toBeVisible();
  await paragraph.locator('.wiki-link').click();
  await expect(panel(page)).toContainText('Beta 文档中的其他块');
  await page.evaluate(() => { window.watchReferencePanel = false; });
  await page.getByRole('button', { name: '反向链接', exact: true }).click();
  await page.evaluate(() => window.mockHost.updateSourceBlock('gamma', 'g1', 'updated preview'));
  await expect(panel(page)).toContainText('Beta 文档中的其他块');
  await expect(panel(page)).not.toContainText('updated preview');
  await expect(page.locator('#backlinks-section')).toBeVisible();
  await expect(panel(page)).toBeHidden();
});
