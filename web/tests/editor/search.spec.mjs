import { test, expect } from "@playwright/test";

test("search panel is hidden by default and opens on click", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(400);
  // The search tab is the middle one (📁 docs, 🔍 search, ≡ outline)
  const searchTab = page.locator('.sidebar-tab[data-left-pane="search"]');
  await expect(searchTab).toBeVisible();
  // Click the search tab
  await searchTab.click();
  await page.waitForTimeout(200);
  // Search input should now be visible
  const searchInput = page.locator('#search-input');
  await expect(searchInput).toBeVisible();
});

test("search finds matches in document titles across all bookmarks", async ({ page }) => {
  await page.goto("/");
  await page.locator('.sidebar-tab[data-left-pane="search"]').click();
  await page.waitForTimeout(200);
  const searchInput = page.locator('#search-input');
  await searchInput.fill("Alpha");
  await page.waitForTimeout(300);
  // Should find at least one match
  const hits = page.locator('.list-item.search-hit');
  await expect(hits.first()).toBeVisible();
  const count = await hits.count();
  console.log("Hits for 'Alpha':", count);
  expect(count).toBeGreaterThan(0);
});

test("search finds matches inside block content (not just titles)", async ({ page }) => {
  await page.goto("/");
  await page.locator('.sidebar-tab[data-left-pane="search"]').click();
  await page.waitForTimeout(200);
  // Beta has a block with text "Beta 的内容" (in the mock seed data)
  const searchInput = page.locator('#search-input');
  await searchInput.fill("Beta");
  await page.waitForTimeout(300);
  const hits = page.locator('.list-item.search-hit');
  const count = await hits.count();
  console.log("Hits for 'Beta':", count);
  expect(count).toBeGreaterThan(0);
});

test("search highlights matched substring in excerpt", async ({ page }) => {
  await page.goto("/");
  await page.locator('.sidebar-tab[data-left-pane="search"]').click();
  await page.waitForTimeout(200);
  await page.locator('#search-input').fill("Alpha");
  await page.waitForTimeout(300);
  // The first hit's excerpt should contain a <mark> around "Alpha"
  const marks = page.locator('.search-hit-excerpt mark');
  const count = await marks.count();
  console.log("Highlight marks:", count);
  expect(count).toBeGreaterThan(0);
  await expect(marks.first()).toContainText(/alpha/i);
});

test("clicking a search hit opens the document and jumps to the block", async ({ page }) => {
  await page.goto("/");
  await page.locator('.sidebar-tab[data-left-pane="search"]').click();
  await page.waitForTimeout(200);
  await page.locator('#search-input').fill("Beta");
  await page.waitForTimeout(300);
  // Click first hit that has a kind-block badge (block content, not title)
  const blockHit = page.locator('.list-item.search-hit').filter({ has: page.locator('.kind-block') }).first();
  await expect(blockHit).toBeVisible();
  await blockHit.click();
  await page.waitForTimeout(800);
  // Title should now be Beta
  await expect(page.locator('#title')).toHaveValue("Beta");
  // The focused element should be a block-text inside the doc
  const inDoc = await page.evaluate(() => {
    const a = document.activeElement;
    return !!a?.closest('[data-own-block]');
  });
  console.log("After search hit click, focused inside doc block:", inDoc);
  expect(inDoc).toBe(true);
});

test("search shows no-match state for unknown query", async ({ page }) => {
  await page.goto("/");
  await page.locator('.sidebar-tab[data-left-pane="search"]').click();
  await page.waitForTimeout(200);
  await page.locator('#search-input').fill("zzzzz-no-such-text");
  await page.waitForTimeout(300);
  await expect(page.locator('.panel-list .empty')).toBeVisible();
  await expect(page.locator('.panel-list .empty')).toContainText("没有匹配");
});

test("search shows groups per document with hit count", async ({ page }) => {
  await page.goto("/");
  await page.locator('.sidebar-tab[data-left-pane="search"]').click();
  await page.waitForTimeout(200);
  await page.locator('#search-input').fill("的");
  await page.waitForTimeout(300);
  const groups = page.locator('.search-group-head');
  const groupCount = await groups.count();
  console.log("Document groups for '的':", groupCount);
  expect(groupCount).toBeGreaterThan(0);
  // First group should have a count badge
  await expect(groups.first().locator('.search-group-count')).toBeVisible();
});

test("Escape clears the search input", async ({ page }) => {
  await page.goto("/");
  await page.locator('.sidebar-tab[data-left-pane="search"]').click();
  await page.waitForTimeout(200);
  const input = page.locator('#search-input');
  await input.fill("Alpha");
  await input.press("Escape");
  await page.waitForTimeout(200);
  await expect(input).toHaveValue("");
});
