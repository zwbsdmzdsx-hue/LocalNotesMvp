import { test, expect } from "@playwright/test";

async function makePdf(browser) {
  const page = await browser.newPage();
  await page.setContent("<h1>Reference Book</h1><p>Cross document evidence.</p>");
  const buffer = await page.pdf({ format: "A4" });
  await page.close();
  return buffer;
}

async function createReadingNote(page, browser) {
  page.once("dialog", dialog => dialog.accept("跨文档书架"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建读书笔记" }).click();
  await page.locator(".reading-file-input").setInputFiles({ name: "reference.pdf", mimeType: "application/pdf", buffer: await makePdf(browser) });
  await expect(page.locator(".reading-pane")).toHaveCount(0);
  await page.locator('.reading-book-cover[aria-label="打开：reference"]').click();
  await expect(page.locator(".reading-text-layer")).toContainText("Cross document evidence");
  await page.getByRole("button", { name: "在读物中添加笔记" }).click();
  await page.locator(".reading-pdf-sheet").click({ position: { x: 90, y: 120 } });
  await page.getByLabel("新阅读笔记").fill("跨文档笔记");
  await page.getByRole("button", { name: "保存笔记" }).click();
  await expect(page.locator(".reading-save-state")).toHaveText("已保存");
  return page.evaluate(() => {
    const state = window.mockHost.state(window.mockHost.current);
    return { readingId: state.note.id, noteId: state.blocks.find(block => block.type === "reading_note").id,
      bookId: state.blocks.find(block => block.type === "reading_book").id };
  });
}

async function openReadingNotes(page) {
  await page.locator('[data-reading-inspector-tab="note"]').click();
}

test("reading and Canvas blocks reference each other with source block backlinks", async ({ page, browser }) => {
  test.setTimeout(30000);
  await page.goto("/");
  const { readingId, noteId, bookId } = await createReadingNote(page, browser);
  await openReadingNotes(page);
  const note = page.locator(`.reading-inspector-annotation[data-annotation-id="${noteId}"]`);
  await note.getByLabel("注释内容").fill("跨文档笔记 [[默认笔记本/Beta/");
  await page.locator('.reading-link-suggestion[data-block-id="b1"]').click();
  await expect(page.locator(".reading-save-state")).toHaveText("已保存");
  expect(await page.evaluate(({ readingId, noteId }) => window.mockHost.state(readingId).blocks
    .find(block => block.id === noteId).content.links[0].targetBlockId, { readingId, noteId })).toBe("b1");

  await page.locator('[data-document-id="beta"] > .doc-item').click();
  await page.locator('[data-own-block][data-id="b1"] .grip').click();
  await page.locator('.block-menu').getByRole('button', { name: '查看引用此块' }).click();
  await expect(page.locator('#backlinks-section')).toBeVisible();
  expect(await page.locator('.backlink-card').evaluateAll(cards =>
    cards.length > 0 && cards.every(card => card.dataset.sourceId.endsWith(':b1')))).toBe(true);
  await page.locator('[data-pane-btn="backlinks"]').click();
  const incoming = page.locator(`.backlink-card[data-source-id^="${readingId}:${noteId}:"]`);
  await expect(incoming).toContainText("跨文档书架");
  await incoming.getByRole("button", { name: "打开" }).click();
  await expect(page.locator(".reading-view")).toBeVisible();
  await openReadingNotes(page);
  await expect(page.locator(`.reading-inspector-annotation[data-annotation-id="${noteId}"]`)).toBeVisible();

  page.once("dialog", dialog => dialog.accept("跨类型画布"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Canvas" }).click();
  const canvasId = await page.evaluate(() => window.canvasManager.activeId());
  await page.locator('[data-canvas-action="add"]').click();
  await page.locator(".canvas-note-text").fill("[[默认笔记本/跨文档书架/跨文档笔记");
  await page.locator(`.canvas-link-suggestion[data-block-id="${noteId}"]`).click();
  await page.getByRole("menu", { name: "引用显示方式" }).getByRole("button", { name: "正文直显" }).click();
  await expect(page.locator(".canvas-live-reference")).toContainText("跨文档笔记");
  await page.locator('[data-canvas-action="add"]').click();
  await page.locator('.canvas-note-text').last().fill('[[默认笔记本/跨文档书架/reference');
  await page.locator(`.canvas-link-suggestion[data-block-id="${bookId}"]`).click();
  await page.getByRole('menu', { name: '引用显示方式' }).getByRole('button', { name: '正文直显' }).click();
  await expect(page.locator('.canvas-live-reference iframe')).toBeVisible();
  const sourceBlockId = await page.evaluate(id => window.mockHost.state(id).blocks.find(block => block.content.links?.some(link => link.targetBlockId))?.id, canvasId);
  await page.locator(`[data-document-id="${readingId}"] > .doc-item`).click();
  await page.locator('[data-pane-btn="backlinks"]').click();
  const canvasBacklink = page.locator(`.backlink-card[data-source-id^="${canvasId}:${sourceBlockId}:"]`);
  await expect(canvasBacklink).toContainText("跨类型画布");
  await expect(canvasBacklink).toContainText("指向：跨文档笔记");
  await canvasBacklink.getByRole("button", { name: "打开" }).click();
  await expect(page.locator(`.canvas-node[data-node-id="${sourceBlockId}"].selected`)).toBeVisible();
  await page.locator(`[data-document-id="${readingId}"] > .doc-item`).click();
  await page.locator('.reading-book-cover').click();
  await openReadingNotes(page);
  const readingNote = page.locator(`.reading-inspector-annotation[data-annotation-id="${noteId}"]`);
  await readingNote.getByLabel('注释内容').fill('跨文档笔记 [[默认笔记本/跨类型画布/');
  await page.locator('.reading-link-suggestion[data-block-id="' + sourceBlockId + '"]').click();
  await expect(page.locator('.reading-save-state')).toHaveText('已保存');
  await page.locator(`[data-document-id="${canvasId}"] > .doc-item`).click();
  await page.locator(`.canvas-node[data-node-id="${sourceBlockId}"] .canvas-node-grip`).click();
  await page.getByRole('menuitem', { name: '查看引用此块' }).click();
  await expect(page.locator('#backlinks-section')).toBeVisible();
  await expect(page.locator(`.backlink-card[data-source-id^="${readingId}:${noteId}:"]`)).toHaveCount(1);
});

test("Dashboard widgets can link to reading blocks and be linked back", async ({ page, browser }) => {
  await page.goto("/");
  const { readingId, noteId, bookId } = await createReadingNote(page, browser);
  page.once("dialog", dialog => dialog.accept("引用看板"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Dashboard" }).click();
  const dashboardId = await page.evaluate(() => window.mockHost.current);
  const widget = page.locator(".dashboard-widget").first();
  const widgetId = await widget.getAttribute("data-widget-id");
  await widget.click();
  await page.locator('[data-pane-btn="dashboard-config"]').click();
  const settings = page.locator('[data-slot="dashboard-config"]');
  await settings.getByLabel("引用目标文档").selectOption(readingId);
  await settings.getByLabel("引用目标块").selectOption(noteId);
  await settings.getByRole("button", { name: "引用选中的块" }).click();
  await expect(page.locator(".dashboard-save-state")).toHaveText("已保存");
  expect(await page.evaluate(({ dashboardId, widgetId }) => window.mockHost.state(dashboardId).blocks
    .find(block => block.id === widgetId).content.links[0].targetBlockId, { dashboardId, widgetId })).toBe(noteId);

  await page.locator(`[data-document-id="${readingId}"] > .doc-item`).click();
  await page.locator('[data-pane-btn="backlinks"]').click();
  await expect(page.locator(`.backlink-card[data-source-id^="${dashboardId}:${widgetId}:"]`)).toContainText("引用看板");
  await page.locator('.reading-book-cover').click();
  await openReadingNotes(page);
  const noteInspector = page.locator(`.reading-inspector-annotation[data-annotation-id="${noteId}"]`);
  await noteInspector.getByLabel('注释内容').fill('跨文档笔记 [[默认笔记本/引用看板/');
  await page.locator('.reading-link-suggestion[data-block-id="' + widgetId + '"]').click();
  await expect(page.locator(".reading-save-state")).toHaveText("已保存");
  await page.locator(`[data-document-id="${dashboardId}"] > .doc-item`).click();
  await widget.click();
  await page.locator('[data-pane-btn="dashboard-config"]').click();
  await expect(page.locator('[data-slot="dashboard-config"] .dashboard-inbound')).toHaveText("被引用 1");
  await page.locator('[data-slot="dashboard-config"] .dashboard-inbound').click();
  await expect(page.locator(`.backlink-card[data-source-id^="${readingId}:${noteId}:"]`)).toContainText("指向：实时引用");
  expect(bookId).toBeTruthy();
});

test("a document body links to a reading note by block ID", async ({ page, browser }) => {
  await page.goto('/');
  const { readingId, noteId } = await createReadingNote(page, browser);
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  const source = page.locator('[data-own-block][data-id="a1"] .block-text');
  await source.fill('[[默认笔记本/跨文档书架/跨文档笔记');
  await page.locator(`.link-suggestion[data-block-id="${noteId}"]`).click();
  await expect.poll(() => page.evaluate(id => window.mockHost.state('alpha').blocks
    .find(block => block.id === 'a1').content.links.some(link => link.targetBlockId === id), noteId)).toBe(true);
  await page.locator(`[data-document-id="${readingId}"] > .doc-item`).click();
  await page.locator('.reading-book-cover').click();
  await openReadingNotes(page);
  const note = page.locator(`.reading-inspector-annotation[data-annotation-id="${noteId}"]`);
  await page.getByRole('button', { name: '反向链接', exact: true }).click();
  await expect(page.locator('#backlinks-section')).toBeVisible();
  await expect(page.locator('.backlink-card[data-source-id^="alpha:a1:"]')).toContainText('指向：跨文档笔记');
});

test("document links render reading bookmark, highlight and note blocks", async ({ page, browser }) => {
  await page.goto('/');
  const { readingId, noteId, bookId } = await createReadingNote(page, browser);
  const pane = page.locator('.reading-pane');
  await pane.getByRole('button', { name: '添加书签' }).click();
  await expect(page.locator('.reading-save-state')).toHaveText('已保存');
  await pane.locator('.reading-text-layer').evaluate(layer => {
    const span = [...layer.querySelectorAll('span')].find(item => item.textContent?.includes('Cross document evidence'));
    if (!span) throw new Error('reading text layer missing highlight target');
    const range = document.createRange(); range.selectNodeContents(span);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await pane.getByRole('button', { name: '高亮所选文字' }).click();
  await expect(page.locator('.reading-save-state')).toHaveText('已保存');
  const ids = await page.evaluate(id => {
    const blocks = window.mockHost.state(id).blocks;
    return {
      bookmarkId: blocks.find(block => block.type === 'reading_bookmark').id,
      highlightId: blocks.find(block => block.type === 'reading_highlight').id,
      noteId: blocks.find(block => block.type === 'reading_note').id
    };
  }, readingId);
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  const source = page.locator('[data-own-block][data-id="a1"] .block-text');
  await source.fill('[[默认笔记本/跨文档书架/');
  await expect(page.locator(`.link-suggestion[data-block-id="${ids.bookmarkId}"]`)).toBeVisible();
  await page.locator(`.link-suggestion[data-block-id="${ids.bookmarkId}"]`).click();
  await source.press('Tab');
  await page.locator('.wiki-link').hover();
  await expect(page.locator('.link-preview .reading-reference-preview')).toContainText('书签');
  await expect(page.locator('.link-preview .reading-reference-preview')).toContainText('第 1 页');
  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  const linked = page.locator('.linked-reference-entry').filter({ hasText: '跨文档书架' });
  await linked.locator('.reference-mode-menu').click();
  await page.getByRole('menu').getByRole('button', { name: '正文直显' }).click();
  await expect(page.locator('#blocks .reference-card .reading-reference-preview')).toContainText('书签');

  await page.locator('[data-document-id="' + readingId + '"] > .doc-item').click();
  await page.locator('.reading-book-cover').click();
  await page.locator('[data-reading-inspector-tab="note"]').click();
  const note = page.locator(`.reading-inspector-annotation[data-annotation-id="${ids.noteId}"]`);
  await note.getByLabel('注释内容').fill('附带高亮 [[默认笔记本/跨文档书架/');
  await expect(page.locator(`.reading-link-suggestion[data-block-id="${ids.highlightId}"]`)).toBeVisible();
  await page.locator(`.reading-link-suggestion[data-block-id="${ids.highlightId}"]`).click();
  await expect(note.locator('.reading-annotation-preview')).toContainText('高亮');
  await expect(note.locator('.reading-annotation-preview')).toContainText('Cross document evidence');
  expect(bookId).toBeTruthy();
});


test("reading annotations share reference modes, calendar inserts and location inserts", async ({ page, browser }, testInfo) => {
  test.setTimeout(45000);
  await page.goto('/');
  await page.locator('[data-pane-btn="calendar"]').click();
  await page.locator('.calendar-create').click();
  await page.locator('.calendar-create-popup').getByRole('button', { name: '创建' }).click();
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  const { readingId, noteId, bookId } = await createReadingNote(page, browser);
  const input = page.getByLabel('注释内容');
  await input.fill('前文 [[Bet');
  await expect(page.getByRole('listbox', { name: '插入引用' })).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('前文 [[默认笔记本/Beta]]');
  await input.press('End');
  await input.pressSequentially(' 后文');
  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  const refs = page.locator('#reference-sidebar-section');
  await expect(refs).toBeVisible();
  await expect(refs).toContainText('Beta');
  await refs.locator('.linked-reference-entry .reference-mode-menu').click();
  await page.locator('.block-menu').getByRole('button', { name: '右侧分栏', exact: true }).click();
  await expect(refs.locator('.reference-card[data-reference-id]')).toBeVisible();
  await expect(input).toHaveValue('前文 [[默认笔记本/Beta]] 后文');
  await input.press('End');
  await input.pressSequentially(' 更新');
  await expect(page.locator('.reading-save-state')).toHaveText('已保存');
  await expect.poll(() => page.evaluate(id => window.mockHost.state(id).references[0]?.mode, readingId)).toBe('sidebar');

  await input.focus(); await input.press('End');
  await page.locator('[data-pane-btn="calendar"]').click();
  await page.locator('.calendar-day.selected').click();
  await page.locator('.calendar-insert-link').click();
  await expect(input).toHaveValue(/更新\[\[/);
  await expect(page.locator('.reading-save-state')).toHaveText('已保存');
  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  await expect(refs.locator('.reference-document-group')).toHaveCount(2);

  await page.locator('[data-pane-btn="locations"]').click();
  await page.locator('.location-card').filter({ hasText: '默认办公点' }).getByRole('button', { name: '插入正文' }).click();
  await expect(page.locator('.reading-inspector')).toContainText('默认办公点');
  await expect(page.locator('.reading-save-state')).toHaveText('已保存');
  const location = await page.evaluate(id => window.mockHost.state(id).blocks.find(block => block.type === 'location'), readingId);
  expect(location.parentId).toBe(bookId);
  expect(location.properties.locationId).toBe('loc-default-office');
  expect(location.properties.readingAnchor.bookId).toBe(bookId);
  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  await page.screenshot({ path: testInfo.outputPath('reading-shared-panels.png') });
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.locator('[data-document-id="' + readingId + '"] > .doc-item').click();
  await page.locator('.reading-book-cover').click();
  await page.locator('[data-reading-inspector-tab="note"]').click();
  await expect(page.getByLabel('注释内容')).toHaveValue(/更新\[\[/);
  await expect(page.locator('.reading-inspector')).toContainText('默认办公点');
});
