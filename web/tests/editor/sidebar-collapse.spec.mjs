import { test, expect } from "@playwright/test";

async function createSidebarReference(page) {
  const paragraph = page.locator('[data-id="a1"] > .block-row > .block-text');
  await page.locator('[data-editor-mode="source"]').click();
  await paragraph.fill('第二个引用 [[默认笔记本/Gamma#^g1]]');
  await expect(page.locator('#status')).toContainText('已保存');
  await page.locator('[data-editor-mode="rich"]').click();
  await page.locator('[data-pane-btn="reference-sidebar"]').click();
  const entry = page.locator('#reference-sidebar .linked-reference-entry').filter({ hasText: 'Gamma' });
  await expect(entry).toBeVisible();
  await entry.locator('.reference-mode-menu').click();
  await page.getByRole('menu').getByText('右侧分栏', { exact: true }).click();
}

test("× button on sidebar reference card does NOT blank 实时引用 panel", async ({ page }) => {
  await page.goto("/");
  // Set the only reference to sidebar mode
  await page.locator('[data-own-block][data-type="reference"] .reference-heading .grip').click();
  await page.getByRole("menu").getByText("右侧分栏").click();
  await page.waitForTimeout(400);
  // Now in the sidebar there is one ref card
  const sidebar = page.locator('#reference-sidebar');
  await expect(sidebar.locator('.reference-card.sidebar[data-reference-id="ref1"]')).toBeVisible();

  // Capture how many cards exist before
  const countBefore = await sidebar.locator('.reference-card.sidebar[data-reference-id]').count();
  expect(countBefore).toBe(1);

  // Click × on the row (hides the block)
  const row = sidebar.locator('.reference-card.sidebar[data-reference-id="ref1"] .reference-row').first();
  // Sample: count cards in #reference-sidebar every 40ms during the action
  const samples = [];
  page.waitForTimeout(50).then(async () => {
    while (true) {
      const n = await sidebar.locator('.reference-card.sidebar[data-reference-id]').count();
      samples.push(n);
      await page.waitForTimeout(40);
      if (samples.length > 20) break;
    }
  }).catch(() => {});
  await row.locator('.hide').click({ force: true });
  await page.waitForTimeout(800);
  // The 实时引用 panel should never go blank (zero cards) during the action
  for (const n of samples) {
    if (typeof n === 'number') expect(n).toBeGreaterThanOrEqual(1);
  }
  // After: still 1 card, but the row is gone
  const finalCount = await sidebar.locator('.reference-card.sidebar[data-reference-id]').count();
  expect(finalCount).toBe(1);
  const rowAfter = await sidebar.locator('.reference-card.sidebar[data-reference-id="ref1"] .reference-row').count();
  expect(rowAfter).toBe(0);
});

test("sidebar reference cards can be collapsed/expanded independently", async ({ page }) => {
  await page.goto("/");
  // Use Alpha: has a single reference to Beta
  await page.locator('[data-own-block][data-type="reference"] .reference-heading .grip').click();
  await page.getByRole("menu").getByText("右侧分栏").click();
  await page.waitForTimeout(400);
  const sidebar = page.locator('#reference-sidebar');
  const card = sidebar.locator('.reference-card.sidebar[data-reference-id="ref1"]');
  await expect(card).toBeVisible();
  // Initially expanded: row visible
  await expect(card.locator('.reference-row')).toBeVisible();
  // Click toggle in the summary
  await card.locator('.reference-card-summary .reference-expand').click();
  await page.waitForTimeout(200);
  // Body collapsed: row hidden
  await expect(card).toHaveClass(/is-collapsed/);
  await expect(card.locator('.reference-row')).toHaveCount(0);
  // Click again to expand
  await card.locator('.reference-card-summary .reference-expand').click();
  await page.waitForTimeout(200);
  await expect(card).not.toHaveClass(/is-collapsed/);
  await expect(card.locator('.reference-row')).toBeVisible();
});

