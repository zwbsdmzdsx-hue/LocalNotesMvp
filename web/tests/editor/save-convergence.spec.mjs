import { test, expect } from "@playwright/test";

test("document saves serialize delayed edits and navigation reads the final snapshot", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const host = window.mockHost;
    const send = host.send.bind(host);
    const held = [];
    window.delayedSaves = {
      held,
      release: () => held.shift()?.(),
      messages: [],
      initialVersion: host.docs.get("alpha").note.clientVersion
    };
    host.send = message => {
      if (message.kind !== "saveDocument") return send(message);
      window.delayedSaves.messages.push(message.payload);
      if (window.delayedSaves.messages.length === 1) held.push(() => send(message));
      else send(message);
    };
  });
  const block = page.locator('[data-own-block][data-type="paragraph"] .block-text').first();
  await block.fill("first delayed edit");
  await expect.poll(() => page.evaluate(() => window.delayedSaves.messages.length)).toBe(1);
  await block.fill("final delayed edit");
  await page.evaluate(() => window.delayedSaves.release());
  await expect(page.locator("#status")).toContainText("已保存");
  await expect.poll(() => page.evaluate(() => window.mockHost.docs.get("alpha").blocks.some(block => block.content.text === "final delayed edit"))).toBe(true);
  await page.locator('[data-doc="beta"]').click();
  await expect(page.locator("#title")).toHaveValue("Beta");
  await page.locator('[data-doc="alpha"]').click();
  await expect(block).toHaveText("final delayed edit");
  const result = await page.evaluate(() => ({
    versions: window.delayedSaves.messages.map(message => message.clientVersion),
    initial: window.delayedSaves.initialVersion,
    saved: window.mockHost.docs.get("alpha").note.clientVersion
  }));
  expect(result.versions).toEqual([result.initial + 1, result.initial + 2]);
  expect(result.saved).toBe(result.initial + 2);
});

test("creating a diary from Canvas saves the diary without replacing the active surface", async ({ page }) => {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept("日历操作画布"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Canvas" }).click();
  await expect(page.locator(".canvas-view")).toBeVisible();
  await page.locator('[data-pane-btn="calendar"]').click();
  await page.locator('[data-slot="calendar"] .calendar-create').click();
  await page.locator(".calendar-create-popup input").fill("画布中的日记");
  await page.locator(".calendar-create-popup .primary").click();
  await expect(page.locator(".canvas-view")).toBeVisible();
  await expect(page.locator(".canvas-title")).toHaveValue("日历操作画布");
  await expect.poll(() => page.evaluate(() => [...window.mockHost.docs.values()].some(state =>
    /^\d{4}-\d{1,2}月$/.test(state.note.title) && state.blocks.some(block => block.content.markdown?.includes("画布中的日记"))
  ))).toBe(true);
});
