import { sanitizeHtml, editableContent } from "./block-content";
import type { BlockType, BlockContent, BlockProperties, Block, LinkToken, Note, Backlink, OverrideNotice, ReferenceOverride, ReferenceMode, ReferenceInstance, EditorState, SaveMutation, RequestMap, StyleSheet, MediaAsset, MediaKind } from "../../protocol/types";
import type { EditorHostApi } from "./editor-host-api";
import type { HistoryModel } from "./history";
import { orderBlockTree } from "./block-tree";
import { markdownFromContent, markdownFromHtml, renderMarkdown } from "./markdown";

// The existing renderer and editing operations are shared by browser and desktop.
export function mountEditor(host: EditorHostApi, ui: {
  showReferences?(): void;
  showHistory?(): void;
  updateHistory?(model: HistoryModel): void;
} = {}) {
const titleInput = document.querySelector<HTMLInputElement>("#title")!;
const blockSurface = document.querySelector<HTMLDivElement>("#blocks")!;
const saveStatus = document.querySelector<HTMLSpanElement>("#status")!;
const linkSuggestions = document.querySelector<HTMLDivElement>("#link-suggestions")!;
function getSlot(name: string): HTMLElement {
  let slot = document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (!slot) {
    // Shell hasn't built slots yet (e.g. core used standalone). Create a fallback inside the workspace
    // so the standalone usage still renders relations and shell mount can later relocate them.
    slot = document.createElement("div");
    slot.dataset.slot = name;
    document.body.append(slot);
  }
  return slot;
}
const backlinksPanel = getSlot("backlinks") as HTMLDivElement;
const noticesPanel = getSlot("override-notices") as HTMLDivElement;
const referenceSidebarPanel = getSlot("reference-sidebar") as HTMLDivElement;
const stylesPanel = getSlot("styles") as HTMLDivElement;
const editorElement = document.querySelector<HTMLElement>(".editor")!;
type EditorMode = "rich" | "source" | "preview";
let editorMode = (localStorage.getItem("lnm-editor-mode") as EditorMode | null) ?? "rich";
if (!["rich", "source", "preview"].includes(editorMode)) editorMode = "rich";
let stylePanelScope: "document" | "notebook" = "document";
// The shell owns section visibility and tab selection. The core renders slot contents only.
let state: EditorState | null = null;
let mutationVersion = 0;
let inFlightMutation: SaveMutation | null = null;
let queuedMutation: SaveMutation | null = null;
let commandTail: Promise<void> = Promise.resolve();
let commandFailure: Error | null = null;
let saveFailure: string | null = null;
let historyTail: Promise<void> = Promise.resolve();
let historyBusy = false;
let editGroup = newId();
let editTarget: EventTarget | null = null;
let editTime = 0;
const saveDrainWaiters: Array<() => void> = [];
let activeEditable: HTMLElement | null = null;
let activeBlock: HTMLElement | null = null;
// Keep the last valid rich-text range while the style panel is clicked. Browsers may
// collapse the native selection when focus moves to a sidebar button, even when the
// button prevents its default mousedown behavior. The remembered range is refreshed
// only by a valid editor selection and is cleared when the document changes.
let styleSelection: { editable: HTMLElement; range: Range; blockId: string } | null = null;
let linkMenuItems: Array<{ id: string; blockId?: string; title: string; meta: string; label: string }> = [];
let linkMenuIndex = 0;
const sidebarCollapsedIds = new Set<string>();

// Drag & drop state
let draggingBlockId: string | null = null;
let dropIndicator: { targetId: string; position: "before" | "after" | "child" | "column-left" | "column-right" } | null = null;
let draggingColumn: { containerId: string; column: number } | null = null;
let columnDropIndicator: { containerId: string; column: number; slot: HTMLElement } | null = null;

const referenceModeLabels: Record<ReferenceMode, string> = {
  inline: "正文直显",
  collapsed: "折叠卡片",
  sidebar: "右侧分栏",
  link: "仅标题链接"
};

type Message = { [K in keyof RequestMap]: { type: K } & RequestMap[K] }[keyof RequestMap];
function post(message: Message, sourceDocumentId = state?.note.id): Promise<void> {
  const { type, ...payload } = message;
  if (type === "saveDocument") {
    return host.saveDocument(payload as SaveMutation).then(handleSaveAck, error =>
      handleSaveNack({ mutationId: (payload as SaveMutation).mutationId, error: error.message }));
  }
  if (type === "openDocument" || type === "navigateBack" || type === "navigateForward") {
    return historyTail.then(() => flush()).then(() => host.request(type, payload as RequestMap[typeof type], sourceDocumentId))
      .then(() => undefined).catch(showError);
  }
  const owner = sourceDocumentId;
  if (!owner) return Promise.resolve();
  // Open on the user's action, not its delayed ACK: they may select another tab while waiting.
  if (type === "setReferenceMode" && (payload as RequestMap["setReferenceMode"]).mode === "sidebar")
    ui.showReferences?.();
  const commandKinds = new Set(["createReference", "setReferenceMode", "saveOverride", "saveInstanceBlock", "moveReferenceBlock", "deleteInstanceBlock", "hideReferenceBlock", "resetOverride", "resetReference", "removeReference"]);
  const operationName = (value: string) => value.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
    commandTail = commandTail.catch(() => undefined).then(async () => {
    const result = commandKinds.has(type)
      ? await host.executeCommand({ operation: operationName(type), ...(payload as Record<string, unknown>) }, owner)
      : await host.request(type, payload as RequestMap[typeof type], owner);
    commandFailure = null;
    if (result && "state" in result && state?.note.id === owner) {
      // Single render entry point. After every state-mutating ACK, sync both the main
      // blockSurface and the right-side reference/backlinks/notices panels from `result.state`.
      // The individual renderers (renderOwnBlock diff, renderRelations diff, renderBacklinks,
      // renderNotices) are diff-based and atomic — no panel ever flashes empty mid-update.
      // For text edits on a focused contentEditable, we preserve caret/IME across re-render.
      applyServerState(result.state, type);
    }
    saveStatus.textContent = "已保存";
  }).catch(error => { commandFailure = error; showError(error); });
  return commandTail as Promise<void>;
}

/**
 * Apply a server-authoritative state to the editor. Replaces every previous per-command
 * branching (was: "if saveOverride skip re-render, if createReference skip re-render, …").
 * All renderers are diff-based, so this is safe to call after every ACK — no DOM thrash,
 * no intermediate empty states, and any panel that drifted out of sync is self-corrected.
 *
 * For commands that don't carry `state` (loadDocument, navigateBack/Forward) the caller
 * still goes through `render()` — this function is purely for command ACKs.
 */
function applyServerState(next: EditorState, sourceType: string) {
  if (!state) return;
  // Capture caret on any focused contentEditable row so text-edit ACKs (saveOverride,
  // saveInstanceBlock) can restore it after a partial row re-render.
  const caret = captureCaret();
  next.blocks = orderBlockTree(next.blocks);
  next.references.forEach(reference => reference.blocks = orderBlockTree(reference.blocks));
  state = next;
  if (sourceType.startsWith("history-")) { blockSurface.replaceChildren(); referenceSidebarPanel.replaceChildren(); activeEditable = null; activeBlock = null; }
  // Sync DOM. This rebuilds only what changed (rows added/moved/removed, cards added/removed).
  renderAllPanels();
  // For text-edit commands, restore caret. For structural commands we don't restore —
  // structural changes inherently move focus and re-render is correct.
  if (sourceType === "saveOverride" || sourceType === "saveInstanceBlock") restoreCaret(caret);
  publishHistory();
  saveStatus.textContent = "已同步本地数据库";
}

function moveHistory(direction: "undo" | "redo") { return runHistory("history-" + direction); }
function restoreHistory(id: string) { return runHistory("history-restore", id); }
function runHistory(operation: string, entryId?: string) {
  const owner = state?.note.id;
  historyTail = historyTail.then(async () => {
    if (!owner || state?.note.id !== owner) return;
    await flush();
    const model = state.history;
    if (operation === "history-undo" && !model?.canUndo || operation === "history-redo" && !model?.canRedo) return;
    historyBusy = true;
    const caret = captureCaret();
    const titleSelection = document.activeElement === titleInput ? [titleInput.selectionStart, titleInput.selectionEnd] : null;
    document.querySelectorAll<HTMLElement>(".editor, .toolbar, .relations, .sidebar-right").forEach(el => el.inert = true);
    publishHistory();
    try {
      const result = await host.executeCommand({ operation, entryId, expectedVersion: state.note.clientVersion }, owner);
      applyServerState(result.state, operation);
      mutationVersion = result.state.note.clientVersion;
      editGroup = newId();
    } finally {
      historyBusy = false;
      document.querySelectorAll<HTMLElement>(".editor, .toolbar, .relations, .sidebar-right").forEach(el => el.inert = false);
      if (titleSelection) { titleInput.focus(); titleInput.setSelectionRange(titleSelection[0], titleSelection[1]); }
      else restoreCaret(caret);
      publishHistory();
    }
  }).catch(showError);
  return historyTail;
}
function publishHistory() {
  if (!state) return;
  const model = state.history ?? { documentId: state.note.id, entries: [], currentId: "", canUndo: false, canRedo: false };
  ui.updateHistory?.(model);
  const undo = document.querySelector<HTMLButtonElement>("#undo");
  const redo = document.querySelector<HTMLButtonElement>("#redo");
  if (undo) undo.disabled = historyBusy || !model.canUndo;
  if (redo) redo.disabled = historyBusy || !model.canRedo;
}

function captureCaret(): { editable: HTMLElement; offset: number; marker: string } | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !active.classList?.contains("block-text")) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!active.contains(range.startContainer) && range.startContainer !== active) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(active);
  pre.setEnd(range.startContainer, range.startOffset);
  // Capture a unique identifier for the editable that survives re-render. For contentEditable
  // inside a reference row, the row has data-target-block-id; for regular own blocks, the
  // shell has data-id. We look outward for the most specific marker.
  const refRow = active.closest<HTMLElement>(".reference-row");
  const marker = refRow
    ? `refRow:${refRow.dataset.referenceInstanceId}:${refRow.dataset.targetBlockId}`
    : (active.closest<HTMLElement>("[data-own-block]")?.dataset.id ?? "");
  return { editable: active, offset: pre.toString().length, marker };
}

function restoreCaret(caret: ReturnType<typeof captureCaret>) {
  if (!caret) return;
  // Find the editable that matches the marker. For ref-row markers, locate by reference-id
  // + target-block-id (preserves which instance row the user was typing in). For own-block
  // markers, locate by block id.
  let newEditable: HTMLElement | null = null;
  if (caret.marker.startsWith("refRow:")) {
    const [, refId, targetBlockId] = caret.marker.split(":");
    const sel = `[data-reference-instance-id="${CSS.escape(refId)}"][data-target-block-id="${CSS.escape(targetBlockId)}"] .block-text`;
    newEditable = document.querySelector<HTMLElement>(sel);
  } else if (caret.marker) {
    newEditable = document.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(caret.marker)}"] .block-text`);
  }
  // Fallback to the original (likely now-detached) editable if we couldn't find a match.
  if (!newEditable || !newEditable.isConnected) newEditable = caret.editable.isConnected ? caret.editable : null;
  if (!newEditable) return;
  const offset = Math.min(caret.offset, (newEditable.textContent ?? "").length);
  newEditable.focus({ preventScroll: true });
  const range = document.createRange();
  const walker = document.createTreeWalker(newEditable, NodeFilter.SHOW_TEXT, null);
  let remaining = offset;
  let node: Node | null = walker.nextNode();
  while (node) {
    const len = (node.nodeValue ?? "").length;
    if (remaining <= len) {
      range.setStart(node, remaining);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    remaining -= len;
    node = walker.nextNode();
  }
}

/**
 * Sync every right-side panel + the main block surface with the current `state`.
 * This is the single point where state → DOM conversion happens (after every ACK).
 */
