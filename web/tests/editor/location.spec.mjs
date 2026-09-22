import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
});

test("地图管理显示当前笔记本和全局位置", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane-btn="locations"]').click();
  const panel = page.locator('[data-slot="locations"]');
  await expect(panel).toContainText("默认办公点");
  await expect(panel.locator(".location-card")).toHaveCount(1);
  await panel.locator(".location-scopes button").filter({ hasText: "全局位置" }).click();
  await expect(panel).toContainText("广州越秀区");
  await expect(panel.locator(".location-card")).toHaveCount(1);
});

test("新建位置、坐标输入和插入正文保持稳定 locationId", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane-btn="locations"]').click();
  const panel = page.locator('[data-slot="locations"]');
  await panel.locator(".location-create").click();
  await panel.locator('input').nth(0).fill("广州越秀新点");
  await panel.locator('input[type="number"]').nth(0).fill("23.129123");
  await panel.locator('input[type="number"]').nth(1).fill("113.264456");
  await panel.locator('input').nth(1).fill("广东省广州市越秀区某路");
  await panel.getByRole("button", { name: "保存位置" }).click();
  await expect(panel).toContainText("广州越秀新点");
  const locationId = await panel.locator(".location-card").filter({ hasText: "广州越秀新点" }).getAttribute("data-location-id");
  expect(locationId).toBeTruthy();
  await panel.locator(".location-card").filter({ hasText: "广州越秀新点" }).getByRole("button", { name: "插入正文" }).click();
  const block = page.locator('[data-own-block][data-type="location"]').last();
  await expect(block).toHaveAttribute("data-type", "location");
  await expect(block.locator(".location-body-head")).toContainText("广州越秀新点");
  const persisted = await page.evaluate(() => window.mockHost.state("alpha"));
  const saved = persisted.blocks.find(block => block.type === "location");
  expect(saved.properties.locationId).toBe(locationId);
  await page.locator('[data-editor-mode="source"]').click();
  await expect(block.locator(".location-source")).toContainText(`id: ${locationId}`);
  await page.locator('[data-editor-mode="preview"]').click();
  await expect(block.locator(".location-body-map")).toBeVisible();
});

test("IP 定位不会自动请求，浏览器定位按钮可被用户主动触发", async ({ page }) => {
  let ipRequests = 0;
  await page.route("https://ipapi.co/**", route => { ipRequests += 1; void route.abort(); });
  await page.goto("/");
  await page.locator('[data-pane-btn="locations"]').click();
  await page.locator('[data-slot="locations"] .location-create').click();
  expect(ipRequests).toBe(0);
  await page.locator('[data-slot="locations"]').getByRole("button", { name: "按公网 IP 定位" }).click();
  await expect.poll(() => ipRequests).toBe(1);
});

test("位置软删除可恢复，浏览器定位只在按钮点击后读取坐标", async ({ page, context }) => {
  page.on("dialog", dialog => dialog.accept());
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 22.5431, longitude: 114.0579 });
  await page.goto("/");
  await page.locator('[data-pane-btn="locations"]').click();
  const panel = page.locator('[data-slot="locations"]');
  const seeded = panel.locator('.location-card').filter({ hasText: "默认办公点" });
  await seeded.getByRole("button", { name: "编辑" }).click();
  await panel.getByRole("button", { name: "使用浏览器当前位置" }).click();
  await expect(panel.locator('input[type="number"]').nth(0)).toHaveValue("22.5431");
  await panel.getByRole("button", { name: "保存位置" }).click();
  await seeded.getByRole("button", { name: "删除" }).click();
  await expect(panel.locator(".location-deleted-heading")).toBeVisible();
  await panel.locator(".location-card.is-deleted").filter({ hasText: "默认办公点" }).getByRole("button", { name: "恢复" }).click();
  await expect(panel.locator(".location-card:not(.is-deleted)")).toContainText("默认办公点");
});

test("位置目录写入进入历史并可撤销/重做", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane-btn="locations"]').click();
  const panel = page.locator('[data-slot="locations"]');
  await panel.locator(".location-create").click();
  await panel.locator('input').nth(0).fill("历史位置");
  await panel.getByRole("button", { name: "保存位置" }).click();
  await expect(panel).toContainText("历史位置");
  await page.locator("#undo").click();
  await expect.poll(() => panel.locator(".location-card").filter({ hasText: "历史位置" }).count()).toBe(0);
  await page.locator("#redo").click();
  await expect(panel).toContainText("历史位置");
});

test("反向地理编码失败不会阻止保存坐标", async ({ page }) => {
  await page.route("https://nominatim.openstreetmap.org/**", route => route.fulfill({ status: 503, body: "offline" }));
  await page.goto("/");
  await page.locator('[data-pane-btn="locations"]').click();
  const panel = page.locator('[data-slot="locations"]');
  await panel.locator(".location-create").click();
  await panel.getByRole("button", { name: "反查地址" }).click();
  await expect(panel).toContainText("保存位置");
  await panel.getByRole("button", { name: "保存位置" }).click();
  await expect(panel).toContainText("新位置");
});
