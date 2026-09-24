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
  const dueDate = `${year}-${month}-${String(now.getDate()).padStart(2, '0')}`;
  await page.locator('#add-todo').click();
  const todo = page.locator('#blocks > [data-own-block][data-type="todo"]').last();
  await todo.locator('.block-text').fill('待办内容');
  const created = todo.locator('.todo-created-date');
  const due = todo.locator('.todo-due-date');
  const completed = todo.locator('.todo-completed-date');
  await expect(created).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  await created.fill(createdDate);
  await due.fill(dueDate);
  await expect(page.locator('#status')).toContainText('已保存', { timeout: 3000 });
  await expect.poll(() => page.evaluate(() => {
    const block = window.mockHost.state('alpha').blocks.find(item => item.type === 'todo');
    return { created: block?.properties.todoCreatedAt, due: block?.properties.todoDueAt, completed: block?.properties.todoCompletedAt };
  })).toEqual({ created: createdDate, due: dueDate, completed: undefined });

  await switchMode(page, 'source');
  await expect(todo.locator('.todo-dates')).toBeHidden();
  await expect(todo.locator('.block-text')).not.toContainText(createdDate);
  await switchMode(page, 'rich');
  await expect(created).toHaveValue(createdDate);
  await expect(due).toHaveValue(dueDate);
  await expect(completed).toHaveValue('');
  await expect(todo.locator('.todo-status-pending')).toBeVisible();

  await page.locator('[data-pane-btn="calendar"]').click();
  const panel = page.locator('[data-slot="calendar"]');
  const createdDay = panel.locator(`.calendar-day[data-date="${createdDate}"]`);
  const dueDay = panel.locator(`.calendar-day[data-date="${dueDate}"]`);
  await expect(createdDay.locator('.calendar-dot-todo-pending, .calendar-dot-todo-overdue, .calendar-dot-todo-complete')).toHaveCount(0);
  await expect(dueDay.locator('.calendar-dot-todo-pending')).toBeVisible();
  await expect(createdDay).not.toHaveClass(/has-calendar-activity/);
  await expect(dueDay).toHaveClass(/has-calendar-activity/);
  await dueDay.click();
  const todoPreview = panel.locator('.calendar-todo-entry').filter({ hasText: '待办内容' });
  await expect(todoPreview).toBeVisible();
  await expect(todoPreview).toContainText(`应完成 ${dueDate}`);

  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  await todo.locator('.todo-check').check();
  await expect.poll(() => page.evaluate(() => {
    const block = window.mockHost.state('alpha').blocks.find(item => item.type === 'todo');
    return block?.properties.todoCompletedAt;
  })).toMatch(/\d{4}-\d{2}-\d{2}/);
  await expect(todo.locator('.todo-completed-date')).not.toHaveValue('');
  await expect(todo.locator('.todo-status-complete-early')).toBeVisible();

  await page.locator('[data-pane-btn="calendar"]').click();
  await expect(panel.locator(`.calendar-day[data-date="${dueDate}"] .calendar-dot-todo-complete`)).toBeVisible();
  const emptyDay = panel.locator('.calendar-day:not(.has-calendar-activity):not(.selected):not(:disabled)').first();
  await expect(emptyDay).toHaveCSS('color', 'rgb(152, 162, 179)');
});

test('todo status shows a red warning when overdue and a late red check when completed late', async ({ page }) => {
  await page.locator('#add-todo').click();
  const todo = page.locator('#blocks > [data-own-block][data-type="todo"]').last();
  const due = todo.locator('.todo-due-date');
  const completed = todo.locator('.todo-completed-date');
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const iso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  await due.fill(iso);
  await expect(todo.locator('.todo-status-overdue')).toBeVisible();
  await todo.locator('.todo-check').check();
  await completed.fill(new Date().toISOString().slice(0, 10));
  await expect(todo.locator('.todo-status-complete-late')).toBeVisible();
});
