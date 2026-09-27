import type { Block, BlockContent, BlockProperties, EditorState, ReferenceInstance, ReferenceMode } from "../../protocol/types";
import type { ReferenceRowContentServices } from "./module-registry";

type EditorMode = "rich" | "source" | "preview";

export type ReferenceCardActions = {
  state: EditorState;
  mode: EditorMode;
  collapsedIds: Set<string>;
  blockDepth(block: Block, blocks: Block[]): number;
  renderReferenceRowContent(source: Block, services: ReferenceRowContentServices): { projected: boolean };
  referenceRowClass(source: Block): string;
  renderReadingAnnotation(block: Block, content: BlockContent): HTMLElement;
  databaseDeclaration(block: Block): string;
  markdownHtml(source: string, links?: readonly NonNullable<BlockContent["links"]>[number][]): string;
  renderLinkedHtml(html: string): string;
  onToggleMode(reference: ReferenceInstance, mode: ReferenceMode): void;
  onModeMenu(anchor: HTMLElement, reference: ReferenceInstance): void;
  onFocus(editable: HTMLElement): void;
  onInput(row: HTMLElement, source: Block, properties: BlockProperties, local: boolean): void;
  onKeydown(event: KeyboardEvent, row: HTMLElement, reference: ReferenceInstance, source: Block): void;
  onAddSibling(reference: ReferenceInstance, source: Block, row: HTMLElement): void;
  onHide(row: HTMLElement, reference: ReferenceInstance, source: Block, local: boolean): void;
  onReset(reference: ReferenceInstance, source: Block): void;
  onRestoreHidden(reference: ReferenceInstance): void;
};

export function visibleReferenceBlocks(reference: ReferenceInstance): Block[] {
  const hidden = new Set(reference.hiddenBlockIds);
  return reference.blocks.filter(block => {
    let candidate: Block | undefined = block;
    const visited = new Set<string>();
    while (candidate && !visited.has(candidate.id)) {
      if (hidden.has(candidate.id)) return false;
      visited.add(candidate.id);
      candidate = reference.blocks.find(item => item.id === candidate?.parentId);
    }
    return true;
  });
}

export function referenceRowSignature(reference: ReferenceInstance, mode: EditorMode): string {
  const rows = visibleReferenceBlocks(reference)
    .map(block => `${block.id}:${block.parentId ?? ""}:${block.position}:${JSON.stringify(block.content)}`).join("|");
  const overrides = reference.overrides
    .map(item => `${item.targetBlockId}:${item.baseRevision}:${item.patch.content?.text?.length ?? 0}`).join(";");
  return `${mode}|${reference.mode}|${rows}|${overrides}`;
}

export function renderReferenceBody(
  reference: ReferenceInstance | undefined, mode: ReferenceMode,
  renderCard: (reference: ReferenceInstance) => HTMLElement,
  signature: (reference: ReferenceInstance) => string
): HTMLElement | null {
  if (!reference) return null;
  if (mode === "sidebar" || mode === "link") {
    const entry = document.createElement("button"); entry.type = "button";
    entry.className = "sidebar-reference-entry reference-title";
    entry.dataset.targetId = reference.targetDocumentId;
    if (reference.targetBlockId) entry.dataset.targetBlockId = reference.targetBlockId;
    entry.dataset.referenceId = reference.id;
    entry.textContent = reference.targetTitle;
    entry.title = "悬停预览 · 单击分栏 · 双击打开源";
    entry.dataset.rowSignature = `${mode}|${reference.id}|${reference.targetDocumentId}|${reference.targetBlockId ?? ""}|${reference.targetTitle}`;
    return entry;
  }
  const card = renderCard(reference);
  card.dataset.rowSignature = signature(reference);
  return card;
}

export function renderReferenceHostShell(
  shell: HTMLElement, body: HTMLElement | null, onDetach: () => void
) {
  const heading = document.createElement("div"); heading.className = "reference-heading";
  const grip = document.createElement("button"); grip.type = "button"; grip.className = "grip";
  grip.setAttribute("aria-label", "引用菜单"); grip.title = "引用显示方式";
  grip.draggable = true; grip.textContent = "⠿";
  heading.append(grip); shell.append(heading);
  if (!body) return;
  shell.append(body);
  attachReferenceDetach(body, onDetach);
}

