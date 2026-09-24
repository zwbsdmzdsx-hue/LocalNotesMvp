import { test, expect } from "@playwright/test";

async function openCanvas(page, title = "引用画布") {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept(title));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Canvas" }).click();
  await expect(page.locator(".canvas-view")).toBeVisible();
}

test("canvas text blocks offer [[ suggestions and render a selected document link", async ({ page }) => {
  await openCanvas(page);
  await page.locator('[data-canvas-action="add"]').click();
  const card = page.locator(".canvas-node-text");
  const input = card.locator("textarea");
  await input.fill("查看 [[Bet");
  await expect(page.locator(".canvas-link-suggestions")).toBeVisible();
  await page.locator(".canvas-link-suggestion").filter({ hasText: "Beta" }).first().click();
  await expect(input).toHaveValue("查看 [[Beta]]");
  await input.blur();
  await expect(card.locator(".canvas-note-preview .wiki-link")).toHaveText("Beta");
  await card.locator(".canvas-note-preview .wiki-link").click();
  await expect(page.locator("#title")).toHaveValue("Beta");
});

test("blank canvas context menu creates a block, document, or reference composer", async ({ page }) => {
  await openCanvas(page, "菜单画布");
  const viewport = page.locator(".canvas-viewport");
  await viewport.click({ button: "right", position: { x: 460, y: 340 } });
  await expect(page.locator(".canvas-context-menu")).toBeVisible();
  await expect(page.locator(".canvas-context-menu")).toContainText("新建块");
  await expect(page.locator(".canvas-context-menu")).toContainText("插入文档");
  await expect(page.locator(".canvas-context-menu")).toContainText("插入引用");
  await page.locator(".canvas-context-menu button", { hasText: "插入引用" }).click();
  await expect(page.locator(".canvas-link-suggestions")).toBeVisible();
  await page.locator(".canvas-link-suggestion").filter({ hasText: "Beta" }).first().click();
  await expect(page.locator(".canvas-node-text .canvas-note-preview .wiki-link")).toHaveText("Beta");
});