function cleanCss(css: string): string {
  return (css || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]*;?/gi, "").replace(/url\s*\([^)]*\)/gi, "").replace(/expression\s*\([^)]*\)/gi, "").replace(/javascript\s*:/gi, "");
}
function firstCssClass(css: string): string | null {
  const match = cleanCss(css).match(/\.([A-Za-z_][A-Za-z0-9_-]*)/);
  return match?.[1] ?? null;
}
function editableForSelectionNode(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>(".block-text.rich-editor") ?? null;
}
function rememberStyleSelection() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) {
    return;
  }
  const editable = editableForSelectionNode(selection.anchorNode);
  const focusEditable = editableForSelectionNode(selection.focusNode);
  if (!editable || editable !== focusEditable) {
    return;
  }
  const own = editable.closest<HTMLElement>("[data-own-block]");
  if (!own?.dataset.id) {
    return;
  }
  styleSelection = { editable, range: selection.getRangeAt(0).cloneRange(), blockId: own.dataset.id };
}
function applyStyleToSelection(style: StyleSheet) {
  if (!style.enabled) { saveStatus.textContent = "请先启用这个样式"; return; }
  const className = firstCssClass(style.css);
  if (!className) { saveStatus.textContent = "CSS 中没有可应用的 class 选择器"; return; }
  // A final selectionchange can arrive after the sidebar click. Preserve the last
  // editor range, then validate its owner and attachment before mutating the DOM.
  rememberStyleSelection();
  const remembered = styleSelection;
  const currentOwnBlock = remembered?.editable.closest<HTMLElement>("[data-own-block]");
  if (!remembered || !remembered.editable.isConnected || currentOwnBlock?.dataset.id !== remembered.blockId ||
      !remembered.editable.contains(remembered.range.commonAncestorContainer)) {
    saveStatus.textContent = "请先在正文中选中内容";
    return;
  }
  const range = remembered.range.cloneRange();
  const startBlock = editableForSelectionNode(range.startContainer);
  const endBlock = editableForSelectionNode(range.endContainer);
  if (startBlock !== remembered.editable || endBlock !== remembered.editable) {
    saveStatus.textContent = "一次只能给同一个正文块中的选区应用样式";
    return;
  }
  remembered.editable.focus({ preventScroll: true });
  const selectedElement = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer.closest<HTMLElement>(`.${CSS.escape(className)}`)
    : range.commonAncestorContainer.parentElement?.closest<HTMLElement>(`.${CSS.escape(className)}`);
  if (selectedElement && selectedElement.contains(range.startContainer) && selectedElement.contains(range.endContainer)) {
    selectedElement.classList.add(className);
  } else {
    const fragment = range.extractContents();
    const wrapper = document.createElement("span");
    wrapper.className = className;
    wrapper.append(fragment);
    range.insertNode(wrapper);
    const next = document.createRange(); next.selectNodeContents(wrapper); next.collapse(false);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(next);
  }
  remembered.editable.dispatchEvent(new Event("input", { bubbles: true }));
  saveStatus.textContent = `已应用 .${className}`;
  styleSelection = null;
}
function findCssBlockEnd(css: string, open: number): number {
  let depth = 1;
  let quote = "";
  for (let index = open + 1; index < css.length; index++) {
    const char = css[index];
    if (quote) {
      if (char === "\\" ) index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return css.length - 1;
}

function splitCssSelectors(value: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let parens = 0;
  let brackets = 0;
  let quote = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") quote = char;
    else if (char === "(") parens++;
    else if (char === ")") parens = Math.max(0, parens - 1);
    else if (char === "[") brackets++;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "," && parens === 0 && brackets === 0) {
      if (value.slice(start, index).trim()) selectors.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (value.slice(start).trim()) selectors.push(value.slice(start).trim());
  return selectors;
}

function scopeCss(css: string, root: string): string {
  const source = cleanCss(css);
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("{", cursor);
    if (open < 0) { output += source.slice(cursor); break; }
    const close = findCssBlockEnd(source, open);
    const prelude = source.slice(cursor, open);
    const body = source.slice(open + 1, close);
    const trimmed = prelude.trim();
    if (trimmed.startsWith("@")) {
      // Media/supports/container/layer blocks contain ordinary selectors and need
      // recursive scoping. Keyframes and declaration at-rules must remain untouched.
      const nested = /^@(media|supports|container|layer|document|scope)\b/i.test(trimmed);
      output += prelude + "{" + (nested ? scopeCss(body, root) : body) + "}";
    } else {
      const scoped = splitCssSelectors(prelude).map(selector => `${root} ${selector}`).join(", ");
      output += (prelude.match(/^\s*/)?.[0] ?? "") + scoped + "{" + body + "}";
    }
    cursor = Math.min(source.length, close + 1);
  }
  return output;
}

function firstCssSelector(css: string): string | null {
  const source = cleanCss(css);
  const match = source.match(/(?:^|})\s*([^@{}][^{}]*)\{/);
  return match ? splitCssSelectors(match[1])[0] ?? null : null;
}

function stylePreviewElement(style: StyleSheet): HTMLElement {
  const selector = firstCssSelector(style.css) ?? ".callout";
  const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0]?.toLowerCase();
  const allowedTags = new Set(["p", "span", "div", "strong", "em", "h1", "h2", "h3", "blockquote", "code", "pre", "li"]);
  const sample = document.createElement(tag && allowedTags.has(tag) ? tag : "span");
  for (const token of selector.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) sample.classList.add(token[1]);
  const attributeClass = selector.match(/\[class(?:~|\^|\*|\$|\|)?=\s*["']?([A-Za-z_][A-Za-z0-9_-]*)/i)?.[1];
  if (attributeClass) sample.classList.add(attributeClass);
  const id = selector.match(/#([A-Za-z_][A-Za-z0-9_-]*)/)?.[1];
  if (id) sample.id = id;
  sample.textContent = style.title || "样式预览";
  return sample;
}
function applyManagedStyles() {
  document.querySelectorAll<HTMLStyleElement>("style[data-managed-style]").forEach(el => el.remove());
  const styles = [...(state?.notebookStyles ?? []), ...(state?.documentStyles ?? [])].filter(style => style.enabled && style.css.trim());
  styles.forEach(style => { const tag = document.createElement("style"); tag.dataset.managedStyle = style.id; tag.textContent = scopeCss(style.css, ".editor .block-text"); document.head.append(tag); });
}
function renderStyles() {
  if (!state || !stylesPanel) return;
  document.querySelectorAll<HTMLStyleElement>("style[data-style-preview]").forEach(el => el.remove());
  const list = stylePanelScope === "notebook" ? (state.notebookStyles ?? []) : (state.documentStyles ?? []);
  stylesPanel.replaceChildren();
  const scope = document.createElement("div"); scope.className = "style-scope-switch";
  (["document", "notebook"] as const).forEach(kind => { const button = document.createElement("button"); button.textContent = kind === "document" ? "当前文档" : "当前笔记本"; button.className = stylePanelScope === kind ? "active" : ""; button.onclick = () => { stylePanelScope = kind; renderStyles(); }; scope.append(button); });
  stylesPanel.append(scope);
  const add = document.createElement("button"); add.className = "style-add"; add.textContent = `+ 新建${stylePanelScope === "notebook" ? "笔记本" : "文档"}样式`;
  add.onclick = () => renderStyleCard({ id: newId(), title: "新样式", description: "", css: ".callout { padding: 8px; border-left: 3px solid #3b82f6; }", enabled: true, position: String((list.length + 1) * 1000).padStart(8, "0"), scope: stylePanelScope }, true);
  stylesPanel.append(add);
  if (!list.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "还没有样式。正文 HTML 或 Markdown 中使用 class 即可套用。"; stylesPanel.append(empty); }
  list.forEach(style => renderStyleCard(style, false));
}
function renderStyleCard(style: StyleSheet, draft: boolean) {
  const details = document.createElement("details"); details.className = "style-card"; details.open = draft;
  const summary = document.createElement("summary"); summary.className = "style-card-summary";
  const preview = document.createElement("span"); preview.className = `style-preview style-preview-${style.id}`;
  const sample = stylePreviewElement(style); preview.append(sample);
  const desc = document.createElement("span"); desc.className = "style-description"; desc.textContent = style.description || "暂无描述";
  const apply = document.createElement("button"); apply.type = "button"; apply.className = "style-apply"; apply.textContent = "应用"; apply.title = "应用到正文选中内容";
  apply.addEventListener("mousedown", event => event.preventDefault());
  apply.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); applyStyleToSelection(style); });
  summary.append(preview, desc, apply); details.append(summary);
  const body = document.createElement("div"); body.className = "style-card-body";
  const title = document.createElement("input"); title.value = style.title; title.placeholder = "标题";
  const description = document.createElement("input"); description.value = style.description; description.placeholder = "简短描述";
  const css = document.createElement("textarea"); css.value = style.css; css.placeholder = ".callout { ... }"; css.rows = 7;
  const enabled = document.createElement("label"); enabled.className = "style-enabled"; const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = style.enabled; enabled.append(checkbox, document.createTextNode("启用"));
  const actions = document.createElement("div"); actions.className = "style-actions";
  const save = document.createElement("button"); save.textContent = "保存"; save.onclick = () => { const next = { ...style, title: title.value.trim() || "未命名样式", description: description.value.trim(), css: cleanCss(css.value), enabled: checkbox.checked, scope: stylePanelScope }; void host.executeCommand({ operation: "save-style", ...next }, state!.note.id).then(result => applyServerState(result.state, "save-style")); };
  const remove = document.createElement("button"); remove.className = "danger"; remove.textContent = "删除"; remove.onclick = () => { if (!confirm("删除这个样式？")) return; void host.executeCommand({ operation: "delete-style", styleId: style.id, scope: style.scope }, state!.note.id).then(result => applyServerState(result.state, "delete-style")); };
  actions.append(save, remove); body.append(title, description, css, enabled, actions); details.append(body); stylesPanel.append(details);
  const local = document.createElement("style"); local.dataset.stylePreview = style.id; local.textContent = scopeCss(style.css, `.style-preview-${style.id}`); document.head.append(local);
}

function renderAllPanels() {
  if (!state) return;
  // Main area: diff the blockSurface (preserve focusable rows, replace structural diff).
  syncBlockSurface();
  // Right-side panels: each is a self-contained diff.
  renderRelations();
  syncBacklinks();
  syncNotices();
  renderStyles();
  applyManagedStyles();
  titleInput.value = state.note.title;
}

/** Diff the main block surface against current state.blocks. */
function syncBlockSurface() {
  if (!state) return;
  const wantedIds = new Set(state.blocks.map(b => b.id));
  // Remove shells that no longer belong
  blockSurface.querySelectorAll<HTMLElement>("[data-own-block]").forEach((shell) => {
    const id = shell.dataset.id!;
    if (!wantedIds.has(id)) shell.remove();
  });
  // Column members are mounted inside their layout slot. All other blocks keep the
  // existing flat surface so ordinary indent/outdent and keyboard navigation remain stable.
  const visibleBlocks = state.blocks.filter(block => !columnAncestor(block));
  // Insert / update in order
  let prev: Element | null = null;
  for (const block of visibleBlocks) {
    const id = block.id;
    let existing = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(id)}"]`);
    if (existing && existing.dataset.editorMode !== editorMode) {
      existing.remove();
      existing = null;
    }
    let shell: HTMLElement;
    if (existing) {
      // Update properties + depth without destroying the row (preserves focused contentEditable)
      existing.style.setProperty("--depth", String(blockDepth(block, state.blocks)));
      existing.dataset.type = block.type;
      existing.dataset.parentId = block.parentId ?? "";
      existing.dataset.column = block.properties.column === undefined ? "" : String(block.properties.column);
      const existingText = existing.querySelector<HTMLElement>(":scope > .block-row > .block-text");
      if (existingText) existingText.style.textAlign = block.properties.textAlign ?? "";
      // For reference-type shells, the inner card may need re-rendering when the underlying
      // reference's structure changed (e.g. blocks hidden/added/overridden). We replace the
      // inner card only when its row signature differs from current state — typing inside a
      // focused contentEditable row is safe because the row DOM is only touched when the
      // number/order of rows actually changed.
      if (block.type === "reference") {
        const reference = state.references.find((ref) => ref.hostBlockId === id);
        const mode = reference?.mode ?? "inline";
        // Ensure the inline detach (×) button exists in the card summary for existing shells.
        const summary = existing.querySelector(".reference-card-summary");
        if (summary && !summary.querySelector(".reference-detach")) {
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "reference-detach";
          delBtn.title = "断开引用（保留为正文）";
          delBtn.setAttribute("aria-label", "断开引用（保留为正文）");
          delBtn.textContent = "×";
          delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const ref = state!.references.find(r => r.hostBlockId === id);
            if (!ref) return;
            detachReferenceAsPlainText(ref);
          });
          summary.append(delBtn);
        }
        const newBody = renderReferenceBody(reference, mode, id);
        const oldBody = existing.querySelector<HTMLElement>(":scope > .reference-card, :scope > .sidebar-reference-entry");
        if (oldBody) {
          const oldSig = oldBody.dataset.rowSignature ?? "";
          const newSig = newBody?.dataset.rowSignature ?? "";
          if (oldSig !== newSig) {
            oldBody.replaceWith(newBody!);
          }
        } else if (newBody) {
          // No body yet (heading-only mode previously); add it if reference now warrants one.
          existing.append(newBody);
        } else if (mode === "sidebar" || mode === "link") {
          // We were in entry mode and still should be — leave existing entry alone if any.
          const entry = existing.querySelector<HTMLElement>(".sidebar-reference-entry");
          if (!entry && reference) {
            const e = document.createElement("button");
            e.type = "button";
            e.className = "sidebar-reference-entry reference-title";
            e.dataset.targetId = reference.targetDocumentId;
            if (reference.targetBlockId) e.dataset.targetBlockId = reference.targetBlockId;
            e.dataset.referenceId = reference.id;
            e.textContent = reference.targetTitle;
            e.title = "悬停预览 · 单击分栏 · 双击打开源";
            existing.append(e);
          }
        }
      }
      if (block.properties.layout === "columns") syncColumnsContainer(existing, block);
      shell = existing;
    } else {
      shell = renderOwnBlockShell(block);
    }
    const nextSibling: Element | null = prev ? prev.nextElementSibling : blockSurface.firstElementChild;
    if (nextSibling !== shell) blockSurface.insertBefore(shell, nextSibling);
    prev = shell;
  }
  state.blocks.filter(block => block.properties.layout === "columns").forEach(block => {
    const container = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`);
    if (container) syncColumnsContainer(container, block);
  });
  mountEmbeddedReferences();
}

/**
 * Build the body element that goes after the reference heading (inside the main block-surface
 * shell). Returns either a reference-card, a sidebar-reference-entry, or null if there's
 * nothing to render. The returned element carries a `data-row-signature` for diff use.
 */
function renderReferenceBody(reference: ReferenceInstance | undefined, mode: ReferenceMode, hostBlockId: string): HTMLElement | null {
  if (!reference) return null;
  if (mode === "sidebar" || mode === "link") {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "sidebar-reference-entry reference-title";
    entry.dataset.targetId = reference.targetDocumentId;
    if (reference.targetBlockId) entry.dataset.targetBlockId = reference.targetBlockId;
    entry.dataset.referenceId = reference.id;
    entry.textContent = reference.targetTitle;
    entry.title = "悬停预览 · 单击分栏 · 双击打开源";
    return entry;
  }
  const card = renderReference(reference, false);
  // Stash a structural signature so syncBlockSurface can detect structural changes.
  card.dataset.rowSignature = rowSignature(reference);
  return card;
}

/** Compact representation of a reference's currently visible rows. Includes mode, hidden
 * list, overrides fingerprint, and any visible row ids/parents/positions. Used by both
 * syncBlockSurface and renderRelations to decide whether to reuse existing DOM or rebuild.
 */
function rowSignature(r: ReferenceInstance): string {
  const hidden = new Set(r.hiddenBlockIds);
  const isHidden = (block: Block): boolean => {
    let candidate: Block | undefined = block;
    const visited = new Set<string>();
    while (candidate && !visited.has(candidate.id)) {
      if (hidden.has(candidate.id)) return true;
      visited.add(candidate.id);
      candidate = r.blocks.find((item) => item.id === candidate?.parentId);
    }
    return false;
  };
  const rows = r.blocks.filter((b) => !isHidden(b)).map((b) => `${b.id}:${b.parentId ?? ""}:${b.position}`).join("|");
  // Fingerprint overrides so source content edits and resetOverride re-render the row.
  const ov = r.overrides.map((o) => `${o.targetBlockId}:${o.baseRevision}:${o.patch.content?.text?.length ?? 0}`).join(";");
  return `${editorMode}|${r.mode}|${rows}|${ov}`;
}

function renderOwnBlockShell(block: Block): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "block-shell";
  shell.dataset.ownBlock = "true";
  shell.dataset.id = block.id;
  shell.dataset.parentId = block.parentId ?? "";
  shell.dataset.type = block.type;
  shell.dataset.editorMode = editorMode;
  shell.dataset.column = block.properties.column === undefined ? "" : String(block.properties.column);
  shell.style.setProperty("--depth", String(blockDepth(block, state!.blocks)));
  if (block.properties.layout === "columns") {
    shell.append(createEditableRow(block), createColumnLayout(block));
    syncColumnsContainer(shell, block);
  } else if (block.type === "reference") {
    const reference = state!.references.find((item) => item.hostBlockId === block.id);
    const mode = reference?.mode ?? "inline";
    shell.innerHTML = `<div class="reference-heading"><button type="button" class="grip" aria-label="引用菜单" title="引用显示方式" draggable="true">⠿</button></div>`;
    const body = renderReferenceBody(reference, mode, block.id);
    if (body) {
      shell.append(body);
      // Add a × button to the card summary so the user can detach this reference inline
      // without needing to open the menu. Inserted at the END of the summary to avoid
      // intercepting clicks on existing summary buttons (expand/mode-menu).
      const summary = body.querySelector(".reference-card-summary");
      if (summary) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "reference-detach";
        delBtn.title = "断开引用（保留为正文）";
        delBtn.setAttribute("aria-label", "断开引用（保留为正文）");
        delBtn.textContent = "×";
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const ref = state!.references.find(r => r.hostBlockId === block.id);
          if (!ref) return;
          detachReferenceAsPlainText(ref);
        });
        summary.append(delBtn);
      }
    }
  } else {
    shell.append(createEditableRow(block));
  }
  return shell;
}

function syncBacklinks() {
  if (!state) return;
  // Diff: same pattern as renderRelations but for backlinks.
  const desired = state.backlinks;
  const existing = new Map<string, HTMLElement>();
  backlinksPanel.querySelectorAll<HTMLElement>(".backlink-card").forEach((el) => {
    const key = el.dataset.sourceId ?? el.outerHTML;
    existing.set(key, el);
  });
  const fragment = document.createDocumentFragment();
  if (!desired.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无反向链接。在其他文档中链接或嵌入引用此处时会自动出现。";
    fragment.append(empty);
  } else {
    const intro = document.createElement("div");
    intro.className = "panel-intro";
    intro.textContent = `${desired.length} 处引用了此文档`;
    fragment.append(intro);
    desired.forEach((link) => {
      const key = `${link.sourceDocumentId}:${link.sourceBlockId ?? ""}`;
      let card = existing.get(key);
      if (!card) {
        card = document.createElement("div");
        card.className = "backlink-card";
        card.dataset.sourceId = key;
        const head = document.createElement("div");
        head.className = "backlink-head";
        const icon = document.createElement("span");
        icon.className = "backlink-icon";
        icon.textContent = "🔗";
        const title = document.createElement("span");
        title.className = "backlink-title";
        title.textContent = link.sourceTitle;
        const open = document.createElement("button");
        open.type = "button";
        open.className = "backlink-open";
        open.textContent = "打开";
        open.title = "打开源文档";
        head.append(icon, title, open);
        const excerpt = document.createElement("div");
        excerpt.className = "backlink-excerpt";
        excerpt.textContent = link.excerpt || "(无文本)";
        card.append(head, excerpt);
        card.addEventListener("click", (event) => {
          if ((event.target as HTMLElement).closest(".backlink-open")) return;
          open.click();
        });
        open.addEventListener("click", () => {
          if (link.sourceBlockId) {
            postAfterFlush({ type: "openDocument", documentId: link.sourceDocumentId, blockId: link.sourceBlockId });
          } else {
            postAfterFlush({ type: "openDocument", documentId: link.sourceDocumentId });
          }
        });
      }
      fragment.append(card);
      existing.delete(key);
    });
  }
  existing.forEach((el) => el.remove());
  backlinksPanel.replaceChildren(fragment);
}

function syncNotices() {
  if (!state) return;
  const labels = {
    content_style: "修改了内容或样式",
    hide: "隐藏了此块",
    move: "调整了层级或顺序",
    insert: "增加了专属块"
  } as const;
  const desired = state.overrideNotices;
  const fragment = document.createDocumentFragment();
  if (!desired.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无外部覆写通知。当其他文档修改、重排或隐藏了本块的引用副本时，会在此列出。";
    fragment.append(empty);
  } else {
    const intro = document.createElement("div");
    intro.className = "panel-intro";
    intro.textContent = `${desired.length} 条来自其他引用的覆写通知`;
    fragment.append(intro);
    desired.forEach((notice) => {
      const card = document.createElement("div");
      card.className = "notice-card" + (notice.sourceUpdated ? " warning" : "");
      const head = document.createElement("div");
      head.className = "notice-head";
      const badge = document.createElement("span");
      badge.className = `notice-badge kind-${notice.kind}`;
      badge.textContent = ({ content_style: "改", hide: "隐", move: "移", insert: "增" } as const)[notice.kind];
      const title = document.createElement("span");
      title.className = "notice-title";
      title.textContent = notice.hostTitle;
      head.append(badge, title);
      const desc = document.createElement("div");
      desc.className = "notice-desc";
      const kindLabel = labels[notice.kind] ?? "修改";
      desc.innerHTML = notice.sourceUpdated
        ? `<strong>源内容已更新</strong> · ${escapeText(notice.hostTitle)} ${escapeText(kindLabel)}了 <em>${escapeText(notice.excerpt || "此块")}</em>`
        : `${escapeText(notice.hostTitle)} ${escapeText(kindLabel)}了 <em>${escapeText(notice.excerpt || "此块")}</em>`;
      card.append(head, desc);
      const actions = document.createElement("div");
      actions.className = "notice-actions";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "打开";
      openBtn.onclick = () => postAfterFlush({ type: "openDocument", documentId: notice.hostDocumentId });
      actions.append(openBtn);
      if (notice.kind === "hide") {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "取消隐藏";
        reset.onclick = () => postAfterFlush({ type: "resetOverride", referenceInstanceId: notice.referenceInstanceId, targetBlockId: notice.targetBlockId });
        actions.append(reset);
      } else if (notice.kind === "content_style") {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "恢复继承";
        reset.onclick = () => postAfterFlush({ type: "resetOverride", referenceInstanceId: notice.referenceInstanceId, targetBlockId: notice.targetBlockId });
        actions.append(reset);
      } else if (notice.kind === "insert") {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "删除专属块";
        reset.onclick = () => postAfterFlush({ type: "deleteInstanceBlock", referenceInstanceId: notice.referenceInstanceId, blockId: notice.targetBlockId });
        actions.append(reset);
      } else if (notice.kind === "move") {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "恢复位置";
        reset.onclick = () => postAfterFlush({ type: "resetOverride", referenceInstanceId: notice.referenceInstanceId, targetBlockId: notice.targetBlockId });
        actions.append(reset);
      }
      card.append(actions);
      fragment.append(card);
    });
  }
  noticesPanel.replaceChildren(fragment);
}
function showError(error: unknown) {
  saveStatus.textContent = "保存失败：" + (error instanceof Error ? error.message : String(error));
}
async function flush() {
  if (saveFailure) throw new Error(saveFailure);
  await new Promise<void>(resolve => runAfterSaveDrain(resolve));
  await commandTail;
  if (saveFailure) throw new Error(saveFailure);
  if (commandFailure) throw commandFailure;
}

function pumpSaveQueue() {
  if (inFlightMutation || !queuedMutation) {
    finishSaveDrain();
    return;
  }
  inFlightMutation = queuedMutation;
  queuedMutation = null;
  const mutation = inFlightMutation;
  post({
    type: "saveDocument",
    documentId: mutation.documentId,
    mutationId: mutation.mutationId,
    clientVersion: mutation.clientVersion,
    title: mutation.title,
    blocks: mutation.blocks,
    historyGroup: mutation.historyGroup
  }, mutation.documentId);
}

function finishSaveDrain() {
  if (inFlightMutation || queuedMutation || !saveDrainWaiters.length) return;
  const waiters = saveDrainWaiters.splice(0);
  waiters.forEach((action) => action());
}

function enqueueDocumentSave() {
  if (!state?.note.id) return;
  saveFailure = null;
  const documentId = state.note.id;
  // Coalesced edits replace the queued snapshot; they must keep its version.
  // SQLite versions are contiguous, so only a transaction that will be sent
  // needs a new version number.
  const clientVersion = queuedMutation?.documentId === documentId
    ? queuedMutation.clientVersion
    : Math.max(mutationVersion, state.note.clientVersion ?? 0, inFlightMutation?.clientVersion ?? 0) + 1;
  mutationVersion = clientVersion;
  const mutation: SaveMutation = {
    documentId,
    mutationId: newId(),
    historyGroup: editGroup,
    clientVersion,
    title: titleInput.value.trim() || "未命名笔记",
    blocks: readOwnBlocks()
  };
  state.blocks = mutation.blocks;
  renderRelations();
  queuedMutation = mutation;
  saveStatus.textContent = "正在保存...";
  pumpSaveQueue();
}

function handleSaveAck(message: { mutationId: string; documentId: string; clientVersion: number; history?: HistoryModel }) {
  if (!inFlightMutation || inFlightMutation.mutationId !== message.mutationId) return;
  if (inFlightMutation.documentId !== message.documentId) return;
  if (state?.note.id === message.documentId) state.note.clientVersion = message.clientVersion;
  saveFailure = null;
  inFlightMutation = null;
  if (state?.note.id === message.documentId && message.history) { state.history = message.history; publishHistory(); }
  saveStatus.textContent = "已保存到本地数据库";
  pumpSaveQueue();
  finishSaveDrain();
  if (!inFlightMutation && !queuedMutation && state?.references.some(reference => reference.targetDocumentId === message.documentId)) {
    void refreshLiveReferences();
  }
  if (!inFlightMutation && !queuedMutation && sidebarLink?.documentId === message.documentId && !sidebarLink.referenceId) void showLinkSidebar(sidebarLink, false);
}

let deferredReferenceRefresh = false;
let referenceRefreshSequence = 0;
async function refreshLiveReferences() {
  const current = state;
  if (!current) return;
  const sequence = ++referenceRefreshSequence;
  try {
    await commandTail;
    const next = await host.loadDocument(current.note.id);
    if (state !== current || sequence !== referenceRefreshSequence) return;
    // Never replace an active local edit, including one whose command ACK is pending.
    if (document.activeElement?.closest(".reference-card")) {
      deferredReferenceRefresh = true;
      return;
    }
    next.references.forEach(reference => {
      const previous = current.references.find(item => item.id === reference.id);
      if (JSON.stringify(previous) === JSON.stringify(reference)) return;
      document.querySelectorAll<HTMLElement>(".reference-card[data-reference-id]").forEach(card => {
        if (card.dataset.referenceId !== reference.id) return;
        const replacement = renderReference(reference, reference.mode === "sidebar");
        card.replaceWith(replacement);
      });
      const shell = blockSurface.querySelector<HTMLElement>(`[data-id="${CSS.escape(reference.hostBlockId)}"]`);
      shell?.querySelectorAll<HTMLElement>(".reference-heading strong, .sidebar-reference-entry strong").forEach(title => title.textContent = reference.targetTitle);
    });
    current.references = next.references;
    // Backlinks and override notices also depend on cross-document data, refresh them as well.
    current.backlinks = next.backlinks;
    current.overrideNotices = next.overrideNotices;
    renderRelations();
  } catch (error) {
    saveStatus.textContent = "引用刷新失败：" + (error instanceof Error ? error.message : String(error));
  }
}
document.addEventListener("focusout", () => {
  if (!deferredReferenceRefresh) return;
  queueMicrotask(() => {
    if (document.activeElement?.closest(".reference-card")) return;
    deferredReferenceRefresh = false;
    void refreshLiveReferences();
  });
});

function handleSaveNack(message: { mutationId: string; error: string }) {
  if (!inFlightMutation || inFlightMutation.mutationId !== message.mutationId) return;
  const error = message.error || "本地数据库拒绝了这次保存";
  inFlightMutation = null;
  queuedMutation = null;
  mutationVersion = state?.note.clientVersion ?? 0;
  saveFailure = error;
  saveStatus.textContent = `保存失败：${error}`;
  showError(error);
  saveDrainWaiters.splice(0).forEach(resolve => resolve());
}

function runAfterSaveDrain(action: () => void) {
  if (saveFailure) return;
  saveDrainWaiters.push(action);
  pumpSaveQueue();
}

function postAfterFlush(message: Message) {
  const documentId = state?.note.id;
  runAfterSaveDrain(() => post(message, documentId));
}

function newId() {
  const secureCrypto = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof secureCrypto.randomUUID === "function") return secureCrypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  if (typeof secureCrypto.getRandomValues === "function") secureCrypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function renderLinkedHtml(html: string, alreadySanitized = false) {
  const template = document.createElement("template");
  template.innerHTML = alreadySanitized ? html : sanitizeHtml(html);
  template.content.querySelectorAll<HTMLElement>("[data-target-id]").forEach((link) => { link.className = "wiki-link"; link.contentEditable = "false"; });
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest(".wiki-link, style, script")) textNodes.push(node);
  }
  textNodes.forEach((node) => {
    const value = node.nodeValue ?? "";
    const matches = [...value.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)];
    if (!matches.length) return;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    matches.forEach((match) => {
      fragment.append(value.slice(offset, match.index));
      const link = document.createElement("span");
      link.className = "wiki-link";
      link.contentEditable = "false";
      link.dataset.title = match[1].trim();
      const anchor = match[2]?.trim();
      if (anchor?.startsWith("^")) link.dataset.targetBlockId = anchor.slice(1);
      link.textContent = match[0];
      fragment.append(link);
      offset = (match.index ?? 0) + match[0].length;
    });
    fragment.append(value.slice(offset));
    node.replaceWith(fragment);
  });
  return template.innerHTML;
}

function resolveWikiTargets(root: ParentNode, fallbackLinks: readonly LinkToken[] = []) {
  root.querySelectorAll<HTMLElement>(".wiki-link[data-target-title], .wiki-link[data-title]").forEach(link => {
    if (link.dataset.targetId) return;
    const title = (link.dataset.targetTitle ?? link.dataset.title ?? "").trim();
    const blockId = link.dataset.targetBlockId;
    const retained = fallbackLinks.find(candidate =>
      (!blockId || candidate.targetBlockId === blockId) &&
      (candidate.targetText === title || state?.documents.find(document => document.id === candidate.targetDocumentId)?.title === title));
    const document = state?.documents.find(candidate => candidate.title === title);
    const documentId = retained?.targetDocumentId ?? document?.id;
    if (documentId) link.dataset.targetId = documentId;
    if (!link.dataset.targetTitle) link.dataset.targetTitle = title;
  });
}

function markdownHtml(source: string, fallbackLinks: readonly LinkToken[] = []) {
  const template = document.createElement("template");
  template.innerHTML = renderMarkdown(source);
  resolveWikiTargets(template.content, fallbackLinks);
  return renderLinkedHtml(template.innerHTML, true);
}

function contentFromMarkdown(source: string, fallback: BlockContent): BlockContent {
  const container = document.createElement("div");
  container.innerHTML = markdownHtml(source, fallback.links);
  resolveWikiTargets(container, fallback.links);
  return { ...editableContent(container, fallback), markdown: source.replace(/\r\n?/g, "\n") };
}

function contentFromRichEditable(editable: HTMLElement, fallback: BlockContent): BlockContent {
  if (editable.dataset.originalHtml === editable.innerHTML) return fallback;
  resolveWikiTargets(editable, fallback.links);
  const content = editableContent(editable, fallback);
  return { ...content, markdown: markdownFromHtml(content.html) };
}

function sourceText(editable: HTMLElement) {
  const readInline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
    if (!(node instanceof HTMLElement)) return "";
    if (node.tagName === "BR") return "\n";
    let result = "";
    [...node.childNodes].forEach((child, index) => {
      if (child instanceof HTMLElement && ["DIV", "P"].includes(child.tagName) && index > 0) result += "\n";
      result += readInline(child);
    });
    return result;
  };
  let result = "";
  [...editable.childNodes].forEach((child, index) => {
    if (child instanceof HTMLElement && ["DIV", "P"].includes(child.tagName)) {
      if (index > 0) result += "\n";
      if (!(child.childNodes.length === 1 && child.firstChild instanceof HTMLBRElement)) result += readInline(child);
    } else result += readInline(child);
  });
  return result.replace(/\r\n?/g, "\n");
}

type LinkDestination = { documentId: string; blockId?: string; referenceId?: string; anchor: HTMLElement };
let sidebarLink: LinkDestination | null = null;
let sidebarSequence = 0;
let previewSequence = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function linkDestination(element: EventTarget | null): LinkDestination | null {
  const anchor = (element as HTMLElement | null)?.closest<HTMLElement>(".wiki-link, .reference-title");
  if (!anchor || !state) return null;
  const documentId = anchor.dataset.targetId ?? state.documents.find(item => item.title === anchor.dataset.title)?.id;
  return documentId ? { documentId, blockId: anchor.dataset.targetBlockId, referenceId: anchor.dataset.referenceId, anchor } : null;
}
function dismissPreview() {
  clearTimeout(previewTimer); previewSequence++;
  document.querySelector(".link-preview")?.remove();
}
async function targetProjection(target: LinkDestination): Promise<ReferenceInstance> {
  const instance = state?.references.find(item => item.id === target.referenceId);
  if (instance) return instance;
  const source = await host.loadDocument(target.documentId);
  let blocks = source.blocks;
  if (target.blockId) {
    const ids = new Set([target.blockId]);
    for (let count = -1; count !== ids.size;) {
      count = ids.size;
      blocks.forEach(block => { if (block.parentId && ids.has(block.parentId)) ids.add(block.id); });
    }
    blocks = blocks.filter(block => ids.has(block.id));
  }
  return { id: "link-preview", hostBlockId: "", targetDocumentId: target.documentId, targetBlockId: target.blockId, targetTitle: source.note.title, mode: "link", blocks, overrides: [], hiddenBlockIds: [], broken: !!target.blockId && blocks.length === 0 };
}
function readOnlyProjection(reference: ReferenceInstance) {
  const container = document.createElement("div");
  container.className = "link-preview-content";
  const hidden = new Set(reference.hiddenBlockIds);
  const visible = (block: Block) => {
    let current: Block | undefined = block;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (hidden.has(current.id)) return false;
      seen.add(current.id); current = reference.blocks.find(item => item.id === current?.parentId);
    }
    return true;
  };
  reference.blocks.filter(visible).forEach(block => {
    const override = reference.overrides.find(item => item.targetBlockId === block.id);
    const content = override?.patch.content ?? block.content;
    const paragraph = document.createElement("div");
    paragraph.className = "preview-block";
    paragraph.innerHTML = content.markdown !== undefined
      ? markdownHtml(content.markdown, content.links)
      : renderLinkedHtml(content.html || escapeText(content.text));
    container.append(paragraph);
  });
  if (!container.childElementCount) container.textContent = reference.broken ? "引用目标不存在" : "暂无内容";
  return container;
}
async function showLinkPreview(target: LinkDestination) {
  const sequence = ++previewSequence;
  try {
    const reference = await targetProjection(target);
    if (sequence !== previewSequence || !target.anchor.isConnected) return;
    const popup = document.createElement("aside");
    popup.className = "link-preview"; popup.setAttribute("role", "tooltip");
    const title = document.createElement("div"); title.className = "preview-title"; title.textContent = reference.targetTitle;
    popup.append(title, readOnlyProjection(reference));
    document.body.append(popup);
    const rect = target.anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(innerWidth - popup.offsetWidth - 8, rect.left))}px`;
    popup.style.top = `${Math.max(8, Math.min(innerHeight - popup.offsetHeight - 8, rect.bottom + 6))}px`;
    popup.addEventListener("mouseleave", dismissPreview);
  } catch { if (sequence === previewSequence) dismissPreview(); }
}
function renderSidebarPreview(reference: ReferenceInstance, target: LinkDestination) {
  const header = document.createElement("div"); header.className = "sidebar-preview-heading";
  const title = document.createElement("span"); title.textContent = reference.targetTitle;
  const close = document.createElement("button"); close.textContent = "×"; close.setAttribute("aria-label", "关闭分栏");
  close.onclick = () => { sidebarLink = null; sidebarSequence++; renderRelations(); };
  const embed = document.createElement("button"); embed.textContent = "嵌入正文";
  embed.onclick = () => {
    if (target.referenceId) {
      sidebarLink = null;
      sidebarSequence++;
      const current = state?.references.find(item => item.id === target.referenceId);
      if (current) setReferenceMode(current, "inline");
    } else createReferenceForTarget(target.documentId, target.blockId, "inline", target.anchor);
  };
  header.append(title, embed, close);
  referenceSidebarPanel.replaceChildren(header, target.referenceId ? renderReference(reference, true) : readOnlyProjection(reference));
}

