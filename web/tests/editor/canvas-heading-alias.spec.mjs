import { test, expect } from "@playwright/test";

async function createCanvas(page) {
  page.once("dialog", dialog => dialog.accept("标题结构画布"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Canvas" }).click();
  await expect(page.locator(".canvas-view")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#title")).toHaveValue("Alpha");
});

test("ordinary wiki links keep a custom label and stable target after a rich edit", async ({ page }) => {
  await page.locator('[data-editor-mode="source"]').click();
  const block = page.locator('#blocks [data-id="a1"] > .block-row > .block-text');
  await block.fill("参见 [[默认笔记本/Beta#^b1]]");
  await expect(page.locator("#status")).toContainText("已保存");
  await page.locator('[data-editor-mode="rich"]').click();
  const link = block.locator(".wiki-link");
  await expect(link).toHaveAttribute("data-target-id", "beta");
  page.once("dialog", dialog => dialog.accept("自定义标题"));
  await link.click({ button: "right" });
  await page.locator(".block-menu").getByRole("button", { name: "修改显示文字" }).click();
  await expect(link).toHaveText("自定义标题");
  await expect(page.locator("#status")).toContainText("已保存");
  await page.locator('[data-editor-mode="source"]').click();
  await expect(block).toContainText("[[默认笔记本/Beta#^b1|自定义标题]]");
  await page.locator('[data-editor-mode="preview"]').click();
  await expect(block.locator(".wiki-link")).toHaveAttribute("data-target-id", "beta");
  await expect(block.locator(".wiki-link")).toHaveText("自定义标题");
});

test("Canvas wiki link label edits preserve the reference target", async ({ page }) => {
  await createCanvas(page);
  await page.locator('[data-canvas-action="add"]').click();
  const card = page.locator(".canvas-node-text").first();
  await card.locator("textarea").fill("[[Beta]]");
  await card.locator("textarea").blur();
  const link = card.locator(".wiki-link");
  await expect(link).toHaveAttribute("data-target-id", "beta");
  page.once("dialog", dialog => dialog.accept("别名"));
  await link.click({ button: "right" });
  await page.getByRole("menu", { name: "引用显示方式" }).getByRole("button", { name: "修改显示文字" }).click();
  await expect(card.locator(".wiki-link")).toHaveText("别名");
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  const saved = await page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.find(node => node.kind === "block")?.block);
  expect(saved.content.markdown).toBe("[[Beta|别名]]");
  expect(saved.content.links[0].targetDocumentId).toBe("beta");
});

test("Canvas heading card stores independently movable paragraph blocks", async ({ page }) => {
  await createCanvas(page);
  await page.locator(".canvas-viewport").click({ button: "right", position: { x: 440, y: 330 } });
  await page.locator(".canvas-context-menu button", { hasText: "新建标题块" }).click();
  const card = page.locator(".canvas-heading-card");
  await expect(card.locator(".canvas-node-type-icon")).toHaveText("H");
  const title = card.locator(".canvas-node-body > textarea");
  await title.fill("章节标题");
  await title.press("Enter");
  let children = card.locator(".canvas-heading-child");
  await expect(children).toHaveCount(1);
  await children.first().locator("textarea").fill("# 二级标题");
  await children.first().locator("textarea").press("Enter");
  children = card.locator(".canvas-heading-child");
  await children.last().locator("textarea").fill("正文段落");
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");

  const blocks = await page.evaluate(() => window.mockHost.state(window.mockHost.current).blocks);
  const heading = blocks.find(block => block.type === "heading" && block.parentId === null);
  const nested = blocks.filter(block => block.parentId === heading.id);
  expect(heading.properties.headingLevel).toBe(1);
  expect(nested).toHaveLength(2);
  expect(nested[0].properties.headingLevel).toBe(2);
  expect(nested[0].content.markdown).toBe("## 二级标题");
  expect(nested[1].type).toBe("paragraph");
  expect(new Set(nested.map(block => block.id)).size).toBe(2);

  await page.dragAndDrop(".canvas-heading-child:nth-child(2) .canvas-heading-grip", ".canvas-heading-child:nth-child(1)");
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.filter(node => node.block?.parentId).map(node => node.block.content.markdown))).toEqual(["正文段落", "## 二级标题"]);
  await card.locator(".canvas-node-grip").click();
  page.once("dialog", dialog => dialog.accept("自定义章节"));
  await page.getByRole("menuitem", { name: "重命名块" }).click();
  await expect(card.locator(".canvas-node-label")).toHaveText("自定义章节");
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");

  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.locator('.doc-item .list-label', { hasText: "标题结构画布" }).click();
  await expect(page.locator(".canvas-heading-child")).toHaveCount(2);
  await expect(page.locator(".canvas-node-label")).toContainText("自定义章节");
  await page.locator(".canvas-heading-child").first().locator(".canvas-heading-grip").click();
  await page.getByRole("menuitem", { name: "删除此块" }).click();
  await expect(page.locator(".canvas-heading-child")).toHaveCount(1);
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
});

