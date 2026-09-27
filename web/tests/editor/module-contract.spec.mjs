import { test, expect } from "@playwright/test";

test("registries reject duplicates and incomplete capability declarations", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createDocumentRegistry, createBlockRegistry, createPanelRegistry } = await import("/src/module-registry.ts");
    const runtime = { open() {}, update() {}, close() {}, async flush() {}, focusBlock() {}, async restoreHistory() {} };
    const documents = createDocumentRegistry();
    const module = { id: "test", createLabel: "测试", createIcon: "T", presentation: { icon: "T", iconClass: "", createPrompt: "名称", defaultTitle: "测试", idPrefix: "test" },
      create() {}, liveContext: { tracksSource: true, create: state => ({ surface: "document", state }) }, runtime };
    documents.register(module);
    let duplicate = false;
    try { documents.register(module); } catch { duplicate = true; }
    let missingLiveContext = false;
    try { documents.register({ ...module, id: "missing-live-context", liveContext: undefined }); }
    catch { missingLiveContext = true; }
    let incompleteLiveContext = false;
    try { documents.register({ ...module, id: "incomplete-live-context", liveContext: { create: module.liveContext.create } }); }
    catch { incompleteLiveContext = true; }
    let invalidCanvasLink = false;
    try { documents.register({ ...module, id: "invalid-canvas-link", canvasLink: { nodeKind: "canvas", width: 0, height: 210 } }); }
    catch { invalidCanvasLink = true; }
    const blocks = createBlockRegistry();
    const editor = { mount(shell) { shell.textContent = "registered editor"; } };
    const suggestion = () => "registered suggestion";
    let missingExtractor = false;
    try { blocks.register({ id: "test", create() {}, label() { return ""; }, preview() {}, suggestion, locate() { return {}; },
      readSnapshot() { return { content: { text: "", html: "" }, properties: {} }; }, editor, capabilities: ["date"] }); }
    catch { missingExtractor = true; }
    let missingSnapshot = false;
    try { blocks.register({ id: "missing-snapshot", create() {}, label() { return ""; }, preview() {}, suggestion, locate() { return {}; }, editor, capabilities: ["reference"] }); }
    catch { missingSnapshot = true; }
    let missingEditor = false;
    try { blocks.register({ id: "missing-editor", create() {}, label() { return ""; }, preview() {}, suggestion, locate() { return {}; },
      readSnapshot() { return { content: { text: "", html: "" }, properties: {} }; }, capabilities: ["reference"] }); }
    catch { missingEditor = true; }
    let missingSuggestion = false;
    try { blocks.register({ id: "missing-suggestion", create() {}, label() { return ""; }, preview() {}, locate() { return {}; },
      readSnapshot() { return { content: { text: "", html: "" }, properties: {} }; }, editor, capabilities: ["reference"] }); }
    catch { missingSuggestion = true; }
    let missingReadingLabel = false;
    try { blocks.register({ id: "missing-reading-label", create() {}, label() { return ""; }, preview() {}, suggestion, locate() { return {}; },
      readSnapshot() { return { content: { text: "", html: "" }, properties: {} }; }, editor, capabilities: ["reference"], readingRole: "bookmark" }); }
    catch { missingReadingLabel = true; }
    blocks.register({ id: "custom", create() {}, label() { return "custom"; }, preview() {}, suggestion, locate() { return {}; },
      readSnapshot() { return { content: { text: "registered", html: "" }, properties: {} }; }, editor, capabilities: ["reference"] });
    const customSnapshot = blocks.require("custom").readSnapshot();
    const customShell = document.createElement("div");
    blocks.require("custom").editor.mount(customShell);
    const panels = createPanelRegistry();
    let updates = 0; let disposals = 0;
    panels.register({ id: "test", label: "测试面板", icon: "T", order: 1, available: () => true,
      mount(slot) { slot.textContent = "已挂载"; return { update() { updates++; }, dispose() { disposals++; } }; } });
    const slot = document.createElement("div");
    const handle = panels.require("test").mount(slot);
    handle.update(null); handle.dispose();
    return { duplicate, missingLiveContext, incompleteLiveContext, invalidCanvasLink, missingExtractor, missingSnapshot, missingEditor, missingSuggestion, missingReadingLabel, customSnapshot,
      customSuggestion: blocks.require("custom").suggestion(),
      customEditor: customShell.textContent, title: slot.textContent, updates, disposals, documentCount: documents.entries().length };
  });
  expect(result).toEqual({ duplicate: true, missingLiveContext: true, incompleteLiveContext: true, invalidCanvasLink: true, missingExtractor: true, missingSnapshot: true, missingEditor: true, missingSuggestion: true, missingReadingLabel: true,
    customSnapshot: { content: { text: "registered", html: "" }, properties: {} },
    customSuggestion: "registered suggestion",
    customEditor: "registered editor", title: "已挂载", updates: 1, disposals: 1, documentCount: 1 });
});