async function showLinkSidebar(target: LinkDestination, activate = true) {
  dismissPreview(); sidebarLink = target;
  const sequence = ++sidebarSequence;
  const owner = state?.note.id;
  if (activate) ui.showReferences?.();
  if (!referenceSidebarPanel.hasChildNodes()) {
    const loading = document.createElement("div"); loading.className = "empty"; loading.textContent = "正在加载引用…";
    referenceSidebarPanel.append(loading);
  }
  try {
    const reference = await targetProjection(target);
    if (sequence !== sidebarSequence || owner !== state?.note.id) return;
    renderSidebarPreview(reference, target);
  } catch (error) {
    if (sequence !== sidebarSequence || owner !== state?.note.id) return;
    const msg = document.createElement("div");
    msg.className = "empty";
    msg.textContent = "无法加载分栏预览：" + (error instanceof Error ? error.message : String(error));
    const close = document.createElement("button"); close.textContent = "关闭分栏";
    close.onclick = () => { sidebarLink = null; sidebarSequence++; renderRelations(); };
    referenceSidebarPanel.replaceChildren(msg, close);
    showError(error);
  }
}
document.addEventListener("mouseover", event => {
  const target = linkDestination(event.target);
  if (!target || target.anchor.contains(event.relatedTarget as Node | null)) return;
  dismissPreview(); previewTimer = setTimeout(() => void showLinkPreview(target), 400);
});
document.addEventListener("mouseout", event => {
  const target = linkDestination(event.target);
  if (!target || target.anchor.contains(event.relatedTarget as Node | null)) return;
  if ((event.relatedTarget as HTMLElement | null)?.closest?.(".link-preview")) return;
  dismissPreview();
});
document.addEventListener("click", event => {
  const target = linkDestination(event.target);
  if (!target) return;
  event.preventDefault();
  if (event.detail < 2) void showLinkSidebar(target);
});
document.addEventListener("dblclick", event => {
  const target = linkDestination(event.target);
  if (!target) return;
  event.preventDefault(); dismissPreview(); sidebarSequence++;
  postAfterFlush({ type: "openDocument", documentId: target.documentId, blockId: target.blockId });
});
document.addEventListener("contextmenu", event => {
  const target = linkDestination(event.target);
  if (!target) return;
  event.preventDefault();
  const instance = state?.references.find(item => item.id === target.referenceId);
  if (instance) showReferenceMenu(target.anchor, undefined, instance);
  else showLinkChoiceMenu(target.anchor, { id: target.documentId, blockId: target.blockId, label: target.anchor.textContent ?? "链接" });
});
document.addEventListener("keydown", event => { if (event.key === "Escape") dismissPreview(); });

