import { test, expect } from '@playwright/test';

test('creates an editable database table and preserves its structure in source mode', async ({ page }) => {
  await page.goto('/');
  await page.locator('#add-database').click();
  await expect(page.locator('[data-own-block][data-type="database_table"]')).toHaveCount(1);
  await expect(page.locator('.database-table th')).toHaveCount(3);
  await page.locator('.database-add-row').click();
  await expect(page.locator('.database-table tbody tr')).toHaveCount(1);
  const name = page.locator('.database-cell[data-field-key="name"]').first();
  await name.fill('任务一');
  await name.press('Tab');
  await expect(page.locator('#status')).toContainText('已同步本地数据库', { timeout: 3000 });
  await page.locator('[data-editor-mode="source"]').click();
  await expect(page.locator('.database-source')).toContainText('localnotes-database');
  await expect(page.locator('.database-source')).toContainText('prop("amount") * 1');
  await page.locator('[data-editor-mode="rich"]').click();
  await expect(page.locator('.database-cell[data-field-key="name"]').first()).toHaveValue('任务一');
});

test('DQL and formulas use stable property names without executing scripts', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { evaluateFormula } = await import('/src/database-expression.ts');
    const { parseDql } = await import('/src/database-query.ts');
    return {
      formula: evaluateFormula('prop("amount") * 2', { amount: 3 }),
      query: parseDql('TABLE name, amount\nFROM current\nWHERE amount >= 2\nSORT amount DESC\nLIMIT 10'),
      unsafe: evaluateFormula('globalThis.process.exit()', { amount: 3 })
    };
  });
  expect(result.formula).toBe(6);
  expect(result.query).toMatchObject({ from: 'current', limit: 10, table: ['name', 'amount'] });
  expect(result.unsafe).toMatchObject({ code: 'syntax' });
});

test('database source edits schema while invalid declarations preserve stored fields', async ({ page }) => {
  await page.goto('/');
  await page.locator('#add-database').click();
  await page.locator('[data-editor-mode="source"]').click();
  const source = page.locator('[data-own-block][data-type="database_table"] .database-source');
  const declaration = await source.textContent();
  const id = declaration.match(/id:\s*(\S+)/)[1];
  await source.fill(`\`\`\`localnotes-database\nid: ${id}\nview: table\nfields:\n  - key: task\n    title: 任务\n    type: text\n  - key: doubled\n    title: 双倍\n    type: formula\n    formula: prop("task")\nquery:\n  from: current\n\`\`\``);
  await expect(source).not.toHaveClass(/database-source-error/);
  await page.locator('[data-editor-mode="rich"]').click();
  await expect(page.locator('[data-own-block][data-type="database_table"] .database-field-header > span:last-child')).toHaveText(['任务', '双倍']);
  await page.locator('[data-editor-mode="source"]').click();
  await source.fill('```localnotes-database\nview: table\n```');
  await expect(source).toHaveClass(/database-source-error/);
  await page.locator('[data-editor-mode="rich"]').click();
  await expect(page.locator('[data-own-block][data-type="database_table"] .database-field-header > span:last-child')).toHaveText(['任务', '双倍']);
});

test('DQL reports formula cycles and emits grouped sorted rows', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { executeDql, parseDql } = await import('/src/database-query.ts');
    const source = {
      id: 'db', title: '测试', recordCount: 2,
      fields: [
        { id: 'name', databaseId: 'db', key: 'name', title: '名称', type: 'text', position: '1' },
        { id: 'amount', databaseId: 'db', key: 'amount', title: '金额', type: 'number', position: '2' },
        { id: 'a', databaseId: 'db', key: 'a', title: 'A', type: 'formula', formula: 'prop("B")', position: '3' },
        { id: 'b', databaseId: 'db', key: 'b', title: 'B', type: 'formula', formula: 'prop("A")', position: '4' }
      ]
    };
    const records = [
      { id: 'r1', databaseId: 'db', position: '1', values: { name: '甲', amount: 1 } },
      { id: 'r2', databaseId: 'db', position: '2', values: { name: '乙', amount: 3 } }
    ];
    const query = parseDql('TABLE name, amount, a\nFROM current\nSORT amount DESC\nGROUP BY name\nLIMIT 10');
    return 'code' in query ? query : executeDql(query, source, records);
  });
  expect(result.rows[0]).toMatchObject({ grouped: true });
  expect(result.rows[1]).toMatchObject({ recordId: 'r2', values: { name: '乙', amount: 3 } });
  expect(result.errors.some(error => error.code === 'cycle')).toBeTruthy();
});

test('converts a GFM table in place and converts the same records back to Markdown', async ({ page }) => {
  await page.goto('/');
  const paragraph = page.locator('[data-id="a1"] > .block-row > .block-text');
  await page.locator('[data-editor-mode="source"]').click();
  await paragraph.fill('| 名称 | 金额 |\n| --- | --- |\n| 咖啡 | 28 |\n| 茶 | 16 |');
  await page.locator('[data-editor-mode="rich"]').click();
  await page.locator('[data-id="a1"] > .block-row > .grip').click();
  await page.getByRole('menu').getByText('转换为普通数据表', { exact: true }).click();
  await expect(page.locator('[data-id="a1"][data-type="database_table"]')).toBeVisible();
  await expect(page.locator('[data-id="a1"] .database-table tbody tr')).toHaveCount(2);
  await page.locator('[data-id="a1"] > .block-row > .grip').click();
  await page.getByRole('menu').getByText('转换为 Markdown 表格', { exact: true }).click();
  await page.locator('[data-editor-mode="source"]').click();
  await expect(page.locator('[data-id="a1"] .block-text')).toContainText('| 咖啡 | 28 |');
  await expect(page.locator('[data-id="a1"] .block-text')).toContainText('| 茶 | 16 |');
});