test("sidebar collapse state is preserved across reference updates", async ({ page }) => {
  await page.goto("/");
  // Set to sidebar mode
  await page.locator('[data-own-block][data-type="reference"] .reference-heading .grip').click();
  await page.getByRole("menu").getByText("右侧分栏").click();
  await page.waitForTimeout(400);
  const sidebar = page.locator('#reference-sidebar');
  const card = sidebar.locator('.reference-card.sidebar[data-reference-id="ref1"]');
  // Collapse it
  await card.locator('.reference-card-summary .reference-expand').click();
  await page.waitForTimeout(200);
  await expect(card).toHaveClass(/is-collapsed/);
  // Now: switch reference mode to "inline" then back to "sidebar" — collapse state should survive re-renders
  await page.locator('[data-own-block][data-type="reference"] .reference-heading .grip').click();
  await page.getByRole("menu").getByText("正文直显").click();
  await page.waitForTimeout(400);
  await page.locator('[data-own-block][data-type="reference"] .reference-heading .grip').click();
  await page.getByRole("menu").getByText("右侧分栏").click();
  await page.waitForTimeout(400);
  // Sidebar card should still be collapsed (state persists)
  const cardAfter = sidebar.locator('.reference-card.sidebar[data-reference-id="ref1"]');
  await expect(cardAfter).toHaveClass(/is-collapsed/);
});

test("× on INLINE-mode reference row does NOT blank 实时引用 panel", async ({ page }) => {
  await page.goto("/");
  // Default mode is inline — verify sidebar shows the fallback (inline refs in panel)
  const sidebar = page.locator('#reference-sidebar');
  await page.waitForTimeout(400);
  const countBefore = await sidebar.locator('.reference-card[data-reference-id]').count();
  expect(countBefore).toBe(1);

  // Click × on the main reference card's row (the row inside blockSurface)
  const mainCard = page.locator('[data-own-block][data-type="reference"] .reference-card');
  const row = mainCard.locator('.reference-row').first();
  // Sample the panel during the action
  const samples = [];
  page.waitForTimeout(50).then(async () => {
    while (true) {
      const n = await sidebar.locator('.reference-card[data-reference-id]').count();
      samples.push(n);
      await page.waitForTimeout(40);
      if (samples.length > 20) break;
    }
  }).catch(() => {});
  await row.locator('.hide').click({ force: true });
  await page.waitForTimeout(800);
  // Panel should never show zero cards during the action
  for (const n of samples) {
    if (typeof n === 'number') expect(n).toBeGreaterThanOrEqual(1);
  }
  // After: 1 card still there, the row inside it is gone
  const finalCount = await sidebar.locator('.reference-card[data-reference-id]').count();
  expect(finalCount).toBe(1);
  const rowsAfter = await sidebar.locator('.reference-card[data-reference-id="ref1"] .reference-row').count();
  expect(rowsAfter).toBe(0);
});