function blockDepth(block: Block, all: Block[]) {
  let depth = 0;
  let parentId = block.parentId;
  const visited = new Set<string>();
  while (parentId && depth < 8 && !visited.has(parentId)) {
    visited.add(parentId);
    parentId = all.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    depth++;
  }
  return depth;
}

function findBlock(blockId: string | null | undefined) {
  return blockId && state ? state.blocks.find(candidate => candidate.id === blockId) : undefined;
}

/** Return the nearest columns layout that owns this block, if any. */
function columnAncestor(block: Block) {
  let parent = findBlock(block.parentId);
  const visited = new Set<string>();
  while (parent && !visited.has(parent.id)) {
    if (parent.properties.layout === "columns") return parent;
    visited.add(parent.id);
    parent = findBlock(parent.parentId);
  }
  return undefined;
}

function columnIndex(block: Block, fallback = 0) {
  const value = block.properties.column;
  return Number.isInteger(value) && value! >= 0 ? value! : fallback;
}

function columnRelativeDepth(block: Block, container: Block) {
  return Math.max(0, blockDepth(block, state?.blocks ?? []) - blockDepth(container, state?.blocks ?? []) - 1);
}

function columnMembers(container: Block) {
  if (!state) return [];
  return state.blocks.filter(block => columnAncestor(block)?.id === container.id);
}

function clearColumnPlacement(block: Block) {
  const { column: _column, ...properties } = block.properties;
  block.properties = properties;
}

function normalizeSiblingPositions(parentId: string | null, column?: number) {
  if (!state) return;
  const siblings = state.blocks
    .filter(block => block.parentId === parentId && (column === undefined || columnIndex(block) === column))
    .sort((left, right) => left.position.localeCompare(right.position) || left.id.localeCompare(right.id));
  siblings.forEach((block, index) => { block.position = String((index + 1) * 1000).padStart(8, "0"); });
}

function removeEmptyColumnContainers() {
  if (!state) return;
  const empty = state.blocks.filter(block => block.properties.layout === "columns" && !state!.blocks.some(child => child.parentId === block.id));
  if (!empty.length) return;
  const ids = new Set(empty.map(block => block.id));
  state.blocks = state.blocks.filter(block => !ids.has(block.id));
}

function createColumnLayout(container: Block) {
  const layout = document.createElement("div");
  layout.className = "columns-layout";
  layout.dataset.containerId = container.id;
  syncColumnsContainerLayout(layout, container);
  return layout;
}

function syncColumnsContainerLayout(layout: HTMLElement, container: Block) {
  const count = Math.max(2, Math.min(6, Math.floor(container.properties.columnCount ?? 2)));
  layout.style.setProperty("--column-count", String(count));
  layout.style.setProperty("--column-gap", container.properties.columnGap ?? "16px");
  const members = columnMembers(container);
  const wanted = new Set(members.map(block => block.id));
  layout.querySelectorAll<HTMLElement>(":scope > .column-slot > [data-own-block]").forEach(shell => {
    if (!wanted.has(shell.dataset.id ?? "")) shell.remove();
  });
  for (let index = 0; index < count; index++) {
    let slot = layout.querySelector<HTMLElement>(`:scope > .column-slot[data-column="${index}"]`);
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "column-slot";
      slot.dataset.column = String(index);
      const head = document.createElement("div");
      head.className = "column-slot-head";
      const grip = document.createElement("button");
      grip.type = "button";
      grip.className = "column-grip";
      grip.draggable = editorMode !== "preview";
      grip.textContent = "⠿";
      grip.title = "拖拽调整列顺序";
      grip.setAttribute("aria-label", `第 ${index + 1} 列菜单`);
      const label = document.createElement("span");
      label.textContent = `第 ${index + 1} 列`;
      const add = document.createElement("button");
      add.type = "button";
      add.className = "column-add-child";
      add.textContent = "+";
      add.title = "在此列添加子块";
      add.disabled = editorMode === "preview";
      add.addEventListener("click", () => addColumnChild(container.id, index));
      head.append(grip, label, add);
      slot.append(head);
      layout.append(slot);
    } else {
      const grip = slot.querySelector<HTMLButtonElement>(".column-grip");
      if (grip) grip.draggable = editorMode !== "preview";
      const add = slot.querySelector<HTMLButtonElement>(".column-add-child");
      if (add) add.disabled = editorMode === "preview";
      const label = slot.querySelector<HTMLElement>(":scope > .column-slot-head > span");
      if (label) label.textContent = `第 ${index + 1} 列`;
    }
  }
  layout.querySelectorAll<HTMLElement>(":scope > .column-slot").forEach(slot => {
    const index = Number(slot.dataset.column);
    if (index >= count) slot.remove();
  });
  members.forEach(block => {
    const index = Math.min(count - 1, columnIndex(block));
    const slot = layout.querySelector<HTMLElement>(`:scope > .column-slot[data-column="${index}"]`);
    if (!slot) return;
    let shell = layout.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`);
    if (!shell || shell.dataset.editorMode !== editorMode) {
      shell?.remove();
      shell = renderOwnBlockShell(block);
    }
    shell.dataset.column = String(index);
    shell.style.setProperty("--depth", String(columnRelativeDepth(block, container)));
    slot.append(shell);
  });
}

function syncColumnsContainer(shell: HTMLElement, block: Block) {
  let layout = shell.querySelector<HTMLElement>(":scope > .columns-layout");
  if (!layout) {
    layout = createColumnLayout(block);
    shell.append(layout);
  } else syncColumnsContainerLayout(layout, block);
  const restore = shell.querySelector<HTMLButtonElement>(":scope > .block-row .delete-block");
  if (restore) {
    restore.title = "还原为普通块并保留内容";
    restore.setAttribute("aria-label", "还原为普通块并保留内容");
    restore.onclick = () => restoreColumns(shell);
  }
}

function render(next: EditorState) {
  document.querySelector(".block-menu")?.remove();
  hideInlineLinkSuggestions();
  const changed = state?.note.id !== next.note.id;
  dismissPreview();
  if (changed) { sidebarLink = null; sidebarSequence++; styleSelection = null; }
  // Ordinary blocks stay flat; only columns containers may own block children.
  const blockById = new Map(next.blocks.map(block => [block.id, block]));
  next.blocks.forEach(block => {
    if (!block.parentId) return;
    const parent = blockById.get(block.parentId);
    if (block.type !== "reference" && parent?.properties.layout !== "columns") {
      block.parentId = null;
      const { column: _column, ...properties } = block.properties;
      block.properties = properties;
    }
  });
  next.blocks = orderBlockTree(next.blocks);
  next.references.forEach(reference => reference.blocks = orderBlockTree(reference.blocks));
  state = next;
  activeEditable = null;
  if (changed) {
    saveFailure = null;
    commandFailure = null;
    mutationVersion = next.note.clientVersion ?? 0;
    editGroup = newId();
  }
  else mutationVersion = Math.max(mutationVersion, next.note.clientVersion ?? 0);
  // Normalize blocks list: an empty doc still needs at least one shell to edit.
  if (next.blocks.length === 0) next.blocks.push(createBlock());
  titleInput.value = next.note.title;
  // Wipe and rebuild blockSurface for a doc switch (changed === true). For same-doc refreshes,
  // run a diff via renderAllPanels so focused contentEditables survive. We fall back to a full
  // rebuild for the doc-switch path because the old shells belong to a different document.
  if (changed) {
    blockSurface.innerHTML = "";
    syncBlockSurface();
  }
  // Always re-sync right-side panels + diff main area for same-doc updates.
  renderAllPanels();
  publishHistory();
  saveStatus.textContent = "已同步本地数据库";
}

function mountEmbeddedReferences() {
  if (editorMode === "source") return;
  blockSurface.querySelectorAll<HTMLElement>("[data-reference-host-id]").forEach(anchor => {
    const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(anchor.dataset.referenceHostId!)}"]`);
    if (!shell || shell.contains(anchor)) return;
    anchor.contentEditable = "false";
    anchor.className = "embedded-reference";
    shell.style.setProperty("--depth", "0");
    anchor.replaceChildren(shell);
    syncEmbeddedOwnerControls(anchor.closest<HTMLElement>(".block-text"));
  });
}

function syncEmbeddedOwnerControls(editable: HTMLElement | null) {
  if (!editable) return;
  const copy = editable.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[data-reference-host-id]").forEach(anchor => anchor.remove());
  const hasOnlyEmbeddedReferences = !!editable.querySelector(":scope > [data-reference-host-id]") &&
    !copy.textContent?.trim() && !copy.querySelector("img, br, .wiki-link");
  editable.closest(".block-row")?.classList.toggle("embedded-only", hasOnlyEmbeddedReferences);
}

function focusBlock(blockId: string) {
  window.setTimeout(() => {
    const block = document.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(blockId)}"]`);
    if (!block) return;
    block.scrollIntoView({ block: "center", behavior: "smooth" });
    block.querySelector<HTMLElement>(".block-text")?.focus({ preventScroll: true });
    block.classList.add("navigation-target");
    window.setTimeout(() => block.classList.remove("navigation-target"), 900);
  }, 50);
}

function createBlock(type: BlockType = "paragraph", parentId: string | null = null): Block {
  return { id: newId(), parentId, position: "", type, content: { text: "", html: "", markdown: "", checked: false }, properties: {}, revision: 1 };
}

