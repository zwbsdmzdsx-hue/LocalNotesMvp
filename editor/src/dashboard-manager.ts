import type { EditorState, Block, BlockProperties } from "../../protocol/types";
import type { WorkspaceApi, WorkspaceDocument } from "./workspace-api";
import type { DocumentModule, ModuleRegistry } from "./module-registry";
import type { EditorHostApi } from "./editor-host-api";
import type { HistoryModel } from "./history";
import { createRegisteredBlock as createBlock, isDashboardWidgetBlock } from "./block-modules";
import { DocumentSaveSession } from "./document-session";
import { dashboardMetricPresets, normalizeDashboardQuery, runDashboardQuery } from "./dashboard-query";
import { dataViews, renderDataView, sourceNames, type DataViewKind } from "./dashboard-views";
import type { DashboardExternalWidget } from "./dashboard-extension";
import type { DashboardConfigPanelModel } from "./dashboard-config-panel";
import { defaultDashboardRenderers, dashboardWidgetConfig, widgetIcons, type DashboardWidgetRenderer } from "./dashboard-renderers";
import { renderDashboardDocumentFilter } from "./dashboard-filter-widget";
import { renderDashboardWidgetBody } from "./dashboard-widget-body";

export type DashboardWidgetKind =
  | "references" | "backlinks" | "overrides" | "comments" | "history"
  | "calendar" | "locations" | "styles" | "databases" | (string & {});

type DashboardCallbacks = {
  onOpenDocument(documentId: string, blockId?: string): void;
  onError(error: unknown): void;
  onStateChanged?(state: EditorState): void;
  onHistoryChanged?(model: HistoryModel): void;
  onWidgetSelection?(selected: boolean, activate?: boolean): void;
  onShowBacklinks?(blockId: string, state: EditorState): void;
  onWidgetConfig?(model: DashboardConfigPanelModel | null): void;
};

type DashboardConfig = NonNullable<BlockProperties["dashboardWidget"]>;
type DashboardSaveSnapshot = { documentId: string; title: string; blocks: Block[] };

