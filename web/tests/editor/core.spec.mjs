import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
});

test("core runs independently and saves through Mock Host", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#title")).toHaveValue("Alpha");
  await expect(page.locator('.link-tools, #link-search, #document-picker, #insert-link, #insert-reference')).toHaveCount(0);
  const block = page.locator(".block-text").first();
  await block.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" 独立浏览器编辑");
  await expect(page.locator("#status")).toContainText("已保存", { timeout: 3000 });
  await expect(block).toContainText("独立浏览器编辑");
});

test("core menus and navigation run in browser mode", async ({ page }) => {
  await page.goto("/");
  const block = page.locator(".block-text").first();
  await block.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" [[");
  await expect(page.locator("#link-suggestions")).toBeVisible();
  await page.locator(".link-suggestion").first().click();
  await expect(block.locator(".wiki-link")).toHaveAttribute("data-target-id", "beta");
  await expect(block.locator(".wiki-link")).toHaveText("Beta");
  await expect(block.locator(".wiki-link")).not.toContainText("[[");
  await expect(page.getByRole("menu").filter({ hasText: "已插入双链" })).toBeVisible();
  await page.locator(".grip").first().click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menu").getByText("复制块链接").click();
});

test("candidate action can create a reference with a selected display mode", async ({ page }) => {
  await page.goto("/");
  const block = page.locator('[data-own-block][data-type="paragraph"] .block-text').first();
  await block.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" [[");
  await page.locator(".link-suggestion").first().click();
  await page.getByRole("menu").getByText("嵌入实时引用 · 折叠卡片").click();
  await expect(page.locator(".reference-card.is-collapsed")).toBeVisible();
  await expect(page.locator(".reference-card.is-collapsed .reference-expand")).toHaveAttribute("aria-expanded", "false");
});

test("Mock Host can simulate a save error without freezing editing", async ({ page }) => {
  await page.goto("/");
  await page.locator("#dev-fail").click();
  await page.locator(".block-text").first().fill("触发失败");
  await expect(page.locator("#status")).toContainText("保存失败", { timeout: 3000 });
  await page.locator("#dev-retry").click();
  await expect(page.locator("#status")).toContainText("已保存", { timeout: 3000 });
});

test("navigation uses the host protocol and reloads the editor state", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-doc="beta"]').click();
  await expect(page.locator("#title")).toHaveValue("Beta");
  await expect.poll(() => page.evaluate(() => window.mockHost.lastRequest?.kind)).toBe("openDocument");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.locator("#title")).toHaveValue("Alpha");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator("#title")).toHaveValue("Beta");
});

test("reference modes provide inline, collapsible, and sidebar views", async ({ page }, testInfo) => {
  await page.goto("/");
  const referenceShell = page.locator('[data-own-block][data-type="reference"]');
  const referenceGrip = referenceShell.locator(".reference-heading .grip");

  await expect(referenceShell.locator(".reference-card")).toBeVisible();
  await referenceGrip.click();
  await page.getByRole("menu").getByText("折叠卡片").click();
  const collapsedCard = referenceShell.locator(".reference-card");
  await expect(collapsedCard).toHaveClass(/is-collapsed/);
  await collapsedCard.getByRole("button", { name: "展开" }).click();
  await expect(collapsedCard).toHaveClass(/is-expanded/);
  await expect(collapsedCard.locator(".reference-row")).toHaveCount(1);
  await expect(collapsedCard).not.toContainText("Beta 文档中的其他块");
  await page.screenshot({ path: testInfo.outputPath("collapsed-expanded.png"), fullPage: true });
  await collapsedCard.getByRole("button", { name: "收起" }).click();
  await expect(collapsedCard).toHaveClass(/is-collapsed/);

  await referenceGrip.click();
  await page.getByRole("menu").getByText("右侧分栏").click();
  await expect(page.locator("#reference-sidebar-section")).toBeVisible();
  await expect(page.locator("#reference-sidebar .reference-row")).toContainText("Beta 的内容");
  await expect(referenceShell.locator(".sidebar-reference-entry")).toContainText("Beta");
  await expect(page.locator('#reference-sidebar .reference-card.sidebar[data-reference-id="ref1"]')).toHaveCount(1);
  await expect(page.locator('[data-own-block][data-type="reference"] .reference-card')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("sidebar.png"), fullPage: true });
});