function removeOwnBlock(shell: HTMLElement | null) {
  if (!shell) return;
  const layoutBlock = state?.blocks.find(block => block.id === shell.dataset.id && block.properties.layout === "columns");
  if (layoutBlock) {
    restoreColumns(shell);
    return;
  }
  const removedReferenceIds = new Set<string>();
  shell.querySelectorAll<HTMLElement>("[data-own-block][data-type='reference']").forEach(referenceShell => {
    const reference = state?.references.find(item => item.hostBlockId === referenceShell.dataset.id);
    if (reference) removedReferenceIds.add(reference.id);
  });
  if (shell.dataset.type === "reference") {
    const reference = state?.references.find(item => item.hostBlockId === shell.dataset.id);
    if (reference) removedReferenceIds.add(reference.id);
  }
  state?.blocks.filter(block => block.type === "reference" && block.parentId === shell.dataset.id).forEach(block => {
    const reference = state?.references.find(item => item.hostBlockId === block.id);
    if (reference) removedReferenceIds.add(reference.id);
    blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`)?.remove();
  });
  // Keep surviving children at the deleted block's level, never with a dangling parent ID.
  blockSurface.querySelectorAll<HTMLElement>("[data-own-block]").forEach(child => {
    if (child.dataset.parentId === shell.dataset.id && !shell.contains(child))
      child.dataset.parentId = shell.dataset.parentId ?? "";
  });
  const embeddedAnchor = shell.parentElement?.closest<HTMLElement>("[data-reference-host-id]");
  if (embeddedAnchor?.contains(shell)) embeddedAnchor.remove();
  else shell.remove();
  removeReferencesFromLocalState(removedReferenceIds);
  recalculateDepths();
  if (!blockSurface.querySelector("[data-own-block]")) addBlock("paragraph");
  scheduleDocumentSave(0);
}

function createEditableRow(block: Block) {
  const row = document.createElement("div");
  if (block.type === "media") {
    row.className = "block-row media-row";
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "grip";
    grip.setAttribute("aria-label", "媒体块菜单");
    grip.title = "媒体块菜单";
    grip.draggable = editorMode !== "preview";
    grip.textContent = "⠿";
    const asset = block.content.media;
    if (asset) row.append(grip, renderMediaPreview(asset));
    else {
      const missing = document.createElement("div");
      missing.className = "media-preview media-missing";
      missing.textContent = "媒体文件不可用";
      row.append(grip, missing);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-block";
    remove.title = "删除媒体块";
    remove.textContent = "×";
    remove.disabled = editorMode === "preview";
    remove.addEventListener("click", () => removeOwnBlock(row.closest<HTMLElement>("[data-own-block]")));
    row.append(remove);
    return row;
  }
  row.className = "block-row";
  if (block.properties.layout === "columns") row.classList.add("columns-container-row");
  const checkbox = block.type === "todo" ? `<input class="todo-check" type="checkbox" ${block.content.checked ? "checked" : ""}>` : "";
  row.innerHTML = `<button type="button" class="grip" aria-label="块菜单" draggable="${editorMode !== "preview"}">⠿</button>${checkbox}<div class="block-text ${block.type === "heading" ? "heading" : ""}"></div><button class="delete-block" title="删除块">×</button>`;
  if (block.properties.layout === "columns") {
    const restore = row.querySelector<HTMLButtonElement>(".delete-block");
    if (restore) {
      restore.classList.add("columns-restore");
      restore.textContent = "↶";
      restore.title = "还原为普通块并保留内容";
      restore.setAttribute("aria-label", "还原为普通块并保留内容");
    }
  }
  const editable = row.querySelector<HTMLElement>(".block-text")!;
  if (editorMode === "source") {
    editable.classList.add("markdown-source");
    editable.contentEditable = "plaintext-only";
    editable.spellcheck = false;
    editable.textContent = markdownFromContent(block.content);
  } else if (editorMode === "preview") {
    editable.classList.add("markdown-preview");
    editable.innerHTML = block.content.markdown !== undefined
      ? markdownHtml(block.content.markdown, block.content.links)
      : renderLinkedHtml(block.content.html || escapeText(block.content.text));
  } else {
    editable.classList.add("rich-editor");
    editable.contentEditable = "true";
    editable.innerHTML = block.content.markdown !== undefined
      ? markdownHtml(block.content.markdown, block.content.links)
      : renderLinkedHtml(block.content.html || escapeText(block.content.text));
    editable.dataset.originalHtml = editable.innerHTML;
  }
  editable.style.backgroundColor = block.properties.background ?? "";
  editable.style.color = block.properties.textColor ?? "";
  editable.style.textAlign = block.properties.textAlign ?? "";
  if (editorMode !== "preview") {
    editable.addEventListener("focus", () => activeEditable = editable);
    editable.addEventListener("input", event => {
      if (event.target !== editable) return;
      syncEmbeddedOwnerControls(editable);
      scheduleDocumentSave();
    });
    editable.addEventListener("keydown", handleBlockKeydown);
    row.querySelector("input")?.addEventListener("change", () => scheduleDocumentSave(0));
  } else row.querySelector<HTMLInputElement>("input")?.setAttribute("disabled", "");
  row.querySelector(".delete-block")?.addEventListener("click", () => {
    removeOwnBlock(row.closest<HTMLElement>("[data-own-block]"));
  });
  row.querySelector<HTMLButtonElement>(".delete-block")!.disabled = editorMode === "preview";
  return row;
}

function renderMediaPreview(asset: MediaAsset): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "media-preview";
  figure.dataset.mediaKind = asset.kind;
  let media: HTMLImageElement | HTMLVideoElement | HTMLAudioElement;
  if (asset.kind === "image") {
    const image = document.createElement("img");
    image.src = asset.url;
    image.alt = asset.name;
    image.loading = "lazy";
    media = image;
  } else if (asset.kind === "video") {
    const video = document.createElement("video");
    video.src = asset.url;
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    media = video;
  } else {
    const audio = document.createElement("audio");
    audio.src = asset.url;
    audio.controls = true;
    audio.preload = "metadata";
    media = audio;
  }
  media.classList.add("media-player");
  figure.append(media);
  const caption = document.createElement("figcaption");
  caption.className = "media-caption";
  const name = document.createElement("span");
  name.className = "media-name";
  name.textContent = asset.name;
  const meta = document.createElement("small");
  meta.textContent = `${asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "音频"} · ${formatMediaSize(asset.size)}`;
  caption.append(name, meta);
  figure.append(caption);
  return figure;
}

function formatMediaSize(size: number) {
  if (!Number.isFinite(size) || size < 1024) return `${Math.max(0, size | 0)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function handleBlockKeydown(event: KeyboardEvent) {
  if (event.target !== event.currentTarget) return;
  if (event.defaultPrevented) return;
  if (editorMode === "source") return;
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  const current = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-own-block]")!;
  const currentBlock = state?.blocks.find(block => block.id === current.dataset.id);
  const next = createBlock("paragraph", current.dataset.parentId || null);
  if (currentBlock && columnAncestor(currentBlock)) next.properties = { column: columnIndex(currentBlock) };
  const shell = document.createElement("div");
  shell.className = "block-shell";
  shell.dataset.ownBlock = "true";
  shell.dataset.id = next.id;
  shell.dataset.parentId = next.parentId ?? "";
  shell.dataset.type = next.type;
  shell.style.setProperty("--depth", String(Number(current.style.getPropertyValue("--depth")) || 0));
  shell.append(createEditableRow(next));
  current.after(shell);
  shell.querySelector<HTMLElement>(".block-text")?.focus();
  scheduleDocumentSave(0);
}

function readOwnBlocks(): Block[] {
  const siblingIndexes = new Map<string, number>();
  const blocks: Block[] = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")].map((shell): Block => {
    const old = state?.blocks.find((block) => block.id === shell.dataset.id);
    const oldParentId = shell.dataset.parentId || null;
    const oldParent = oldParentId ? state?.blocks.find(block => block.id === oldParentId) : undefined;
    const isReferenceChild = shell.dataset.type === "reference" && !!oldParentId;
    const parentId = isReferenceChild || oldParent?.properties.layout === "columns" ? oldParentId : null;
    const siblingKey = parentId ?? "";
    const siblingIndex = (siblingIndexes.get(siblingKey) ?? 0) + 1;
    siblingIndexes.set(siblingKey, siblingIndex);
    const position = String(siblingIndex * 1000).padStart(8, "0");
    if (shell.dataset.type === "reference") return {
      id: shell.dataset.id!, parentId, position,
      type: "reference", content: old?.content ?? { text: "", html: "" }, properties: old?.properties ?? {}, revision: old?.revision ?? 1
    };
    if (shell.dataset.type === "media") return {
      id: shell.dataset.id!, parentId, position,
      type: "media", content: old?.content ?? { text: "", html: "" }, properties: old?.properties ?? {}, revision: old?.revision ?? 1
    };
    const editable = shell.querySelector<HTMLElement>(":scope > .block-row > .block-text")!;
    const content = editorMode === "preview"
      ? old?.content ?? { text: "", html: "", markdown: "" }
      : editorMode === "source"
        ? contentFromMarkdown(sourceText(editable), old?.content ?? { text: "", html: "" })
        : contentFromRichEditable(editable, old?.content ?? { text: "", html: "" });
    return {
      id: shell.dataset.id!, parentId, position,
      type: shell.dataset.type as BlockType,
      content: { ...content, checked: shell.querySelector<HTMLInputElement>(".todo-check")?.checked ?? old?.content.checked ?? false },
      properties: editorMode === "rich"
        ? {
          ...(old?.properties ?? {}),
          background: editable.style.backgroundColor || undefined,
          textColor: editable.style.color || undefined,
          textAlign: editable.style.textAlign === "left" || editable.style.textAlign === "center" || editable.style.textAlign === "right" ? editable.style.textAlign : undefined,
          ...(shell.dataset.column === "" ? {} : { column: Number(shell.dataset.column) })
        }
        : {
          ...(old?.properties ?? {}),
          ...(old?.properties.textAlign ? { textAlign: old.properties.textAlign } : {}),
          ...(shell.dataset.column === "" ? {} : { column: Number(shell.dataset.column) })
        },
      revision: old?.revision ?? 1
    };
  });
  const byId = new Map(blocks.map(block => [block.id, block]));
  const removedReferenceIds = new Set<string>();
  const retained = blocks.filter(block => {
    if (block.type !== "reference" || !block.parentId) return true;
    const parent = byId.get(block.parentId);
    const retainedByOwner = parent?.content.html.includes(`data-reference-host-id="${block.id}"`) ?? false;
    if (!retainedByOwner) {
      const reference = state?.references.find(item => item.hostBlockId === block.id);
      if (reference) removedReferenceIds.add(reference.id);
    }
    return retainedByOwner;
  });
  removeReferencesFromLocalState(removedReferenceIds);
  return orderBlockTree(retained);
}

function removeReferencesFromLocalState(referenceIds: ReadonlySet<string>) {
  if (!state || referenceIds.size === 0) return;
  state.references = state.references.filter(reference => !referenceIds.has(reference.id));
  sidebarCollapsedIds.forEach(id => { if (referenceIds.has(id)) sidebarCollapsedIds.delete(id); });
  if (sidebarLink?.referenceId && referenceIds.has(sidebarLink.referenceId)) {
    sidebarLink = null;
    sidebarSequence++;
  }
  renderRelations();
}

function scheduleDocumentSave(structural?: number) {
  if (structural !== undefined) editGroup = newId();
  enqueueDocumentSave();
}

function saveDocument() {
  editGroup = newId();
  enqueueDocumentSave();
}

/**
 * Compare two references' rendered structure (which blocks are visible, in what order,
 * with what hidden/override flags). Returns true when the two would render the same set
 * of rows — useful for deciding whether a saveInstanceBlock / moveReferenceBlock /
 * hideReferenceBlock ACK requires a card re-render (which would clobber focused
 * contentEditables). Returns false when blocks were added/removed/moved/re-parented
 * or hidden state changed.
 */
function sameInstanceStructure(a: ReferenceInstance, b: ReferenceInstance): boolean {
  return visibleRowSignature(a) === visibleRowSignature(b);
}

/**
 * Signature of a reference's currently visible rows. Used both for change detection
 * and to skip re-rendering sidebar cards whose DOM already matches state.
 */
function visibleRowSignature(r: ReferenceInstance): string {
  const hidden = new Set(r.hiddenBlockIds);
  const isHidden = (block: Block): boolean => {
    let candidate: Block | undefined = block;
    const visited = new Set<string>();
    while (candidate && !visited.has(candidate.id)) {
      if (hidden.has(candidate.id)) return true;
      visited.add(candidate.id);
      candidate = r.blocks.find((item) => item.id === candidate?.parentId);
    }
    return false;
  };
  return r.blocks.filter((b) => !isHidden(b)).map((b) => `${b.id}:${b.parentId ?? ""}:${b.position}`).join("|");
}

// (sameInstanceStructure / visibleRowSignature are no longer needed: renderRelations runs on
// every ACK and diffs against current state, so we always re-render stale cards.)

function renderReference(reference: ReferenceInstance, inSidebar = false) {
  const card = document.createElement("section");
  const collapsed = !inSidebar && reference.mode === "collapsed";
  const sidebarCollapsed = inSidebar && sidebarCollapsedIds.has(reference.id);
  card.className = `reference-card ${collapsed ? "collapsed is-collapsed" : "is-expanded"} ${inSidebar ? (sidebarCollapsed ? "sidebar is-collapsed" : "sidebar") : ""}`;
  card.dataset.referenceId = reference.id;
  // Every reference card has a summary header with collapse/expand toggle.
  const summary = document.createElement("div");
  summary.className = "reference-card-summary";
  const isOpen = inSidebar ? !sidebarCollapsed : !collapsed;
  const toggleLabel = isOpen ? "收起" : "展开";
  const toggleIcon = isOpen ? "▾" : "▸";
  const refTitle = escapeText(reference.targetTitle);
  const targetDocId = escapeText(reference.targetDocumentId);
  const refIdAttr = escapeText(reference.id);
  summary.innerHTML = `<button type="button" class="reference-expand" aria-expanded="${isOpen}" aria-label="${toggleLabel}" title="${inSidebar ? (isOpen ? "折叠此引用" : "展开此引用") : (collapsed ? "展开引用正文" : "折叠引用正文")}">${toggleIcon}</button><button type="button" class="reference-title" data-target-id="${targetDocId}" data-reference-id="${refIdAttr}">${refTitle}</button>${inSidebar ? `<button type="button" class="reference-mode-menu" aria-label="引用显示方式" title="切换显示方式">⠿</button>` : ""}`;
  const title = summary.querySelector<HTMLElement>(".reference-title")!;
  if (reference.targetBlockId) title.dataset.targetBlockId = reference.targetBlockId;
  const toggle = summary.querySelector<HTMLButtonElement>(".reference-expand")!;
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (inSidebar) {
      // Sidebar-local collapse state, no protocol change needed.
      if (sidebarCollapsedIds.has(reference.id)) sidebarCollapsedIds.delete(reference.id);
      else sidebarCollapsedIds.add(reference.id);
      const replacement = renderReference(reference, true);
      card.replaceWith(replacement);
      return;
    }
    setReferenceMode(reference, collapsed ? "inline" : "collapsed");
  });
  const modeMenuBtn = summary.querySelector<HTMLButtonElement>(".reference-mode-menu");
  if (modeMenuBtn) {
    modeMenuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      showReferenceMenu(modeMenuBtn, undefined, reference);
    });
  }
  card.append(summary);
  // Sidebar collapsed: skip row/footer rendering entirely (only show the summary header).
  if (sidebarCollapsed) return card;
  const overrideMap = new Map(reference.overrides.map((item) => [item.targetBlockId, item]));
  const hidden = new Set(reference.hiddenBlockIds);
  const isHidden = (block: Block) => {
    let candidate: Block | undefined = block;
    const visited = new Set<string>();
    while (candidate && !visited.has(candidate.id)) {
      if (hidden.has(candidate.id)) return true;
      visited.add(candidate.id);
      candidate = reference.blocks.find((item) => item.id === candidate?.parentId);
    }
    return false;
  };
  reference.blocks.filter((block) => !isHidden(block)).forEach((source) => {
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
    row.style.setProperty("--depth", String(blockDepth(source, reference.blocks)));
    const local = source.scopeType === "reference_instance";
    row.innerHTML = `<div class="reference-meta"><span>${local ? "本地新增" : override ? "已覆写" : "继承"}</span><button class="add-sibling" title="在同级新增块">+</button>${local ? "" : '<button class="reset" title="恢复源内容与位置">↺</button>'}<button class="hide" title="${local ? "删除本地块" : "在此引用中隐藏"}">×</button></div><div class="block-text ${source.type === "heading" ? "heading" : ""}"></div>`;
    const editable = row.querySelector<HTMLElement>(".block-text")!;
    if (override && source.revision > override.baseRevision) row.querySelector(".reference-meta span")!.textContent = "已覆写 · 源内容已更新";
    if (editorMode === "source") {
      editable.classList.add("markdown-source");
      editable.contentEditable = "plaintext-only";
      editable.spellcheck = false;
      editable.textContent = markdownFromContent(content);
    } else if (editorMode === "preview") {
      editable.classList.add("markdown-preview");
      editable.innerHTML = content.markdown !== undefined
        ? markdownHtml(content.markdown, content.links)
        : renderLinkedHtml(content.html || escapeText(content.text));
    } else {
      editable.classList.add("rich-editor");
      editable.contentEditable = "true";
      editable.innerHTML = content.markdown !== undefined
        ? markdownHtml(content.markdown, content.links)
        : renderLinkedHtml(content.html || escapeText(content.text));
      editable.dataset.originalHtml = editable.innerHTML;
    }
    editable.style.backgroundColor = properties.background ?? "";
    editable.style.color = properties.textColor ?? "";
    if (editorMode !== "preview") {
      editable.addEventListener("focus", () => activeEditable = editable);
      editable.addEventListener("input", () => local ? scheduleInstanceBlock(row, source) : scheduleOverride(row, source, properties));
    }
    row.querySelector<HTMLButtonElement>(".add-sibling")!.disabled = editorMode === "preview";
    row.querySelector(".add-sibling")!.addEventListener("click", () => addInstanceBlock(reference, source.parentId ?? null, row));
    row.querySelector<HTMLButtonElement>(".hide")!.disabled = editorMode === "preview";
    row.querySelector(".hide")!.addEventListener("click", () => {
      // Optimistic UI: dim the row while we wait for the host command
      row.style.opacity = "0.35";
      saveStatus.textContent = local ? "正在删除本地块..." : "正在隐藏源块...";
      const documentId = state?.note.id;
      const cmd = local
        ? { type: "deleteInstanceBlock" as const, referenceInstanceId: reference.id, blockId: source.id }
        : { type: "hideReferenceBlock" as const, referenceInstanceId: reference.id, targetBlockId: source.id };
      void post(cmd, documentId).then(() => {
        // post owns ACK/NACK status; do not overwrite a rejection with a success label.
        row.style.opacity = "";
      });
    });
    const reset = row.querySelector<HTMLButtonElement>(".reset");
    if (reset) reset.disabled = editorMode === "preview";
    reset?.addEventListener("click", () => postAfterFlush({ type: "resetOverride", referenceInstanceId: reference.id, targetBlockId: source.id }));
    card.append(row);
  });
  const footer = document.createElement("footer");
  footer.className = "reference-footer";
  footer.innerHTML = `${hidden.size ? `<span>已隐藏 ${hidden.size} 块</span><button class="restore-hidden">恢复隐藏块</button>` : ""}`;
  footer.querySelector(".restore-hidden")?.addEventListener("click", () => {
    const documentId = state?.note.id;
    runAfterSaveDrain(() => reference.hiddenBlockIds.forEach((id) => post({ type: "resetOverride", referenceInstanceId: reference.id, targetBlockId: id }, documentId)));
  });
  card.append(footer);
  return card;
}

function blockFromReferenceRow(row: HTMLElement, fallback: Block): Block {
  const editable = row.querySelector<HTMLElement>(".block-text")!;
  const content = editorMode === "source"
    ? contentFromMarkdown(sourceText(editable), fallback.content)
    : editorMode === "preview"
      ? fallback.content
      : contentFromRichEditable(editable, fallback.content);
  return {
    ...fallback,
    parentId: row.dataset.parentId || null,
    position: row.dataset.position || fallback.position,
    content,
    properties: editorMode === "rich"
      ? { ...fallback.properties, background: editable.style.backgroundColor || undefined, textColor: editable.style.color || undefined }
      : fallback.properties
  };
}

function scheduleInstanceBlock(row: HTMLElement, source: Block) {
  const documentId = state?.note.id;
  const referenceInstanceId = row.dataset.referenceInstanceId!;
  const block = blockFromReferenceRow(row, source);
  saveStatus.textContent = "正在保存引用专属块...";
  post({ type: "saveInstanceBlock", referenceInstanceId, block, historyGroup: editGroup }, documentId);

}

function addInstanceBlock(reference: ReferenceInstance, parentId: string | null, afterRow?: HTMLElement) {
  const documentId = state?.note.id;
  const block = createBlock("paragraph", parentId);
  block.scopeType = "reference_instance";
  const rows = [...(afterRow?.closest(".reference-card") ?? blockSurface).querySelectorAll<HTMLElement>(".reference-row")];
  block.position = String((rows.length + 1) * 1000).padStart(8, "0");
  runAfterSaveDrain(() => post({ type: "saveInstanceBlock", referenceInstanceId: reference.id, block }, documentId));
}

/**
 * 断开引用 → 把当前显示内容（应用覆写 + 隐藏过滤后）作为普通文本块保留。
 * 1. 在 DOM/state 中把 hostBlockId 替换为多个普通块
 * 2. 立即更新右栏中的引用状态
 * 3. 保存当前文档；宿主在同一事务中清理缺失宿主块对应的引用记录
 */
function detachReferenceAsPlainText(reference: ReferenceInstance) {
  if (!state) return;
  const hostShell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(reference.hostBlockId)}"]`);
  if (!hostShell) {
    // 兜底：直接发命令
    postAfterFlush({ type: "removeReference", referenceInstanceId: reference.id });
    return;
  }
  const hostBlock = state.blocks.find(b => b.id === reference.hostBlockId);
  if (!hostBlock) return;

  const hidden = new Set(reference.hiddenBlockIds);
  const overrideMap = new Map(reference.overrides.map(o => [o.targetBlockId, o]));
  const visible = reference.blocks
    .filter(b => b.scopeType !== "reference_instance")
    .filter(b => !hidden.has(b.id));

  const newBlocks: Block[] = visible.map(src => {
    const ov = overrideMap.get(src.id);
    const content = ov?.patch.content ?? src.content;
    const properties = ov?.patch.properties ?? src.properties;
    return {
      id: newId(),
      parentId: hostBlock.parentId,
      position: src.position,
      type: src.type,
      content: { text: content.text ?? "", html: content.html ?? "", links: content.links },
      properties: { ...(properties ?? {}) },
      revision: 1
    };
  });

  if (newBlocks.length === 0) {
    newBlocks.push({ ...createBlock("paragraph", hostBlock.parentId), position: hostBlock.position });
  }

  // Update state.blocks: replace hostBlock with new blocks
  const idx = state.blocks.findIndex(b => b.id === reference.hostBlockId);
  state.blocks.splice(idx, 1, ...newBlocks);

  // Update DOM: replace hostShell with new shells
  const fragment = document.createDocumentFragment();
  for (const b of newBlocks) {
    const shell = document.createElement("div");
    shell.className = "block-shell";
    shell.dataset.ownBlock = "true";
    shell.dataset.id = b.id;
    shell.dataset.parentId = b.parentId ?? "";
    shell.dataset.type = b.type;
    shell.style.setProperty("--depth", String(blockDepth(b, state!.blocks)));
    shell.append(createEditableRow(b));
    fragment.append(shell);
  }
  hostShell.replaceWith(fragment);

  // Focus first new block
  fragment.querySelector<HTMLElement>(".block-text")?.focus();

  removeReferencesFromLocalState(new Set([reference.id]));
  // Save immediately; removing the host block also removes its reference instance.
  saveDocument();
  saveStatus.textContent = "引用已断开，内容保留为正文";
}

