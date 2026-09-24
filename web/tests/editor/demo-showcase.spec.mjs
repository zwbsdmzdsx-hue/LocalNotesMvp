import { test, expect } from "@playwright/test";

test("seeded demo workspace exposes rich documents and Canvas examples", async ({ page }) => {
  await page.goto("/");

  const fixture = await page.evaluate(() => {
    const host = window.mockHost;
    const showcase = host.state("showcase");
    const roadmap = host.canvas("canvas-roadmap");
    const research = host.canvas("canvas-research");
    return {
      showcaseTitle: showcase?.note.title,
      showcaseTypes: showcase?.blocks.map(block => block.type),
      showcaseHasComments: Boolean(showcase?.blocks.some(block => block.properties.comments?.length)),
      roadmapKinds: roadmap?.nodes.map(node => node.kind),
      roadmapReferences: roadmap?.nodes.filter(node => node.kind === "document").length,
      roadmapHasCurve: roadmap?.nodes.some(node => node.kind === "curve" && node.curve?.label),
      researchHasNestedCanvas: research?.nodes.some(node => node.kind === "canvas" && node.targetId === "canvas-roadmap"),
      researchHasIcon: research?.nodes.some(node => node.kind === "document" && node.displayMode === "icon")
    };
  });

  expect(fixture.showcaseTitle).toBe("演示中心");
  expect(fixture.showcaseTypes).toEqual(expect.arrayContaining(["heading", "todo", "database_table", "location", "media"]));
  expect(fixture.showcaseHasComments).toBe(true);
  expect(fixture.roadmapKinds).toEqual(expect.arrayContaining(["block", "document", "media", "curve"]));
  expect(fixture.roadmapReferences).toBeGreaterThanOrEqual(2);
  expect(fixture.roadmapHasCurve).toBe(true);
  expect(fixture.researchHasNestedCanvas).toBe(true);
  expect(fixture.researchHasIcon).toBe(true);

  await page.locator('.bk-strip').filter({ hasText: "项目" }).click();
  await page.locator('[data-document-id="showcase"] > .doc-item').click();
  await expect(page.locator("#title")).toHaveValue("演示中心");
  await expect(page.locator(".database-table:not(.database-table-preview)")).toBeVisible();
  await expect(page.locator(".location-card-body")).toBeVisible();
  await expect(page.locator(".media-preview")).toBeVisible();

  await page.locator('[data-document-id="canvas-roadmap"] > .doc-item').click();
  await expect(page.locator(".canvas-view")).toBeVisible();
  await expect(page.locator(".canvas-node-document")).toHaveCount(2);
  await expect(page.locator(".canvas-node-media")).toBeVisible();
  await expect(page.locator(".canvas-connection-visible")).toHaveCount(1);
});