const uid = () => `dashboard-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
function widgetConfig(block: Block): DashboardConfig | undefined {
  return dashboardWidgetConfig(block) as DashboardConfig | undefined;
}

export type DashboardManager = {
  open(state: EditorState, sourceState?: EditorState | null): void;
  close(): void;
  flush(): Promise<void>;
  restoreHistory(entryId: string): Promise<void>;
  isOpen(): boolean;
  currentState(): EditorState | null;
  focusBlock(blockId: string): void;
  applyState(state: EditorState): void;
  setSourceState(state: EditorState | null): void;
  refreshSources(documentId?: string): void;
  register(renderer: DashboardWidgetRenderer): void;
  registerExternal(definition: DashboardExternalWidget): () => void;
};

export function mountDashboardManager(host: EditorHostApi, workspace: WorkspaceApi, callbacks: DashboardCallbacks, documentModules: ModuleRegistry<DocumentModule>): DashboardManager {
  const container = document.querySelector<HTMLElement>(".workspace")!;
  const view = document.createElement("section");
  view.className = "dashboard-view";
  view.hidden = true;
  view.innerHTML = `<header class="dashboard-bar"><span class="dashboard-mark" aria-hidden="true">▦</span><input class="dashboard-title" aria-label="Dashboard 名称" maxlength="120"><span class="dashboard-save-state" role="status">已保存</span><span class="dashboard-spacer"></span><button type="button" data-dashboard-action="add" title="添加组件" aria-label="添加组件">＋</button></header><div class="dashboard-viewport"><div class="dashboard-stage"></div></div>`;
  container.append(view);
  const title = view.querySelector<HTMLInputElement>(".dashboard-title")!;
  const saveState = view.querySelector<HTMLElement>(".dashboard-save-state")!;
  const stage = view.querySelector<HTMLElement>(".dashboard-stage")!;
  const editor = container.querySelector<HTMLElement>(".editor")!;
  let current: EditorState | null = null;
  let sourceState: EditorState | null = null;
  const sourceStates = new Map<string, EditorState>();
  const versions = new Map<string, number>();
  const saveSession = new DocumentSaveSession<DashboardSaveSnapshot>(async snapshot => {
    const clientVersion = versions.get(snapshot.documentId);
    if (clientVersion === undefined) throw new Error("Dashboard 版本未知");
    const result = await host.saveDocument({ ...snapshot, mutationId: uid(), clientVersion: clientVersion + 1 });
    versions.set(snapshot.documentId, result.clientVersion);
    if (current?.note.id === snapshot.documentId) {
      current.note.clientVersion = result.clientVersion;
      if (result.history) { current.history = result.history; callbacks.onHistoryChanged?.(result.history); }
      callbacks.onStateChanged?.(structuredClone(current));
    }
  }, (phase, error) => {
    setSaveState(phase === "pending" ? "未保存" : phase === "saving" ? "保存中" : phase === "saved" ? "已保存" : "保存失败", phase === "failed");
    if (phase === "failed") callbacks.onError(error);
  });
  let selectedWidgetId: string | null = null;
  let viewDisposers: Array<() => void> = [];
  const renderers = new Map<string, DashboardWidgetRenderer>(defaultDashboardRenderers().map(renderer => [renderer.kind, renderer]));
  const externalWidgets = new Map<string, DashboardExternalWidget>();
  const externalRuntimes = new Map<string, { kind: string; settings: string; element: HTMLElement; dispose(): void }>();

  function setSaveState(text: string, error = false) { saveState.textContent = text; saveState.classList.toggle("is-error", error); }
  function widgets() { return current?.blocks.filter(block => isDashboardWidgetBlock(block) && widgetConfig(block)) ?? []; }
  function dashboardSources(documents: WorkspaceDocument[]) {
    return documents.filter(item => Boolean(documentModules.require(item.kind).dashboardSource));
  }
  function documentFilterIds() { return widgets().find(block => widgetConfig(block)?.kind === "documentFilter")?.properties.dashboardWidget?.documentIds ?? []; }
  function rendererFor(kind: string) { return renderers.get(kind); }
  function aggregate(states: EditorState[]): EditorState | null {
    const first = states[0];
    if (!first) return null;
    const result = structuredClone(first);
    result.blocks = states.flatMap(state => state.blocks.map(block => structuredClone(block)));
    result.references = states.flatMap(state => state.references.map(reference => structuredClone(reference)));
    result.backlinks = states.flatMap(state => state.backlinks.map(backlink => structuredClone(backlink)));
    result.overrideNotices = states.flatMap(state => state.overrideNotices.map(notice => structuredClone(notice)));
    result.locations = [...new Map(states.flatMap(state => state.locations ?? []).map(location => [location.id, structuredClone(location)])).values()];
    result.databases = [...new Map(states.flatMap(state => state.databases ?? []).map(database => [database.id, structuredClone(database)])).values()];
    result.systemStyles = [...new Map(states.flatMap(state => state.systemStyles ?? []).map(style => [style.id, structuredClone(style)])).values()];
    result.notebookStyles = [...new Map(states.flatMap(state => state.notebookStyles ?? []).map(style => [style.id, structuredClone(style)])).values()];
    result.documentStyles = [...new Map(states.flatMap(state => state.documentStyles ?? []).map(style => [style.id, structuredClone(style)])).values()];
    return result;
  }
  function dataStateFor(config: NonNullable<BlockProperties["dashboardWidget"]>) {
    const states = dataStatesFor(config);
    if (states.length) return aggregate(states)!;
    const empty = structuredClone(current!);
    empty.blocks = []; empty.references = []; empty.backlinks = []; empty.overrideNotices = [];
    empty.locations = []; empty.databases = []; empty.systemStyles = []; empty.notebookStyles = []; empty.documentStyles = [];
    return empty;
  }
  function dataStatesFor(config: DashboardConfig): EditorState[] {
    const documents = dashboardSources(workspace.snapshot().documents);
    const selected = documentFilterIds();
    const allowed = new Set(documents.filter(item => (!selected.length || selected.includes(item.id)) &&
      (config.kind !== "metric" && !(config.kind in dataViews) || normalizeDashboardQuery(config.query).source !== "documents" || documentModules.require(item.kind).dashboardSource?.countsAsDocument)).map(item => item.id));
    if (config.scope === "activeDocument") return sourceState && allowed.has(sourceState.note.id) ? [sourceState] : [];
    if (config.scope === "document") return [sourceStates.get(config.sourceId ?? sourceState?.note.id ?? "")].filter((state): state is EditorState => !!state && allowed.has(state.note.id));
    const states = [...sourceStates.values()].filter(state => allowed.has(state.note.id));
    if (config.scope === "notebook") return states.filter(state => state.note.workspaceId === current?.note.workspaceId);
    return states;
  }
  function renderQueryWidget(config: DashboardConfig) {
    const query = normalizeDashboardQuery(config.query);
    const kind = config.kind as DataViewKind;
    const definition = dataViews[kind];
    if (definition && !definition.sources.includes(query.source)) {
      const body = document.createElement("div"); body.className = "dashboard-query-result";
      const error = document.createElement("p"); error.className = "dashboard-query-error";
      error.textContent = "此视图不支持当前数据类型，请在右栏重新选择。";
      body.append(error);
      return { element: body, dispose() {} };
    }
    const result = runDashboardQuery(dataStatesFor(config), query);
    const body = document.createElement("div"); body.className = "dashboard-query-result";
    const view = renderDataView(kind, config, query, result); body.append(view.element);
    return { element: body, dispose: view.dispose };
  }
  function renderDocumentFilter(block: Block, config: DashboardConfig) {
    const options = dashboardSources(workspace.snapshot().documents).map(item => ({ id: item.id, title: item.title }));
    return renderDashboardDocumentFilter({ documents: options, selectedIds: config.documentIds ?? [], onChange: ids => {
      config.documentIds = ids;
      block.revision += 1;
      render(); renderSettings(); scheduleSave();
    } });
  }
  function renderExternalWidget(block: Block, definition: DashboardExternalWidget) {
    const config = widgetConfig(block)!;
    const settings = JSON.stringify(config.externalSettings ?? {});
    const previous = externalRuntimes.get(block.id);
    if (previous?.kind === config.kind && previous.settings === settings) return previous.element;
    previous?.dispose();
    const element = document.createElement("div"); element.className = "dashboard-external-widget";
    const status = document.createElement("p"); status.className = "dashboard-empty"; status.textContent = "加载中"; element.append(status);
    const controller = new AbortController();
    let cleanup: void | (() => void);
    let stopped = false;
    const runtime = {
      kind: config.kind, settings, element,
      dispose() { if (stopped) return; stopped = true; controller.abort(); externalRuntimes.delete(block.id); try { cleanup?.(); } catch (error) { callbacks.onError(error); } }
    };
    externalRuntimes.set(block.id, runtime);
    const context = {
      widgetId: block.id,
      settings: structuredClone(config.externalSettings ?? {}),
      signal: controller.signal,
      refresh: () => { if (stopped || !current?.blocks.some(item => item.id === block.id)) return; runtime.dispose(); element.replaceWith(renderExternalWidget(block, definition)); }
    };
    void Promise.resolve().then(() => definition.mount(element, context)).then(result => {
      if (stopped) { if (typeof result === "function") result(); return; }
      cleanup = result;
      if (status.isConnected) {
        if (element.childNodes.length > 1) status.remove();
        else status.textContent = "组件没有内容";
      }
    }).catch(error => {
      if (stopped) return;
      const message = document.createElement("p"); message.className = "dashboard-query-error";
      message.textContent = `组件加载失败：${error instanceof Error ? error.message : String(error)}`;
      element.replaceChildren(message);
    });
    return element;
  }
  function renderWidget(block: Block) {
    const config = widgetConfig(block)!;
    const card = document.createElement("article");
    card.className = "dashboard-widget";
    card.dataset.widgetId = block.id;
    card.classList.toggle("is-selected", selectedWidgetId === block.id);
    card.onclick = event => { if (!(event.target as Element).closest("button")) selectWidget(block.id, true); };
    card.style.left = `${config.layout.x}px`; card.style.top = `${config.layout.y}px`;
    card.style.width = `${config.layout.width}px`; card.style.height = `${config.layout.height}px`;
    card.style.zIndex = String(config.layout.zIndex ?? 1);
    if (config.style?.background) card.style.backgroundColor = config.style.background;
    if (config.style?.color) card.style.setProperty("--dashboard-widget-color", config.style.color);
    if (config.style?.accent) card.style.borderColor = config.style.accent;
    if (config.style?.fontSize) card.style.setProperty("--dashboard-widget-font-size", `${config.style.fontSize}px`);
    const head = document.createElement("header"); head.className = "dashboard-widget-head";
    const icon = document.createElement("span"); icon.className = "dashboard-widget-icon";
    icon.textContent = externalWidgets.get(config.kind)?.icon || rendererFor(config.kind)?.icon || dataViews[config.kind as DataViewKind]?.icon || widgetIcons[config.kind] || "◇";
    icon.title = config.kind;
    const label = document.createElement("strong"); label.textContent = config.title || config.kind;
    const kind = document.createElement("small"); kind.textContent = externalWidgets.has(config.kind) ? "外部组件" : config.kind in dataViews ? sourceNames[normalizeDashboardQuery(config.query).source] : config.kind === "documentFilter" ? "范围控件" : config.kind;
    const controls = document.createElement("span"); controls.className = "dashboard-widget-controls";
    const smaller = document.createElement("button"); smaller.type = "button"; smaller.textContent = "−"; smaller.title = "缩小组件"; smaller.onclick = () => resize(block, -24, -16);
    const larger = document.createElement("button"); larger.type = "button"; larger.textContent = "+"; larger.title = "放大组件"; larger.onclick = () => resize(block, 24, 16);
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "移除组件"; remove.onclick = () => { current!.blocks = current!.blocks.filter(item => item.id !== block.id); if (selectedWidgetId === block.id) selectWidget(null); render(); scheduleSave(); };
    controls.append(smaller, larger, remove); head.append(icon, label, kind, controls); card.append(head);
    const body = document.createElement("div"); body.className = "dashboard-widget-body";
    body.append(renderDashboardWidgetBody({
      block, config, state: dataStateFor(config), renderers,
      dataViews: Object.fromEntries(Object.entries(dataViews).map(([kind, definition]) => [kind, { label: definition.label, icon: definition.icon }])),
      externalWidgets,
      renderDocumentFilter,
      renderQuery: renderQueryWidget,
      renderExternal: renderExternalWidget,
      registerDispose: dispose => viewDisposers.push(dispose)
    }));
    if (config.description) { const description = document.createElement("p"); description.className = "dashboard-widget-description"; description.textContent = config.description; body.append(description); }
    card.append(body);
    enableDrag(card, block);
    return card;
  }
  function selectWidget(id: string | null, activate = false) {
    selectedWidgetId = id;
    stage.querySelectorAll<HTMLElement>(".dashboard-widget").forEach(card => card.classList.toggle("is-selected", card.dataset.widgetId === id));
    renderSettings();
    callbacks.onWidgetSelection?.(!!id, activate);
  }
  function renderSettings() {
    const block = widgets().find(item => item.id === selectedWidgetId);
    if (!block || !current) { callbacks.onWidgetConfig?.(null); return; }
    const owner = current;
    const config = widgetConfig(block)!;
    callbacks.onWidgetConfig?.({
      block, current: owner, external: externalWidgets.get(config.kind),
      documents: dashboardSources(workspace.snapshot().documents), dataStatesFor,
      onChange(rerenderSettings) {
        if (current !== owner) return;
        block.revision += 1;
        render();
        scheduleSave();
        if (rerenderSettings) renderSettings();
      },
      hydrateSources,
      openDocument: callbacks.onOpenDocument,
      showBacklinks: () => callbacks.onShowBacklinks?.(block.id, owner)
    });
  }
  function render() {
    if (!current) return;
    title.value = current.note.title;
    viewDisposers.forEach(dispose => dispose()); viewDisposers = [];
    const active = new Set(widgets().map(block => block.id));
    for (const [id, runtime] of externalRuntimes) if (!active.has(id) || !externalWidgets.has(runtime.kind)) runtime.dispose();
    stage.replaceChildren(...widgets().sort((a, b) => (widgetConfig(a)!.layout.zIndex ?? 0) - (widgetConfig(b)!.layout.zIndex ?? 0)).map(renderWidget));
    const maxX = Math.max(900, ...widgets().map(block => (widgetConfig(block)!.layout.x + widgetConfig(block)!.layout.width + 40)));
    const maxY = Math.max(620, ...widgets().map(block => (widgetConfig(block)!.layout.y + widgetConfig(block)!.layout.height + 40)));
    stage.style.width = `${maxX}px`; stage.style.height = `${maxY}px`;
  }
  async function hydrateSources() {
    if (!current) return;
    const configs = widgets().map(widgetConfig).filter((config): config is DashboardConfig => Boolean(config));
    const ids = new Set<string>();
    const snapshot = workspace.snapshot();
    configs.filter(config => !externalWidgets.has(config.kind)).forEach(config => {
      if (config.scope === "document" && config.sourceId) ids.add(config.sourceId);
      if (config.scope === "notebook" || config.scope === "workspace") dashboardSources(snapshot.documents).filter(item =>
        (config.scope === "workspace" || snapshot.bookmarks.find(bookmark => bookmark.id === item.bookmarkId)?.notebookId === current?.note.workspaceId)).forEach(item => ids.add(item.id));
    });
    if (sourceState) sourceStates.set(sourceState.note.id, structuredClone(sourceState));
    await Promise.all([...ids].filter(id => !sourceStates.has(id)).map(async id => {
      try { sourceStates.set(id, await host.loadDocument(id)); } catch { /* deleted source: renderer shows its empty state */ }
    }));
    if (current) { render(); renderSettings(); }
  }
  function resize(block: Block, dx: number, dy: number) {
    const layout = widgetConfig(block)!.layout;
    layout.width = Math.max(220, layout.width + dx); layout.height = Math.max(140, layout.height + dy); block.revision += 1; render(); scheduleSave();
  }
  function enableDrag(card: HTMLElement, block: Block) {
    const head = card.querySelector<HTMLElement>(".dashboard-widget-head")!;
    let drag: { x: number; y: number; left: number; top: number } | null = null;
    head.addEventListener("pointerdown", event => {
      if ((event.target as Element).closest("button")) return;
      const layout = widgetConfig(block)!.layout; drag = { x: event.clientX, y: event.clientY, left: layout.x, top: layout.y }; head.setPointerCapture(event.pointerId);
    });
    head.addEventListener("pointermove", event => { if (!drag) return; const layout = widgetConfig(block)!.layout; layout.x = Math.max(0, drag.left + event.clientX - drag.x); layout.y = Math.max(0, drag.top + event.clientY - drag.y); card.style.left = `${layout.x}px`; card.style.top = `${layout.y}px`; });
    head.addEventListener("pointerup", () => { if (drag) { block.revision += 1; scheduleSave(); } drag = null; });
    head.addEventListener("pointercancel", () => { drag = null; });
  }
  function addWidget(kind: string) {
    if (!current) return;
    if (kind === "documentFilter" && widgets().some(block => widgetConfig(block)?.kind === kind)) { selectWidget(widgets().find(block => widgetConfig(block)?.kind === kind)!.id, true); return; }
    const metric = !!dashboardMetricPresets[kind];
    const definition = dataViews[kind as DataViewKind];
    const external = externalWidgets.get(kind);
    const query = metric ? { ...dashboardMetricPresets[kind] } : definition ? { source: definition.defaultSource, measure: "count" as const } : undefined;
    const width = definition || external ? 400 : 320;
    const height = definition || external ? 260 : 220;
    let placement = { x: 32, y: 32 };
    const rows = [32, ...widgets().map(item => { const layout = widgetConfig(item)!.layout; return layout.y + layout.height + 16; })].sort((a, b) => a - b);
    for (const y of rows) {
      const candidate = [32, 376].map(x => ({ x, y })).find(({ x, y }) =>
        widgets().every(item => { const other = widgetConfig(item)!.layout; return x >= other.x + other.width + 16 || other.x >= x + width + 16 || y >= other.y + other.height + 16 || other.y >= y + height + 16; }));
      if (candidate) { placement = candidate; break; }
    }
    const externalSettings = external ? Object.fromEntries((external.settings ?? []).map(setting => [setting.key, setting.defaultValue ?? null])) : undefined;
    const block = createBlock({ id: uid(), type: "dashboard_widget", position: String((current.blocks.length + 1) * 1000).padStart(8, "0"), properties: { dashboardWidget: { kind: metric ? "metric" : kind, title: kind === "documentFilter" ? "文档范围" : definition?.label ?? external?.title ?? kind, scope: metric || definition || external ? "workspace" : "activeDocument", query, externalSettings, layout: { ...placement, width, height } } } });
    current.blocks.push(block); render(); selectWidget(block.id, true); scheduleSave(); if (!external) void hydrateSources();
  }
  function scheduleSave() {
    if (!current) return;
    saveSession.schedule({ documentId: current.note.id, title: current.note.title, blocks: structuredClone(current.blocks) }, 350);
  }
  function setupAddMenu() {
    view.querySelector<HTMLButtonElement>("[data-dashboard-action=add]")!.onclick = event => {
      event.stopPropagation(); document.querySelector(".dashboard-add-menu")?.remove();
      const menu = document.createElement("div"); menu.className = "dashboard-add-menu";
      ["documentFilter", "文档数量", "关键字数量", "未完成待办", "已完成待办", "位置汇总", "表格汇总", "detailTable", "pivotTable", "barChart", "pieChart", "trendChart", "todoCalendar", "locationMap", "relationGraph", "references", "backlinks", "overrides", "comments", "history", "calendar", "locations", "styles", "databases", ...externalWidgets.keys()].forEach(kind => { const button = document.createElement("button"); button.type = "button"; button.textContent = kind === "documentFilter" ? "文档范围筛选" : dataViews[kind as DataViewKind]?.label ?? externalWidgets.get(kind)?.title ?? kind; button.onclick = () => { menu.remove(); addWidget(kind); }; menu.append(button); });
      document.body.append(menu); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); menu.style.left = `${rect.left}px`; menu.style.top = `${rect.bottom + 4}px`;
      setTimeout(() => document.addEventListener("pointerdown", event => {
        if (!menu.contains(event.target as Node) && !view.querySelector("[data-dashboard-action=add]")?.contains(event.target as Node)) menu.remove();
      }, { once: true }), 0);
    };
    title.addEventListener("change", () => { if (!current) return; current.note.title = title.value.trim() || "未命名 Dashboard"; scheduleSave(); });
  }
  setupAddMenu();
  function open(state: EditorState, nextSourceState?: EditorState | null) {
    externalRuntimes.forEach(runtime => runtime.dispose());
    current = structuredClone(state);
    versions.set(state.note.id, state.note.clientVersion);
    selectedWidgetId = null;
    sourceStates.clear();
    sourceState = nextSourceState ? structuredClone(nextSourceState) : sourceState;
    if (sourceState) sourceStates.set(sourceState.note.id, structuredClone(sourceState));
    editor.hidden = true; view.hidden = false; render(); renderSettings(); callbacks.onHistoryChanged?.(state.history ?? { documentId: state.note.id, entries: [], currentId: "", canUndo: false, canRedo: false }); callbacks.onWidgetSelection?.(false); void hydrateSources();
  }
  function close() { viewDisposers.forEach(dispose => dispose()); viewDisposers = []; externalRuntimes.forEach(runtime => runtime.dispose()); view.hidden = true; current = null; sourceState = null; selectedWidgetId = null; sourceStates.clear(); editor.hidden = false; stage.replaceChildren(); callbacks.onWidgetConfig?.(null); callbacks.onWidgetSelection?.(false); }
  function setSourceState(state: EditorState | null) {
    sourceState = state ? structuredClone(state) : null;
    if (sourceState) sourceStates.set(sourceState.note.id, structuredClone(sourceState));
    if (current) { render(); void hydrateSources(); }
  }
  function refreshSources(documentId?: string) {
    if (documentId) sourceStates.delete(documentId);
    if (sourceState && (!documentId || sourceState.note.id === documentId)) sourceStates.delete(sourceState.note.id);
    if (current) void hydrateSources();
  }
  const focusBlock = (blockId: string) => {
    if (!widgets().some(block => block.id === blockId)) return;
    selectWidget(blockId, true);
    stage.querySelector<HTMLElement>(`[data-widget-id="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: "center", inline: "center" });
  };
  async function restoreHistory(entryId: string) {
    await saveSession.flush();
    if (!current) return;
    const result = await host.executeCommand({ operation: "history-restore", entryId, expectedVersion: current.note.clientVersion }, current.note.id);
    if (current?.note.id === result.state.note.id) applyState(result.state);
  }
  function applyState(state: EditorState) {
    if (!current || current.note.id !== state.note.id) return;
    current = structuredClone(state);
    versions.set(state.note.id, state.note.clientVersion);
    callbacks.onHistoryChanged?.(state.history ?? { documentId: state.note.id, entries: [], currentId: "", canUndo: false, canRedo: false });
    render(); renderSettings();
    callbacks.onStateChanged?.(structuredClone(current));
  }
  return { open, close, focusBlock, restoreHistory, isOpen: () => !view.hidden, currentState: () => current ? structuredClone(current) : null, applyState, setSourceState, refreshSources,
    register: renderer => { renderers.set(renderer.kind, renderer); if (current) render(); },
    registerExternal: definition => {
      if (!/^[a-z][\w-]*(?:\.[a-z][\w-]*)+$/i.test(definition.kind) || definition.kind in dataViews || renderers.has(definition.kind) || externalWidgets.has(definition.kind)) throw new Error("外部组件需要唯一的命名空间类型 ID");
      externalWidgets.set(definition.kind, definition);
      if (current) { render(); renderSettings(); }
      return () => { if (externalWidgets.get(definition.kind) !== definition) return; externalWidgets.delete(definition.kind); for (const runtime of externalRuntimes.values()) if (runtime.kind === definition.kind) runtime.dispose(); if (current) { render(); renderSettings(); } };
    }, flush: () => saveSession.flush() };
}