test('adds and removes rows and typed columns with icons', async ({ page }) => {
  await page.goto('/');
  await page.locator('#add-database').click();
  const table = page.locator('[data-own-block][data-type="database_table"]');
  await table.locator('.database-add-row').click();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await table.locator('.database-add-column').click();
  const menu = page.locator('.database-field-menu');
  await menu.locator('input').nth(0).fill('网址');
  await menu.locator('input').nth(1).fill('website');
  await menu.locator('select').selectOption('url');
  await menu.getByRole('button', { name: '添加列' }).click();
  const webHeader = table.locator('th[data-field-key="website"]');
  await expect(webHeader).toContainText('↗');
  await expect(webHeader).toContainText('网址');
  const webInput = table.locator('.database-cell[data-field-key="website"]');
  await expect(webInput).toHaveAttribute('type', 'url');
  await webInput.fill('https://example.com');
  await webInput.press('Tab');
  await table.locator('.database-delete-row').click({ force: true });
  await expect(table.locator('tbody tr')).toHaveCount(0);
  await webHeader.locator('.database-field-header').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.database-field-menu').getByRole('button', { name: '删除列' }).click();
  await expect(table.locator('th[data-field-key="website"]')).toHaveCount(0);
});

test('formula and rule cells reveal source only when clicked in edit mode', async ({ page }) => {
  await page.goto('/');
  await page.locator('#add-database').click();
  const table = page.locator('[data-own-block][data-type="database_table"]');
  await table.locator('.database-add-row').click();
  const formula = table.locator('td[data-field-key="total"]');
  await expect(formula.locator('.database-computed-cell')).toHaveText('0');
  await formula.locator('.database-computed-cell').click();
  await expect(formula.locator('.database-formula-source')).toHaveValue('prop("amount") * 1');
  await formula.locator('.database-formula-source').fill('prop("amount") + 1');
  await formula.locator('.database-formula-source').press('Enter');
  await expect(table.locator('.database-computed-cell').first()).toHaveText('1');
  await page.locator('[data-editor-mode="preview"]').click();
  await expect(table.locator('button.database-computed-cell')).toHaveCount(0);
  await expect(table.locator('.database-computed-cell').first()).toHaveText('1');
  await page.locator('[data-editor-mode="source"]').click();
  await expect(table.locator('.database-source')).toContainText('formula: prop("amount") + 1');
});

test('media and rule field types keep typed previews across modes', async ({ page }) => {
  await page.goto('/');
  await page.locator('#add-database').click();
  const table = page.locator('[data-own-block][data-type="database_table"]');
  await table.locator('.database-add-row').click();
  await table.locator('.database-add-column').click();
  let menu = page.locator('.database-field-menu');
  await menu.locator('input').nth(0).fill('附件');
  await menu.locator('input').nth(1).fill('asset');
  await menu.locator('select').selectOption('media');
  await menu.getByRole('button', { name: '添加列' }).click();
  await table.locator('td[data-field-key="asset"] input[type="file"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl7WZ8AAAAASUVORK5CYII=', 'base64') });
  await expect(table.locator('td[data-field-key="asset"] img.database-media-preview')).toBeVisible();
  await table.locator('.database-add-column').click();
  menu = page.locator('.database-field-menu');
  await menu.locator('input').nth(0).fill('规则');
  await menu.locator('input').nth(1).fill('valid');
  await menu.locator('select').selectOption('rule');
  await menu.locator('textarea').fill('prop("amount") >= 0');
  await menu.getByRole('button', { name: '添加列' }).click();
  await expect(table.locator('td[data-field-key="valid"] .database-computed-cell')).toHaveText('✓ 符合');
  await page.locator('[data-editor-mode="preview"]').click();
  await expect(table.locator('td[data-field-key="asset"] img.database-media-preview')).toBeVisible();
  await expect(table.locator('td[data-field-key="valid"] button')).toHaveCount(0);
  await page.locator('[data-editor-mode="source"]').click();
  await expect(table.locator('.database-source')).toContainText('type: media');
  await expect(table.locator('.database-source')).toContainText('type: rule');
});

test('database sidebar is contextual and clears when the active table is deleted', async ({ page }) => {
  await page.goto('/');
  const tab = page.locator('[data-pane-btn="databases"]');
  await expect(tab).toBeHidden();
  await page.locator('#add-database').click();
  const table = page.locator('[data-own-block][data-type="database_table"]');
  await expect(table).toBeVisible();
  await expect(tab).toBeVisible();
  await expect(page.locator('#databases-section')).toBeVisible();
  await expect(page.locator('#databases .database-context-panel input[aria-label="数据表名称"]')).toHaveValue('新数据库');
  await expect(page.locator('#databases .database-context-field')).toHaveCount(3);
  const formulaField = page.locator('#databases .database-context-field').filter({ hasText: '合计' });
  await formulaField.locator('summary').click();
  await expect(formulaField).toContainText('公式表达式');
  await expect(formulaField.locator('textarea')).toHaveValue('prop("amount") * 1');

  await page.locator('[data-id="a1"]').click();
  await expect(tab).toBeHidden();
  await expect(page.locator('#databases-section')).toBeHidden();

  await table.locator('.delete-block').click();
  await expect(table).toHaveCount(0);
  await expect(tab).toBeHidden();
  await expect(page.locator('#databases')).toBeEmpty();
});