function attachReferenceDetach(body: HTMLElement, onDetach: () => void, label = "断开引用（保留为正文）") {
  const summary = body.querySelector(".reference-card-summary");
  if (!summary || summary.querySelector(".reference-detach")) return;
  const detach = document.createElement("button"); detach.type = "button";
  detach.className = "reference-detach";
  detach.title = label;
  detach.setAttribute("aria-label", label);
  detach.textContent = "×";
  detach.addEventListener("click", event => { event.stopPropagation(); onDetach(); });
  summary.append(detach);
}

export function syncReferenceHostShell(
  shell: HTMLElement, reference: ReferenceInstance | undefined,
  renderCard: (reference: ReferenceInstance) => HTMLElement,
  signature: (reference: ReferenceInstance) => string, onDetach: () => void
) {
  const oldBody = shell.querySelector<HTMLElement>(":scope > .reference-card, :scope > .sidebar-reference-entry");
  const body = renderReferenceBody(reference, reference?.mode ?? "inline", renderCard, signature);
  if (!body) { oldBody?.remove(); return; }
  if (oldBody && oldBody.dataset.rowSignature === body.dataset.rowSignature) {
    attachReferenceDetach(oldBody, onDetach);
    return;
  }
  if (oldBody) oldBody.replaceWith(body);
  else shell.append(body);
  attachReferenceDetach(body, onDetach);
}

export function syncOrdinaryReferenceBody(
  shell: HTMLElement, reference: ReferenceInstance | undefined,
  renderCard: (reference: ReferenceInstance) => HTMLElement,
  signature: (reference: ReferenceInstance) => string, onRemove: () => void
) {
  const oldBody = shell.querySelector<HTMLElement>(":scope > .reference-card");
  if (!reference) { oldBody?.remove(); return; }
  if (oldBody?.dataset.rowSignature === signature(reference)) {
    attachReferenceDetach(oldBody, onRemove, "删除引用");
    return;
  }
  const body = renderReferenceBody(reference, reference.mode, renderCard, signature);
  if (!body) return;
  attachReferenceDetach(body, onRemove, "删除引用");
  if (oldBody) oldBody.replaceWith(body);
  else shell.append(body);
}