function scheduleOverride(row: HTMLElement, source: Block, originalProperties: BlockProperties) {
  const documentId = state?.note.id;
  const referenceInstanceId = row.dataset.referenceInstanceId!;
  const targetBlockId = row.dataset.targetBlockId!;
  const editable = row.querySelector<HTMLElement>(".block-text")!;
  const content = editableContent(editable, source.content);
  const properties = { ...originalProperties, background: editable.style.backgroundColor || undefined, textColor: editable.style.color || undefined };
  saveStatus.textContent = "正在保存局部覆写...";
  post({ type: "saveOverride", referenceInstanceId, targetBlockId, content, properties, historyGroup: editGroup }, documentId);

}

function renderRelations() {
  if (!state) return;
  if (sidebarLink) {
    // Ordinary previews own the slot until explicitly closed; unrelated command ACKs
    // must not erase them. Instance previews update from the acknowledged local state.
    if (!sidebarLink.referenceId) return;
    const reference = state.references.find(item => item.id === sidebarLink!.referenceId);
    if (reference) { renderSidebarPreview(reference, sidebarLink); return; }
    sidebarLink = null;
    sidebarSequence++;
  }
  // Diff the right-side reference sidebar against `state.references`. Cards whose rendered
  // row signature still matches current state are reused (preserves focused contentEditables
  // and scroll position). Cards that no longer belong are removed. New cards are inserted.
  // The whole fragment is applied with `replaceChildren` so the panel never paints empty.
  const ordinaryLinks = state.blocks.flatMap(block => (block.content.links ?? [])
    .filter(link => !!link.targetDocumentId)
    .map((link, index) => ({
      key: `${block.id}:${link.targetDocumentId}:${link.targetBlockId ?? ""}:${link.start}:${index}`,
      sourceBlockId: block.id,
      documentId: link.targetDocumentId!,
      blockId: link.targetBlockId,
      label: state!.documents.find(document => document.id === link.targetDocumentId)?.title ?? link.targetText,
      excerpt: block.content.text
    })));
  const desiredSidebarRefs = state.references.filter((reference) => reference.mode === "sidebar");
  let showCards: ReferenceInstance[] = desiredSidebarRefs;
  let introOrEmpty: "intro" | "empty" | null = null;
  if (desiredSidebarRefs.length === 0) {
    showCards = state.references.filter(r => r.mode === "inline" || r.mode === "collapsed");
    introOrEmpty = showCards.length > 0 ? "intro" : ordinaryLinks.length ? null : "empty";
  }
  // Index existing cards by their data-reference-id so we can decide reuse vs. rebuild.
  const existingCards = new Map<string, HTMLElement>();
  referenceSidebarPanel.querySelectorAll<HTMLElement>(".reference-card[data-reference-id]").forEach((el) => {
    existingCards.set(el.dataset.referenceId!, el);
  });
  // Collect everything into the fragment BEFORE replaceChildren, so the panel is never
  // temporarily blank even if showCards is empty or an error occurs mid-render.
  const fragment = document.createDocumentFragment();
  for (const reference of showCards) {
    const existing = existingCards.get(reference.id);
    const sig = rowSignature(reference);
    if (existing && (existing as HTMLElement & { __rowSig?: string }).__rowSig === sig) {
      // Structure unchanged → reuse existing DOM (preserves focused contentEditable).
      fragment.append(existing);
    } else {
      // Either no existing card (new) or structural change (rows added/hidden/moved).
      const fresh = renderReference(reference, true);
      (fresh as HTMLElement & { __rowSig?: string }).__rowSig = sig;
      fragment.append(fresh);
    }
    existingCards.delete(reference.id);
  }
  if (ordinaryLinks.length) {
    const heading = document.createElement("div");
    heading.className = "linked-reference-heading";
    heading.textContent = `普通双链 ${ordinaryLinks.length}`;
    fragment.append(heading);
    for (const link of ordinaryLinks) {
      const entry = document.createElement("section");
      entry.className = "linked-reference-entry";
      entry.dataset.linkKey = link.key;
      const title = document.createElement("button");
      title.type = "button";
      title.className = "reference-title";
      title.dataset.targetId = link.documentId;
      if (link.blockId) title.dataset.targetBlockId = link.blockId;
      title.textContent = link.label || "未命名链接";
      title.title = "悬停预览 · 单击分栏 · 双击打开源";
      const excerpt = document.createElement("p");
      excerpt.textContent = link.excerpt || "（空白段落）";
      entry.append(title, excerpt);
      entry.addEventListener("click", event => {
        if ((event.target as HTMLElement).closest("button")) return;
        title.click();
      });
      fragment.append(entry);
    }
  }
  // Remove cards that no longer belong (e.g. reference was removed).
  existingCards.forEach((el) => el.remove());
  if (introOrEmpty === "intro") {
    const intro = document.createElement("div");
    intro.className = "ref-sidebar-intro";
    intro.textContent = `当前文档包含 ${showCards.length} 处实时引用（不是右侧分栏模式）。可在引用菜单选择「右侧分栏」以在此处查看。`;
    fragment.append(intro);
  } else if (introOrEmpty === "empty") {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无右侧分栏。双链预览会自动展开在此区域。";
    fragment.append(empty);
  }
  // Swap the whole panel atomically — intro/empty is already in the fragment.
  referenceSidebarPanel.replaceChildren(fragment);
  // An empty result is still a visible selected panel. Only the shell changes tabs.
}

