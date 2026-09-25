import { test, expect } from "@playwright/test";

async function createCanvas(page, title) {
  page.once("dialog", dialog => dialog.accept(title));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Canvas" }).click();
  await expect(page.locator(".canvas-view")).toBeVisible();
  await expect(page.locator(".canvas-title")).toHaveValue(title);
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#title")).toHaveValue("Alpha");
});

test("a failed Canvas save keeps the draft when navigating from the dev bar", async ({ page }) => {
  await createCanvas(page, "待保存画布");
  await page.locator('[data-canvas-action="add"]').click();
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  await page.getByRole("button", { name: "编辑块源码" }).click();
  await page.evaluate(() => window.mockHost.failNextSave = true);
  await page.locator(".canvas-node-text textarea").fill("尚未保存的内容");
  await page.locator('[data-doc="beta"]').click();
  await expect(page.locator(".canvas-save-state")).toHaveText("保存失败");
  await expect(page.locator(".canvas-view")).toBeVisible();
  await expect(page.locator(".canvas-node-text textarea")).toHaveValue("尚未保存的内容");
});

test("bookmark plus creates a Canvas with movable resizable cards and history", async ({ page }) => {
  await createCanvas(page, "项目画布");
  await expect(page.locator('.doc-item .list-label', { hasText: "项目画布" })).toBeVisible();

  await page.locator('[data-canvas-action="add"]').click();
  const card = page.locator(".canvas-node-text");
  await expect(card).toBeVisible();
  await card.locator("textarea").fill("可以自由摆放的卡片内容");
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  await page.locator('[data-canvas-action="undo"]').click();
  await expect(page.locator(".canvas-node-text")).toHaveCount(0);
  await page.locator('[data-canvas-action="redo"]').click();
  await expect(card.locator("textarea")).toHaveValue("可以自由摆放的卡片内容");

  const before = await card.boundingBox();
  const grip = card.locator(".canvas-node-grip");
  const gripBox = await grip.boundingBox();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + 120, gripBox.y + 80, { steps: 6 });
  await page.mouse.up();
  const moved = await card.boundingBox();
  expect(moved.x).toBeGreaterThan(before.x + 70);
  expect(moved.y).toBeGreaterThan(before.y + 40);

  const handle = card.locator(".canvas-resize-handle");
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + 5, handleBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 90, handleBox.y + 65, { steps: 5 });
  await page.mouse.up();
  const resized = await card.boundingBox();
  expect(resized.width).toBeGreaterThan(moved.width + 50);
  expect(resized.height).toBeGreaterThan(moved.height + 35);

  await page.keyboard.press("Control+z");
  await expect(card).toBeVisible();
  await page.keyboard.press("Control+y");
  await expect(card).toBeVisible();

  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await expect(page.locator("#title")).toBeVisible();
  await page.locator('.doc-item .list-label', { hasText: "项目画布" }).click();
  await expect(page.locator(".canvas-node-text textarea")).toHaveValue("可以自由摆放的卡片内容");
});

test("documents can be dragged into a Canvas as resizable live previews", async ({ page }) => {
  await createCanvas(page, "资料板");
  await page.dragAndDrop('[data-document-id="beta"] > .doc-item', ".canvas-viewport", { targetPosition: { x: 430, y: 300 } });
  const preview = page.locator(".canvas-node-document");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Beta 文档中的其他块");

  const before = await preview.boundingBox();
  const handleBox = await preview.locator(".canvas-resize-handle").boundingBox();
  await page.mouse.move(handleBox.x + 4, handleBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 75, handleBox.y + 55, { steps: 5 });
  await page.mouse.up();
  const after = await preview.boundingBox();
  expect(after.width).toBeGreaterThan(before.width + 40);
  expect(after.height).toBeGreaterThan(before.height + 30);

  await preview.getByRole("button", { name: "打开Beta" }).click();
  await expect(page.locator("#title")).toHaveValue("Beta");
});

test("Canvas block grip opens a folded node menu and persists font size", async ({ page }) => {
  await createCanvas(page, "节点菜单画布");
  await page.locator('[data-canvas-action="add"]').click();
  const card = page.locator(".canvas-node-text").first();
  await card.locator("textarea").fill("菜单内容");
  await card.locator(".canvas-node-grip").click();
  const menu = page.getByRole("menu", { name: /正文块操作/ });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "增大字号" }).click();
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes[0]?.fontSize)).toBe(16);
  await expect(card.locator(".canvas-node-body")).toHaveCSS("font-size", "16px");
  await card.locator(".canvas-node-grip").click();
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "重置字号" }).click();
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes[0]?.fontSize)).toBeUndefined();
});

