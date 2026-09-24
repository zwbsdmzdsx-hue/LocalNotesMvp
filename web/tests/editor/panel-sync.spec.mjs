import { test, expect } from "@playwright/test";

async function createCanvas(page, title) {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept(title));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Canvas" }).click();
  await expect(page.locator(".canvas-view")).toBeVisible();
}

test("Canvas todo dates publish to the calendar before the save debounce", async ({ page }) => {
  await createCanvas(page, "待办同步画布");
  await page.locator(".canvas-viewport").click({ button: "right", position: { x: 460, y: 340 } });
  await page.locator(".canvas-context-menu button", { hasText: "新建待办块" }).click();
  const todo = page.locator(".canvas-node-text").last();
  await todo.locator("textarea").fill("Canvas 待办");
  const due = new Date(); due.setDate(due.getDate() + 2);
  const dueDate = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  await todo.locator(".todo-due-date").fill(dueDate);
  await expect(page.locator("[data-pane-btn=calendar]")).toBeVisible();
  await page.locator("[data-pane-btn=calendar]").click();
  const day = page.locator(`.calendar-day[data-date="${dueDate}"]`);
  await expect(day.locator(".calendar-dot-todo-pending")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.some(node => (node.block?.content.text ?? node.block?.content.markdown ?? "").includes("Canvas 待办")))).toBe(true);
});

test("Canvas references use the shared live reference panel", async ({ page }) => {
  await createCanvas(page, "引用同步画布");
  await page.locator("[data-canvas-action=add]").click();
  const input = page.locator(".canvas-note-text").last();
  await input.fill("[[Bet");
  await page.locator(".canvas-link-suggestion").filter({ hasText: "Beta" }).first().click();
  await page.getByRole("menu", { name: "引用显示方式" }).getByRole("button", { name: "正文直显", exact: true }).click();
  await page.locator("[data-pane-btn=reference-sidebar]").click();
  await expect(page.locator("#reference-sidebar-section")).toContainText("Beta");
});

test("Dashboard widgets resolve their source document state", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#title")).toHaveValue("Alpha");
  page.once("dialog", dialog => dialog.accept("状态面板"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Dashboard" }).click();
  await expect(page.locator(".dashboard-widget", { hasText: "实时引用" })).toContainText("Beta");
  await page.evaluate(() => window.mockHost.updateSourceBlock("beta", "b1", "Dashboard 来源已更新"));
  await page.locator(".doc-item .list-label", { hasText: "Alpha" }).click();
  await page.locator(".doc-item .list-label", { hasText: "状态面板" }).click();
  await expect(page.locator(".dashboard-view")).toBeVisible();
  await expect(page.locator(".dashboard-widget", { hasText: "实时引用" })).toContainText("Beta");
});