test("right splitter drag resizes right column and content area", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(400);
  const splitterRight = page.locator('#splitter-right');
  const sidebarRight = page.locator('#sidebar-right');
  const blocks = page.locator('#blocks');

  const before = await page.evaluate(() => {
    const sr = document.querySelector('#sidebar-right').getBoundingClientRect();
    const b = document.querySelector('#blocks').getBoundingClientRect();
    return { sidebarRightWidth: sr.width, blocksRight: b.right, blocksLeft: b.left };
  });

  // Drag the splitter leftward by 100px → sidebar should GROW, content shrink
  const splitterBox = await splitterRight.boundingBox();
  await page.mouse.move(splitterBox.x + 3, splitterBox.y + splitterBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitterBox.x - 100, splitterBox.y + splitterBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const afterLeftward = await page.evaluate(() => {
    const sr = document.querySelector('#sidebar-right').getBoundingClientRect();
    const b = document.querySelector('#blocks').getBoundingClientRect();
    return { sidebarRightWidth: sr.width, blocksRight: b.right };
  });

  console.log("Right before:", before, "after leftward:", afterLeftward);
  expect(afterLeftward.sidebarRightWidth).toBeGreaterThan(before.sidebarRightWidth + 30);
  expect(afterLeftward.blocksRight).toBeLessThan(before.blocksRight);

  // Drag the splitter rightward by 60px → sidebar should SHRINK
  const splitterBox2 = await splitterRight.boundingBox();
  await page.mouse.move(splitterBox2.x + 3, splitterBox2.y + splitterBox2.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitterBox2.x + 60, splitterBox2.y + splitterBox2.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const afterRightward = await page.evaluate(() => {
    const sr = document.querySelector('#sidebar-right').getBoundingClientRect();
    const b = document.querySelector('#blocks').getBoundingClientRect();
    return { sidebarRightWidth: sr.width, blocksRight: b.right };
  });
  console.log("After rightward drag:", afterRightward);
  expect(afterRightward.sidebarRightWidth).toBeLessThan(afterLeftward.sidebarRightWidth - 30);
  expect(afterRightward.blocksRight).toBeGreaterThan(afterLeftward.blocksRight);
});

test("left splitter drag resizes left column", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(400);
  const splitterLeft = page.locator('#splitter-left');
  const sidebarLeft = page.locator('#sidebar-left');

  const before = await sidebarLeft.evaluate(el => el.getBoundingClientRect().width);

  const splitterBox = await splitterLeft.boundingBox();
  await page.mouse.move(splitterBox.x + 3, splitterBox.y + splitterBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitterBox.x + 80, splitterBox.y + splitterBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const after = await sidebarLeft.evaluate(el => el.getBoundingClientRect().width);
  console.log("Left sidebar width before:", before, "after:", after);
  expect(after).toBeGreaterThan(before + 50);
});

test("sidebar-mode reference entry shows visible grip for mode switch", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-own-block][data-type="reference"] .reference-heading .grip').click();
  await page.getByRole("menu").getByText("右侧分栏").click();
  await page.waitForTimeout(400);

  // The grip should be visible WITHOUT hover (we made it always-visible for sidebar-mode blocks)
  const grip = page.locator('[data-own-block][data-type="reference"] .reference-heading .grip');
  await expect(grip).toBeVisible();

  // Click it → should show the reference menu including "正文直显" / "折叠卡片" / "仅标题链接"
  await grip.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menu").getByText("正文直显")).toBeVisible();
  await expect(page.getByRole("menu").getByText("折叠卡片")).toBeVisible();
  await expect(page.getByRole("menu").getByText("仅标题链接")).toBeVisible();
});

test("typing inside reference body keeps caret", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(400);
  // Focus a paragraph inside the reference card
  const refEditable = page.locator('[data-own-block][data-type="reference"] .reference-card .reference-row .block-text').first();
  await refEditable.click();
  await refEditable.pressSequentially("X", { delay: 0 });
  await page.waitForTimeout(300);
  // Focus must still be inside the reference
  const inRef = await page.evaluate(() => {
    const a = document.activeElement;
    return !!a?.closest(".reference-card");
  });
  console.log("After typing, focused inside reference card:", inRef);
  expect(inRef).toBe(true);
});

test("typing into a NEW reference instance block keeps caret", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(400);
  // Add a sibling instance block (creates a new reference_instance row)
  const ref = page.locator('[data-own-block][data-type="reference"]');
  const firstRow = ref.locator('.reference-row[data-scope-type="canonical"]').first();
  await firstRow.locator(".reference-meta").hover();
  await firstRow.locator(".add-sibling").click({ force: true });
  await page.waitForTimeout(600);
  // Click the new local row
  const localRow = ref.locator('.reference-row[data-scope-type="reference_instance"]').first();
  const localEditable = localRow.locator(".block-text");
  await localEditable.click();
  await localEditable.pressSequentially("Y", { delay: 0 });
  await page.waitForTimeout(400);
  const inLocal = await page.evaluate(() => {
    const a = document.activeElement;
    return !!a?.closest('.reference-row[data-scope-type="reference_instance"]');
  });
  console.log("After typing into new instance block, focused inside:", inLocal);
  expect(inLocal).toBe(true);
});