function showMenu(anchor: HTMLElement, actions: Array<{ label: string; run: () => void; danger?: boolean }>) {
  document.querySelector(".block-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "block-menu";
  menu.setAttribute("role", "menu");
  actions.forEach((action) => {
    const button = document.createElement("button");
    button.textContent = action.label;
    if (action.danger) button.className = "danger";
    button.addEventListener("click", () => { menu.remove(); action.run(); });
    menu.append(button);
  });
  const host = anchor.closest<HTMLElement>(".block-shell") ?? anchor.parentElement ?? document.body;
  host.append(menu);
  menu.style.display = "block";
  const close = (event: MouseEvent) => { if (!menu.contains(event.target as Node) && event.target !== anchor) { menu.remove(); document.removeEventListener("mousedown", close); } };
  window.setTimeout(() => document.addEventListener("mousedown", close), 0);
}

function showOwnBlockMenu(anchor: HTMLElement, block: Block) {
  activeEditable = anchor.closest("[data-own-block]")?.querySelector<HTMLElement>(".block-text") ?? activeEditable;
  showMenu(anchor, [
    { label: "复制块链接", run: () => navigator.clipboard?.writeText(`[[${state?.note.title}^${block.id}]]`) },
    { label: "插入块链接", run: () => insertTarget(block.id, state?.note.id, block.content.text || "块") },
    { label: "嵌入为实时引用", run: () => createReferenceForTarget(state?.note.id, block.id) },
    { label: "删除块", run: () => {
      removeOwnBlock(anchor.closest<HTMLElement>("[data-own-block]"));
    }, danger: true }
  ]);
}

function showReferenceMenu(anchor: HTMLElement, _block: Block | undefined, reference?: ReferenceInstance) {
  if (!reference) return;
  showMenu(anchor, [
    { label: "仅标题链接", run: () => setReferenceMode(reference, "link") },
    { label: "正文直显", run: () => setReferenceMode(reference, "inline") },
    { label: "折叠卡片", run: () => setReferenceMode(reference, "collapsed") },
    { label: "右侧分栏", run: () => setReferenceMode(reference, "sidebar") },
    { label: "打开源文档", run: () => postAfterFlush({ type: "openDocument", documentId: reference.targetDocumentId }) },
    { label: "删除引用", danger: true, run: () => {
      const shell = blockSurface.querySelector<HTMLElement>(
        `[data-own-block][data-id="${CSS.escape(reference.hostBlockId)}"]`
      );
      removeOwnBlock(shell);
    }},
    { label: "断开引用（保留为正文）", run: () => detachReferenceAsPlainText(reference) },
    { label: "恢复全部继承内容", run: () => postAfterFlush({ type: "resetReference", referenceInstanceId: reference.id }) }
  ]);
}

function setReferenceMode(reference: ReferenceInstance, mode: ReferenceMode) {
  postAfterFlush({ type: "setReferenceMode", referenceInstanceId: reference.id, mode });
}

function createReferenceForTarget(targetDocumentId?: string, targetBlockId?: string, mode: ReferenceMode = "inline", anchor?: HTMLElement) {
  if (!state || !targetDocumentId) return;
  const documentId = state.note.id;
  const block = createBlock("reference");
  block.content.targetDocumentId = targetDocumentId;
  if (anchor?.closest(".reference-row")) { showError("请在普通正文块中嵌入引用；引用内的链接可在分栏预览。"); return; }
  const ownerShell = (anchor ?? activeEditable)?.closest<HTMLElement>("[data-own-block]");
  if (anchor?.isConnected && ownerShell) {
    const marker = document.createElement("span");
    marker.dataset.referenceHostId = block.id;
    marker.contentEditable = "false";
    anchor.replaceWith(marker);
    block.parentId = ownerShell.dataset.id!;
  } else block.parentId = ownerShell?.dataset.parentId || null;
  state.blocks = readOwnBlocks();
  const index = state.blocks.findIndex(item => item.id === ownerShell?.dataset.id);
  state.blocks.splice(index < 0 ? state.blocks.length : index + 1, 0, block);
  sidebarLink = null;
  sidebarSequence++;

  // Optimistically add the new reference to state so renderRelations() shows it immediately,
  // avoiding a brief blank/old-state flash while the createReference command is in flight.
  const optimisticRef: ReferenceInstance = {
    id: `pending-${block.id}`,
    hostBlockId: block.id,
    targetDocumentId,
    targetBlockId,
    targetTitle: state.documents.find(d => d.id === targetDocumentId)?.title ?? targetDocumentId,
    mode,
    blocks: [],
    overrides: [],
    hiddenBlockIds: []
  };
  state.references.push(optimisticRef);

  render(state);
  saveDocument();
  runAfterSaveDrain(async () => {
    await post({ type: "createReference", hostBlockId: block.id, targetDocumentId, targetBlockId }, documentId);
    // applyServerState in post's ACK already synced state.references.
    // For non-inline modes, switch the newly-created reference to the requested mode.
    if (mode !== "inline") {
      const reference = state?.references.find((item) => item.hostBlockId === block.id);
      if (reference) void post({ type: "setReferenceMode", referenceInstanceId: reference.id, mode }, documentId);
    }
  });
}

function insertTarget(targetBlockId?: string, targetDocumentId?: string, label = "链接") {
  if (!activeEditable || !targetDocumentId) return;
  activeEditable.focus();
  if (editorMode === "source") {
    document.execCommand("insertText", false, `[[${label}${targetBlockId ? `#^${targetBlockId}` : ""}]]`);
    activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  const escapedLabel = escapeText(label);
  const html = `<span contenteditable="false" class="wiki-link" data-target-id="${escapeText(targetDocumentId)}"${targetBlockId ? ` data-target-block-id="${escapeText(targetBlockId)}"` : ""} data-target-title="${escapedLabel}">${escapedLabel}</span>`;
  document.execCommand("insertHTML", false, html);
  activeEditable.closest(".reference-row") ? activeEditable.dispatchEvent(new Event("input", { bubbles: true })) : scheduleDocumentSave(0);
  const links = [...activeEditable.querySelectorAll<HTMLElement>(".wiki-link")];
  const inserted = links[links.length - 1];
  if (inserted) showLinkChoiceMenu(inserted, { id: targetDocumentId, blockId: targetBlockId, label });
}

function suggestionItems(query: string) {
  if (!state) return [];
  const normalized = query.toLocaleLowerCase();
  const items: Array<{ id: string; blockId?: string; title: string; meta: string; label: string }> = [];
  state.documents.filter((item) => item.id !== state?.note.id).forEach((item) => {
    if (!normalized || item.title.toLocaleLowerCase().includes(normalized)) items.push({ id: item.id, title: item.title, meta: "文档", label: item.title });
  });
  state.blocks.filter((block) => block.content.text.toLocaleLowerCase().includes(normalized)).slice(0, 8).forEach((block) => {
    items.push({ id: state!.note.id, blockId: block.id, title: block.content.text.slice(0, 48) || "未命名块", meta: "当前文档中的块", label: block.content.text.slice(0, 48) || "块" });
  });
  return items.slice(0, 12);
}

function updateInlineLinkSuggestions(editable: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !selection.anchorNode) return hideInlineLinkSuggestions();
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(editable);
  try { beforeRange.setEnd(selection.anchorNode, selection.anchorOffset); } catch { return hideInlineLinkSuggestions(); }
  const before = beforeRange.toString();
  const marker = before.lastIndexOf("[[");
  if (marker < 0 || before.slice(marker).includes("]]")) return hideInlineLinkSuggestions();
  activeEditable = editable;
  linkMenuItems = suggestionItems(before.slice(marker + 2));
  linkMenuIndex = 0;
  renderInlineLinkSuggestions(editable);
}

function renderInlineLinkSuggestions(editable: HTMLElement) {
  linkSuggestions.innerHTML = "";
  if (!linkMenuItems.length) {
    const empty = document.createElement("div");
    empty.className = "link-suggestion-empty";
    empty.textContent = "没有匹配的文档或块";
    linkSuggestions.append(empty);
  }
  linkMenuItems.forEach((item, index) => {
    const button = document.createElement("button");
    button.className = `link-suggestion ${index === linkMenuIndex ? "active" : ""}`;
    button.innerHTML = `<strong>${escapeText(item.title)}</strong><span>${escapeText(item.meta)}</span>`;
    button.addEventListener("mousedown", (event) => { event.preventDefault(); insertInlineSuggestion(item); });
    linkSuggestions.append(button);
  });
  const editor = editable.closest<HTMLElement>(".editor") ?? document.body;
  if (linkSuggestions.parentElement !== editor) editor.append(linkSuggestions);
  linkSuggestions.hidden = false;
  const editorRect = editor.getBoundingClientRect();
  const editRect = editable.getBoundingClientRect();
  linkSuggestions.style.left = `${Math.max(36, editRect.left - editorRect.left)}px`;
  linkSuggestions.style.top = `${editRect.bottom - editorRect.top + 8}px`;
}

function hideInlineLinkSuggestions() { linkSuggestions.hidden = true; linkMenuItems = []; }

function insertInlineSuggestion(item: { id: string; blockId?: string; label: string }) {
  const selection = window.getSelection();
  if (!activeEditable || !selection?.rangeCount || !selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(activeEditable);
  try { beforeRange.setEnd(selection.anchorNode!, selection.anchorOffset); } catch { return; }
  const marker = beforeRange.toString().lastIndexOf("[[");
  if (marker < 0) return;
  const textWalker = document.createTreeWalker(activeEditable, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let current: Node | null;
  while ((current = textWalker.nextNode())) {
    const length = current.textContent?.length ?? 0;
    if (offset + length >= marker) {
      startNode = current as Text;
      startOffset = Math.max(0, marker - offset);
      break;
    }
    offset += length;
  }
  if (!startNode) return;
  range.setStart(startNode, Math.min(startOffset, startNode.length));
  range.deleteContents();
  if (editorMode === "source") {
    const source = `[[${item.label}${item.blockId ? `#^${item.blockId}` : ""}]]`;
    const text = document.createTextNode(source);
    range.insertNode(text);
    range.setStartAfter(text);
    range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    hideInlineLinkSuggestions();
    activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  const link = document.createElement("span");
  link.className = "wiki-link";
  link.contentEditable = "false";
  link.dataset.targetId = item.id;
  if (item.blockId) link.dataset.targetBlockId = item.blockId;
  link.dataset.targetTitle = item.label;
  link.textContent = item.label;
  range.insertNode(link);
  range.setStartAfter(link);
  range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range);
  hideInlineLinkSuggestions();
  activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
  showLinkChoiceMenu(link, item);
}

function showLinkChoiceMenu(anchor: HTMLElement, item: { id: string; blockId?: string; label: string }) {
  document.querySelector(".link-mode-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "link-mode-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `<strong>已插入双链</strong><span>选择后续操作</span>`;
  const choices: Array<{ label: string; mode?: ReferenceMode }> = [
    { label: "保持普通双链" },
    { label: "嵌入实时引用 · 正文直显", mode: "inline" },
    { label: "嵌入实时引用 · 折叠卡片", mode: "collapsed" },
    { label: "嵌入实时引用 · 右侧分栏", mode: "sidebar" }
  ];
  choices.forEach((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice.label;
    button.addEventListener("click", () => {
      menu.remove();
      if (choice.mode) createReferenceForTarget(item.id, item.blockId, choice.mode, anchor);
    });
    menu.append(button);
  });
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(window.innerWidth - 260, Math.max(8, rect.left))}px`;
  menu.style.top = `${Math.min(window.innerHeight - 210, rect.bottom + 8)}px`;
  const close = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node) && event.target !== anchor) {
      menu.remove(); document.removeEventListener("mousedown", close);
    }
  };
  window.setTimeout(() => document.addEventListener("mousedown", close), 0);
}

function handleInlineLinkKeys(event: KeyboardEvent) {
  if (linkSuggestions.hidden) return;
  if (event.key === "Escape") { event.preventDefault(); hideInlineLinkSuggestions(); return; }
  if (!linkMenuItems.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    linkMenuIndex = (linkMenuIndex + (event.key === "ArrowDown" ? 1 : -1) + linkMenuItems.length) % linkMenuItems.length;
    renderInlineLinkSuggestions(activeEditable!);
  } else if (event.key === "Enter") {
    event.preventDefault();
    insertInlineSuggestion(linkMenuItems[linkMenuIndex]);
  }
}

function addBlock(type: BlockType) {
  if (editorMode === "preview") return;
  if (!state) return;
  const block = createBlock(type);
  state.blocks.push(block);
  const shell = renderOwnBlockShell(block);
  blockSurface.append(shell);
  shell.querySelector<HTMLElement>(".block-text")?.focus();
  scheduleDocumentSave(0);
}

function mediaKindForMime(mimeType: string): MediaKind | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取媒体文件失败"));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("媒体文件编码失败"));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

async function insertMediaFiles(files: readonly File[]) {
  if (!state || editorMode === "preview") return;
  const accepted = files.filter(file => mediaKindForMime(file.type) !== null);
  if (!accepted.length) {
    showError(new Error("请选择图片、视频或音频文件。"));
    return;
  }
  const failures: string[] = [];
  let inserted = 0;
  for (const file of accepted) {
    try {
      const data = await fileToBase64(file);
      const result = await host.storeMedia({ name: file.name, mimeType: file.type, size: file.size, data });
      const asset = result.media;
      const block = createBlock("media");
      block.position = nextPosition(null);
      block.content = { text: asset.name, html: "", media: asset };
      state.blocks.push(block);
      inserted++;
    } catch (error) {
      failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (inserted) {
    state.blocks = orderBlockTree(state.blocks);
    renderAllPanels();
    scheduleDocumentSave(0);
  }
  if (failures.length) showError(new Error(`部分媒体未插入：${failures.join("；")}`));
}

function nextPosition(parentId: string | null) {
  const positions = state?.blocks.filter(block => block.parentId === parentId).map(block => Number(block.position)) ?? [];
  const next = Math.max(0, ...positions.filter(Number.isFinite)) + 1000;
  return String(next).padStart(8, "0");
}

function addColumns() {
  if (editorMode === "preview" || !state) return;
  const container = createBlock("paragraph");
  container.position = nextPosition(null);
  container.properties = { layout: "columns", columnCount: 2, columnGap: "16px" };
  const first = createBlock("paragraph", container.id);
  first.position = "00001000";
  first.properties = { column: 0 };
  const second = createBlock("paragraph", container.id);
  second.position = "00002000";
  second.properties = { column: 1 };
  state.blocks.push(container, first, second);
  state.blocks = orderBlockTree(state.blocks);
  renderAllPanels();
  blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(first.id)}"] .block-text`)?.focus();
  scheduleDocumentSave(0);
}

function addColumnChild(containerId: string, column: number) {
  if (editorMode === "preview" || !state) return;
  const container = state.blocks.find(block => block.id === containerId && block.properties.layout === "columns");
  if (!container) return;
  const child = createBlock("paragraph", containerId);
  child.position = nextPosition(containerId);
  child.properties = { column };
  state.blocks.push(child);
  state.blocks = orderBlockTree(state.blocks);
  renderAllPanels();
  blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(child.id)}"] .block-text`)?.focus();
  scheduleDocumentSave(0);
}

function restoreColumns(shell: HTMLElement) {
  if (!state) return;
  const container = state.blocks.find(block => block.id === shell.dataset.id && block.properties.layout === "columns");
  if (!container) return;
  const members = columnMembers(container);
  const parentId = container.parentId;
  const direct = members.filter(block => block.parentId === container.id);
  direct.forEach(block => { block.parentId = parentId; });
  members.forEach(block => {
    const { column: _column, ...properties } = block.properties;
    block.properties = properties;
  });
  state.blocks = state.blocks.filter(block => block.id !== container.id);
  const siblings = state.blocks.filter(block => block.parentId === parentId && block.id !== container.id);
  let position = siblings.length;
  direct.forEach(block => { block.position = String((position += 1) * 1000).padStart(8, "0"); });
  state.blocks = orderBlockTree(state.blocks);
  renderAllPanels();
  scheduleDocumentSave(0);
}

function reorderColumns(containerId: string, from: number, to: number) {
  if (!state || from === to) return;
  const container = state.blocks.find(block => block.id === containerId && block.properties.layout === "columns");
  if (!container) return;
  const count = Math.max(2, Math.min(6, Math.floor(container.properties.columnCount ?? 2)));
  if (from < 0 || to < 0 || from >= count || to >= count) return;
  columnMembers(container).forEach(block => {
    const current = columnIndex(block);
    if (current === from) block.properties = { ...block.properties, column: to };
    else if (from < to && current > from && current <= to) block.properties = { ...block.properties, column: current - 1 };
    else if (from > to && current >= to && current < from) block.properties = { ...block.properties, column: current + 1 };
  });
  renderAllPanels();
  scheduleDocumentSave(0);
}

function applyFormat(command: "bold" | "italic" | "hiliteColor") {
  if (!activeEditable || editorMode === "preview") return;
  activeEditable.focus();
  if (editorMode === "source") {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !activeEditable.contains(selection.anchorNode)) return;
    const marker = command === "bold" ? "**" : command === "italic" ? "_" : "==";
    document.execCommand("insertText", false, `${marker}${selection.toString()}${marker}`);
    activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  document.execCommand(command, false, command === "hiliteColor" ? "#fff2a8" : undefined);
  activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyColor(property: "color" | "backgroundColor", value: string) {
  if (!activeEditable || editorMode !== "rich") return;
  activeEditable.style[property] = value;
  activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyBlockAlignment(value: "left" | "center" | "right") {
  const shell = selectedOwnBlock();
  if (!shell || !state || editorMode === "preview") return;
  const block = state.blocks.find(item => item.id === shell.dataset.id);
  if (!block) return;
  block.properties = { ...block.properties, textAlign: value };
  const text = shell.querySelector<HTMLElement>(":scope > .block-row > .block-text");
  if (text) text.style.textAlign = value;
  scheduleDocumentSave(0);
}

function updateEditorModeUi() {
  document.body.dataset.editorModeState = editorMode;
  editorElement.classList.toggle("editor-mode-rich", editorMode === "rich");
  editorElement.classList.toggle("editor-mode-source", editorMode === "source");
  editorElement.classList.toggle("editor-mode-preview", editorMode === "preview");
  document.querySelectorAll<HTMLButtonElement>("[data-editor-mode]").forEach(button => {
    const active = button.dataset.editorMode === editorMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  titleInput.readOnly = editorMode === "preview";
  const previewOnlyDisabled = ["add-paragraph", "add-heading", "add-todo", "add-columns", "add-media", "bold", "italic", "highlight", "outdent", "indent", "move-up", "move-down", "align"];
  previewOnlyDisabled.forEach(id => {
    const button = document.querySelector<HTMLButtonElement>(`#${id}`);
    if (button) button.disabled = editorMode === "preview";
  });
  document.querySelectorAll<HTMLInputElement>("#text-color, #background-color").forEach(input => input.disabled = editorMode !== "rich");
}

async function switchEditorMode(next: EditorMode) {
  if (next === editorMode) return;
  if (state && editorMode !== "preview") {
    enqueueDocumentSave();
    await flush();
    if (saveFailure) return;
  }
  editorMode = next;
  localStorage.setItem("lnm-editor-mode", editorMode);
  activeEditable = null;
  activeBlock = null;
  hideInlineLinkSuggestions();
  document.querySelector(".block-menu")?.remove();
  updateEditorModeUi();
  if (!state) return;
  blockSurface.replaceChildren(...state.blocks.map(renderOwnBlockShell));
  referenceSidebarPanel.replaceChildren();
  mountEmbeddedReferences();
  renderRelations();
  saveStatus.textContent = editorMode === "preview" ? "预览模式" : editorMode === "source" ? "Markdown 源码模式" : "编辑模式";
}

function selectedOwnBlock() { return selectedReferenceRow() ? null : activeEditable?.closest<HTMLElement>("[data-own-block]") ?? null; }
function selectedReferenceRow() { return activeEditable?.closest<HTMLElement>(".reference-row") ?? null; }

function persistReferenceStructure(row: HTMLElement) {
  if (!state) return;
  const reference = state.references.find((item) => item.id === row.dataset.referenceInstanceId);
  const block = reference?.blocks.find((item) => item.id === row.dataset.targetBlockId);
  if (!reference || !block) return;
  runAfterSaveDrain(() => {
    if (row.dataset.scopeType === "reference_instance") {
      post({ type: "saveInstanceBlock", referenceInstanceId: reference.id, block: blockFromReferenceRow(row, block) });
    } else {
      post({
        type: "moveReferenceBlock", referenceInstanceId: reference.id, targetBlockId: block.id,
        parentBlockId: row.dataset.parentId || null, position: row.dataset.position ?? "00001000"
      });
    }
  });
}

function recalculateReferenceDepths(card: HTMLElement) {
  const rows = [...card.querySelectorAll<HTMLElement>(".reference-row")];
  const depth = (row: HTMLElement, visited = new Set<string>()): number => {
    const parentId = row.dataset.parentId;
    if (!parentId || visited.has(parentId)) return 0;
    visited.add(parentId);
    const parent = rows.find((candidate) => candidate.dataset.targetBlockId === parentId);
    return parent ? Math.min(8, 1 + depth(parent, visited)) : 0;
  };
  rows.forEach((row) => row.style.setProperty("--depth", String(depth(row))));
}

function indent(direction: "in" | "out") {
  const current = selectedOwnBlock();
  if (current) {
    // Ordinary blocks are intentionally flat. Columns are the only block hierarchy.
    const block = state?.blocks.find(item => item.id === current.dataset.id);
    if (block && columnAncestor(block)) saveStatus.textContent = "分列中的块请使用左右拖拽调整";
    else saveStatus.textContent = "正文块不支持普通子级";
    return;
  }
  const referenceRow = selectedReferenceRow();
  const card = referenceRow?.closest<HTMLElement>(".reference-card");
  if (!referenceRow || !card) return;
  const rows = [...card.querySelectorAll<HTMLElement>(".reference-row")];
  const index = rows.indexOf(referenceRow);
  if (direction === "in" && index > 0) referenceRow.dataset.parentId = rows[index - 1].dataset.targetBlockId!;
  if (direction === "out" && referenceRow.dataset.parentId) {
    const parent = rows.find((row) => row.dataset.targetBlockId === referenceRow.dataset.parentId);
    referenceRow.dataset.parentId = parent?.dataset.parentId ?? "";
  }
  recalculateReferenceDepths(card);
  persistReferenceStructure(referenceRow);
  saveStatus.textContent = "引用结构已保存";
}

function recalculateDepths() {
  const rows = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")];
  const depth = (row: HTMLElement, visited = new Set<string>()): number => {
    const parentId = row.dataset.parentId;
    if (!parentId || visited.has(parentId)) return 0;
    visited.add(parentId);
    const parent = rows.find((candidate) => candidate.dataset.id === parentId);
    return parent ? Math.min(8, 1 + depth(parent, visited)) : 0;
  };
  rows.forEach((row) => row.style.setProperty("--depth", String(depth(row))));
}

function move(delta: -1 | 1) {
  const current = selectedOwnBlock();
  if (current) {
    const rows = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")];
    const index = rows.indexOf(current);
    const target = rows[index + delta];
    if (!target) return;
    delta < 0 ? target.before(current) : target.after(current);
    scheduleDocumentSave(0);
    return;
  }
  const referenceRow = selectedReferenceRow();
  const card = referenceRow?.closest<HTMLElement>(".reference-card");
  if (!referenceRow || !card) return;
  const rows = [...card.querySelectorAll<HTMLElement>(".reference-row")];
  const index = rows.indexOf(referenceRow);
  const target = rows[index + delta];
  if (!target) return;
  delta < 0 ? target.before(referenceRow) : target.after(referenceRow);
  [...card.querySelectorAll<HTMLElement>(".reference-row")].forEach((row, rowIndex) => {
    const nextPosition = String((rowIndex + 1) * 1000).padStart(8, "0");
    if (row.dataset.position === nextPosition) return;
    row.dataset.position = nextPosition;
    persistReferenceStructure(row);
  });
  saveStatus.textContent = "引用顺序已保存";
}

function escapeText(value: string) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

host.onEvent(event => {
  if (event.kind === "documentChanged" && state?.references.some(reference => reference.targetDocumentId === event.payload.documentId)) void refreshLiveReferences();
  if (event.kind === "documentChanged" && sidebarLink?.documentId === event.payload.documentId && !sidebarLink.referenceId) void showLinkSidebar(sidebarLink, false);
  if (event.kind === "documentLoaded") render(event.payload.state);
  if (event.kind === "focusBlock") focusBlock(event.payload.blockId);
  if (event.kind === "notification") saveStatus.textContent = event.payload.message;
  if (event.kind === "flush") {
    const requestId = event.payload.requestId;
    void historyTail.then(() => flush()).then(() => host.emit({ protocolVersion: 1, kind: "flushResult", payload: { requestId, ok: true } }),
      error => host.emit({ protocolVersion: 1, kind: "flushResult", payload: { requestId, ok: false, error: error.message } }));
  }
});

document.querySelector("#add-paragraph")!.addEventListener("click", () => addBlock("paragraph"));
document.querySelector("#add-heading")!.addEventListener("click", () => addBlock("heading"));
document.querySelector("#add-todo")!.addEventListener("click", () => addBlock("todo"));
document.querySelector("#add-columns")!.addEventListener("click", addColumns);
document.querySelector("#add-media")?.addEventListener("click", () => document.querySelector<HTMLInputElement>("#media-file-input")?.click());
document.querySelector<HTMLInputElement>("#media-file-input")?.addEventListener("change", event => {
  const input = event.target as HTMLInputElement;
  const files = input.files ? [...input.files] : [];
  input.value = "";
  void insertMediaFiles(files);
});
document.querySelector("#bold")!.addEventListener("click", () => applyFormat("bold"));
document.querySelector("#italic")!.addEventListener("click", () => applyFormat("italic"));
document.querySelector("#highlight")!.addEventListener("click", () => applyFormat("hiliteColor"));
document.querySelector<HTMLInputElement>("#text-color")!.addEventListener("input", (event) => applyColor("color", (event.target as HTMLInputElement).value));
document.querySelector<HTMLInputElement>("#background-color")!.addEventListener("input", (event) => applyColor("backgroundColor", (event.target as HTMLInputElement).value));
document.querySelector("#indent")!.addEventListener("click", () => indent("in"));
document.querySelector("#outdent")!.addEventListener("click", () => indent("out"));
document.querySelector("#move-up")!.addEventListener("click", () => move(-1));
document.querySelector("#move-down")!.addEventListener("click", () => move(1));
const alignButton = document.querySelector<HTMLButtonElement>("#align");
const alignMenu = document.querySelector<HTMLElement>("#align-menu");
alignButton?.addEventListener("mousedown", event => event.preventDefault());
alignButton?.addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();
  if (alignButton.disabled) return;
  const open = alignMenu?.hidden ?? true;
  if (alignMenu) alignMenu.hidden = !open;
  alignButton.setAttribute("aria-expanded", String(open));
});
alignMenu?.querySelectorAll<HTMLButtonElement>("[data-align]").forEach(button => {
  button.addEventListener("mousedown", event => event.preventDefault());
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    applyBlockAlignment(button.dataset.align as "left" | "center" | "right");
    alignMenu.hidden = true;
    alignButton?.setAttribute("aria-expanded", "false");
  });
});
document.addEventListener("click", event => {
  if (!(event.target as HTMLElement).closest(".align-tool")) {
    if (alignMenu) alignMenu.hidden = true;
    alignButton?.setAttribute("aria-expanded", "false");
  }
});
document.querySelector("#undo")?.addEventListener("click", () => void moveHistory("undo"));
document.querySelector("#redo")?.addEventListener("click", () => void moveHistory("redo"));
document.querySelector("#history")?.addEventListener("click", () => ui.showHistory?.());
document.querySelector("#notebook-styles")?.addEventListener("click", () => {
  stylePanelScope = "notebook";
  const tab = document.querySelector<HTMLElement>('[data-pane-btn="styles"]');
  tab?.click();
  renderStyles();
});
document.querySelectorAll<HTMLButtonElement>("[data-editor-mode]").forEach(button => {
  button.addEventListener("click", () => void switchEditorMode(button.dataset.editorMode as EditorMode));
});
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const grip = target?.closest<HTMLElement>(".grip");
  if (!grip) return;
  if (draggingBlockId) return; // suppress menu during drag
  event.preventDefault();
  event.stopPropagation();
  const shell = grip.closest<HTMLElement>("[data-own-block]");
  const block = shell?.dataset.id ? state?.blocks.find((item) => item.id === shell.dataset.id) : undefined;
  const instanceId = grip.closest<HTMLElement>(".reference-card")?.dataset.referenceId;
  const reference = instanceId ? state?.references.find(item => item.id === instanceId) : shell?.dataset.id ? state?.references.find((item) => item.hostBlockId === shell.dataset.id) : undefined;
  if (reference) showReferenceMenu(grip, block, reference);
  else if (block) showOwnBlockMenu(grip, block);
}, true);
document.addEventListener("selectionchange", rememberStyleSelection);
document.addEventListener("input", (event) => {
  const input = event as InputEvent;
  if (event.target !== editTarget || Date.now() - editTime > 900 || input.inputType && !["insertText", "deleteContentBackward", "deleteContentForward", "insertCompositionText", "insertFromComposition"].includes(input.inputType)) editGroup = newId();
  editTarget = event.target; editTime = Date.now();
  const editable = (event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text[contenteditable='true']");
  if (editable) updateInlineLinkSuggestions(editable);
}, true);
document.addEventListener("beforeinput", event => {
  const target = event.target as HTMLElement;
  if (!(event as InputEvent).isComposing && (target === titleInput ? titleInput.selectionStart !== titleInput.selectionEnd : !getSelection()?.isCollapsed)) editGroup = newId();
}, true);
document.addEventListener("pointerdown", () => { editGroup = newId(); }, true);
document.addEventListener("compositionstart", () => { editGroup = newId(); }, true);
document.addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) editGroup = newId();
  const target = event.target as HTMLElement;
  if ((target.matches("input, textarea") && target !== titleInput) || target.closest("[data-slot=history]")) return;
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && !event.altKey && !event.isComposing && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) void moveHistory("redo");
    else void moveHistory("undo");
    return;
  }
  if (event.altKey && !event.ctrlKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) post({ type: event.key === "ArrowLeft" ? "navigateBack" : "navigateForward" });
    return;
  }
  const editable = (event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text[contenteditable='true']");
  if (editable && !linkSuggestions.hidden) handleInlineLinkKeys(event);
}, true);
titleInput.addEventListener("input", () => scheduleDocumentSave());
document.querySelectorAll<HTMLButtonElement>(".icon-tools button").forEach((button) => button.addEventListener("mousedown", (event) => event.preventDefault()));
updateEditorModeUi();