test("references refresh source content and block references stay scoped", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.mockHost.updateSourceBlock("beta", "b1", "Beta 源内容已更新"));
  await expect(page.locator('#reference-sidebar-section')).toBeHidden();
  await expect(page.locator('[data-own-block][data-type="reference"] .reference-row')).toContainText("Beta 源内容已更新");
  await expect(page.locator('[data-own-block][data-type="reference"] .reference-row')).toHaveCount(1);
});

test("same-page source edits update the reference without losing the typing caret", async ({ page }) => {
  await page.goto("/");
  const source = page.locator('[data-own-block][data-id="a1"]');
  await source.locator(".grip").click();
  await page.getByRole("menu").getByText("嵌入为实时引用", { exact: true }).click();
  const reference = page.locator('[data-own-block][data-type="reference"]').first();
  await expect(reference.locator(".reference-row")).toContainText("浏览器编辑器核心");
  await source.locator(".block-text").fill("同页源内容自动同步");
  await expect(reference.locator(".reference-row")).toContainText("同页源内容自动同步");
  await expect(source.locator(".block-text")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" continued typing");
  await expect(reference.locator(".reference-row")).toContainText("continued typing");
});

test("source updates preserve instance overrides and reset restores the newest source", async ({ page }) => {
  await page.goto("/");
  const reference = page.locator('[data-own-block][data-type="reference"]');
  await reference.locator(".block-text").fill("仅此引用的局部内容");
  await expect(page.locator("#status")).toContainText("已保存");
  await page.locator('[data-doc="beta"]').click();
  await page.locator('[data-own-block][data-id="b1"] .block-text').fill("源内容更新但不覆盖局部内容");
  await expect(page.locator("#status")).toContainText("已保存");
  await page.locator('[data-doc="alpha"]').click();
  await expect(reference.locator(".block-text")).toHaveText("仅此引用的局部内容");
  await expect(reference.locator(".reference-meta")).toContainText("源内容已更新");
  await reference.locator(".reference-row").hover();
  await reference.locator(".reset").click();
  await expect(reference.locator(".block-text")).toHaveText("源内容更新但不覆盖局部内容");
});

test("expanded block cards include descendants but exclude unrelated source blocks", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-doc="beta"]').click();
  const root = page.locator('[data-own-block][data-id="b1"] .block-text');
  await root.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("child of the referenced block");
  await page.locator("#indent").click();
  await expect(page.locator("#status")).toContainText("已保存");
  await page.locator('[data-doc="alpha"]').click();
  const reference = page.locator('[data-own-block][data-type="reference"]');
  await reference.locator(".reference-heading .grip").click();
  await page.getByRole("menu").getByText("折叠卡片", { exact: true }).click();
  await reference.getByRole("button", { name: "展开", exact: true }).click();
  await expect(reference.locator(".reference-row")).toHaveCount(2);
  await expect(reference).toContainText("child of the referenced block");
  await expect(reference).not.toContainText("Beta 文档中的其他块");
});

test("editing the source document refreshes its live block reference", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-doc="beta"]').click();
  const sourceBlock = page.locator('[data-own-block][data-type="paragraph"] .block-text').first();
  await sourceBlock.fill("Beta 源文档刚刚修改");
  await expect(page.locator("#status")).toContainText("已保存", { timeout: 3000 });

  await page.locator('[data-doc="alpha"]').click();
  const reference = page.locator('[data-own-block][data-type="reference"]');
  await expect(reference.locator(".reference-row")).toContainText("Beta 源文档刚刚修改");
  await expect(reference.locator(".reference-row")).toHaveCount(1);
});