test("panel registration owns initial and fallback tab policy", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createPanelRegistry } = await import("/src/module-registry.ts");
    const panels = createPanelRegistry();
    const definition = { label: "测试", icon: "T", order: 0, available: () => true,
      mount: () => ({ update() {}, dispose() {} }) };
    panels.register({ ...definition, id: "fallback", fallbackTab: true });
    panels.register({ ...definition, id: "initial", initialTab: true });
    const errors = [];
    for (const candidate of [
      { ...definition, id: "second-fallback", fallbackTab: true },
      { ...definition, id: "second-initial", initialTab: true }
    ]) {
      try { panels.register(candidate); } catch (error) { errors.push(String(error)); }
    }
    try { createPanelRegistry().register({ ...definition, id: "unavailable-fallback", fallbackTab: true, available: () => false }); }
    catch (error) { errors.push(String(error)); }
    return { errors, entries: panels.entries().map(panel => panel.id) };
  });
  expect(result.entries).toEqual(["fallback", "initial"]);
  expect(result.errors).toHaveLength(3);
  expect(result.errors[0]).toContain("回退面板");
  expect(result.errors[1]).toContain("初始面板");
  expect(result.errors[2]).toContain("空上下文可用");
});

test("a registered document runtime routes without changing the host entrypoint", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createDocumentRegistry } = await import("/src/module-registry.ts");
    const { createDocumentRouter } = await import("/src/document-router.ts");
    const registry = createDocumentRegistry();
    const calls = [];
    registry.register({ id: "example", order: 1, createLabel: "新建示例", createIcon: "E",
      presentation: { icon: "E", iconClass: "", createPrompt: "名称", defaultTitle: "示例", idPrefix: "example" },
      create() {}, liveContext: { tracksSource: true, create: state => ({ surface: "document", state }) }, runtime: {
        open(state) { calls.push(`open:${state.note.id}`); }, update(state) { calls.push(`update:${state.note.id}`); },
        close() { calls.push("close"); }, async flush() { calls.push("flush"); },
        focusBlock(id) { calls.push(`focus:${id}`); }, async restoreHistory(id) { calls.push(`history:${id}`); }
      } });
    const router = createDocumentRouter(registry);
    const state = { note: { id: "example-1" } };
    router.open("example", state); router.update(state); router.focusBlock("block-1");
    await router.restoreHistory("revision-1"); await router.flush();
    router.open("example", { note: { id: "example-2" } });
    return calls;
  });
  expect(result).toEqual(["open:example-1", "update:example-1", "focus:block-1", "history:revision-1", "flush", "close", "open:example-2"]);
});

test("all built-in block kinds declare reference and search capabilities", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { blockModules } = await import("/src/block-modules.ts");
    return blockModules.entries().map(module => ({ id: module.id, reference: module.capabilities.includes("reference"),
      search: module.capabilities.includes("search"), editor: typeof module.editor.mount === "function",
      typeLabel: module.typeLabel, icon: module.icon?.({ type: module.id, id: "probe", parentId: null, position: "00001000", content: { text: "", html: "" }, properties: {}, revision: 1 }) }));
  });
  expect(result).toHaveLength(13);
  expect(result.every(item => item.reference && item.search && item.editor && item.typeLabel && item.icon)).toBe(true);
});