export function renderReferenceCard(reference: ReferenceInstance, inSidebar: boolean, actions: ReferenceCardActions): HTMLElement {
  const { state, mode } = actions;
  const card = document.createElement("section");
  const collapsed = !inSidebar && reference.mode === "collapsed";
  const sidebarCollapsed = inSidebar && actions.collapsedIds.has(reference.id);
  card.className = `reference-card ${collapsed ? "collapsed is-collapsed" : "is-expanded"} ${inSidebar ? (sidebarCollapsed ? "sidebar is-collapsed" : "sidebar") : ""}`;
  card.dataset.referenceId = reference.id;
  const summary = document.createElement("div");
  summary.className = "reference-card-summary";
  const isOpen = inSidebar ? !sidebarCollapsed : !collapsed;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "reference-expand";
  toggle.setAttribute("aria-expanded", String(isOpen));
  toggle.setAttribute("aria-label", isOpen ? "收起" : "展开");
  toggle.title = inSidebar ? (isOpen ? "折叠此引用" : "展开此引用") : (collapsed ? "展开引用正文" : "折叠引用正文");
  toggle.textContent = isOpen ? "▾" : "▸";
  toggle.addEventListener("click", event => {
    event.stopPropagation();
    if (inSidebar) {
      if (sidebarCollapsed) actions.collapsedIds.delete(reference.id);
      else actions.collapsedIds.add(reference.id);
      card.replaceWith(renderReferenceCard(reference, true, actions));
    } else actions.onToggleMode(reference, collapsed ? "inline" : "collapsed");
  });
  summary.append(toggle);
  if (!inSidebar) {
    const title = document.createElement("button");
    title.type = "button";
    title.className = "reference-title";
    title.dataset.targetId = reference.targetDocumentId;
    title.dataset.referenceId = reference.id;
    if (reference.targetBlockId) title.dataset.targetBlockId = reference.targetBlockId;
    title.textContent = reference.targetTitle;
    summary.append(title);
  }
  const modeMenu = document.createElement("button");
  modeMenu.type = "button";
  modeMenu.className = "reference-mode-menu";
  modeMenu.setAttribute("aria-label", "引用显示方式");
  modeMenu.title = "选择引用显示方式";
  modeMenu.textContent = "显示方式";
  modeMenu.addEventListener("click", event => { event.stopPropagation(); actions.onModeMenu(modeMenu, reference); });
  summary.append(modeMenu);
  card.append(summary);
  if (sidebarCollapsed) return card;

  const overrideMap = new Map(reference.overrides.map(item => [item.targetBlockId, item]));
  const hidden = new Set(reference.hiddenBlockIds);
  visibleReferenceBlocks(reference).forEach(source => {
    const override = overrideMap.get(source.id);
    const content = override?.patch.content ?? source.content;
    const properties = override?.patch.properties ?? source.properties;
    const row = document.createElement("div");
    row.className = "reference-row";
    row.dataset.referenceInstanceId = reference.id;
    row.dataset.targetBlockId = source.id;
    row.dataset.parentId = source.parentId ?? "";
    row.dataset.position = source.position;
    row.dataset.scopeType = source.scopeType ?? "canonical";
    row.dataset.type = source.type;
    row.style.setProperty("--depth", String(actions.blockDepth(source, reference.blocks)));
    const local = source.scopeType === "reference_instance";
    row.innerHTML = `<div class="reference-meta"><span>${local ? "本地新增" : override ? "已覆写" : "继承"}</span><button class="add-sibling" title="在同级新增块">+</button>${local ? "" : '<button class="reset" title="恢复源内容与位置">↺</button>'}<button class="hide" title="${local ? "删除本地块" : "在此引用中隐藏"}">×</button></div><div class="block-text ${actions.referenceRowClass(source)}"></div>`;
    const editable = row.querySelector<HTMLElement>(".block-text")!;
    if (override && source.revision > override.baseRevision) row.querySelector(".reference-meta span")!.textContent = "已覆写 · 源内容已更新";
    const { projected } = actions.renderReferenceRowContent(source, { source, content, properties, state, mode, editable,
      renderReadingAnnotation: actions.renderReadingAnnotation,
      databaseDeclaration: actions.databaseDeclaration,
      markdownHtml: actions.markdownHtml,
      renderLinkedHtml: actions.renderLinkedHtml });
    editable.style.backgroundColor = properties.background ?? "";
    editable.style.color = properties.textColor ?? "";
    if (mode !== "preview" && !projected) {
      editable.addEventListener("focus", () => actions.onFocus(editable));
      editable.addEventListener("input", () => actions.onInput(row, source, properties, local));
      editable.addEventListener("keydown", event => actions.onKeydown(event, row, reference, source));
    }
    row.dataset.referenceSource = local ? "instance" : "canonical";
    row.querySelector<HTMLButtonElement>(".add-sibling")!.disabled = mode === "preview" || projected;
    row.querySelector(".add-sibling")!.addEventListener("click", () => actions.onAddSibling(reference, source, row));
    row.querySelector<HTMLButtonElement>(".hide")!.disabled = mode === "preview";
    row.querySelector(".hide")!.addEventListener("click", () => actions.onHide(row, reference, source, local));
    const reset = row.querySelector<HTMLButtonElement>(".reset");
    if (reset) reset.disabled = mode === "preview";
    reset?.addEventListener("click", () => actions.onReset(reference, source));
    card.append(row);
  });
  const footer = document.createElement("footer");
  footer.className = "reference-footer";
  if (hidden.size) {
    const count = document.createElement("span"); count.textContent = `已隐藏 ${hidden.size} 块`;
    const restore = document.createElement("button"); restore.className = "restore-hidden"; restore.textContent = "恢复隐藏块";
    restore.addEventListener("click", () => actions.onRestoreHidden(reference));
    footer.append(count, restore);
  }
  card.append(footer);
  return card;
}