test("Canvas reference blocks can switch to a custom Icon from the grip menu", async ({ page }) => {
  await createCanvas(page, "引用 Icon 画布");
  await page.locator('[data-canvas-action="add"]').click();
  const card = page.locator(".canvas-node-text").first();
  const input = card.locator("textarea");
  await input.fill("[[Bet");
  await page.locator(".canvas-link-suggestion").filter({ hasText: "Beta" }).first().click();
  await page.getByRole("menu", { name: "引用显示方式" }).getByRole("button", { name: "仅标题链接", exact: true }).click();
  await input.blur();
  await card.locator(".canvas-node-grip").click();
  const menu = page.getByRole("menu", { name: /正文块操作/ });
  await menu.getByRole("menuitem", { name: "显示自定义 Icon" }).click();
  await expect(card).toHaveClass(/reference-icon-mode/);
  await expect(card.locator(".canvas-reference-icon")).toBeVisible();
  await card.locator(".canvas-node-grip").click();
  page.once("dialog", dialog => dialog.accept("★"));
  await menu.locator("button").filter({ hasText: "设置引用 Icon" }).click();
  await expect(card.locator(".canvas-reference-icon > span")).toHaveText("★");
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes[0]?.referenceIcon)).toBe("★");
});

test("nested Canvas links support preview and icon modes without recursive cycles", async ({ page }) => {
  await createCanvas(page, "Canvas A");
  await createCanvas(page, "Canvas B");

  await page.dragAndDrop('.doc-item:has(.list-label:text-is("Canvas A"))', ".canvas-viewport", { targetPosition: { x: 390, y: 280 } });
  const nested = page.locator(".canvas-node-canvas");
  await expect(nested).toBeVisible();
  await expect(nested.locator(".canvas-miniature")).toBeVisible();
  await nested.locator(".canvas-node-mode").click();
  await expect(nested).toHaveClass(/icon-mode/);
  const iconBox = await nested.boundingBox();
  expect(Math.round(iconBox.width)).toBe(112);
  expect(Math.round(iconBox.height)).toBe(112);

  await nested.getByRole("button", { name: "打开Canvas A" }).click();
  await expect(page.locator(".canvas-title")).toHaveValue("Canvas A");
  await page.dragAndDrop('.doc-item:has(.list-label:text-is("Canvas B"))', ".canvas-viewport", { targetPosition: { x: 360, y: 260 } });
  await expect(page.locator(".canvas-node-canvas")).toHaveCount(0);
});

test("Canvas shares the right sidebar history and toolbar undo/redo", async ({ page }) => {
  await createCanvas(page, "历史画布");
  await page.locator('[data-canvas-action="add"]').click();
  await page.locator(".canvas-node-text textarea").fill("Canvas 历史内容");
  await page.locator('[data-pane-btn="history"]').click();
  await expect(page.locator("#history-list")).toContainText("Canvas");
  await expect(page.locator('[data-canvas-action="undo"]')).toBeEnabled();
  await page.locator('[data-canvas-action="undo"]').click();
  await expect(page.locator(".canvas-node-text")).toHaveCount(0);
  await page.locator('[data-canvas-action="redo"]').click();
  await expect(page.locator(".canvas-node-text textarea")).toHaveValue("Canvas 历史内容");
});

test("Canvas participates in toolbar back and forward navigation", async ({ page }) => {
  await createCanvas(page, "导航画布");
  await page.locator('[data-canvas-action="add"]').click();
  await page.locator(".canvas-node-text textarea").fill("可恢复的布局");
  await page.locator('[data-doc="alpha"]').click();
  await expect(page.locator("#title")).toHaveValue("Alpha");
  await page.locator("#navigate-back").click();
  await expect(page.locator(".canvas-title")).toHaveValue("导航画布");
  await expect(page.locator(".canvas-node-text textarea")).toHaveValue("可恢复的布局");
  await page.locator("#navigate-forward").click();
  await expect(page.locator("#title")).toHaveValue("Alpha");
});