test("specialized reference rows are supplied by block definitions", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { blockModules } = await import("/src/block-modules.ts");
    return {
      headingClass: blockModules.require("heading").referenceRowClass?.({ type: "heading" }),
      location: typeof blockModules.require("location").referenceRow === "function",
      table: typeof blockModules.require("database_table").referenceRow === "function",
      query: typeof blockModules.require("data_view").referenceRow === "function",
      bookmark: typeof blockModules.require("reading_bookmark").referenceRow === "function",
      highlight: typeof blockModules.require("reading_highlight").referenceRow === "function",
      note: typeof blockModules.require("reading_note").referenceRow === "function"
    };
  });
  expect(result).toEqual({ headingClass: "heading", location: true, table: true, query: true, bookmark: true, highlight: true, note: true });
});

test("database and reference host roles and todo defaults come from the block registry", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { blockModules, createRegisteredBlock, databaseBlockRole, isReferenceInstanceHost } = await import("/src/block-modules.ts");
    const todo = createRegisteredBlock({ id: "todo-probe", type: "todo" });
    const table = createRegisteredBlock({ id: "table-probe", type: "database_table" });
    const query = createRegisteredBlock({ id: "query-probe", type: "data_view" });
    return {
      todoChecked: todo.content.checked,
      todoCreatedAt: todo.properties.todoCreatedAt,
      tableRole: databaseBlockRole(table),
      queryRole: databaseBlockRole(query),
      paragraphRole: blockModules.require("paragraph").databaseRole,
      referenceHost: isReferenceInstanceHost(createRegisteredBlock({ id: "reference-probe", type: "reference" })),
      ordinaryHost: isReferenceInstanceHost(createRegisteredBlock({ id: "paragraph-probe" }))
    };
  });
  expect(result.todoChecked).toBe(false);
  expect(result.todoCreatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(result.tableRole).toBe("table");
  expect(result.queryRole).toBe("query");
  expect(result.paragraphRole).toBeUndefined();
  expect(result.referenceHost).toBe(true);
  expect(result.ordinaryHost).toBe(false);
});

test("the browser entrypoint registers five document kinds and eleven panel slots", async ({ page }) => {
  await page.goto("/");
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  const result = await page.evaluate(async () => {
    const { createBuiltinPanelRegistry } = await import("/src/builtin-panels.ts");
    const panels = createBuiltinPanelRegistry({}).entries();
    return {
      panels: panels.map(panel => panel.id),
      mountedTabs: [...document.querySelectorAll("#sidebar-right [data-pane-btn]")].map(tab => tab.getAttribute("data-pane-btn")),
      slots: [...document.querySelectorAll("#sidebar-right-body > [data-panel]")].length,
      creationKinds: [...document.querySelectorAll(".workspace-create-menu button")].length
    };
  });
  expect(result.panels).toHaveLength(11);
  expect(result.mountedTabs).toEqual(result.panels);
  expect(result.slots).toBe(11);
  expect(result.creationKinds).toBe(5);
});

test("document definitions declare Dashboard source eligibility", async ({ page }) => {
  await page.goto("/");
  const roles = await page.evaluate(async () => {
    const { createDocumentRegistry } = await import("/src/module-registry.ts");
    const { registerBuiltinDocumentModules } = await import("/src/builtin-document-modules.ts");
    const { BrowserMockHost } = await import("/src/browser-mock-host.ts");
    const registry = createDocumentRegistry();
    registerBuiltinDocumentModules(registry, new BrowserMockHost(), {});
    return Object.fromEntries(registry.entries().map(item => [item.id, {
      dashboardSource: item.dashboardSource?.countsAsDocument ?? null,
      canvasNodeKind: item.canvasLink?.nodeKind ?? "document"
    }]));
  });
  expect(roles).toEqual({
    document: { dashboardSource: true, canvasNodeKind: "document" },
    database: { dashboardSource: false, canvasNodeKind: "document" },
    canvas: { dashboardSource: false, canvasNodeKind: "canvas" },
    dashboard: { dashboardSource: null, canvasNodeKind: "document" },
    reading: { dashboardSource: false, canvasNodeKind: "document" }
  });
});

