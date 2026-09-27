import { test, expect } from "@playwright/test";

test("shared block layout migrates legacy columns and fills heading metadata", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { migrateLegacyColumns, normalizeCanonicalBlockProperties, columnIndex } = await import("/src/block-layout.ts");
    const layout = { id: "layout-1", parentId: null, position: "00001000", type: "paragraph", content: { text: "", html: "" }, properties: { layout: "columns" }, revision: 1 };
    const heading = { id: "heading-1", parentId: "layout-1", position: "00001000", type: "heading", content: { text: "标题", html: "", markdown: "## 标题" }, properties: { column: 1 }, revision: 1 };
    const migrated = migrateLegacyColumns([layout, heading]);
    const normalized = normalizeCanonicalBlockProperties(migrated[0]);
    return { count: migrated.length, group: normalized.properties.columnGroup, column: columnIndex(normalized), level: normalized.properties.headingLevel };
  });
  expect(result).toEqual({ count: 1, group: "columns-layout-1", column: 1, level: 2 });
});

test("reference preview resolves stable document targets and only projects a block subtree", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { linkDestination, projectLinkTarget } = await import("/src/reference-preview.ts");
    const anchor = document.createElement("a");
    anchor.className = "wiki-link";
    anchor.dataset.targetId = "doc-2";
    anchor.dataset.targetBlockId = "root";
    document.body.append(anchor);
    const state = {
      note: { id: "doc-1", title: "当前", isSticky: false }, blocks: [], documents: [{ id: "doc-2", title: "目标" }],
      backlinks: [], overrideNotices: [], references: [], locations: [], databases: [], databaseRecords: {}
    };
    const target = linkDestination(anchor, state);
    const source = { ...state, note: { ...state.note, id: "doc-2", title: "目标" }, blocks: [
      { id: "root", parentId: null, position: "00001000", type: "paragraph", content: { text: "根", html: "" }, properties: {}, revision: 1 },
      { id: "child", parentId: "root", position: "00002000", type: "paragraph", content: { text: "子", html: "" }, properties: {}, revision: 1 },
      { id: "other", parentId: null, position: "00003000", type: "paragraph", content: { text: "旁支", html: "" }, properties: {}, revision: 1 }
    ] };
    const projection = await projectLinkTarget(target, state, async () => source);
    return { documentId: target.documentId, blockIds: projection.blocks.map(block => block.id) };
  });
  expect(result).toEqual({ documentId: "doc-2", blockIds: ["root", "child"] });
});

test("link rendering keeps aliases and resolves document IDs through injected state", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createLinkRendering } = await import("/src/link-rendering.ts");
    const state = { note: { id: "doc-1", title: "当前", isSticky: false }, documents: [{ id: "doc-2", title: "目标" }] };
    const rendering = createLinkRendering(() => state);
    const root = document.createElement("div");
    root.innerHTML = rendering.markdownHtml("[[目标|自定义标题]]");
    rendering.resolveWikiTargets(root);
    const link = root.querySelector(".wiki-link");
    return { text: link?.textContent, targetId: link?.dataset.targetId, targetTitle: link?.dataset.targetTitle };
  });
  expect(result).toEqual({ text: "自定义标题", targetId: "doc-2", targetTitle: "目标" });
});

test("drag and database helpers keep type-specific defaults outside the editor core", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { blockSummaryForDrag, isBlockDescendant } = await import("/src/block-drag.ts");
    const { createDatabaseRecord } = await import("/src/database-records.ts");
    const { createDatabaseView, databaseViewLabel } = await import("/src/database-views.ts");
    const blocks = [
      { id: "root", parentId: null, position: "00001000", type: "paragraph", content: { text: "根块", html: "" }, properties: {}, revision: 1 },
      { id: "child", parentId: "root", position: "00002000", type: "paragraph", content: { text: "子块", html: "" }, properties: {}, revision: 1 }
    ];
    const database = { id: "db-1", title: "表", fields: [
      { id: "f1", databaseId: "db-1", key: "name", title: "名称", type: "text", position: "00001000" },
      { id: "f2", databaseId: "db-1", key: "count", title: "数量", type: "number", position: "00002000" }
    ], recordCount: 0 };
    const record = createDatabaseRecord(database, [], "r1");
    const view = createDatabaseView(database, "board", 0, "v1");
    return {
      dragLabel: blockSummaryForDrag(blocks[0]),
      descendant: isBlockDescendant(blocks, "root", "child"),
      values: record.values,
      view: { label: databaseViewLabel(view.type), name: view.name, groupBy: view.settings.groupBy }
    };
  });
  expect(result).toEqual({
    dragLabel: "根块",
    descendant: true,
    values: { name: "", count: 0 },
    view: { label: "看板", name: "看板 1", groupBy: "name" }
  });
});

