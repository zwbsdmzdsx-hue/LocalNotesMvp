import type { EditorState, Block, BlockProperties } from "../../protocol/types";
import type { WorkspaceApi } from "./workspace-api";
import type { EditorHostApi } from "./editor-host-api";

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
};

const uid = () => `dashboard-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
const escapeText = (value: unknown) => String(value ?? "");

function widgetConfig(block: Block) {
  return block.properties.dashboardWidget;
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
  open(state: EditorState): void;
  close(): void;
  flush(): Promise<void>;
  isOpen(): boolean;
  applyState(state: EditorState): void;
  register(renderer: DashboardWidgetRenderer): void;
};

export function mountDashboardManager(host: EditorHostApi, _workspace: WorkspaceApi, callbacks: DashboardCallbacks): DashboardManager {
  const container = document.querySelector<HTMLElement>(".workspace")!;
  const view = document.createElement("section");
  view.className = "dashboard-view";
  view.hidden = true;
  view.innerHTML = `<header class="dashboard-bar"><span class="dashboard-mark" aria-hidden="true">▦</span><input class="dashboard-title" aria-label="Dashboard 名称" maxlength="120"><span class="dashboard-save-state" role="status">已保存</span><span class="dashboard-spacer"></span><button type="button" data-dashboard-action="add" title="添加组件" aria-label="添加组件">＋</button></header><div class="dashboard-viewport"><div class="dashboard-stage"></div></div>`;
  container.append(view);
  const title = view.querySelector<HTMLInputElement>(".dashboard-title")!;
  const saveState = view.querySelector<HTMLElement>(".dashboard-save-state")!;
  const stage = view.querySelector<HTMLElement>(".dashboard-stage")!;
  let current: EditorState | null = null;
  let saveTail = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const renderers = new Map<string, DashboardWidgetRenderer>(defaultRenderers().map(renderer => [renderer.kind, renderer]));

  function setSaveState(text: string, error = false) { saveState.textContent = text; saveState.classList.toggle("is-error", error); }
  function widgets() { return current?.blocks.filter(block => block.type === "dashboard_widget" && widgetConfig(block)) ?? []; }
  function rendererFor(kind: string) { return renderers.get(kind); }
  function renderWidget(block: Block) {
    const config = widgetConfig(block)!;
    const card = document.createElement("article");
    card.className = "dashboard-widget";
    card.dataset.widgetId = block.id;
    card.style.left = `${config.layout.x}px`; card.style.top = `${config.layout.y}px`;
    card.style.width = `${config.layout.width}px`; card.style.height = `${config.layout.height}px`;
    card.style.zIndex = String(config.layout.zIndex ?? 1);
    const head = document.createElement("header"); head.className = "dashboard-widget-head";
    const label = document.createElement("strong"); label.textContent = config.title || config.kind;
    const kind = document.createElement("small"); kind.textContent = config.kind;
    const controls = document.createElement("span"); controls.className = "dashboard-widget-controls";
    const smaller = document.createElement("button"); smaller.type = "button"; smaller.textContent = "−"; smaller.title = "缩小组件"; smaller.onclick = () => resize(block, -24, -16);
    const larger = document.createElement("button"); larger.type = "button"; larger.textContent = "+"; larger.title = "放大组件"; larger.onclick = () => resize(block, 24, 16);
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "移除组件"; remove.onclick = () => { current!.blocks = current!.blocks.filter(item => item.id !== block.id); render(); scheduleSave(); };
    controls.append(smaller, larger, remove); head.append(label, kind, controls); card.append(head);
    const body = document.createElement("div"); body.className = "dashboard-widget-body";
    const custom = rendererFor(config.kind);
    if (custom) body.append(custom.render(current!, block));
    else { body.append(countCard("自定义组件占位", 0)); const hint = document.createElement("p"); hint.className = "dashboard-empty"; hint.textContent = "此组件类型已预留，可通过 DashboardWidgetRenderer 注册。"; body.append(hint); }
    card.append(body);
    enableDrag(card, block);
    return card;
  }
  function render() {
    if (!current) return;
    title.value = current.note.title;
    stage.replaceChildren(...widgets().sort((a, b) => (widgetConfig(a)!.layout.zIndex ?? 0) - (widgetConfig(b)!.layout.zIndex ?? 0)).map(renderWidget));
    const maxX = Math.max(900, ...widgets().map(block => (widgetConfig(block)!.layout.x + widgetConfig(block)!.layout.width + 40)));
    const maxY = Math.max(620, ...widgets().map(block => (widgetConfig(block)!.layout.y + widgetConfig(block)!.layout.height + 40)));
    stage.style.width = `${maxX}px`; stage.style.height = `${maxY}px`;
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
    const block: Block = { id: uid(), parentId: null, position: String((current.blocks.length + 1) * 1000).padStart(8, "0"), type: "dashboard_widget", content: { text: "", html: "" }, properties: { dashboardWidget: { kind, title: kind, scope: "activeDocument", layout: { x: 32 + (index % 3) * 344, y: 32 + Math.floor(index / 3) * 244, width: 320, height: 220 } } }, revision: 1 };
    current.blocks.push(block); render(); scheduleSave();
  }
  function scheduleSave() { if (saveTimer) clearTimeout(saveTimer); saveState.textContent = "未保存"; saveTimer = setTimeout(() => { saveTimer = null; saveTail = saveTail.then(save).catch(callbacks.onError); }, 350); }
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
      ["references", "backlinks", "overrides", "comments", "history", "calendar", "locations", "styles", "databases"].forEach(kind => { const button = document.createElement("button"); button.type = "button"; button.textContent = kind; button.onclick = () => { menu.remove(); addWidget(kind); }; menu.append(button); });
      document.body.append(menu); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); menu.style.left = `${rect.left}px`; menu.style.top = `${rect.bottom + 4}px`;
      setTimeout(() => document.addEventListener("pointerdown", event => {
        if (!menu.contains(event.target as Node) && !view.querySelector("[data-dashboard-action=add]")?.contains(event.target as Node)) menu.remove();
      }, { once: true }), 0);
    };
    title.addEventListener("change", () => { if (!current) return; current.note.title = title.value.trim() || "未命名 Dashboard"; scheduleSave(); });
  }
  setupAddMenu();
  function open(state: EditorState) { current = structuredClone(state); view.hidden = false; render(); }
  function close() { view.hidden = true; current = null; stage.replaceChildren(); }
  return { open, close, isOpen: () => !view.hidden, applyState: state => { if (!current || current.note.id !== state.note.id) return; current = structuredClone(state); render(); }, register: renderer => { renderers.set(renderer.kind, renderer); if (current) render(); }, flush: async () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveTail = saveTail.then(save).catch(callbacks.onError); } await saveTail; } };
}