test("canvas completion preserves the caret suffix and shows only one editing surface", async ({ page }) => {
  await openCanvas(page);
  await page.locator('[data-canvas-action="add"]').click();
  const input = page.locator(".canvas-note-text");
  await input.fill("前文 [[Bet 后文");
  await input.evaluate(input => { input.setSelectionRange(8, 8); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.locator(".canvas-link-suggestion").filter({ hasText: "Beta" }).click();
  await expect(input).toHaveValue("前文 [[Beta]] 后文");
  await expect(page.getByRole("menu", { name: "引用显示方式" })).toBeVisible();
  await expect(page.locator(".canvas-note-preview")).toBeHidden();
  await input.press("Escape");
  await input.blur();
  await expect(input).toBeHidden();
  await expect(page.locator(".canvas-note-preview")).toBeVisible();
  await page.locator(".canvas-note-preview").click({ position: { x: 4, y: 4 } });
  await expect(input).toBeVisible();
});

async function insertLiveBlock(page, query = "默认笔记本/Beta/Beta 的内容") {
  await page.locator('[data-canvas-action="add"]').click();
  await page.locator(".canvas-note-text").last().fill("[[" + query);
  await page.locator(".canvas-link-suggestion[data-block-id]").first().click();
  await page.getByRole("menu", { name: "引用显示方式" }).getByRole("button", { name: "正文直显", exact: true }).click();
  await expect(page.locator(".canvas-live-reference").last()).toBeVisible();
  await expect(page.locator(".canvas-live-reference").last().locator(".preview-block")).not.toHaveCount(0);
}

test("canvas live block references are scoped, refresh, edit locally, and restore with history", async ({ page }, testInfo) => {
  await openCanvas(page);
  await insertLiveBlock(page);
  const reference = page.locator(".canvas-live-reference");
  await expect(reference).toContainText("Beta 的内容");
  await expect(reference).not.toContainText("Beta 文档中的其他块");
  await page.evaluate(() => window.mockHost.updateSourceBlock("beta", "b1", "源块实时更新"));
  await expect(reference).toContainText("源块实时更新");
  await reference.locator(".preview-block").dblclick();
  const edit = page.getByRole("textbox", { name: "编辑引用内容" });
  await edit.fill("**此处覆写**");
  await edit.blur();
  await expect(reference.locator("strong")).toHaveText("此处覆写");
  expect(await page.evaluate(() => window.mockHost.docs.get("beta").blocks[0].content.text)).toBe("源块实时更新");
  await page.locator('[data-canvas-action="undo"]').click();
  await expect(reference).toContainText("源块实时更新");
  await page.locator('[data-canvas-action="redo"]').click();
  await expect(reference).toContainText("此处覆写");
  await reference.getByRole("button", { name: "折叠引用", exact: true }).click();
  await expect(reference.locator(".preview-block")).toHaveCount(0);
  await reference.getByRole("button", { name: "展开引用", exact: true }).click();
  await expect(reference).toContainText("此处覆写");
  const canvasId = await page.evaluate(() => window.canvasManager.activeId());
  await page.locator('[data-document-id="beta"] > .doc-item').click();
  await page.locator('[data-document-id="' + canvasId + '"] > .doc-item').click();
  await expect(reference).toContainText("此处覆写");
  await page.screenshot({ path: testInfo.outputPath("canvas-live-reference.png") });
  const stored = await page.evaluate(id => window.mockHost.canvas(id), canvasId);
  expect(stored.references).toHaveLength(1);
  expect(stored.nodes[0].block.content.markdown).not.toContain("此处覆写");
});

test("canvas heading completion uses notebook scope and includes only its heading section", async ({ page }) => {
  await openCanvas(page);
  await page.evaluate(() => {
    const doc = window.mockHost.docs.get("zeta");
    const block = (id, text, position) => ({ id, type: "paragraph", parentId: null, position, content: { text, html: text, markdown: text }, properties: {}, revision: 1 });
    doc.blocks = [block("heading1", "# 一级标题", "001"), block("section", "**区间正文**", "002"),
      block("heading2", "## 二级标题", "003"), block("nested", "子标题正文", "004"), block("end", "# 结束", "005")];
    window.canvasManager.open(window.canvasManager.activeId());
  });
  await page.locator('[data-canvas-action="add"]').click();
  const input = page.locator(".canvas-note-text");
  await input.fill("[[研究/Zeta/##");
  await expect(page.locator(".canvas-link-suggestion[data-block-id]")).toHaveCount(1);
  await expect(page.locator(".canvas-link-suggestion")).toContainText("二级标题");
  await input.fill("[[研究/Zeta/#一级");
  await input.press("Enter");
  await page.getByRole("menu", { name: "引用显示方式" }).getByRole("button", { name: "正文直显", exact: true }).click();
  const reference = page.locator(".canvas-live-reference");
  await expect(reference).toContainText("区间正文");
  await expect(reference).toContainText("子标题正文");
  await expect(reference).not.toContainText("结束");
});

test("canvas composition does not commit a suggestion and escaping keeps input", async ({ page }) => {
  await openCanvas(page);
  await page.locator('[data-canvas-action="add"]').click();
  const input = page.locator(".canvas-note-text");
  await input.fill("[[默认");
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(input).toHaveValue("[[默认");
  await input.dispatchEvent("compositionend");
  await expect(page.locator(".canvas-link-suggestions")).toBeVisible();
  await input.press("Escape");
  await expect(page.locator(".canvas-link-suggestions")).toHaveCount(0);
  await expect(input).toHaveValue("[[默认");
});

test("multiple canvas references keep stable targets and removing source syntax prunes only that instance", async ({ page }) => {
  await openCanvas(page);
  await insertLiveBlock(page);
  await page.getByRole("button", { name: "编辑块源码" }).click();
  const input = page.locator(".canvas-note-text");
  await input.press("End");
  await input.press("Control+End");
  await input.pressSequentially(" + [[");
  await page.keyboard.insertText("研究/Zeta/");
  await page.locator(".canvas-link-suggestion").filter({ hasText: "整篇文档" }).click();
  await page.getByRole("menu", { name: "引用显示方式" }).getByRole("button", { name: "正文直显", exact: true }).click();
  await expect(page.locator(".canvas-live-reference")).toHaveCount(2);
  await expect(page.locator(".canvas-live-reference").nth(1)).toContainText("Zeta 参考资料");
  await page.getByRole("button", { name: "编辑块源码" }).click();
  await input.fill("只留下 [[研究/Zeta]]");
  await input.blur();
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.canvasManager.activeId()).references.length)).toBe(1);
  await page.locator('[data-canvas-action="undo"]').click();
  await expect(page.locator(".canvas-live-reference")).toHaveCount(2);
});