// ─────────────────────────────────────────────────────────────────────────────
// Drag & drop for block reordering
// ─────────────────────────────────────────────────────────────────────────────

function clearDropIndicator() {
  document.querySelectorAll(".block-shell").forEach(el => {
    el.classList.remove("is-dragging", "drop-before", "drop-after", "drop-child", "drop-column-side");
  });
  dropIndicator = null;
  columnDropIndicator?.slot.classList.remove("drop-column");
  columnDropIndicator = null;
}

function setDropIndicator(targetShell: HTMLElement, position: "before" | "after" | "child") {
  clearDropIndicator();
  targetShell.classList.add(position === "child" ? "drop-child" : position === "before" ? "drop-before" : "drop-after");
  dropIndicator = { targetId: targetShell.dataset.id!, position };
}

function setColumnDropIndicator(targetShell: HTMLElement, side: "left" | "right") {
  clearDropIndicator();
  targetShell.classList.add("drop-column-side");
  dropIndicator = { targetId: targetShell.dataset.id!, position: side === "left" ? "column-left" : "column-right" };
}

/** Whether targetId is inside the subtree of sourceId (own blocks only). */
function isDescendant(sourceId: string, targetId: string): boolean {
  if (!state) return false;
  const parentOf = new Map<string, string | null>();
  for (const block of state.blocks) parentOf.set(block.id, block.parentId);
  let current: string | null = targetId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current === sourceId) return true;
    current = parentOf.get(current) ?? null;
  }
  return false;
}

function handleDragStart(event: DragEvent) {
  const columnGrip = (event.target as HTMLElement).closest<HTMLElement>(".column-grip");
  if (columnGrip) {
    const slot = columnGrip.closest<HTMLElement>(".column-slot");
    const layout = columnGrip.closest<HTMLElement>(".columns-layout");
    if (!slot || !layout || editorMode === "preview") return;
    draggingColumn = { containerId: layout.dataset.containerId!, column: Number(slot.dataset.column) };
    columnGrip.classList.add("is-dragging");
    event.dataTransfer?.setData("text/plain", `column:${draggingColumn.column}`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    event.stopPropagation();
    return;
  }
  const grip = (event.target as HTMLElement).closest<HTMLElement>(".grip");
  if (!grip) return;
  const shell = grip.closest<HTMLElement>(".block-shell[data-own-block]");
  if (!shell?.dataset.id) return;
  // Prevent dragging reference rows (they stay within their card)
  if (grip.closest(".reference-row")) return;
  draggingBlockId = shell.dataset.id;
  shell.classList.add("is-dragging");
  // Use block text as drag image label
  const textEl = shell.querySelector<HTMLElement>(".block-text");
  if (textEl && event.dataTransfer) {
    event.dataTransfer.setData("text/plain", textEl.textContent ?? "");
    event.dataTransfer.effectAllowed = "move";
    // Custom drag image: a small ghost with the block text
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = (textEl.textContent ?? "").slice(0, 60) || "块";
    ghost.style.position = "absolute";
    ghost.style.top = "-1000px";
    document.body.append(ghost);
    event.dataTransfer.setDragImage(ghost, 10, 14);
    setTimeout(() => ghost.remove(), 0);
  }
}

function handleDragOver(event: DragEvent) {
  if (event.dataTransfer?.types.includes("Files")) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    blockSurface.classList.add("media-drop-active");
    return;
  }
  if (draggingColumn) {
    const slot = (event.target as HTMLElement).closest<HTMLElement>(".column-slot");
    const layout = slot?.closest<HTMLElement>(".columns-layout");
    if (!slot || !layout || layout.dataset.containerId !== draggingColumn.containerId) return;
    const column = Number(slot.dataset.column);
    if (column === draggingColumn.column) return;
    columnDropIndicator?.slot.classList.remove("drop-column");
    slot.classList.add("drop-column");
    columnDropIndicator = { containerId: layout.dataset.containerId!, column, slot };
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    return;
  }
  if (!draggingBlockId) return;
  const emptySlot = (event.target as HTMLElement).closest<HTMLElement>(".column-slot");
  const containingShell = (event.target as HTMLElement).closest<HTMLElement>(".block-shell");
  const layoutShell = emptySlot?.closest<HTMLElement>(".columns-layout")?.parentElement;
  if (emptySlot && (!containingShell || containingShell === layoutShell)) {
    const layout = emptySlot.closest<HTMLElement>(".columns-layout");
    if (layout) {
      clearDropIndicator();
      emptySlot.classList.add("drop-column");
      columnDropIndicator = { containerId: layout.dataset.containerId!, column: Number(emptySlot.dataset.column), slot: emptySlot };
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }
    return;
  }
  const shell = (event.target as HTMLElement).closest<HTMLElement>(".block-shell[data-own-block]");
  if (!shell || !shell.dataset.id || shell.dataset.id === draggingBlockId) return;

  // Reference rows are not valid drop targets for own blocks
  if (shell.closest(".reference-row")) return;

  // Block being dragged cannot be dropped into its own subtree
  if (isDescendant(draggingBlockId, shell.dataset.id)) return;

  const rect = shell.getBoundingClientRect();
  const relY = (event.clientY - rect.top) / Math.max(1, rect.height);
  const relX = (event.clientX - rect.left) / Math.max(1, rect.width);

  // Horizontal edge drops are reserved for columns. Near the left/right 24% of a
  // block, the dragged block becomes a sibling column of the target.
  if (relX < 0.24) setColumnDropIndicator(shell, "left");
  else if (relX > 0.76) setColumnDropIndicator(shell, "right");
  else if (relY < 0.33) setDropIndicator(shell, "before");
  else if (relY > 0.67) setDropIndicator(shell, "after");
  else setDropIndicator(shell, relY < 0.5 ? "before" : "after");

  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function handleDragLeave(event: DragEvent) {
  if (event.dataTransfer?.types.includes("Files")) {
    const related = event.relatedTarget as Node | null;
    if (!related || !blockSurface.contains(related)) blockSurface.classList.remove("media-drop-active");
    return;
  }
  const related = event.relatedTarget as HTMLElement | null;
  const shell = (event.target as HTMLElement).closest<HTMLElement>(".block-shell[data-own-block]");
  if (!shell || (related && shell.contains(related))) return;
  shell.classList.remove("drop-before", "drop-after", "drop-child", "drop-column-side");
  if (columnDropIndicator?.slot && !columnDropIndicator.slot.contains(related)) {
    columnDropIndicator.slot.classList.remove("drop-column");
    columnDropIndicator = null;
  }
}

function handleDrop(event: DragEvent) {
  event.preventDefault();
  const files = event.dataTransfer?.files ? [...event.dataTransfer.files] : [];
  if (files.length) {
    blockSurface.classList.remove("media-drop-active");
    clearDropIndicator();
    draggingBlockId = null;
    draggingColumn = null;
    void insertMediaFiles(files);
    return;
  }
  if (draggingColumn && columnDropIndicator && state) {
    const { containerId, column } = columnDropIndicator;
    const from = draggingColumn.column;
    draggingColumn = null;
    clearDropIndicator();
    reorderColumns(containerId, from, column);
    return;
  }
  if (draggingBlockId && columnDropIndicator && state) {
    const targetColumn = columnDropIndicator.column;
    const block = state.blocks.find(candidate => candidate.id === draggingBlockId);
    const container = state.blocks.find(candidate => candidate.id === columnDropIndicator!.containerId && candidate.properties.layout === "columns");
    const row = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(draggingBlockId)}"]`);
    if (block && container && row && !isDescendant(block.id, container.id)) {
      const oldContainer = columnAncestor(block);
      const oldColumn = oldContainer ? columnIndex(block) : undefined;
      const oldParent = block.parentId;
      block.parentId = container.id;
      block.properties = { ...block.properties, column: targetColumn };
      row.dataset.parentId = container.id;
      row.dataset.column = String(targetColumn);
      draggingBlockId = null;
      clearDropIndicator();
      if (oldContainer && oldContainer.id !== container.id) removeEmptyColumnContainers();
      if (oldContainer) normalizeSiblingPositions(oldContainer.id, oldColumn);
      else normalizeSiblingPositions(oldParent);
      normalizeSiblingPositions(container.id, targetColumn);
      state.blocks = orderBlockTree(state.blocks);
      renderAllPanels();
      recalculateDepths();
      scheduleDocumentSave(0);
      return;
    }
  }
  if (!draggingBlockId || !dropIndicator || !state) {
    clearDropIndicator();
    draggingBlockId = null;
    return;
  }
  const { targetId, position } = dropIndicator;
  if (targetId === draggingBlockId) {
    clearDropIndicator();
    draggingBlockId = null;
    return;
  }

  const rows = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")];
  const draggedIdx = rows.findIndex(r => r.dataset.id === draggingBlockId);
  const targetIdx = rows.findIndex(r => r.dataset.id === targetId);
  const draggedRow = rows[draggedIdx];
  const targetRow = rows[targetIdx];
  const draggedBlock = state.blocks.find(block => block.id === draggingBlockId);
  const targetBlock = state.blocks.find(block => block.id === targetId);
  if (!draggedRow || !targetRow) {
    clearDropIndicator();
    draggingBlockId = null;
    return;
  }

  if ((position === "column-left" || position === "column-right") && draggedBlock && targetBlock) {
    const oldContainer = columnAncestor(draggedBlock);
    const oldColumn = oldContainer ? columnIndex(draggedBlock) : undefined;
    const oldParent = draggedBlock.parentId;
    const targetContainer = columnAncestor(targetBlock);
    if (targetContainer) {
      const targetColumn = columnIndex(targetBlock);
      const nextColumn = position === "column-left" ? targetColumn : targetColumn + 1;
      const count = Math.max(2, Number(targetContainer.properties.columnCount ?? 2));
      targetContainer.properties = { ...targetContainer.properties, columnCount: Math.min(6, Math.max(count, nextColumn + 1)) };
      draggedBlock.parentId = targetContainer.id;
      draggedBlock.properties = { ...draggedBlock.properties, column: Math.min(5, nextColumn) };
    } else {
      const container = createBlock("paragraph", targetBlock.parentId);
      container.position = targetBlock.position;
      container.properties = { layout: "columns", columnCount: 2, columnGap: "16px" };
      targetBlock.parentId = container.id;
      targetBlock.properties = { ...targetBlock.properties, column: position === "column-left" ? 1 : 0 };
      draggedBlock.parentId = container.id;
      draggedBlock.properties = { ...draggedBlock.properties, column: position === "column-left" ? 0 : 1 };
      state.blocks.push(container);
    }
    if (oldContainer) normalizeSiblingPositions(oldContainer.id, oldColumn);
    else normalizeSiblingPositions(oldParent);
    removeEmptyColumnContainers();
    normalizeSiblingPositions(draggedBlock.parentId, draggedBlock.properties.column as number);
    normalizeSiblingPositions(targetBlock.parentId, targetBlock.properties.column as number);
    state.blocks = orderBlockTree(state.blocks);
    renderAllPanels();
    scheduleDocumentSave(0);
    clearDropIndicator();
    draggingBlockId = null;
    return;
  }

  if (draggedBlock && targetBlock) {
    const oldParentId = draggedBlock.parentId;
    const targetContainer = targetBlock.properties.layout === "columns" ? targetBlock : columnAncestor(targetBlock);
    const newParentId = targetContainer ? targetContainer.id : null;
    const targetColumn = targetContainer
      ? (targetBlock.properties.layout === "columns" ? 0 : columnIndex(targetBlock))
      : undefined;
    draggedBlock.parentId = newParentId;
    if (targetContainer) draggedBlock.properties = { ...draggedBlock.properties, column: targetColumn };
    else clearColumnPlacement(draggedBlock);

    const siblings = state.blocks
      .filter(block => block.parentId === newParentId && block.id !== draggedBlock.id &&
        (targetColumn === undefined || columnIndex(block) === targetColumn))
      .sort((left, right) => left.position.localeCompare(right.position) || left.id.localeCompare(right.id));
    let insertion = siblings.length;
    if (position !== "child") {
      const targetIndex = siblings.findIndex(block => block.id === targetBlock.id);
      insertion = Math.max(0, targetIndex + (position === "after" ? 1 : 0));
    }
    siblings.splice(Math.min(insertion, siblings.length), 0, draggedBlock);
    siblings.forEach((block, index) => { block.position = String((index + 1) * 1000).padStart(8, "0"); });
    if (oldParentId !== newParentId) normalizeSiblingPositions(oldParentId);
    removeEmptyColumnContainers();
  }

  // Rebuild the visual order from the normalized tree. This prevents a later
  // ACK/refresh from restoring the old position that the temporary DOM move used.
  state.blocks = orderBlockTree(state.blocks);
  renderAllPanels();

  recalculateDepths();
  scheduleDocumentSave(0);
  clearDropIndicator();
  draggingBlockId = null;
}

function handleDragEnd() {
  blockSurface.classList.remove("media-drop-active");
  clearDropIndicator();
  document.querySelectorAll(".column-grip").forEach(el => el.classList.remove("is-dragging"));
  draggingColumn = null;
  document.querySelectorAll(".block-shell").forEach(el => el.classList.remove("is-dragging"));
  draggingBlockId = null;
}

// Register drag events on block surface (delegated)
blockSurface.addEventListener("dragstart", handleDragStart as EventListener);
blockSurface.addEventListener("dragover", handleDragOver as EventListener);
blockSurface.addEventListener("dragleave", handleDragLeave as EventListener);
blockSurface.addEventListener("drop", handleDrop as EventListener);
blockSurface.addEventListener("dragend", handleDragEnd);

void host.request("ready", {}).catch(showError);
function clear() {
  state = null;
  activeEditable = null;
  sidebarLink = null;
  sidebarSequence++;
  dismissPreview();
  hideInlineLinkSuggestions();
  titleInput.value = "";
  blockSurface.replaceChildren();
  backlinksPanel.replaceChildren();
  noticesPanel.replaceChildren();
  referenceSidebarPanel.replaceChildren();
  editGroup = newId();
  ui.updateHistory?.({ documentId: "", entries: [], currentId: "", canUndo: false, canRedo: false });
  saveStatus.textContent = "请选择或新建笔记";
}
return {
  flush: async () => { await historyTail; await flush(); },
  showError,
  focusBlock,
  clear,
  undo: () => moveHistory("undo"),
  redo: () => moveHistory("redo"),
  restoreHistory,
  retry: () => { saveFailure = null; commandFailure = null; enqueueDocumentSave(); },
  load: render
};
}
