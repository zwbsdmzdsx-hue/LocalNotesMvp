import type { EditorState, Block, BlockProperties } from "../../protocol/types";
import type { WorkspaceApi } from "./workspace-api";
import type { EditorHostApi } from "./editor-host-api";
import { dashboardRows, normalizeDashboardQuery, runDashboardQuery, type DashboardOperator, type DashboardQuery } from "./dashboard-query";

export type DashboardWidgetKind =
  | "references" | "backlinks" | "overrides" | "comments" | "history"
  | "calendar" | "locations" | "styles" | "databases" | (string & {});

export type DashboardWidgetRenderer = {
  kind: DashboardWidgetKind;
  render(state: EditorState, widget: Block): HTMLElement;
};

type DashboardCallbacks = {
  onOpenDocument(documentId: string, blockId?: string): void;
  onError(error: unknown): void;
  onStateChanged?(state: EditorState): void;
  onWidgetSelection?(selected: boolean, activate?: boolean): void;
};

type DashboardConfig = NonNullable<BlockProperties["dashboardWidget"]> & {
  description?: string;
  style?: { background?: string; color?: string; accent?: string; fontSize?: number };
};

const uid = () => `dashboard-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
const escapeText = (value: unknown) => String(value ?? "");

function widgetConfig(block: Block): DashboardConfig | undefined {
  return block.properties.dashboardWidget as DashboardConfig | undefined;
}

function list(title: string, values: string[], empty = "暂无内容") {
  const section = document.createElement("div");
  section.className = "dashboard-widget-list";
  if (!values.length) {
    const p = document.createElement("p"); p.className = "dashboard-empty"; p.textContent = empty; section.append(p); return section;
  }
  values.slice(0, 12).forEach(value => { const row = document.createElement("div"); row.className = "dashboard-list-row"; row.textContent = value; section.append(row); });
  if (values.length > 12) { const more = document.createElement("small"); more.textContent = `还有 ${values.length - 12} 项`; section.append(more); }
  return section;
}

function countCard(label: string, count: number) {
  const body = document.createElement("div"); body.className = "dashboard-count-card";
  const value = document.createElement("strong"); value.textContent = String(count);
  const caption = document.createElement("span"); caption.textContent = label;
  body.append(value, caption); return body;
}

function defaultRenderers(): DashboardWidgetRenderer[] {
  return [
    { kind: "references", render: state => list("references", state.references.map(ref => `${ref.targetTitle} · ${ref.mode}`)) },
    { kind: "backlinks", render: state => list("backlinks", state.backlinks.map(link => `${link.sourceTitle} · ${link.excerpt}`)) },
    { kind: "overrides", render: state => countCard("条外部覆写通知", state.overrideNotices.length) },
    { kind: "comments", render: state => countCard("条正文注释", state.blocks.reduce((total, block) => total + (block.properties.comments?.length ?? 0), 0)) },
    { kind: "history", render: state => list("history", (state.history?.entries ?? []).map(entry => `${entry.label} · ${entry.preview}`)) },
    { kind: "calendar", render: state => list("calendar", state.blocks.filter(block => block.type === "todo").map(block => block.content.text || "未命名待办"), "当前文档没有待办") },
    { kind: "locations", render: state => list("locations", (state.locations ?? []).filter(location => !location.deletedAt).map(location => `${location.name} · ${location.address}`)) },
    { kind: "styles", render: state => list("styles", [...(state.systemStyles ?? []), ...(state.notebookStyles ?? []), ...(state.documentStyles ?? [])].map(style => `${style.title}${style.enabled ? "" : " · 已停用"}`)) },
    { kind: "databases", render: state => list("databases", (state.databases ?? []).map(database => `${database.title} · ${database.recordCount} 条记录`)) }
  ];
}

export type DashboardManager = {
  open(state: EditorState, sourceState?: EditorState | null): void;
  close(): void;
  flush(): Promise<void>;
  isOpen(): boolean;
  applyState(state: EditorState): void;
  setSourceState(state: EditorState | null): void;
  refreshSources(documentId?: string): void;
  register(renderer: DashboardWidgetRenderer): void;
};

export function mountDashboardManager(host: EditorHostApi, workspace: WorkspaceApi, callbacks: DashboardCallbacks): DashboardManager {
  const container = document.querySelector<HTMLElement>(".workspace")!;
  const view = document.createElement("section");
  view.className = "dashboard-view";
  view.hidden = true;
  view.innerHTML = `<header class="dashboard-bar"><span class="dashboard-mark" aria-hidden="true">▦</span><input class="dashboard-title" aria-label="Dashboard 名称" maxlength="120"><span class="dashboard-save-state" role="status">已保存</span><span class="dashboard-spacer"></span><button type="button" data-dashboard-action="add" title="添加组件" aria-label="添加组件">＋</button></header><div class="dashboard-viewport"><div class="dashboard-stage"></div></div>`;
  container.append(view);
  const title = view.querySelector<HTMLInputElement>(".dashboard-title")!;
  const saveState = view.querySelector<HTMLElement>(".dashboard-save-state")!;
  const stage = view.querySelector<HTMLElement>(".dashboard-stage")!;
  const settings = document.querySelector<HTMLElement>('[data-slot="dashboard-config"]')!;
  const editor = container.querySelector<HTMLElement>(".editor")!;
  let current: EditorState | null = null;
  let sourceState: EditorState | null = null;
  const sourceStates = new Map<string, EditorState>();
  let saveTail = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSaveError: unknown = null;
  let selectedWidgetId: string | null = null;
  const renderers = new Map<string, DashboardWidgetRenderer>(defaultRenderers().map(renderer => [renderer.kind, renderer]));

  function setSaveState(text: string, error = false) { saveState.textContent = text; saveState.classList.toggle("is-error", error); }
  function widgets() { return current?.blocks.filter(block => block.type === "dashboard_widget" && widgetConfig(block)) ?? []; }
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
    if (config.scope === "activeDocument") return sourceState ?? current!;
    if (config.scope === "document") return sourceStates.get(config.sourceId ?? sourceState?.note.id ?? "") ?? sourceState ?? current!;
    if (config.scope === "notebook") {
      const notebookId = sourceState?.note.workspaceId;
      const states = [...sourceStates.values()].filter(state => !notebookId || state.note.workspaceId === notebookId);
      return aggregate(states) ?? sourceState ?? current!;
    }
    if (config.scope === "workspace") return aggregate([...sourceStates.values()]) ?? sourceState ?? current!;
    return current!;
  }
  function dataStatesFor(config: DashboardConfig): EditorState[] {
    const documents = workspace.snapshot().documents.filter(item => item.kind !== "dashboard");
    const allowed = new Set(documents.filter(item => normalizeDashboardQuery(config.query).source !== "documents" || item.kind === "document").map(item => item.id));
    if (config.scope === "activeDocument") return sourceState && allowed.has(sourceState.note.id) ? [sourceState] : [];
    if (config.scope === "document") return [sourceStates.get(config.sourceId ?? "")].filter((state): state is EditorState => !!state && allowed.has(state.note.id));
    const states = [...sourceStates.values()].filter(state => allowed.has(state.note.id));
    if (config.scope === "notebook") return states.filter(state => state.note.workspaceId === current?.note.workspaceId);
    return states;
  }
  function renderQueryWidget(config: DashboardConfig) {
    const query = normalizeDashboardQuery(config.query);
    const result = runDashboardQuery(dataStatesFor(config), query);
    const body = document.createElement("div"); body.className = "dashboard-query-result";
    if (result.error) { const error = document.createElement("p"); error.className = "dashboard-query-error"; error.textContent = result.error; body.append(error); return body; }
    const total = document.createElement("strong"); total.className = "dashboard-query-total"; total.textContent = String(result.value); body.append(total);
    if (query.groupBy) {
      const groups = document.createElement("div"); groups.className = "dashboard-query-groups";
      result.groups.forEach(group => { const row = document.createElement("div"); const label = document.createElement("span"); label.textContent = group.key; const value = document.createElement("strong"); value.textContent = String(group.value); row.append(label, value); groups.append(row); });
      body.append(groups);
    }
    return body;
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
    const label = document.createElement("strong"); label.textContent = config.title || config.kind;
    const kind = document.createElement("small"); kind.textContent = config.kind;
    const controls = document.createElement("span"); controls.className = "dashboard-widget-controls";
    const smaller = document.createElement("button"); smaller.type = "button"; smaller.textContent = "−"; smaller.title = "缩小组件"; smaller.onclick = () => resize(block, -24, -16);
    const larger = document.createElement("button"); larger.type = "button"; larger.textContent = "+"; larger.title = "放大组件"; larger.onclick = () => resize(block, 24, 16);
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "移除组件"; remove.onclick = () => { current!.blocks = current!.blocks.filter(item => item.id !== block.id); if (selectedWidgetId === block.id) selectWidget(null); render(); scheduleSave(); };
    controls.append(smaller, larger, remove); head.append(label, kind, controls); card.append(head);
    const body = document.createElement("div"); body.className = "dashboard-widget-body";
    const custom = rendererFor(config.kind);
    if (config.kind === "metric") body.append(renderQueryWidget(config));
    else if (custom) body.append(custom.render(dataStateFor(config), block));
    else { body.append(countCard("自定义组件占位", 0)); const hint = document.createElement("p"); hint.className = "dashboard-empty"; hint.textContent = "此组件类型已预留，可通过 DashboardWidgetRenderer 注册。"; body.append(hint); }
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
    settings.replaceChildren();
    const block = widgets().find(item => item.id === selectedWidgetId);
    if (!block) return;
    const config = widgetConfig(block)!;
    const query = normalizeDashboardQuery(config.query);
    const form = document.createElement("div"); form.className = "dashboard-settings";
    const update = (rerenderSettings = false) => { block.revision += 1; render(); scheduleSave(); if (rerenderSettings) renderSettings(); };
    const field = (labelText: string, value: string, onChange: (value: string) => void, type = "text") => {
      const label = document.createElement("label"); label.textContent = labelText;
      const input = document.createElement("input"); input.type = type; input.value = value; input.setAttribute("aria-label", labelText);
      input.onchange = () => onChange(input.value); label.append(input); form.append(label); return input;
    };
    const choice = (labelText: string, value: string, options: Array<[string, string]>, onChange: (value: string) => void) => {
      const label = document.createElement("label"); label.textContent = labelText;
      const select = document.createElement("select"); select.setAttribute("aria-label", labelText);
      options.forEach(([key, name]) => { const option = document.createElement("option"); option.value = key; option.textContent = name; select.append(option); });
      select.value = value; select.onchange = () => onChange(select.value); label.append(select); form.append(label); return select;
    };
    field("标题", config.title ?? "", value => { config.title = value.trim(); update(); });
    field("文字描述", config.description ?? "", value => { config.description = value.trim(); update(); });
    choice("数据范围", config.scope, [["activeDocument", "当前文档"], ["document", "指定文档"], ["notebook", "当前笔记本"], ["workspace", "整个工作区"]], value => { config.scope = value as DashboardConfig["scope"]; update(true); void hydrateSources(); });
    if (config.scope === "document") choice("来源文档", config.sourceId ?? "", workspace.snapshot().documents.filter(item => item.kind !== "dashboard").map(item => [item.id, item.title]), value => { config.sourceId = value; update(); void hydrateSources(); });
    if (config.kind === "metric") {
      choice("数据类型", query.source, [["documents", "文档"], ["blocks", "正文块"], ["keywords", "关键字"], ["todos", "待办"], ["locations", "位置"], ["databaseRecords", "表格记录"]], value => { query.source = value as DashboardQuery["source"]; config.query = { ...query }; update(true); void hydrateSources(); });
      if (query.source === "keywords") field("关键字", query.keyword ?? "", value => { query.keyword = value; config.query = { ...query }; update(); });
      if (query.source === "databaseRecords") choice("数据表", query.databaseId ?? "", [["", "全部数据表"], ...[...new Map(dataStatesFor(config).flatMap(state => state.databases ?? []).map(database => [database.id, database.title] as [string, string])).entries()]], value => { query.databaseId = value; config.query = { ...query }; update(true); });
      const sample = dashboardRows(dataStatesFor(config), query)[0] ?? {};
      const keys = Object.keys(sample);
      const hints = document.createElement("small"); hints.className = "dashboard-settings-hint"; hints.textContent = keys.length ? `可用字段：${keys.join("、")}` : "当前范围无数据"; form.append(hints);
      const filterHeading = document.createElement("strong"); filterHeading.textContent = "筛选条件"; form.append(filterHeading);
      (query.filters ?? []).forEach((filter, index) => {
        const row = document.createElement("div"); row.className = "dashboard-filter-row";
        const key = document.createElement("input"); key.placeholder = "字段"; key.value = filter.field; key.setAttribute("aria-label", `筛选字段 ${index + 1}`);
        const operator = document.createElement("select"); operator.setAttribute("aria-label", `筛选运算符 ${index + 1}`);
        (["=", "!=", ">", ">=", "<", "<=", "contains"] as const).forEach(value => { const option = document.createElement("option"); option.value = value; option.textContent = value; operator.append(option); }); operator.value = filter.operator;
        const value = document.createElement("input"); value.placeholder = "值"; value.value = filter.value; value.setAttribute("aria-label", `筛选值 ${index + 1}`);
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "删除筛选条件"; remove.onclick = () => { query.filters?.splice(index, 1); config.query = { ...query }; update(true); };
        [key, operator, value].forEach(input => { input.onchange = () => { filter.field = key.value.trim(); filter.operator = operator.value as DashboardOperator; filter.value = value.value; config.query = { ...query }; update(); }; });
        row.append(key, operator, value, remove); form.append(row);
      });
      const addFilter = document.createElement("button"); addFilter.type = "button"; addFilter.textContent = "+ 筛选条件"; addFilter.onclick = () => { query.filters = [...(query.filters ?? []), { field: keys[0] ?? "type", operator: "=", value: "" }]; config.query = { ...query }; update(true); }; form.append(addFilter);
      field("条件表达式", query.condition ?? "", value => { query.condition = value; config.query = { ...query }; update(); });
      field("分类字段", query.groupBy ?? "", value => { query.groupBy = value.trim(); config.query = { ...query }; update(); });
      choice("汇总方式", query.measure ?? "count", [["count", "计数"], ["sum", "求和"], ["avg", "平均"], ["min", "最小"], ["max", "最大"], ["unique", "去重计数"]], value => { query.measure = value as DashboardQuery["measure"]; config.query = { ...query }; update(); });
      field("数值字段", query.valueField ?? "", value => { query.valueField = value.trim(); config.query = { ...query }; update(); });
      field("计算公式", query.formula ?? "", value => { query.formula = value.trim(); config.query = { ...query }; update(); });
    }
    const layoutHeading = document.createElement("strong"); layoutHeading.textContent = "尺寸与布局"; form.append(layoutHeading);
    (["x", "y", "width", "height", "zIndex"] as const).forEach(key => field(key === "width" ? "宽度" : key === "height" ? "高度" : key === "zIndex" ? "层级" : key.toUpperCase(), String(config.layout[key] ?? (key === "zIndex" ? 1 : 0)), value => { const number = Number(value); if (!Number.isFinite(number)) return; config.layout[key] = key === "width" ? Math.max(220, number) : key === "height" ? Math.max(140, number) : Math.max(0, number); update(); }, "number"));
    const styleHeading = document.createElement("strong"); styleHeading.textContent = "样式"; form.append(styleHeading);
    config.style ??= {};
    ([ ["background", "背景色", "#ffffff"], ["color", "文字色", "#344054"], ["accent", "边框色", "#0f766e"] ] as const).forEach(([key, label, fallback]) => field(label, config.style![key] ?? fallback, value => { config.style![key] = value; update(); }, "color"));
    field("字号", String(config.style.fontSize ?? 12), value => { config.style!.fontSize = Math.max(10, Math.min(32, Number(value) || 12)); update(); }, "number");
    settings.append(form);
  }
  function render() {
    if (!current) return;
    title.value = current.note.title;
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
    configs.forEach(config => {
      if (config.scope === "document" && config.sourceId) ids.add(config.sourceId);
      if (config.scope === "notebook" || config.scope === "workspace") snapshot.documents.filter(item => item.kind !== "dashboard" && (config.scope === "workspace" || snapshot.bookmarks.find(bookmark => bookmark.id === item.bookmarkId)?.notebookId === current?.note.workspaceId)).forEach(item => ids.add(item.id));
    });
    if (sourceState) sourceStates.set(sourceState.note.id, structuredClone(sourceState));
    await Promise.all([...ids].filter(id => !sourceStates.has(id)).map(async id => {
      try { sourceStates.set(id, await host.loadDocument(id)); } catch { /* deleted source: renderer shows its empty state */ }
    }));
    if (current) { render(); renderSettings(); }
  }
  function resize(block: Block, dx: number, dy: number) {
    const layout = widgetConfig(block)!.layout;
    layout.width = Math.max(220, layout.width + dx); layout.height = Math.max(140, layout.height + dy); render(); scheduleSave();
  }
  function enableDrag(card: HTMLElement, block: Block) {
    const head = card.querySelector<HTMLElement>(".dashboard-widget-head")!;
    let drag: { x: number; y: number; left: number; top: number } | null = null;
    head.addEventListener("pointerdown", event => {
      if ((event.target as Element).closest("button")) return;
      const layout = widgetConfig(block)!.layout; drag = { x: event.clientX, y: event.clientY, left: layout.x, top: layout.y }; head.setPointerCapture(event.pointerId);
    });
    head.addEventListener("pointermove", event => { if (!drag) return; const layout = widgetConfig(block)!.layout; layout.x = Math.max(0, drag.left + event.clientX - drag.x); layout.y = Math.max(0, drag.top + event.clientY - drag.y); card.style.left = `${layout.x}px`; card.style.top = `${layout.y}px`; });
    head.addEventListener("pointerup", () => { if (drag) scheduleSave(); drag = null; });
    head.addEventListener("pointercancel", () => { drag = null; });
  }
  function addWidget(kind: string) {
    if (!current) return;
    const index = widgets().length;
    const presets: Record<string, DashboardQuery> = {
      "文档数量": { source: "documents", measure: "count" }, "关键字数量": { source: "keywords", measure: "count" },
      "未完成待办": { source: "todos", measure: "count", filters: [{ field: "checked", operator: "=", value: "false" }] },
      "已完成待办": { source: "todos", measure: "count", filters: [{ field: "checked", operator: "=", value: "true" }] },
      "位置汇总": { source: "locations", measure: "count" }, "表格汇总": { source: "databaseRecords", measure: "count" }
    };
    const metric = !!presets[kind];
    const block: Block = { id: uid(), parentId: null, position: String((current.blocks.length + 1) * 1000).padStart(8, "0"), type: "dashboard_widget", content: { text: "", html: "" }, properties: { dashboardWidget: { kind: metric ? "metric" : kind, title: kind, scope: metric ? "workspace" : "activeDocument", query: metric ? { ...presets[kind] } : undefined, layout: { x: 32 + (index % 3) * 344, y: 32 + Math.floor(index / 3) * 244, width: 320, height: 220 } } }, revision: 1 };
    current.blocks.push(block); render(); selectWidget(block.id, true); scheduleSave(); void hydrateSources();
  }
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveState.textContent = "未保存";
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveTail = saveTail.catch(() => undefined).then(async () => {
        try { await save(); lastSaveError = null; }
        catch (error) { lastSaveError = error; setSaveState("保存失败", true); callbacks.onError(error); }
      });
    }, 350);
  }
  async function save() {
    if (!current) return;
    setSaveState("保存中");
    const result = await host.saveDocument({ documentId: current.note.id, title: current.note.title, blocks: structuredClone(current.blocks), mutationId: uid(), clientVersion: current.note.clientVersion + 1 });
    current.note.clientVersion = result.clientVersion; setSaveState("已保存"); callbacks.onStateChanged?.(structuredClone(current));
  }
  function setupAddMenu() {
    view.querySelector<HTMLButtonElement>("[data-dashboard-action=add]")!.onclick = event => {
      event.stopPropagation(); document.querySelector(".dashboard-add-menu")?.remove();
      const menu = document.createElement("div"); menu.className = "dashboard-add-menu";
      ["文档数量", "关键字数量", "未完成待办", "已完成待办", "位置汇总", "表格汇总", "references", "backlinks", "overrides", "comments", "history", "calendar", "locations", "styles", "databases"].forEach(kind => { const button = document.createElement("button"); button.type = "button"; button.textContent = kind; button.onclick = () => { menu.remove(); addWidget(kind); }; menu.append(button); });
      document.body.append(menu); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); menu.style.left = `${rect.left}px`; menu.style.top = `${rect.bottom + 4}px`;
      setTimeout(() => document.addEventListener("pointerdown", event => {
        if (!menu.contains(event.target as Node) && !view.querySelector("[data-dashboard-action=add]")?.contains(event.target as Node)) menu.remove();
      }, { once: true }), 0);
    };
    title.addEventListener("change", () => { if (!current) return; current.note.title = title.value.trim() || "未命名 Dashboard"; scheduleSave(); });
  }
  setupAddMenu();
  function open(state: EditorState, nextSourceState?: EditorState | null) {
    current = structuredClone(state);
    selectedWidgetId = null;
    sourceStates.clear();
    sourceState = nextSourceState ? structuredClone(nextSourceState) : sourceState;
    if (sourceState) sourceStates.set(sourceState.note.id, structuredClone(sourceState));
    editor.hidden = true; view.hidden = false; render(); renderSettings(); callbacks.onWidgetSelection?.(false); void hydrateSources();
  }
  function close() { view.hidden = true; current = null; sourceState = null; selectedWidgetId = null; sourceStates.clear(); editor.hidden = false; stage.replaceChildren(); settings.replaceChildren(); callbacks.onWidgetSelection?.(false); }
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
  return { open, close, isOpen: () => !view.hidden, applyState: state => { if (!current || current.note.id !== state.note.id) return; current = structuredClone(state); render(); renderSettings(); }, setSourceState, refreshSources, register: renderer => { renderers.set(renderer.kind, renderer); if (current) render(); }, flush: async () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveTail = saveTail.catch(() => undefined).then(async () => { try { await save(); lastSaveError = null; } catch (error) { lastSaveError = error; setSaveState("保存失败", true); callbacks.onError(error); } }); } await saveTail; if (lastSaveError) throw lastSaveError; } };
}
