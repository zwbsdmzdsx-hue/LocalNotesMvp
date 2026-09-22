import { test, expect } from '@playwright/test';

const switchMode = (page, mode) => page.locator(`[data-editor-mode="${mode}"]`).click();

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
});

test('todo blocks use GFM task markers in source and checked data in the model', async ({ page }) => {
  await page.locator('#add-todo').click();
  const todo = page.locator('#blocks > [data-own-block][data-type="todo"]').last();
  const body = todo.locator('.block-text');
  await body.fill('待办内容');
  await expect(page.locator('#status')).toContainText('已保存', { timeout: 3000 });

  await switchMode(page, 'source');
  await expect(body).toHaveText('- [ ] 待办内容');
  await body.fill('- [x] 已完成');
  await expect(page.locator('#status')).toContainText('已保存', { timeout: 3000 });
  await expect.poll(() => page.evaluate(() => {
    const block = window.mockHost.state('alpha').blocks.find(item => item.type === 'todo');
    return block && { checked: block.content.checked, markdown: block.content.markdown };
  })).toEqual({ checked: true, markdown: '已完成' });

  await switchMode(page, 'preview');
  await expect(todo.locator('.todo-check')).toBeChecked();
  await expect(todo.locator('.block-text')).toContainText('已完成');
  await expect(todo.locator('.block-text')).not.toContainText('- [x]');

  await switchMode(page, 'rich');
  await todo.locator('.todo-check').uncheck();
  await expect.poll(() => page.evaluate(() => {
    return window.mockHost.state('alpha').blocks.find(item => item.type === 'todo')?.content.checked;
  })).toBe(false);
  await switchMode(page, 'source');
  await expect(todo.locator('.block-text')).toHaveText('- [ ] 已完成');
});

test('todo dates persist as block metadata and appear as colored calendar dots', async ({ page }) => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const createdDate = `${year}-${month}-05`;
  const dueDate = `${year}-${month}-20`;
  await page.locator('#add-todo').click();
  const todo = page.locator('#blocks > [data-own-block][data-type="todo"]').last();
  const created = todo.locator('.todo-created-date');
  const due = todo.locator('.todo-due-date');
  await expect(created).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  await created.fill(createdDate);
  await due.fill(dueDate);
  await expect(page.locator('#status')).toContainText('已保存', { timeout: 3000 });
  await expect.poll(() => page.evaluate(() => {
    const block = window.mockHost.state('alpha').blocks.find(item => item.type === 'todo');
    return { created: block?.properties.todoCreatedAt, due: block?.properties.todoDueAt };
  })).toEqual({ created: createdDate, due: dueDate });

  await switchMode(page, 'source');
  await expect(todo.locator('.todo-dates')).toBeHidden();
  await expect(todo.locator('.block-text')).not.toContainText(createdDate);
  await switchMode(page, 'rich');
  await expect(created).toHaveValue(createdDate);
  await expect(due).toHaveValue(dueDate);

  await page.locator('[data-pane-btn="calendar"]').click();
  const panel = page.locator('[data-slot="calendar"]');
  const createdDay = panel.locator(`.calendar-day[data-date="${createdDate}"]`);
  const dueDay = panel.locator(`.calendar-day[data-date="${dueDate}"]`);
  await expect(createdDay.locator('.calendar-dot-created')).toBeVisible();
  await expect(dueDay.locator('.calendar-dot-due')).toBeVisible();
  await expect(createdDay).toHaveClass(/has-calendar-activity/);
  await expect(dueDay).toHaveClass(/has-calendar-activity/);
  const emptyDay = panel.locator('.calendar-day:not(.has-calendar-activity):not(.selected):not(:disabled)').first();
  await expect(emptyDay).toHaveCSS('color', 'rgb(152, 162, 179)');
});