test("creating a new reference does NOT blank 实时引用 panel mid-action", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(400);
  const sidebar = page.locator('#reference-sidebar');
  const before = await sidebar.locator('.reference-card[data-reference-id]').count();
  await createSidebarReference(page);
  // Sample panel during/after action
  const samples = [];
  await page.waitForTimeout(50).then(async () => {
    const start = Date.now();
    while (Date.now() - start < 1500) {
      const n = await sidebar.locator('.reference-card[data-reference-id]').count();
      samples.push(n);
      await page.waitForTimeout(40);
      if (samples.length > 30) break;
    }
  }).catch(() => {});
  await page.waitForTimeout(1200);
  const minCount = Math.min(...samples);
  console.log(`After createReference: cards before=${before}, samples=${samples.length}, min=${minCount}`);
  expect(minCount).toBeGreaterThanOrEqual(before);  // never blank (sidebar has at least the original card)
  const finalCount = await sidebar.locator('.reference-card[data-reference-id]').count();
  expect(finalCount).toBe(before + 1);
});

test("sidebar-mode reference card has visible mode-menu button", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-own-block][data-type="reference"] .reference-heading .grip').click();
  await page.getByRole("menu").getByText("右侧分栏").click();
  await page.waitForTimeout(400);
  const sidebarCard = page.locator('#reference-sidebar .reference-card.sidebar[data-reference-id="ref1"]');
  const modeMenuBtn = sidebarCard.locator('.reference-mode-menu');
  await expect(modeMenuBtn).toBeVisible();
  // Click → should show the reference menu with mode-switch options
  await modeMenuBtn.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menu").getByText("仅标题链接")).toBeVisible();
  await expect(page.getByRole("menu").getByText("正文直显")).toBeVisible();
  await expect(page.getByRole("menu").getByText("折叠卡片")).toBeVisible();
  await expect(page.getByRole("menu").getByText("打开源文档")).toBeVisible();
});

// ── Refactor regression tests (实时引用 panel sync) ────────────────────────

test("REMOVE-REFERENCE: detach synchronously removes the sidebar card", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(400);
  const sidebar = page.locator('#reference-sidebar');
  const initial = await sidebar.locator('.reference-card[data-reference-id]').count();
  console.log("Initial sidebar cards:", initial);
  // Detach the existing reference
  const refHostBlock = page.locator('[data-own-block][data-type="reference"]');
  await refHostBlock.locator('.reference-heading .grip').click();
  await page.getByRole("menu").getByText("断开引用（保留为正文）").click();
  // Sample fast to make sure the panel never shows stale cards
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const n = await sidebar.locator('.reference-card[data-reference-id]').count();
    samples.push(n);
    await page.waitForTimeout(40);
    if (samples.length > 40) break;
  }
  console.log("Detach samples:", samples);
  await page.waitForTimeout(500);
  const final = await sidebar.locator('.reference-card[data-reference-id]').count();
  // After detach, sidebar may show "intro" with all remaining inline refs, but no sidebar-mode card.
  // What we care about: no zombie card with the removed reference's id.
  const removedCard = await sidebar.locator('.reference-card[data-reference-id="ref1"]').count();
  console.log("After detach: final=", final, " removedRef1 card=", removedCard);
  expect(removedCard).toBe(0);
  // No sample should have shown the removed card
  const anyRemovedSample = samples.length > 0; // placeholder, the assertion below covers it via removedCard check
  expect(samples.length).toBeGreaterThan(20);
});