test("reading annotation behavior is centralized outside the reader window controller", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { isReadingAnnotationType, readingAnnotationKind, readingInspectorTab, readingInspectorMatches, hasReadingMark } = await import("/src/reading-annotation.ts");
    const block = { type: "reading_note", properties: { readingAnchor: { page: 4, x: .2, y: .3, rects: [{ x: .1, y: .1, width: .2, height: .05 }] } } };
    return {
      note: isReadingAnnotationType(block.type),
      location: isReadingAnnotationType("location"),
      kind: readingAnnotationKind(block),
      tab: readingInspectorTab(block.type),
      highlightMatch: readingInspectorMatches({ ...block, type: "reading_highlight" }, "highlight"),
      locationInNotes: readingInspectorMatches({ type: "location", properties: {} }, "note"),
      mark: hasReadingMark(block.type, block.properties.readingAnchor)
    };
  });
  expect(result).toEqual({ note: true, location: false, kind: "注释", tab: "note", highlightMatch: true, locationInNotes: true, mark: true });
});

test("Canvas block-specific previews and text behavior come from the block registry", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { blockModules } = await import("/src/block-modules.ts");
    const state = { note: { id: "doc-1", title: "当前", isSticky: false }, blocks: [], documents: [], locations: [{ id: "loc-1", name: "办公室", address: "主街", latitude: 1, longitude: 2 }], references: [], backlinks: [], overrideNotices: [], databases: [], databaseRecords: {} };
    const location = blockModules.require("location").create({ id: "location-1", properties: { locationId: "loc-1" } });
    const media = blockModules.require("media").create({ id: "media-1", content: { media: { kind: "image", name: "封面", mimeType: "image/png", url: "data:image/png;base64,AA==" } } });
    const heading = blockModules.require("heading");
    const textarea = document.createElement("textarea");
    const behavior = heading.canvasTextBehavior?.({ block: heading.create({ id: "heading-1" }), nodeId: "heading-1", parentId: "heading-1", textarea, commit() {}, splitLines() { return false; }, splitAtCaret() {} });
    return {
      locationPreview: location && blockModules.require(location.type).canvasPreview?.(location, state)?.className,
      mediaPreview: media && blockModules.require(media.type).canvasPreview?.(media, state)?.querySelector(".canvas-media-preview")?.className,
      headingBehavior: !!behavior?.onChange && !!behavior?.onEnter
    };
  });
  expect(result).toEqual({ locationPreview: "canvas-location-preview", mediaPreview: "canvas-media-preview", headingBehavior: true });
});

test("surface-specific block roles and Canvas defaults stay in the block registry", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { blockModules } = await import("/src/block-modules.ts");
    const read = id => {
      const definition = blockModules.require(id);
      return { id, readingRole: definition.readingRole, dashboardRole: definition.dashboardRole,
        headingCard: definition.canvasHeadingCard, editableReference: definition.canvasReferenceEditable,
        size: definition.canvasNodeDefaults && [definition.canvasNodeDefaults.width, definition.canvasNodeDefaults.height] };
    };
    return [read("heading"), read("dashboard_widget"), read("reading_book"), read("reading_note"), read("location")];
  });
  expect(result).toEqual([
    { id: "heading", readingRole: undefined, dashboardRole: undefined, headingCard: true, editableReference: true, size: [300, 125] },
    { id: "dashboard_widget", readingRole: undefined, dashboardRole: "widget", headingCard: undefined, editableReference: undefined, size: undefined },
    { id: "reading_book", readingRole: "book", dashboardRole: undefined, headingCard: undefined, editableReference: undefined, size: undefined },
    { id: "reading_note", readingRole: "note", dashboardRole: undefined, headingCard: undefined, editableReference: undefined, size: undefined },
    { id: "location", readingRole: "attachment", dashboardRole: undefined, headingCard: undefined, editableReference: undefined, size: undefined }
  ]);
});