test("Canvas supports hand-drawn strokes and responsive block wrapping", async ({ page }) => {
  await createCanvas(page, "手绘画布");
  await page.locator('[data-canvas-action="draw"]').click();
  const viewport = await page.locator(".canvas-viewport").boundingBox();
  await page.mouse.move(viewport.x + 360, viewport.y + 260);
  await page.mouse.down();
  await page.mouse.move(viewport.x + 420, viewport.y + 300, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".canvas-viewport")).toHaveClass(/draw-mode/);
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.filter(node => node.kind === "draw").length)).toBe(1);

  await page.locator('[data-canvas-action="add"]').click();
  const textarea = page.locator(".canvas-node-text textarea");
  await textarea.fill("一段很长的文字用于验证 Canvas 块会根据当前宽度自动换行显示，而不是把内容横向撑出块边界。");
  await expect.poll(() => textarea.evaluate(element => getComputedStyle(element).overflowWrap)).toBe("anywhere");
});

test("Canvas curves snap to block edge midpoints and expose Bezier styling", async ({ page }) => {
  await createCanvas(page, "曲线画布");
  await page.locator('[data-canvas-action="add"]').click();
  await page.locator('[data-canvas-action="add"]').click();
  const blocks = page.locator(".canvas-node-text");
  await expect(blocks).toHaveCount(2);
  await page.locator('[data-canvas-action="curve"]').click();
  await expect(page.locator('[data-canvas-action="curve"]')).toHaveClass(/active/);
  await blocks.nth(0).click();
  await expect(page.locator(".canvas-save-state")).toHaveText("请选择曲线终点");
  await blocks.nth(1).click();
  await expect(page.locator(".canvas-curve-style")).toBeVisible();
  await page.locator(".canvas-curve-style select").selectOption("dashed");
  await page.locator(".canvas-curve-style input[type=text]").fill("流程说明");
  await expect.poll(() => page.evaluate(() => {
    const canvas = window.mockHost.canvas(window.mockHost.current);
    return canvas?.nodes.find(node => node.kind === "curve")?.curve?.dash;
  })).toBe("dashed");
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.find(node => node.kind === "curve")?.curve?.label)).toBe("流程说明");
  await expect(page.locator(".canvas-curve-label")).toHaveText("流程说明");
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.filter(node => node.kind === "curve").length)).toBe(1);
  await expect(page.locator(".canvas-connections path.canvas-connection-visible")).toHaveCount(1);
  await page.locator(".canvas-viewport").click({ position: { x: 18, y: 500 } });
  await expect(page.locator(".canvas-curve-style")).toHaveCount(0);
});

test("Canvas document nodes show hover previews", async ({ page }) => {
  await createCanvas(page, "文档 Icon 预览画布");
  await page.dragAndDrop('.doc-item:has(.list-label:text-is("Beta"))', ".canvas-viewport", { targetPosition: { x: 390, y: 280 } });
  const documentNode = page.locator(".canvas-node-document");
  await documentNode.locator(".canvas-node-grip").click();
  await page.getByRole("menu", { name: /Beta操作/ }).getByRole("menuitem", { name: "显示为 Icon" }).click();
  await documentNode.hover();
  await expect(page.locator(".canvas-icon-hover-preview")).toBeVisible();
  await expect(page.locator(".canvas-icon-hover-preview")).toContainText("Beta");
});

test("Canvas document previews support heading section folding", async ({ page }) => {
  await createCanvas(page, "文档标题折叠画布");
  await page.evaluate(() => {
    const doc = window.mockHost.docs.get("beta");
    const block = (id, type, markdown, position, headingLevel) => ({ id, type, parentId: null, position, revision: 1, content: { text: markdown, html: markdown, markdown }, properties: headingLevel ? { headingLevel } : {} });
    doc.blocks = [block("h1", "heading", "# 第一节", "001", 1), block("p1", "paragraph", "第一节正文", "002"), block("h2", "heading", "# 第二节", "003", 1), block("p2", "paragraph", "第二节正文", "004")];
  });
  await page.dragAndDrop('.doc-item:has(.list-label:text-is("Beta"))', ".canvas-viewport", { targetPosition: { x: 390, y: 280 } });
  const preview = page.locator(".canvas-node-document");
  await expect(preview.locator(".canvas-document-line")).toHaveCount(4);
  await preview.locator(".canvas-heading-collapse-toggle").first().click();
  await expect(preview.locator(".canvas-document-line").nth(1)).toBeHidden();
  await expect(preview.locator(".canvas-document-line").nth(2)).toBeVisible();
});