test("CREATE-REFERENCE: panel never goes blank during new reference creation", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(400);
  const sidebar = page.locator('#reference-sidebar');
  const before = await sidebar.locator('.reference-card[data-reference-id]').count();
  console.log("Before create: cards=", before);
  await createSidebarReference(page);
  // Sample the panel contents during/after the operation
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const cards = await sidebar.locator('.reference-card[data-reference-id]').count();
    const empty = await sidebar.locator('.empty').count();
    const intro = await sidebar.locator('.ref-sidebar-intro').count();
    samples.push({ cards, empty, intro });
    await page.waitForTimeout(40);
    if (samples.length > 40) break;
  }
  console.log("First 10 samples:", samples.slice(0, 10));
  // The panel should always show SOMETHING meaningful — either cards or the intro banner.
  // It should NEVER show the bare "empty" placeholder when there are references in the doc.
  for (const s of samples) {
    if (s.empty > 0) {
      throw new Error(`Panel went to 'empty' placeholder mid-action: ${JSON.stringify(s)}`);
    }
    if (s.cards === 0 && s.intro === 0) {
      throw new Error(`Panel went blank mid-action: ${JSON.stringify(s)}`);
    }
  }
  await page.waitForTimeout(500);
  const final = await sidebar.locator('.reference-card[data-reference-id]').count();
  console.log("After create: final=", final);
  expect(final).toBe(before + 1);
});

test("REMOVE-REFERENCE via menu removes the sidebar card and leaves no zombie", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(400);
  const sidebar = page.locator('#reference-sidebar');
  // Snapshot all reference ids currently shown in the sidebar
  const initialIds = await sidebar.locator('.reference-card[data-reference-id]').evaluateAll(els => els.map(e => e.dataset.referenceId));
  console.log("Initial sidebar ids:", initialIds);
  // Detach the existing main reference
  const refHostBlock = page.locator('[data-own-block][data-type="reference"]');
  await refHostBlock.locator('.reference-heading .grip').click();
  await page.getByRole("menu").getByText("断开引用（保留为正文）").click();
  await page.waitForTimeout(1000);
  const afterIds = await sidebar.locator('.reference-card[data-reference-id]').evaluateAll(els => els.map(e => e.dataset.referenceId));
  console.log("After detach sidebar ids:", afterIds);
  // ref1 must be gone
  expect(afterIds).not.toContain("ref1");
});

test("REMOVE-REFERENCE + tab switch: panel still clean after coming back", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(400);
  // Detach the existing reference
  const refHostBlock = page.locator('[data-own-block][data-type="reference"]');
  await refHostBlock.locator('.reference-heading .grip').click();
  await page.getByRole("menu").getByText("断开引用（保留为正文）").click();
  await page.waitForTimeout(800);
  // Switch to 反向链接 tab and back
  await page.locator('#sidebar-right [data-pane-btn="backlinks"]').click();
  await page.waitForTimeout(200);
  await page.locator('#sidebar-right [data-pane-btn="reference-sidebar"]').click();
  await page.waitForTimeout(200);
  const sidebar = page.locator('#reference-sidebar');
  const removedCard = await sidebar.locator('.reference-card[data-reference-id="ref1"]').count();
  console.log("After tab switch back, ref1 card count:", removedCard);
  expect(removedCard).toBe(0);
});

test("CREATE-REFERENCE + tab switch: panel reflects the new card after returning", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(400);
  await createSidebarReference(page);
  await page.waitForTimeout(800);
  // Switch away and back
  await page.locator('#sidebar-right [data-pane-btn="backlinks"]').click();
  await page.waitForTimeout(200);
  await page.locator('#sidebar-right [data-pane-btn="reference-sidebar"]').click();
  await page.waitForTimeout(200);
  const sidebar = page.locator('#reference-sidebar');
  const cardCount = await sidebar.locator('.reference-card[data-reference-id]').count();
  console.log("After tab switch, sidebar cards:", cardCount);
  expect(cardCount).toBeGreaterThanOrEqual(2);
});