test("canvas preserves explicit notebook identity after source rename and failed save keeps the draft", async ({ page }) => {
  await openCanvas(page);
  await page.evaluate(() => {
    window.mockHost.renameDocument("zeta", "Beta");
    window.canvasManager.open(window.canvasManager.activeId());
  });
  await insertLiveBlock(page, "研究/Beta/Zeta 参考资料");
  await page.evaluate(() => {
    window.mockHost.renameDocument("zeta", "新标题");
    window.mockHost.updateSourceBlock("zeta", "z1", "跨笔记本更新");
  });
  await expect(page.locator(".canvas-live-reference")).toContainText("跨笔记本更新");
  await page.getByRole("button", { name: "编辑块源码" }).click();
  const input = page.locator(".canvas-note-text");
  await input.press("Control+End");
  await input.pressSequentially(" suffix");
  await page.evaluate(() => window.mockHost.failNextSave = true);
  await page.locator('[data-document-id="beta"] > .doc-item').click();
  await expect(page.locator(".canvas-view")).toBeVisible();
  await expect(input).toHaveValue(/suffix$/);
  await expect(page.locator(".canvas-save-state")).toHaveText("保存失败");
  await page.getByRole("button", { name: "编辑块源码" }).click();
  await input.press("Control+End");
  await input.pressSequentially(" retry");
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  await page.locator('[data-document-id="beta"] > .doc-item').click();
  await expect(page.locator("#title")).toHaveValue("Beta");
});

test("canvas live previews render source tables and media without editable database controls", async ({ page }, testInfo) => {
  await openCanvas(page);
  await page.evaluate(() => {
    const doc = window.mockHost.docs.get("beta");
    doc.blocks.push({ id: "table", type: "database_table", parentId: null, position: "03000", revision: 1,
      content: { text: "", html: "" }, properties: { databaseId: "db-preview" } });
    doc.blocks.push({ id: "media", type: "media", parentId: null, position: "04000", revision: 1,
      content: { text: "image", html: "", caption: "图片说明", media: { id: "asset", name: "测试图", kind: "image", mimeType: "image/png", size: 0,
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1kAAAAASUVORK5CYII=" } }, properties: {} });
    window.mockHost.databases.set("db-preview", { source: { id: "db-preview", title: "源表格", notebookId: "nb-default",
      fields: [{ id: "f1", databaseId: "db-preview", key: "name", title: "名称", type: "text", position: "001" }], recordCount: 1 },
      records: [{ id: "r1", databaseId: "db-preview", position: "001", values: { name: "表格数据" } }] });
    window.canvasManager.open(window.canvasManager.activeId());
  });
  await page.locator('[data-canvas-action="add"]').click();
  await page.locator(".canvas-note-text").fill("[[Bet");
  await page.locator(".canvas-link-suggestion").filter({ hasText: "Beta" }).click();
  await page.getByRole("menu", { name: "引用显示方式" }).getByRole("button", { name: "正文直显", exact: true }).click();
  const preview = page.locator(".canvas-live-reference");
  await expect(preview.locator("td")).toHaveText("表格数据");
  await expect(preview.locator("img")).toHaveAttribute("alt", "测试图");
  await expect(preview.locator(".database-cell,.database-add-row,.media-resize-handle")).toHaveCount(0);
  await expect(preview.locator("[contenteditable=true]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("canvas-table-media.png") });
});
