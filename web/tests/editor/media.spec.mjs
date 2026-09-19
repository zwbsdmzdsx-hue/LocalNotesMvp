import { test, expect } from "@playwright/test";

test("inserts and persists image, video, and audio media blocks", async ({ page }) => {
  await page.goto("/");
  const input = page.locator("#media-file-input");
  await input.setInputFiles([
    { name: "photo.png", mimeType: "image/png", buffer: Buffer.from("fake-image") },
    { name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from("fake-video") },
    { name: "sound.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("fake-audio") }
  ]);
  await expect(page.locator('[data-own-block][data-type="media"]')).toHaveCount(3);
  await expect(page.locator('.media-preview[data-media-kind="image"] img')).toHaveAttribute("alt", "photo.png");
  await expect(page.locator('.media-preview[data-media-kind="video"] video')).toHaveAttribute("controls", "");
  await expect(page.locator('.media-preview[data-media-kind="audio"] audio')).toHaveAttribute("controls", "");
  await expect.poll(() => page.evaluate(() => window.mockHost.state("alpha").blocks.filter(block => block.type === "media").length)).toBe(3);
  await expect.poll(() => page.evaluate(() => window.mockHost.state("alpha").blocks.filter(block => block.type === "media").every(block => block.content.media.url.startsWith("data:")))).toBe(true);
});

test("accepts media files dropped on the editor surface", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["drop-image"], "drop.webp", { type: "image/webp" }));
    document.querySelector("#blocks").dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.locator('[data-own-block][data-type="media"]')).toHaveCount(1);
});

test("keeps media blocks as previews across source and preview modes", async ({ page }) => {
  await page.goto("/");
  await page.locator("#media-file-input").setInputFiles({ name: "mode.png", mimeType: "image/png", buffer: Buffer.from("mode-image") });
  await expect(page.locator('[data-own-block][data-type="media"] img')).toHaveCount(1);
  await page.locator('[data-editor-mode="source"]').click();
  await expect(page.locator('[data-own-block][data-type="media"] img')).toHaveCount(1);
  await page.locator('[data-editor-mode="preview"]').click();
  await expect(page.locator('[data-own-block][data-type="media"] img')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.mockHost.state("alpha").blocks.some(block => block.type === "media" && block.content.media.name === "mode.png"))).toBe(true);
});
