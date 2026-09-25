import { test, expect } from "@playwright/test";

async function createDashboard(page) {
  page.once("dialog", dialog => dialog.accept("数据监控"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Dashboard" }).click();
  await expect(page.locator(".dashboard-view")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#title")).toHaveValue("Alpha");
});

test("dashboard metric filters, groups and calculates live source records", async ({ page }) => {
  await createDashboard(page);
  await page.locator('[data-dashboard-action="add"]').click();
  await page.locator(".dashboard-add-menu").getByRole("button", { name: "表格汇总" }).click();
  const widget = page.locator(".dashboard-widget", { hasText: "表格汇总" });
  await expect(widget).toBeVisible();
  await expect(page.locator('[data-pane-btn="dashboard-config"]')).toBeVisible();
  const settings = page.locator('[data-slot="dashboard-config"]');
  await expect(settings).toBeVisible();
  await settings.getByLabel("汇总方式").selectOption("sum");
  await settings.getByLabel("数值字段").fill("effort");
  await settings.getByLabel("数值字段").blur();
  await expect(widget.locator(".dashboard-query-total")).toHaveText("10");
  await settings.getByLabel("分类字段").fill("status");
  await settings.getByLabel("分类字段").blur();
  await expect(widget.locator(".dashboard-query-groups > div")).toHaveCount(3);
  await expect(widget.locator(".dashboard-query-total")).toHaveText("10");
  await settings.getByRole("button", { name: "+ 筛选条件" }).click();
  await settings.getByLabel("筛选字段 1").fill("status");
  await settings.getByLabel("筛选值 1").fill("已完成");
  await settings.getByLabel("筛选值 1").blur();
  await expect(widget.locator(".dashboard-query-total")).toHaveText("2");
  await settings.getByLabel("计算公式").fill('prop("effort") * 3');
  await settings.getByLabel("计算公式").blur();
  await expect(widget.locator(".dashboard-query-total")).toHaveText("6");
  await settings.getByLabel("条件表达式").fill('prop("effort") > 3');
  await settings.getByLabel("条件表达式").blur();
  await expect(widget.locator(".dashboard-query-total")).toHaveText("0");
  await expect(page.locator(".dashboard-save-state")).toHaveText("已保存");
});

test("dashboard widget settings persist description, scope, size and style", async ({ page }) => {
  await createDashboard(page);
  await page.locator('[data-dashboard-action="add"]').click();
  await page.locator(".dashboard-add-menu").getByRole("button", { name: "未完成待办" }).click();
  const widget = page.locator(".dashboard-widget", { hasText: "未完成待办" });
  const settings = page.locator('[data-slot="dashboard-config"]');
  await settings.getByLabel("文字描述").fill("本周仍需完成的事项");
  await settings.getByLabel("文字描述").blur();
  await settings.getByLabel("宽度").fill("410");
  await settings.getByLabel("宽度").blur();
  await settings.getByLabel("背景色").fill("#f0fff4");
  await settings.getByLabel("背景色").blur();
  await settings.getByLabel("文字色").fill("#136149");
  await settings.getByLabel("文字色").blur();
  await settings.getByLabel("字号").fill("18");
  await settings.getByLabel("字号").blur();
  await settings.getByLabel("数据范围").selectOption("document");
  await settings.getByLabel("来源文档").selectOption("epsilon");
  await expect(widget).toContainText("本周仍需完成的事项");
  await expect(widget).toHaveCSS("width", "410px");
  await expect(widget).toHaveCSS("background-color", "rgb(240, 255, 244)");
  await expect(widget.locator(".dashboard-widget-body")).toHaveCSS("color", "rgb(19, 97, 73)");
  await expect(widget.locator(".dashboard-widget-body")).toHaveCSS("font-size", "18px");
  await expect(page.locator(".dashboard-save-state")).toHaveText("已保存");
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.locator('.doc-item .list-label', { hasText: "数据监控" }).click();
  await widget.click();
  await expect(settings.getByLabel("文字描述")).toHaveValue("本周仍需完成的事项");
  await expect(settings.getByLabel("来源文档")).toHaveValue("epsilon");
  await expect(widget).toHaveCSS("width", "410px");
});

test("dashboard todo count refreshes after a source document changes", async ({ page }) => {
  await createDashboard(page);
  await page.locator('[data-dashboard-action="add"]').click();
  await page.locator(".dashboard-add-menu").getByRole("button", { name: "未完成待办" }).click();
  const widget = page.locator(".dashboard-widget", { hasText: "未完成待办" });
  const total = widget.locator(".dashboard-query-total");
  await expect.poll(async () => Number(await total.textContent())).toBeGreaterThan(0);
  const previous = Number(await total.textContent());
  await expect(page.locator(".dashboard-save-state")).toHaveText("已保存");
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.locator("#add-todo").click();
  await page.locator('#blocks > [data-own-block][data-type="todo"]').last().locator(".block-text").fill("核对 Dashboard 实时统计");
  await expect(page.locator("#status")).toContainText("已保存");
  await page.locator('.doc-item .list-label', { hasText: "数据监控" }).click();
  await expect(total).toHaveText(String(previous + 1));
});

test("map panel shows vector canvas and current scope markers", async ({ page }, testInfo) => {
  await page.locator('[data-pane-btn="locations"]').click();
  const panel = page.locator('[data-slot="locations"]');
  await expect(panel.locator(".location-overview-map canvas")).toBeVisible();
  await expect(panel.getByRole("button", { name: "地图标记：默认办公点" })).toBeVisible();
  await expect(panel.locator(".location-overview-map")).toHaveAttribute("aria-busy", "false", { timeout: 10000 });
  const image = await panel.locator(".location-overview-map").screenshot({ path: testInfo.outputPath("vector-map.png") });
  const colors = await page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    const colors = new Set();
    for (let y = 8; y < 72; y += 4) for (let x = 8; x < 175; x += 4) colors.add([...context.getImageData(x, y, 1, 1).data].join(","));
    return colors.size;
  }, image.toString("base64"));
  expect(colors).toBeGreaterThan(10);
  await panel.locator(".location-scopes button").filter({ hasText: "全局位置" }).click();
  await expect(panel.getByRole("button", { name: "地图标记：广州越秀区" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "地图标记：默认办公点" })).toHaveCount(0);
});
