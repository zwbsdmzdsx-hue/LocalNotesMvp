import { test, expect } from "@playwright/test";

async function createCanvas(page, title) {
  page.once("dialog", dialog => dialog.accept(title));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Canvas" }).click();
  await expect(page.locator(".canvas-view")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#title")).toHaveValue("Alpha");
});

test("Canvas inserts and previews a remote media URL", async ({ page }) => {
  await createCanvas(page, "网络媒体画布");
  page.once("dialog", dialog => dialog.accept("https://cdn.example.test/photo.png"));
  await page.locator('[data-canvas-action="media-url"]').click();
  await expect(page.locator(".canvas-node-media img")).toHaveAttribute("src", "https://cdn.example.test/photo.png");
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.find(node => node.kind === "media")?.block?.content.media?.url)).toBe("https://cdn.example.test/photo.png");
});

test("Canvas document previews render source media blocks", async ({ page }) => {
  await createCanvas(page, "引用媒体预览");
  await page.evaluate(() => {
    const doc = window.mockHost.docs.get("beta");
    doc.blocks.push({ id: "beta-media", parentId: null, position: "99990000", type: "media", revision: 1,
      content: { text: "", html: "", markdown: "", media: { id: "remote", kind: "image", name: "remote.png", mimeType: "image/png", size: 0, url: "https://cdn.example.test/remote.png" }, caption: "远程图片" }, properties: {} });
  });
  await page.dragAndDrop('[data-document-id="beta"] > .doc-item', ".canvas-viewport", { targetPosition: { x: 420, y: 280 } });
  const preview = page.locator(".canvas-node-document");
  await expect(preview.locator("img")).toHaveAttribute("src", "https://cdn.example.test/remote.png");
  await expect(preview).toContainText("远程图片");
});

test("Canvas supports uploaded custom icons and curve branches", async ({ page }) => {
  await createCanvas(page, "高级画布操作");
  await page.dragAndDrop('[data-document-id="beta"] > .doc-item', ".canvas-viewport", { targetPosition: { x: 400, y: 260 } });
  const documentNode = page.locator(".canvas-node-document");
  await documentNode.locator(".canvas-node-grip").click();
  const menu = page.getByRole("menu", { name: /Beta操作/ });
  const iconChooser = page.waitForEvent("filechooser");
  await menu.getByRole("menuitem", { name: "上传自定义 Icon" }).click();
  await (await iconChooser).setFiles({ name: "icon.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><circle cx=\"4\" cy=\"4\" r=\"4\"/></svg>") });
  await expect(documentNode).toHaveClass(/icon-mode/);
  await expect(documentNode.locator(".canvas-custom-icon-image")).toBeVisible();

  await page.locator('[data-canvas-action="add"]').click();
  await page.locator('[data-canvas-action="add"]').click();
  await page.locator('[data-canvas-action="curve"]').click();
  const blocks = page.locator(".canvas-node-text");
  await blocks.nth(0).click();
  await blocks.nth(1).click();
  await page.locator(".canvas-curve-style").getByRole("button", { name: "终点箭头", exact: true }).click();
  await page.locator(".canvas-curve-style").getByRole("button", { name: "插入控制点" }).click();
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.find(node => node.kind === "curve")?.curve?.arrow)).toBe("end");
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.find(node => node.kind === "curve")?.curve?.controlPoints?.length)).toBe(1);
  await page.locator(".canvas-curve-style").getByRole("button", { name: "添加分支点" }).click();
  await documentNode.click();
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.find(node => node.kind === "curve")?.curve?.branches?.length)).toBe(1);
  await page.locator('path.canvas-connection-visible[data-node-id^="canvas-curve"]').first().evaluate(element => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.locator(".canvas-curve-style").getByRole("button", { name: "删除曲线" }).click();
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.filter(node => node.kind === "curve").length)).toBe(0);
});

test("Canvas groups rapid text saves into one history entry", async ({ page }) => {
  await createCanvas(page, "历史分组画布");
  await page.locator('[data-canvas-action="add"]').click();
  const input = page.locator(".canvas-node-text textarea");
  await expect(page.locator(".canvas-save-state")).toHaveText("已保存");
  const before = await page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.history?.entries.length ?? 0);
  await input.fill("第一段");
  await page.waitForTimeout(550);
  await input.fill("第一段继续");
  await page.waitForTimeout(550);
  const after = await page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.history?.entries.length ?? 0);
  expect(after - before).toBeLessThanOrEqual(1);
});