test("Canvas accepts dropped media and persists a unified preview node", async ({ page }) => {
  await createCanvas(page, "媒体画布");
  const chooser = page.waitForEvent("filechooser");
  await page.locator('[data-canvas-action="media"]').click();
  await (await chooser).setFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
  await expect(page.locator(".canvas-node-media img")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.find(node => node.kind === "media")?.block?.content.media?.name)).toBe("pixel.png");
  expect(await page.evaluate(() => {
    const id = window.mockHost.current;
    const node = window.mockHost.canvas(id).nodes.find(item => item.kind === "media");
    const block = window.mockHost.state(id).blocks.find(item => item.id === node.id);
    return { type: block?.type, name: block?.content.media?.name, legacyMedia: Object.hasOwn(node, "media") };
  })).toEqual({ type: "media", name: "pixel.png", legacyMedia: false });
});

test("legacy Canvas media is read as a block with its caption", async ({ page }) => {
  await page.goto("/");
  const media = await page.evaluate(() => {
    const node = window.mockHost.canvas("canvas-roadmap").nodes.find(item => item.id === "canvas-roadmap-cover");
    const block = window.mockHost.state("canvas-roadmap").blocks.find(item => item.id === node.id);
    return { nodeType: node.block?.type, caption: node.block?.content.caption, indexedType: block?.type, legacyMedia: Object.hasOwn(node, "media") };
  });
  expect(media).toEqual({ nodeType: "media", caption: "路线图视觉卡片", indexedType: "media", legacyMedia: false });
});

test("mixed legacy Canvas media keeps its block and moves old media fields", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { normalizeCanvasNode } = await import("/src/workspace-api.ts");
    const media = { id: "asset", kind: "image", name: "cover.png", mimeType: "image/png", size: 1, url: "https://example.test/cover.png" };
    const node = normalizeCanvasNode({ id: "cover", kind: "media", x: 0, y: 0, width: 300, height: 200, zIndex: 1,
      media, caption: "旧说明", block: { id: "cover", parentId: null, position: "00001000", type: "media", content: { text: "", html: "" }, properties: {}, revision: 3 } });
    return { media: node.block?.content.media, caption: node.block?.content.caption, revision: node.block?.revision, hasLegacy: "media" in node || "caption" in node };
  });
  expect(result).toEqual({ media: { id: "asset", kind: "image", name: "cover.png", mimeType: "image/png", size: 1, url: "https://example.test/cover.png" }, caption: "旧说明", revision: 3, hasLegacy: false });
});

test("Canvas media caption edits persist in the shared block", async ({ page }) => {
  await createCanvas(page, "媒体说明画布");
  page.once("dialog", dialog => dialog.accept("https://cdn.example.test/photo.png"));
  await page.locator('[data-canvas-action="media-url"]').click();
  await page.locator(".canvas-node-media .canvas-node-grip").click();
  page.once("dialog", dialog => dialog.accept("项目封面"));
  await page.getByText("编辑说明", { exact: true }).click();
  await expect(page.locator(".canvas-media-caption")).toHaveText("项目封面");
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.locator('.doc-item .list-label', { hasText: "媒体说明画布" }).click();
  await expect(page.locator(".canvas-media-caption")).toHaveText("项目封面");
  expect(await page.evaluate(() => window.mockHost.state(window.mockHost.current).blocks.find(block => block.type === "media")?.content.caption)).toBe("项目封面");
});

test("editing a seeded Canvas with a legacy curve envelope saves and navigates", async ({ page }) => {
  await page.locator(".bk-strip").filter({ hasText: "项目" }).click();
  await page.locator('[data-document-id="canvas-roadmap"] > .doc-item').click();
  await expect(page.locator(".canvas-view")).toBeVisible();
  await page.locator(".canvas-node-block").first().getByRole("button", { name: "编辑块源码" }).click();
  await page.locator(".canvas-note-text:visible").first().fill("更新路线图内容");
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  await page.locator(".bk-strip").filter({ hasText: "收集" }).click();
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await expect(page.locator("#title")).toHaveValue("Alpha");
});