test("Dashboard widgets can be named and retain icons for their types", async ({ page }) => {
  page.once("dialog", dialog => dialog.accept("指标面板"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Dashboard" }).click();
  const widgets = page.locator(".dashboard-widget");
  await expect(widgets).toHaveCount(3);
  await expect(widgets.locator(".dashboard-widget-icon")).toHaveCount(3);
  await widgets.first().click();
  await page.locator(".dashboard-settings").getByRole("textbox", { name: "标题" }).fill("我的数据摘要");
  await page.locator(".dashboard-settings").getByRole("textbox", { name: "标题" }).dispatchEvent("change");
  await expect(widgets.first().locator(".dashboard-widget-head strong")).toHaveText("我的数据摘要");
  await expect(page.locator(".dashboard-save-state")).toHaveText("已保存");
  const icons = await widgets.locator(".dashboard-widget-icon").allTextContents();
  expect(icons.every(icon => icon.trim().length > 0)).toBe(true);
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.locator('.doc-item .list-label', { hasText: "指标面板" }).click();
  await expect(page.locator(".dashboard-widget-head strong").first()).toHaveText("我的数据摘要");
});

test("links inside Canvas heading paragraphs feed the shared reference panel", async ({ page }) => {
  await createCanvas(page);
  await page.locator(".canvas-viewport").click({ button: "right", position: { x: 360, y: 300 } });
  await page.locator(".canvas-context-menu button", { hasText: "新建标题块" }).click();
  await page.locator(".canvas-heading-card .canvas-node-body > textarea").fill("带引用的章节");
  await page.locator(".canvas-heading-card .canvas-node-body > textarea").press("Enter");
  const child = page.locator(".canvas-heading-child").first();
  await child.locator("textarea").fill("查看 [[Bet");
  await page.locator(".canvas-link-suggestion").filter({ hasText: "Beta" }).first().click();
  await page.getByRole("menu", { name: "引用显示方式" }).getByRole("button", { name: "正文直显", exact: true }).click();
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  await page.locator("[data-pane-btn=reference-sidebar]").click();
  await expect(page.locator("#reference-sidebar-section")).toContainText("Beta");
  const owner = await page.evaluate(() => window.mockHost.state(window.mockHost.current));
  const nested = owner.blocks.find(block => block.parentId);
  expect(owner.references.some(reference => reference.hostBlockId === nested.id && reference.targetDocumentId === "beta")).toBe(true);
});

test("legacy multiline headings split on open and deleting the card removes its children", async ({ page }) => {
  await createCanvas(page);
  await page.locator(".canvas-viewport").click({ button: "right", position: { x: 360, y: 300 } });
  await page.locator(".canvas-context-menu button", { hasText: "新建标题块" }).click();
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  await page.evaluate(() => {
    const id = window.mockHost.current;
    const canvas = window.mockHost.canvas(id);
    const node = canvas.nodes.find(item => item.block?.type === "heading");
    node.block.content = { text: "旧标题\n# 旧子标题\n旧正文", html: "", markdown: "# 旧标题\n# 旧子标题\n旧正文" };
    window.mockHost.saveCanvas(id, canvas.nodes, canvas.viewport, crypto.randomUUID(), canvas.version);
    window.canvasManager.open(id);
  });
  await expect(page.locator(".canvas-heading-child")).toHaveCount(2);
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  const before = await page.evaluate(() => window.mockHost.state(window.mockHost.current).blocks);
  expect(before.filter(block => block.parentId)).toHaveLength(2);
  await page.locator(".canvas-heading-card .canvas-node-remove").click();
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  const after = await page.evaluate(() => window.mockHost.state(window.mockHost.current).blocks);
  expect(after).toHaveLength(0);
});
