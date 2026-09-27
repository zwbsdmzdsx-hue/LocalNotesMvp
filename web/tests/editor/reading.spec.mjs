import { test, expect } from "@playwright/test";

async function makePdf(browser, title) {
  const page = await browser.newPage();
  await page.setContent(`<style>body{font:20px Arial;padding:55px}.next{break-before:page}</style><h1>${title}</h1><p>First page reading sample text.</p><section class="next"><h1>${title} page two</h1><p>Second page highlight sentence.</p></section>`);
  const buffer = await page.pdf({ format: "A4", printBackground: true });
  await page.close();
  return buffer;
}

test("reading note keeps two PDFs open with positioned bookmarks, highlights and notes", async ({ page, browser }, testInfo) => {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept("研究书架"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建读书笔记" }).click();
  await expect(page.locator(".reading-view")).toBeVisible();
  const one = await makePdf(browser, "Book One");
  const two = await makePdf(browser, "Book Two");
  await page.locator(".reading-file-input").setInputFiles([
    { name: "one.pdf", mimeType: "application/pdf", buffer: one },
    { name: "two.pdf", mimeType: "application/pdf", buffer: two }
  ]);
  await expect(page.locator(".reading-book")).toHaveCount(2);
  await expect(page.locator(".reading-pane")).toHaveCount(0);
  await page.locator('.reading-book-cover[aria-label="打开：one"]').click();
  await page.locator('.reading-book-cover[aria-label="打开：two"]').click();
  await expect(page.locator(".reading-pane")).toHaveCount(2);
  await expect.poll(async () => {
    const frame = await page.locator(".reading-view").boundingBox();
    const secondFrame = await page.locator(".reading-pane").last().boundingBox();
    return Math.ceil(secondFrame.x + secondFrame.width - frame.x - frame.width);
  }).toBeLessThanOrEqual(0);
  const first = page.locator(".reading-pane").first();
  const second = page.locator(".reading-pane").last();
  await expect(first.locator(".reading-text-layer")).toContainText("First page reading sample text");
  await expect(second.locator(".reading-text-layer")).toContainText("Book Two");
  await expect(page.locator(".reading-book-cover canvas")).toHaveCount(2);
  const pixels = await first.locator(".reading-pdf-canvas").evaluate(canvas => {
    const context = canvas.getContext("2d");
    return [context.getImageData(10, 10, 1, 1).data.join(","), context.getImageData(200, 200, 1, 1).data.join(",")];
  });
  expect(pixels[0]).not.toBe("0,0,0,0");

  await first.getByRole("button", { name: "下一页" }).click();
  await expect(first.locator(".reading-text-layer")).toContainText("Second page highlight sentence");
  await expect(first.getByLabel("页码：one")).toHaveValue("2");
  await expect(second.getByLabel("页码：two")).toHaveValue("1");
  await first.getByRole("button", { name: "添加书签" }).click();
  await expect(page.locator(".reading-inspector-annotation")).toContainText(["2 页"]);

  await first.getByRole("button", { name: "在读物中添加笔记" }).click();
  await first.locator(".reading-pdf-sheet").click({ position: { x: 120, y: 180 } });
  await page.locator(".reading-inspector").getByLabel("新阅读笔记").fill("这个论点需要对照第二本书");
  await page.locator(".reading-inspector").getByRole("button", { name: "保存笔记" }).click();
  await expect(page.locator(".reading-inspector").getByLabel("注释内容")).toHaveValue("这个论点需要对照第二本书");
  await expect(first.locator(".reading-note-pin")).toHaveCount(1);

  await first.locator(".reading-text-layer").evaluate(layer => {
    const span = [...layer.querySelectorAll("span")].find(item => item.textContent?.includes("Second page highlight sentence"));
    if (!span) throw new Error("PDF text layer missing highlight sentence");
    const range = document.createRange(); range.selectNodeContents(span);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await first.getByRole("button", { name: "高亮所选文字" }).click();
  await expect(first.locator(".reading-highlight-mark")).toHaveCount(1);
  await expect(page.locator(".reading-save-state")).toHaveText("已保存");
  const documentId = await page.evaluate(() => window.mockHost.current);
  const blocks = await page.evaluate(id => window.mockHost.state(id).blocks, documentId);
  const book = blocks.find(block => block.type === "reading_book" && block.content.media.name === "one.pdf");
  const note = blocks.find(block => block.type === "reading_note");
  const highlight = blocks.find(block => block.type === "reading_highlight");
  expect(book).toBeTruthy();
  expect(note.parentId).toBe(book.id);
  expect(note.properties.readingAnchor).toMatchObject({ bookId: book.id, page: 2 });
  expect(note.properties.readingAnchor.x).toBeGreaterThan(0);
  expect(highlight.properties.readingAnchor.rects.length).toBeGreaterThan(0);
  expect(highlight.properties.readingAnchor.quote).toContain("Second page highlight sentence");
  await expect(page.locator('.reading-inbound, .reading-block-links, .reading-annotation-panel')).toHaveCount(0);
  await second.locator('.reading-pane-head strong').click();
  await expect(page.locator('.reading-inspector > header strong')).toHaveText('two');
  await expect(page.locator('.reading-inspector-annotation')).toHaveCount(0);
  for (const tab of ['note', 'bookmark', 'highlight']) {
    await page.locator('[data-reading-inspector-tab="' + tab + '"]').click();
    await expect(page.locator('.reading-inspector-annotation')).toHaveCount(0);
  }
  await first.locator('.reading-pane-head strong').click();
  await expect(page.locator('.reading-inspector > header strong')).toHaveText('one');
  await expect(page.locator('.reading-inspector-annotation')).toHaveCount(1);
  await first.getByRole('button', { name: '在读物中添加笔记' }).click();
  await first.locator('.reading-pdf-sheet').click({ position: { x: 100, y: 150 } });
  await page.getByLabel('新阅读笔记').fill('切换窗口保留的草稿');
  await second.locator('.reading-pane-head strong').click();
  await expect(page.getByLabel('新阅读笔记')).toHaveCount(0);
  await first.locator('.reading-pane-head strong').click();
  await expect(page.getByLabel('新阅读笔记')).toHaveValue('切换窗口保留的草稿');
  await page.locator('.reading-note-composer').getByRole('button', { name: '取消' }).click();
  await first.getByRole("button", { name: "标注面板" }).click();
  await page.locator(".reading-view").screenshot({ path: testInfo.outputPath("reading-desktop.png") });

  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.locator('.doc-item .list-label', { hasText: "研究书架" }).click();
  await expect(page.locator(".reading-book")).toHaveCount(2);
  await expect.poll(() => page.evaluate(id => window.mockHost.state(id).blocks.filter(block => block.type === "reading_note").length, documentId)).toBe(1);
  await page.locator('.reading-book-cover[aria-label="打开：one"]').click();
  await expect(page.locator(".reading-pane")).toHaveCount(1);
  await page.locator('[data-reading-inspector-tab="note"]').click();
  await expect(page.getByLabel("注释内容")).toHaveValue("这个论点需要对照第二本书");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "移除：one" }).click();
  await expect(page.locator(".reading-book")).toHaveCount(1);
  await expect.poll(() => page.evaluate(({ documentId, bookId }) =>
    window.mockHost.state(documentId).blocks.some(block => block.id === bookId || block.parentId === bookId),
  { documentId, bookId: book.id })).toBe(false);
  await page.getByRole("button", { name: "历史记录" }).click();
  await page.locator(".history-entry").nth(1).click();
  await page.getByRole("button", { name: "恢复此版本" }).click();
  await expect(page.locator(".reading-book")).toHaveCount(2);
  await page.locator('.reading-book-cover[aria-label="打开：one"]').click();
  await page.locator('[data-reading-inspector-tab="note"]').click();
  await expect(page.getByLabel("注释内容")).toHaveValue("这个论点需要对照第二本书");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".reading-pane")).toBeVisible();
  await page.locator(".reading-view").screenshot({ path: testInfo.outputPath("reading-mobile.png") });
});