test("Dashboard panel context keeps its document identity when a source refreshes", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createSurfaceContextController } = await import("/src/surface-context-controller.ts");
    const source = { note: { id: "source" } };
    const refreshed = { note: { id: "source", title: "Updated" } };
    const dashboard = { note: { id: "dashboard" } };
    const published = [];
    const module = id => ({ liveContext: {
      tracksSource: id === "source",
      create: (state, sourceState, surface) => ({ state, sourceState, surface })
    } });
    const controller = createSurfaceContextController({
      module, load: async () => refreshed, publish: context => published.push(context),
      readingId: () => null, flushReading: async () => {}, refreshReading() {}, refreshCanvas() {},
      refreshDashboard() {}, dashboardOpen: () => true, dashboardState: () => dashboard,
      applyEditor() {}, setDashboardSource() {}, error: error => { throw error; }
    });
    controller.changed(source, "document");
    controller.changed(dashboard, "dashboard", source);
    controller.documentChanged("source");
    await new Promise(resolve => setTimeout(resolve, 0));
    return published.map(context => [context.surface, context.state.note.id, context.sourceState?.note.id]);
  });
  expect(result).toEqual([
    ["document", "source", "source"],
    ["dashboard", "dashboard", "source"],
    ["dashboard", "dashboard", "source"]
  ]);
});

test("opening a Dashboard publishes its own identity to the right panels", async ({ page }) => {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept("上下文看板"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Dashboard" }).click();
  const dashboardId = await page.evaluate(() => window.mockHost.current);
  await expect(page.locator('[data-slot="history"]')).toHaveAttribute("data-document-id", dashboardId);
  await expect(page.locator('[data-slot="reference-sidebar"]')).toHaveAttribute("data-document-id", dashboardId);
  await page.evaluate(() => {
    window.dashboardContextUpdates = [];
    const publish = window.shell.setPanelContext.bind(window.shell);
    window.shell.setPanelContext = context => {
      window.dashboardContextUpdates.push({ surface: context?.surface, documentId: context?.state.note.id });
      publish(context);
    };
  });
  await page.evaluate(() => window.mockHost.updateSourceBlock("alpha", "a1", "更新 Dashboard 来源"));
  await expect.poll(() => page.evaluate(() => window.dashboardContextUpdates.length)).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => window.dashboardContextUpdates.at(-1))).toEqual({ surface: "dashboard", documentId: dashboardId });
  await expect(page.locator('[data-slot="history"]')).toHaveAttribute("data-document-id", dashboardId);
  await expect(page.locator('[data-slot="reference-sidebar"]')).toHaveAttribute("data-document-id", dashboardId);
});

test("host document loads use the registered Canvas and Reading surfaces", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.loadedContexts = [];
    const publish = window.shell.setPanelContext.bind(window.shell);
    window.shell.setPanelContext = context => {
      if (context) window.loadedContexts.push({ surface: context.surface, documentId: context.state.note.id });
      publish(context);
    };
  });
  page.once("dialog", dialog => dialog.accept("单路由画布"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建 Canvas" }).click();
  const canvasId = await page.evaluate(() => window.mockHost.current);
  await expect(page.locator(".canvas-view")).toBeVisible();
  const canvasSurfaces = await page.evaluate(id => window.loadedContexts.filter(item => item.documentId === id).map(item => item.surface), canvasId);
  expect(canvasSurfaces.length).toBeGreaterThan(0);
  expect(canvasSurfaces.every(surface => surface === "canvas")).toBe(true);

  await page.locator('[data-document-id="alpha"] > .doc-item').click();
  await page.evaluate(() => { window.loadedContexts = []; });
  page.once("dialog", dialog => dialog.accept("单路由读书笔记"));
  await page.locator(".bk-strip.active .bookmark-add-document").click();
  await page.getByRole("button", { name: "新建读书笔记" }).click();
  const readingId = await page.evaluate(() => window.mockHost.current);
  await expect(page.locator(".reading-view")).toBeVisible();
  expect(await page.evaluate(id => window.loadedContexts.filter(item => item.documentId === id).map(item => item.surface), readingId)).toEqual(["document"]);
});

