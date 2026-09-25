import { test, expect } from "@playwright/test";

async function createCanvas(page) {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept("交互画布"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Canvas" }).click();
  await expect(page.locator(".canvas-view")).toBeVisible();
}

test("Canvas object properties live in the right panel and both lower corners resize", async ({ page }) => {
  await createCanvas(page);
  await page.locator('[data-canvas-action="add"]').click();
  const card = page.locator(".canvas-node-text");
  const panel = page.locator('[data-panel="canvas-config"]');
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-pane-btn="canvas-config"]')).toHaveClass(/active/);
  await expect(panel.locator(".canvas-object-settings input")).toHaveCount(6);
  await expect(card.locator(".canvas-resize-handle")).toHaveCount(2);

  const before = await card.boundingBox();
  const head = await card.locator(".canvas-node-label").boundingBox();
  await page.mouse.move(head.x + 10, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + 80, head.y + 30, { steps: 5 });
  await page.mouse.up();
  const moved = await card.boundingBox();
  expect(moved.x).toBeGreaterThan(before.x + 40);

  const left = await card.locator(".canvas-resize-left").boundingBox();
  await page.mouse.move(left.x + left.width / 2, left.y + left.height / 2);
  await page.mouse.down();
  await page.mouse.move(left.x - 45, left.y + 40, { steps: 5 });
  await page.mouse.up();
  const resized = await card.boundingBox();
  expect(resized.x).toBeLessThan(moved.x - 20);
  expect(resized.width).toBeGreaterThan(moved.width + 20);
  expect(resized.height).toBeGreaterThan(moved.height + 20);
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.find(node => node.kind === "block")?.width)).toBeGreaterThan(moved.width + 20);
});

test("Canvas highlights its edge and accepts dropped and pasted remote or local media", async ({ page }) => {
  await createCanvas(page);
  const viewport = page.locator(".canvas-viewport");
  const box = await viewport.boundingBox();
  const remote = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/uri-list", "https://example.com/cover.png");
    return transfer;
  });
  const point = { clientX: box.x + 250, clientY: box.y + 220 };
  await viewport.dispatchEvent("dragover", { dataTransfer: remote, ...point });
  await expect(viewport).toHaveClass(/drop-active/);
  await viewport.dispatchEvent("drop", { dataTransfer: remote, ...point });
  await expect(viewport).not.toHaveClass(/drop-active/);
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.find(node => node.kind === "media")?.block?.content.media?.url)).toBe("https://example.com/cover.png");

  await viewport.evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["local-image"], "local.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  });
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.filter(node => node.kind === "media").length)).toBe(2);
  await viewport.evaluate(element => {
    const transfer = new DataTransfer();
    transfer.setData("text/html", '<img src="https://example.com/asset?id=42">');
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  });
  await expect.poll(() => page.evaluate(() => window.mockHost.canvas(window.mockHost.current)?.nodes.find(node => node.block?.content.media?.url === "https://example.com/asset?id=42")?.block?.content.media?.kind)).toBe("image");
  await expect(page.locator(".canvas-node-media")).toHaveCount(3);
});

test("document media drop indicators and saved placement agree on all four sides", async ({ page }) => {
  for (const [side, x, y, expectedClass] of [
    ["top", .5, .1, "drop-before"],
    ["bottom", .5, .9, "drop-after"],
    ["left", .05, .5, "drop-column-left"],
    ["right", .95, .5, "drop-column-right"]
  ]) {
    await page.goto("/");
    const target = page.locator('[data-own-block][data-id="a1"]');
    const box = await target.boundingBox();
    const point = { clientX: box.x + box.width * x, clientY: box.y + box.height * y };
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["image"], "drop.webp", { type: "image/webp" }));
      return data;
    });
    await target.dispatchEvent("dragover", { dataTransfer: transfer, ...point });
    await expect(target).toHaveClass(new RegExp(expectedClass));
    await target.dispatchEvent("drop", { dataTransfer: transfer, ...point });
    await expect.poll(() => page.evaluate(() => window.mockHost.state("alpha").blocks.some(block => block.type === "media"))).toBe(true);
    const blocks = await page.evaluate(() => window.mockHost.state("alpha").blocks);
    const original = blocks.find(block => block.id === "a1");
    const media = blocks.find(block => block.type === "media");
    if (side === "top") expect(Number(media.position)).toBeLessThan(Number(original.position));
    if (side === "bottom") expect(Number(media.position)).toBeGreaterThan(Number(original.position));
    if (side === "left" || side === "right") {
      expect(media.properties.columnGroup).toBe(original.properties.columnGroup);
      expect(media.properties.column).toBe(side === "left" ? 0 : 1);
      expect(original.properties.column).toBe(side === "left" ? 1 : 0);
    }
  }
});

test("document accepts remote image drops and copied webpage images", async ({ page }) => {
  await page.goto("/");
  const target = page.locator('[data-own-block][data-id="a1"]');
  const box = await target.boundingBox();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.setData("text/uri-list", "https://example.com/remote.jpg");
    return data;
  });
  const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height - 2 };
  await target.dispatchEvent("dragover", { dataTransfer: transfer, ...point });
  await expect(target).toHaveClass(/drop-after/);
  await target.dispatchEvent("drop", { dataTransfer: transfer, ...point });
  await expect.poll(() => page.evaluate(() => window.mockHost.state("alpha").blocks.find(block => block.type === "media")?.content.media?.url)).toBe("https://example.com/remote.jpg");

  await page.locator('[data-id="a1"] .block-text').evaluate(element => {
    const data = new DataTransfer();
    data.setData("text/html", '<img src="https://example.com/copied?id=1">');
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
  });
  await expect.poll(() => page.evaluate(() => window.mockHost.state("alpha").blocks.filter(block => block.type === "media").length)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.mockHost.state("alpha").blocks.find(block => block.content.media?.url === "https://example.com/copied?id=1")?.content.media?.kind)).toBe("image");
});