test("reading note keeps unsaved changes in place after a failed save", async ({ page, browser }) => {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept("失败恢复"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建读书笔记" }).click();
  const pdf = await makePdf(browser, "Recovery Book");
  await page.locator(".reading-file-input").setInputFiles({ name: "recovery.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.locator(".reading-save-state")).toHaveText("已保存");
  await expect(page.locator(".reading-book")).toHaveCount(1);
  await page.getByRole("button", { name: "模拟下次保存失败" }).click();
  await page.getByLabel("读书笔记名称").fill("失败后仍保留");
  await page.getByLabel("读书笔记名称").press("Tab");
  await expect(page.locator(".reading-save-state")).toContainText("保存失败");
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await expect(page.locator(".reading-view")).toBeVisible();
  await expect(page.getByLabel("读书笔记名称")).toHaveValue("失败后仍保留");
  await page.locator(".reading-save-state").click();
  await expect(page.locator(".reading-save-state")).toHaveText("已保存");
  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await expect(page.locator(".reading-view")).toBeHidden();
  await page.locator('.doc-item .list-label', { hasText: "失败后仍保留" }).click();
  await expect(page.getByLabel("读书笔记名称")).toHaveValue("失败后仍保留");
  await expect(page.locator(".reading-book")).toHaveCount(1);
});

test("reading shelf opens a PDF from an internet address", async ({ page, browser }) => {
  const pdf = await makePdf(browser, "Remote Book");
  await page.route("https://example.test/book.pdf", route => route.fulfill({
    status: 200, contentType: "application/pdf", headers: { "access-control-allow-origin": "*" }, body: pdf
  }));
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept("网络书架"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建读书笔记" }).click();
  await page.locator('[data-reading-action="url"]').click();
  await page.getByLabel("PDF 地址").fill("https://example.test/book.pdf");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.locator(".reading-book")).toHaveCount(1);
  await expect(page.locator(".reading-pane")).toHaveCount(0);
  await page.locator('.reading-book-cover[aria-label="打开：book"]').click();
  await expect(page.locator(".reading-text-layer")).toContainText("Remote Book");
  await expect(page.locator(".reading-save-state")).toHaveText("已保存");
});

test("reading note pins preview linked annotation content on hover", async ({ page, browser }) => {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept("注释预览"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建读书笔记" }).click();
  const pdf = await makePdf(browser, "Annotation Preview");
  await page.locator(".reading-file-input").setInputFiles({ name: "annotation.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.locator('.reading-book-cover[aria-label="打开：annotation"]').click();
  const pane = page.locator(".reading-pane");
  await pane.getByRole("button", { name: "在读物中添加笔记" }).click();
  await pane.locator(".reading-pdf-sheet").click({ position: { x: 120, y: 180 } });
  await page.getByLabel("新阅读笔记").fill("对照 [[Beta#^b1|产品研究]]");
  await page.getByRole("button", { name: "保存笔记" }).click();
  const pin = pane.locator(".reading-note-pin");
  await expect(pin).toHaveCount(1);
  await pin.hover();
  await expect(page.locator(".reading-note-tooltip")).toContainText("对照");
  await expect(page.locator(".reading-note-tooltip")).toContainText("产品研究");
  await expect(page.locator(".reading-inspector")).toContainText("产品研究");
});

test("non-PDF reading windows use the shared document sheet", async ({ page }) => {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept("多格式阅读"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建读书笔记" }).click();
  await page.locator(".reading-file-input").setInputFiles([
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Markdown\n\n正文") },
    { name: "source.ts", mimeType: "text/plain", buffer: Buffer.from("const answer = 42;") }
  ]);
  await expect(page.locator(".reading-book")).toHaveCount(2);
  await page.locator('.reading-book-cover[aria-label="打开：notes"]').click();
  await page.locator('.reading-book-cover[aria-label="打开：source.ts"]').click();
  await expect(page.locator(".reading-document-sheet")).toHaveCount(2);
  await expect(page.locator(".reading-document-markdown .reading-document-content")).toContainText("Markdown");
  await expect(page.locator(".reading-document-code .reading-document-content")).toContainText("answer = 42");
  await expect(page.locator(".reading-document-sheet").first()).toHaveCSS("background-color", "rgb(255, 255, 255)");
});