test("built-in panel availability reads surface capabilities instead of shell panel branches", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createBuiltinPanelRegistry } = await import("/src/builtin-panels.ts");
    const registry = createBuiltinPanelRegistry({});
    const context = { surface: "document", state: { note: { id: "doc-1" } }, capabilities: { database: true, canvasObject: false, dashboardWidget: false } };
    return {
      database: registry.require("databases").available(context),
      canvas: registry.require("canvas-config").available(context),
      dashboard: registry.require("dashboard-config").available(context)
    };
  });
  expect(result).toEqual({ database: true, canvas: false, dashboard: false });
});

test("built-in panels reject missing command dependencies instead of mounting inert actions", async ({ page }) => {
  await page.goto("/");
  const failures = await page.evaluate(async () => {
    const { createBuiltinPanelRegistry } = await import("/src/builtin-panels.ts");
    const registry = createBuiltinPanelRegistry({});
    return ["reference-sidebar", "backlinks", "overrides", "comments", "history", "calendar", "locations", "styles", "databases"]
      .map(id => {
        try { registry.require(id).mount(document.createElement("div")); return null; }
        catch (error) { return { id, message: String(error) }; }
      });
  });
  expect(failures).toHaveLength(9);
  failures.forEach(failure => {
    expect(failure).not.toBeNull();
    expect(failure.message).toContain(failure.id);
    expect(failure.message).toContain("缺少");
  });
});

test("contextual panels select and restore tabs using their registered policy", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#title")).toHaveValue("Alpha");
  await page.locator('[data-pane-btn="backlinks"]').click();
  await page.evaluate(() => window.shell.setPanelCapability("databases", true, true));
  await expect(page.locator('[data-pane-btn="databases"]')).toHaveClass(/active/);
  await page.evaluate(() => window.shell.setPanelCapability("databases", false));
  await expect(page.locator('[data-pane-btn="backlinks"]')).toHaveClass(/active/);
  await page.evaluate(() => window.shell.setPanelCapability("canvas-config", true, true));
  await expect(page.locator('[data-pane-btn="canvas-config"]')).toHaveClass(/active/);
  await page.evaluate(() => window.shell.setPanelCapability("canvas-config", false));
  await expect(page.locator('[data-pane-btn="reference-sidebar"]')).toHaveClass(/active/);
});

test("a registered panel mounts, receives public context, and controls visibility", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createPanelRegistry } = await import("/src/module-registry.ts");
    const { mountPanelHost } = await import("/src/panel-host.ts");
    const registry = createPanelRegistry();
    const calls = [];
    registry.register({ id: "sample", label: "测试统计", icon: "S", order: 1, available: context => !!context,
      mount(slot) {
        calls.push("mount");
        return { update(context) { slot.textContent = context?.state.note.id ?? ""; calls.push(`update:${context?.state.note.id ?? "none"}`); },
          activate() { calls.push("activate"); },
          dispose() { calls.push("dispose"); } };
      } });
    const tabs = document.createElement("div"); const body = document.createElement("div");
    const host = mountPanelHost(tabs, body, registry);
    host.update(null, "sample");
    const initiallyHidden = tabs.querySelector("button").hidden && body.querySelector("section").hidden;
    host.update({ surface: "document", state: { note: { id: "doc-1" } } }, "sample");
    host.activate("sample");
    const shown = !tabs.querySelector("button").hidden && !body.querySelector("section").hidden;
    const content = body.querySelector("[data-slot=sample]").textContent;
    host.dispose();
    return { initiallyHidden, shown, content, calls };
  });
  expect(result).toEqual({ initiallyHidden: true, shown: true, content: "doc-1",
    calls: ["mount", "update:none", "update:doc-1", "activate", "dispose"] });
});
