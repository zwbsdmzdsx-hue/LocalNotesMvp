import { queryLinkSuggestions, headingInfo, headingSection, type LinkSuggestion } from "./link-suggestions";
import { sanitizeHtml, editableContent } from "./block-content";
import type { BlockType, BlockContent, BlockProperties, Block, BlockComment, LinkToken, Note, Backlink, OverrideNotice, ReferenceOverride, ReferenceMode, ReferenceInstance, ReferenceTargetScope, EditorState, SaveMutation, RequestMap, StyleSheet, MediaAsset, MediaKind, DatabaseField, DatabaseSource, DatabaseRecord, DatabaseValue } from "../../protocol/types";
import type { EditorHostApi } from "./editor-host-api";
import type { HistoryModel } from "./history";
import { orderBlockTree } from "./block-tree";
import { markdownFromContent, markdownFromHtml, plainTextFromContent, renderMarkdown } from "./markdown";
import { parseDql, executeDql } from "./database-query";
import { LocationManager, renderLocationMap } from "./location-manager";
import type { SurfaceKind } from "./panel-context";

// The existing renderer and editing operations are shared by browser and desktop.
export function mountEditor(host: EditorHostApi, ui: {
  showReferences?(): void;
  showLocations?(): void;
  showHistory?(): void;
  setDatabaseContext?(visible: boolean, activate?: boolean): void;
  updateHistory?(model: HistoryModel): void;
  canvasUndo?(): void;
  canvasRedo?(): void;
  canvasStateChanged?(state: EditorState, persist: boolean): void;
  canvasInsertCalendarLink?(targetDocumentId: string, targetBlockId?: string, targetScope?: ReferenceTargetScope, label?: string): boolean;
  canvasInsertLocationBlock?(locationId: string): boolean;
  surfaceStateChanged?(state: EditorState, surface: SurfaceKind): void;
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
const commentsPanel = getSlot("comments") as HTMLDivElement;
const stylesPanel = getSlot("styles") as HTMLDivElement;
const databasesPanel = getSlot("databases") as HTMLDivElement;
const locationsPanel = getSlot("locations") as HTMLDivElement;
const editorElement = document.querySelector<HTMLElement>(".editor")!;
type EditorMode = "rich" | "source" | "preview";
let editorMode = (localStorage.getItem("lnm-editor-mode") as EditorMode | null) ?? "rich";
if (!["rich", "source", "preview"].includes(editorMode)) editorMode = "rich";
let stylePanelScope: "system" | "document" | "notebook" = "document";
// The shell owns section visibility and tab selection. The core renders slot contents only.
let state: EditorState | null = null;
// Canvas reuses the document-shaped state for the right sidebar. Its layout
// and history are persisted by CanvasManager, so shared document saves/history
// must stay disabled while this context is active.
let canvasContext = false;
const locationManager = new LocationManager({
  panel: locationsPanel,
  getState: () => state ? { locations: state.locations ?? [], locationVersion: state.locationVersion ?? 0, notebookId: state.note.workspaceId } : null,
  execute: (command, label) => executeLocationCommand(command, label).then(() => undefined),
  insert: locationId => insertLocationBlock(locationId),
  onError: showError
});
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
let lastEditorCaret: { editable: HTMLElement; range: Range } | null = null;
let activeBlock: HTMLElement | null = null;
// Keep the last valid rich-text range while the style panel is clicked. Browsers may
// collapse the native selection when focus moves to a sidebar button, even when the
// button prevents its default mousedown behavior. The remembered range is refreshed
// only by a valid editor selection and is cleared when the document changes.
let styleSelection: { editable: HTMLElement; endEditable: HTMLElement; range: Range; blockId: string; endBlockId: string; start: TextSelectionEndpoint; end: TextSelectionEndpoint } | null = null;
type TextSelectionEndpoint = { node: Node; offset: number; editable: HTMLElement };
let crossBlockSelection: { start: TextSelectionEndpoint; end: TextSelectionEndpoint; pointerId: number; active: boolean } | null = null;
let linkMenuItems: LinkSuggestion[] = [];
let linkMenuIndex = 0;
let linkMenuStage: "notebook" | "document" | "block" = "notebook";
let linkMenuTrail: string[] = [];
const sidebarCollapsedIds = new Set<string>();

// Drag & drop state
let draggingBlockId: string | null = null;
let draggingBlockIds: string[] = [];
let dropIndicator: { targetId?: string; groupId?: string; position: "before" | "after" | "child" | "column-left" | "column-right" | "group-before" | "group-after" } | null = null;
let draggingColumnGroup: string | null = null;
let draggingColumn: { containerId: string; column: number } | null = null;
let columnDropIndicator: { containerId: string; column: number; slot: HTMLElement } | null = null;
let mediaResize: { blockId: string; startX: number; startWidth: number; containerWidth: number } | null = null;
const selectedBlockIds = new Set<string>();
let blockSelectionDrag: { pointerId: number; active: boolean; startId: string } | null = null;

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
  if (canvasContext) ui.canvasStateChanged?.(state, false);
  // For text-edit commands, restore caret. For structural commands we don't restore —
  // structural changes inherently move focus and re-render is correct.
  if (sourceType === "saveOverride" || sourceType === "saveInstanceBlock") restoreCaret(caret);
  publishHistory();
  saveStatus.textContent = "已同步本地数据库";
}

function moveHistory(direction: "undo" | "redo") { return runHistory("history-" + direction); }
function restoreHistory(id: string) { return runHistory("history-restore", id); }
function runHistory(operation: string, entryId?: string) {
  if (canvasContext) {
    if (operation === "history-undo") ui.canvasUndo?.();
    else if (operation === "history-redo") ui.canvasRedo?.();
    return Promise.resolve();
  }
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
function caretRangeAtPoint(x: number, y: number): Range | null {
  const documentWithCaret = document as Document & {
    caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null;
    caretPositionFromPoint?: (clientX: number, clientY: number) => { offsetNode: Node; offset: number } | null;
  };
  if (documentWithCaret.caretRangeFromPoint) return documentWithCaret.caretRangeFromPoint(x, y);
  const position = documentWithCaret.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}
function textSelectionEndpointAtPoint(x: number, y: number): TextSelectionEndpoint | null {
  const range = caretRangeAtPoint(x, y);
  if (!range) return null;
  const editable = editableForSelectionNode(range.startContainer);
  if (!editable || !editable.isConnected) return null;
  return { node: range.startContainer, offset: range.startOffset, editable };
}
function selectedEditableRanges(start: TextSelectionEndpoint, end: TextSelectionEndpoint): Range[] {
  const editables = [...blockSurface.querySelectorAll<HTMLElement>(".block-text.rich-editor")];
  const startIndex = editables.indexOf(start.editable);
  const endIndex = editables.indexOf(end.editable);
  if (startIndex < 0 || endIndex < 0) return [];
  const forward = startIndex < endIndex || (startIndex === endIndex && (
    start.node === end.node
      ? start.offset <= end.offset
      : Boolean(start.node.compareDocumentPosition(end.node) & Node.DOCUMENT_POSITION_FOLLOWING)
  ));
  return editables.slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1).map(editable => {
    const range = document.createRange();
    range.selectNodeContents(editable);
    if (editable === start.editable) {
      if (forward) range.setStart(start.node, start.offset);
      else range.setEnd(start.node, start.offset);
    }
    if (editable === end.editable) {
      if (forward) range.setEnd(end.node, end.offset);
      else range.setStart(end.node, end.offset);
    }
    return range;
  }).filter(range => !range.collapsed);
}
function clearCrossBlockHighlight() {
  const registry = (CSS as typeof CSS & { highlights?: { delete(name: string): boolean } }).highlights;
  registry?.delete("cross-block-selection");
}
function renderCrossBlockHighlight(start: TextSelectionEndpoint, end: TextSelectionEndpoint) {
  const registry = (CSS as typeof CSS & { highlights?: { set(name: string, value: unknown): void } }).highlights;
  const HighlightConstructor = (window as typeof window & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !HighlightConstructor) return;
  registry.set("cross-block-selection", new HighlightConstructor(...selectedEditableRanges(start, end)));
}
function clearBlockSelection() {
  selectedBlockIds.clear();
  blockSurface.querySelectorAll<HTMLElement>("[data-own-block].block-selected").forEach(shell => shell.classList.remove("block-selected"));
}
function setCrossBlockSelection(start: TextSelectionEndpoint, end: TextSelectionEndpoint) {
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  const range = document.createRange();
  try {
    const order = start.node === end.node
      ? start.offset <= end.offset
      : Boolean(start.node.compareDocumentPosition(end.node) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (order) {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } else {
      range.setStart(end.node, end.offset);
      range.setEnd(start.node, start.offset);
    }
    selection.addRange(range);
    // Keep the anchor/focus direction for reverse drags. The range itself is
    // normalized by the DOM, but the direction determines each block's edge.
    selection.setBaseAndExtent?.(start.node, start.offset, end.node, end.offset);
  } catch {
    // A browser may reject a range that crosses editable roots. The native
    // selection remains intact in that case.
  }
}
function beginCrossBlockSelection(event: PointerEvent) {
  if (event.button !== 0 || editorMode !== "rich") return;
  const target = event.target as HTMLElement | null;
  const shell = target?.closest<HTMLElement>("[data-own-block]");
  if (shell && !target?.closest(".block-text.rich-editor") && !target?.closest("a,button,input,video,audio,.media-name")) {
    clearBlockSelection();
    blockSelectionDrag = { pointerId: event.pointerId, active: false, startId: shell.dataset.id! };
    updateBlockSelectionAtPoint(event.clientX, event.clientY);
    event.preventDefault();
    return;
  }
  const editable = target?.closest<HTMLElement>(".block-text.rich-editor");
  if (!editable || target?.closest("a,button,input,video,audio")) return;
  clearBlockSelection();
  const endpoint = textSelectionEndpointAtPoint(event.clientX, event.clientY);
  if (!endpoint || endpoint.editable !== editable) return;
  clearCrossBlockHighlight();
  crossBlockSelection = { start: endpoint, end: endpoint, pointerId: event.pointerId, active: false };
}
function updateBlockSelectionAtPoint(x: number, y: number) {
  const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-own-block]");
  if (!target?.dataset.id) return;
  const shells = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")];
  const startIndex = shells.findIndex(shell => shell.dataset.id === blockSelectionDrag?.startId);
  const endIndex = shells.indexOf(target);
  if (startIndex < 0 || endIndex < 0) return;
  const first = Math.min(startIndex, endIndex);
  const last = Math.max(startIndex, endIndex);
  shells.slice(first, last + 1).forEach(shell => {
    if (shell.dataset.id) selectedBlockIds.add(shell.dataset.id);
    shell.classList.add("block-selected");
  });
}
function selectBlockRange(startId: string, endId: string) {
  const shells = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")];
  const startIndex = shells.findIndex(shell => shell.dataset.id === startId);
  const endIndex = shells.findIndex(shell => shell.dataset.id === endId);
  if (startIndex < 0 || endIndex < 0) return;
  const first = Math.min(startIndex, endIndex);
  const last = Math.max(startIndex, endIndex);
  selectedBlockIds.clear();
  shells.forEach(shell => shell.classList.remove("block-selected"));
  shells.slice(first, last + 1).forEach(shell => {
    const id = shell.dataset.id;
    if (!id) return;
    selectedBlockIds.add(id);
    shell.classList.add("block-selected");
  });
}
function updateCrossBlockSelection(event: PointerEvent) {
  const drag = crossBlockSelection;
  if (!drag && blockSelectionDrag?.pointerId === event.pointerId && (event.buttons & 1)) {
    updateBlockSelectionAtPoint(event.clientX, event.clientY);
    blockSelectionDrag.active = true;
    event.preventDefault();
    return;
  }
  if (!drag || drag.pointerId !== event.pointerId || !(event.buttons & 1)) return;
  const endpoint = textSelectionEndpointAtPoint(event.clientX, event.clientY);
  if (!endpoint || endpoint.editable === drag.start.editable) return;
  drag.end = endpoint;
  const startShell = drag.start.editable.closest<HTMLElement>("[data-own-block]");
  const endShell = endpoint.editable.closest<HTMLElement>("[data-own-block]");
  if (startShell?.dataset.id && endShell?.dataset.id) selectBlockRange(startShell.dataset.id, endShell.dataset.id);
  setCrossBlockSelection(drag.start, endpoint);
  renderCrossBlockHighlight(drag.start, endpoint);
  drag.active = true;
  event.preventDefault();
}
function finishCrossBlockSelection(event: PointerEvent) {
  if (blockSelectionDrag?.pointerId === event.pointerId) {
    if (blockSelectionDrag.active || selectedBlockIds.size) {
      document.querySelectorAll<HTMLElement>("[data-own-block]").forEach(shell => shell.classList.toggle("block-selected", Boolean(shell.dataset.id && selectedBlockIds.has(shell.dataset.id))));
      activeBlock = document.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape([...selectedBlockIds][0] ?? "")}"]`);
      saveStatus.textContent = `已选择 ${selectedBlockIds.size} 个块`;
      event.preventDefault();
    }
    blockSelectionDrag = null;
    return;
  }
  const drag = crossBlockSelection;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (drag.active) {
    event.preventDefault();
    setCrossBlockSelection(drag.start, drag.end);
    rememberStyleSelection();
  }
  crossBlockSelection = null;
}
function rememberStyleSelection() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) {
    return;
  }
  const anchorEditable = editableForSelectionNode(selection.anchorNode);
  const focusEditable = editableForSelectionNode(selection.focusNode);
  if (!anchorEditable || !focusEditable) {
    return;
  }
  const range = selection.getRangeAt(0).cloneRange();
  const editable = editableForSelectionNode(range.startContainer);
  const endEditable = editableForSelectionNode(range.endContainer);
  if (!editable || !endEditable) return;
  const own = editable.closest<HTMLElement>("[data-own-block]");
  const endOwn = endEditable.closest<HTMLElement>("[data-own-block]");
  if (!own?.dataset.id || !endOwn?.dataset.id) {
    return;
  }
  const startEditable = editableForSelectionNode(selection.anchorNode) ?? editable;
  const finishEditable = editableForSelectionNode(selection.focusNode) ?? endEditable;
  const start = { node: selection.anchorNode, offset: selection.anchorOffset, editable: startEditable };
  const end = { node: selection.focusNode, offset: selection.focusOffset, editable: finishEditable };
  const startOwn = startEditable.closest<HTMLElement>("[data-own-block]");
  const finishOwn = finishEditable.closest<HTMLElement>("[data-own-block]");
  if (!startOwn?.dataset.id || !finishOwn?.dataset.id) return;
  styleSelection = { editable: startEditable, endEditable: finishEditable, range, blockId: startOwn.dataset.id, endBlockId: finishOwn.dataset.id, start, end };
}

function rememberEditorCaret() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !selection.anchorNode) return;
  const editable = editableForSelectionNode(selection.anchorNode);
  if (!editable || !editable.matches(".block-text[contenteditable='true'], .block-text.markdown-source")) return;
  lastEditorCaret = { editable, range: selection.getRangeAt(0).cloneRange() };
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
  const currentEndBlock = remembered?.endEditable.closest<HTMLElement>("[data-own-block]");
  if (!remembered || !remembered.editable.isConnected || !remembered.endEditable.isConnected ||
      currentOwnBlock?.dataset.id !== remembered.blockId || currentEndBlock?.dataset.id !== remembered.endBlockId) {
    saveStatus.textContent = "请先在正文中选中内容";
    return;
  }
  const range = remembered.range.cloneRange();
  const startBlock = remembered.start.editable;
  const endBlock = remembered.end.editable;
  const editables = [...blockSurface.querySelectorAll<HTMLElement>(".block-text.rich-editor")];
  const startIndex = editables.indexOf(remembered.editable);
  const endIndex = editables.indexOf(remembered.endEditable);
  if (startIndex < 0 || endIndex < 0) {
    saveStatus.textContent = "请重新选择正文内容";
    return;
  }
  const firstIndex = Math.min(startIndex, endIndex);
  const lastIndex = Math.max(startIndex, endIndex);
  const selectedEditables = editables.slice(firstIndex, lastIndex + 1);
  const forward = startIndex < endIndex || (startIndex === endIndex && (
    remembered.start.node === remembered.end.node
      ? remembered.start.offset <= remembered.end.offset
      : Boolean(remembered.start.node.compareDocumentPosition(remembered.end.node) & Node.DOCUMENT_POSITION_FOLLOWING)
  ));
  selectedEditables.forEach((editable) => {
    const local = document.createRange();
    local.selectNodeContents(editable);
    if (editable === startBlock) {
      if (forward) local.setStart(remembered.start.node, remembered.start.offset);
      else local.setEnd(remembered.start.node, remembered.start.offset);
    }
    if (editable === endBlock) {
      if (forward) local.setEnd(remembered.end.node, remembered.end.offset);
      else local.setStart(remembered.end.node, remembered.end.offset);
    }
    if (local.collapsed) return;
    const selectedElement = local.commonAncestorContainer instanceof Element
      ? local.commonAncestorContainer.closest<HTMLElement>(`.${CSS.escape(className)}`)
      : local.commonAncestorContainer.parentElement?.closest<HTMLElement>(`.${CSS.escape(className)}`);
    if (selectedElement && selectedElement.contains(local.startContainer) && selectedElement.contains(local.endContainer)) {
      selectedElement.classList.add(className);
    } else {
      const fragment = local.extractContents();
      const wrapper = document.createElement("span");
      wrapper.className = className;
      wrapper.append(fragment);
      local.insertNode(wrapper);
    }
    editable.dispatchEvent(new Event("input", { bubbles: true }));
  });
  remembered.editable.focus({ preventScroll: true });
  remembered.editable.dispatchEvent(new Event("input", { bubbles: true }));
  saveStatus.textContent = `已应用 .${className}`;
  clearCrossBlockHighlight();
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
  const styles = [...(state?.systemStyles ?? []), ...(state?.notebookStyles ?? []), ...(state?.documentStyles ?? [])].filter(style => style.enabled && style.css.trim());
  styles.forEach(style => { const tag = document.createElement("style"); tag.dataset.managedStyle = style.id; tag.textContent = scopeCss(style.css, ".editor .block-text"); document.head.append(tag); });
}
function renderStyles() {
  if (!state || !stylesPanel) return;
  document.querySelectorAll<HTMLStyleElement>("style[data-style-preview]").forEach(el => el.remove());
  const list = stylePanelScope === "system"
    ? (state.systemStyles ?? [])
    : stylePanelScope === "notebook"
      ? (state.notebookStyles ?? [])
      : (state.documentStyles ?? []);
  stylesPanel.replaceChildren();
  const scope = document.createElement("div"); scope.className = "style-scope-switch";
  (["system", "notebook", "document"] as const).forEach(kind => { const button = document.createElement("button"); button.textContent = kind === "system" ? "系统" : kind === "notebook" ? "当前笔记本" : "当前文档"; button.className = stylePanelScope === kind ? "active" : ""; button.onclick = () => { stylePanelScope = kind; renderStyles(); }; scope.append(button); });
  stylesPanel.append(scope);
  const scopeLabel = stylePanelScope === "system" ? "系统" : stylePanelScope === "notebook" ? "笔记本" : "文档";
  const add = document.createElement("button"); add.className = "style-add"; add.textContent = `+ 新建${scopeLabel}样式`;
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

function downloadText(content: string, fileName: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
  const link = document.createElement("a"); link.href = url; link.download = fileName; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderDatabases() {
  if (!state || !databasesPanel) return;
  databasesPanel.replaceChildren();
  const activeId = activeBlock?.dataset.id;
  const block = activeId ? state.blocks.find(item => item.id === activeId) : undefined;
  if (!block || (block.type !== "database_table" && block.type !== "data_view")) {
    ui.setDatabaseContext?.(false);
    return;
  }
  const database = databaseForBlock(block);
  if (!database) {
    ui.setDatabaseContext?.(false);
    return;
  }
  ui.setDatabaseContext?.(true);
  const sources = state.databases ?? [];
  const panel = document.createElement("section");
  panel.className = "database-context-panel";
  const heading = document.createElement("div");
  heading.className = "database-context-heading";
  const headingText = document.createElement("strong");
  headingText.textContent = block.type === "data_view" ? "查询视图属性" : "数据表属性";
  const count = document.createElement("span");
  count.textContent = `${database.recordCount} 条记录`;
  heading.append(headingText, count);
  panel.append(heading);

  if (block.type === "data_view") {
    const source = document.createElement("div");
    source.className = "database-context-source";
    source.textContent = `数据源 · ${database.title}`;
    const query = document.createElement("textarea");
    query.className = "database-context-query";
    query.value = block.properties.dataQuery ?? "FROM current";
    query.setAttribute("aria-label", "DQL 查询");
    const refresh = document.createElement("button");
    refresh.textContent = "保存并刷新";
    refresh.onclick = () => {
      block.properties = { ...block.properties, dataQuery: query.value };
      renderAllPanels();
      scheduleDocumentSave(0);
    };
    panel.append(source, query, refresh);
    databasesPanel.append(panel);
    return;
  }

  const titleLabel = document.createElement("label");
  titleLabel.className = "database-context-control";
  const titleCaption = document.createElement("span");
  titleCaption.textContent = "数据表名称";
  const title = document.createElement("input");
  title.value = database.title;
  title.placeholder = "数据表名称";
  title.setAttribute("aria-label", "数据表名称");
  titleLabel.append(titleCaption, title);
  panel.append(titleLabel);

  const fields = document.createElement("div");
  fields.className = "database-context-fields";
  const drafts = database.fields.map(field => ({ ...field }));
  const addControl = (container: HTMLElement, caption: string, control: HTMLElement) => {
    const label = document.createElement("label");
    label.className = "database-context-control";
    const text = document.createElement("span");
    text.textContent = caption;
    label.append(text, control);
    container.append(label);
  };
  const databaseSelect = (field: DatabaseField) => {
    const select = document.createElement("select");
    for (const source of sources) {
      const option = document.createElement("option");
      option.value = source.id;
      option.textContent = source.title;
      option.selected = (field.relationDatabaseId ?? database.id) === source.id;
      select.append(option);
    }
    select.onchange = () => { field.relationDatabaseId = select.value || database.id; drawFields(); };
    return select;
  };
  const drawFields = () => {
    fields.replaceChildren();
    drafts.forEach((field, index) => {
      const details = document.createElement("details");
      details.className = "database-context-field";
      const summary = document.createElement("summary");
      const icon = document.createElement("span");
      icon.className = "database-field-icon";
      icon.textContent = databaseFieldMeta[field.type].icon;
      const fieldTitle = document.createElement("span");
      fieldTitle.textContent = field.title || "未命名字段";
      const fieldType = document.createElement("small");
      fieldType.textContent = databaseFieldMeta[field.type].label;
      summary.append(icon, fieldTitle, fieldType);
      details.append(summary);

      const body = document.createElement("div");
      body.className = "database-context-field-body";
      const name = document.createElement("input");
      name.value = field.title;
      name.oninput = () => { field.title = name.value; fieldTitle.textContent = name.value || "未命名字段"; };
      addControl(body, "字段名称", name);
      const key = document.createElement("input");
      key.value = field.key;
      key.oninput = () => field.key = key.value;
      addControl(body, "属性 key", key);
      const type = document.createElement("select");
      (Object.keys(databaseFieldMeta) as DatabaseField["type"][]).forEach(value => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = `${databaseFieldMeta[value].icon} ${databaseFieldMeta[value].label}`;
        option.selected = field.type === value;
        type.append(option);
      });
      type.onchange = () => { field.type = type.value as DatabaseField["type"]; drawFields(); };
      addControl(body, "字段类型", type);

      if (field.type === "formula" || field.type === "rule") {
        const formula = document.createElement("textarea");
        formula.value = field.formula ?? "";
        formula.placeholder = field.type === "rule" ? 'prop("状态") = "完成"' : 'prop("单价") * prop("数量")';
        formula.oninput = () => field.formula = formula.value;
        addControl(body, field.type === "rule" ? "规则表达式" : "公式表达式", formula);
      }
      if (field.type === "document_relation") {
        field.relationScope = "document";
        const hint = document.createElement("p");
        hint.className = "database-context-hint";
        hint.textContent = "关联当前笔记本中的文档；单元格保存稳定文档 ID。";
        body.append(hint);
      }
      if (field.type === "record_relation" || field.type === "rollup") {
        field.relationScope = "record";
        addControl(body, "关联数据表", databaseSelect(field));
      }
      if (field.type === "rollup") {
        const targetSource = sources.find(source => source.id === field.relationDatabaseId) ?? database;
        const targetField = document.createElement("select");
        for (const candidate of targetSource.fields) {
          const option = document.createElement("option");
          option.value = candidate.key;
          option.textContent = `${databaseFieldMeta[candidate.type].icon} ${candidate.title}`;
          option.selected = field.rollupFieldKey === candidate.key;
          targetField.append(option);
        }
        targetField.onchange = () => field.rollupFieldKey = targetField.value;
        addControl(body, "汇总字段", targetField);
        const operation = document.createElement("select");
        const rollupLabels: Record<NonNullable<DatabaseField["rollup"]>, string> = { count: "计数", sum: "求和", avg: "平均值", min: "最小值", max: "最大值", unique: "去重计数" };
        (Object.keys(rollupLabels) as NonNullable<DatabaseField["rollup"]>[]).forEach(value => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = rollupLabels[value];
          option.selected = (field.rollup ?? "count") === value;
          operation.append(option);
        });
        operation.onchange = () => field.rollup = operation.value as DatabaseField["rollup"];
        addControl(body, "计算方式", operation);
      }
      const remove = document.createElement("button");
      remove.className = "danger database-context-remove";
      remove.textContent = "删除字段";
      remove.onclick = () => {
        drafts.splice(index, 1);
        drafts.forEach((item, itemIndex) => item.position = String((itemIndex + 1) * 1000).padStart(8, "0"));
        drawFields();
      };
      body.append(remove);
      details.append(body);
      fields.append(details);
    });
  };
  drawFields();
  panel.append(fields);

  const actions = document.createElement("div");
  actions.className = "database-manager-actions";
  const add = document.createElement("button");
  add.textContent = "+ 添加字段";
  add.onclick = () => {
    drafts.push({ id: `field-${newId()}`, databaseId: database.id, key: `field_${drafts.length + 1}`, title: "新字段", type: "text", position: String((drafts.length + 1) * 1000).padStart(8, "0") });
    drawFields();
    fields.lastElementChild?.setAttribute("open", "");
  };
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = "保存属性";
  save.onclick = () => { void saveDatabaseFields(database, drafts, title.value.trim() || "未命名数据表"); };
  const exportButton = (csv: boolean) => {
    const button = document.createElement("button");
    button.textContent = csv ? "导出 CSV" : "导出 Markdown";
    button.onclick = () => {
      void host.executeCommand({ operation: csv ? "export-database-csv" : "export-database-markdown", databaseId: database.id }, state!.note.id)
        .then(result => { if (result.content) downloadText(result.content, result.fileName ?? `${database.title}.${csv ? "csv" : "md"}`, result.mimeType ?? "text/plain"); })
        .catch(showError);
    };
    return button;
  };
  actions.append(add, save, exportButton(false), exportButton(true));
  panel.append(actions);
  databasesPanel.append(panel);
}

function renderAllPanels() {
  if (!state) return;
  // Main area: diff the blockSurface (preserve focusable rows, replace structural diff).
  syncBlockSurface();
  // Right-side panels: each is a self-contained diff.
  renderRelations();
  syncBacklinks();
  syncNotices();
  renderComments();
  renderStyles();
  renderDatabases();
  locationManager.render();
  applyManagedStyles();
  if (openCommentBlockId) renderOpenCommentPopover();
  titleInput.value = state.note.title;
  ui.surfaceStateChanged?.(state, canvasContext ? "canvas" : "document");
}

function isEmbeddedReferenceBlock(block: Block) {
  if (!state || block.type !== "reference" || !block.parentId) return false;
  const parent = state.blocks.find(candidate => candidate.id === block.parentId);
  if (!parent) return false;
  return !!blockSurface.querySelector(`[data-reference-host-id="${CSS.escape(block.id)}"]`) ||
    parent.content.html?.includes(`data-reference-host-id="${block.id}"`) ||
    parent.content.markdown?.includes(`#^${block.id}`) || false;
}

function existingBlockShell(blockId: string, embedded: boolean) {
  const shells = [...blockSurface.querySelectorAll<HTMLElement>(`[data-own-block][data-id="${CSS.escape(blockId)}"]`)]
    .filter(shell => shell.dataset.id === blockId);
  if (!embedded || shells.length < 2) return shells.find(shell => shell.closest("[data-reference-host-id]")) ?? shells[0];
  // A stale root shell can survive a structural refresh while the canonical
  // shell is already mounted in its inline anchor. Keep the mounted shell and
  // remove every extra copy before the next drag/re-render can expose it.
  const mounted = shells.find(shell => shell.closest("[data-reference-host-id]")) ?? shells[0];
  shells.forEach(shell => { if (shell !== mounted) shell.remove(); });
  return mounted;
}

/** Diff the main block surface against current state.blocks. */
function syncBlockSurface() {
  if (!state) return;
  const groups = new Map<string, Block[]>();
  state.blocks.forEach(block => {
    if (!block.properties.columnGroup) return;
    const list = groups.get(block.properties.columnGroup) ?? [];
    list.push(block);
    groups.set(block.properties.columnGroup, list);
  });
  const groupedIds = new Set([...groups.values()].flat().map(block => block.id));
  const visibleBlocks = state.blocks.filter(block => !groupedIds.has(block.id));
  const visibleIds = new Set(visibleBlocks.map(block => block.id));
  blockSurface.querySelectorAll<HTMLElement>(":scope > [data-own-block]").forEach((shell) => {
    const id = shell.dataset.id!;
    if (!visibleIds.has(id)) shell.remove();
  });
  let prev: Element | null = null;
  for (const block of visibleBlocks) {
    const id = block.id;
    const embedded = isEmbeddedReferenceBlock(block);
    let existing = embedded
      ? existingBlockShell(id, true)
      : blockSurface.querySelector<HTMLElement>(`:scope > [data-own-block][data-id="${CSS.escape(id)}"]`);
    if (existing && (existing.dataset.editorMode !== editorMode || block.type === "database_table" || block.type === "data_view")) {
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
      existing.dataset.columnGroup = block.properties.columnGroup ?? "";
      const existingText = existing.querySelector<HTMLElement>(":scope > .block-row > .block-text");
      if (existingText) existingText.style.textAlign = block.properties.textAlign ?? "";
      syncBlockCommentBubble(existing, block);
      if (block.type === "location" && existing.dataset.locationSignature !== locationSignature(block) && !document.activeElement?.closest(".location-source")) {
        existing.querySelector<HTMLElement>(":scope > .block-row")?.replaceWith(createLocationRow(block));
        existing.dataset.locationSignature = locationSignature(block);
      }
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
      shell = existing;
    } else {
      shell = renderOwnBlockShell(block);
    }
    // An inline reference shell is owned by its anchor. It must not be moved
    // back to the root flow while syncing a dragged sibling block.
    if (embedded && shell.closest("[data-reference-host-id]")) continue;
    const nextSibling: Element | null = prev ? prev.nextElementSibling : blockSurface.firstElementChild;
    if (nextSibling !== shell) blockSurface.insertBefore(shell, nextSibling);
    prev = shell;
  }
  syncColumnGroups();
  mountEmbeddedReferences();
  applyHeadingCollapseVisibility();
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

function locationForBlock(block: Block) {
  return state?.locations?.find(location => location.id === block.properties.locationId);
}
function locationSignature(block: Block) {
  const location = locationForBlock(block);
  return JSON.stringify([editorMode, block.properties.locationId ?? "", block.properties.locationLabelOverride ?? "", location?.updatedAt ?? "", location?.deletedAt ?? ""]);
}

function renderLocationCard(block: Block, context = state) {
  const location = context?.locations?.find(location => location.id === block.properties.locationId);
  const card = document.createElement("figure");
  card.className = `location-card-body${location?.deletedAt ? " is-deleted" : ""}`;
  card.setAttribute("aria-label", location ? `位置：${location.name}` : "位置已删除");
  const head = document.createElement("div"); head.className = "location-body-head";
  const icon = document.createElement("span"); icon.className = "location-pin-icon"; icon.textContent = "📍";
  const title = document.createElement("strong"); title.textContent = block.properties.locationLabelOverride || location?.name || "位置已删除";
  head.append(icon, title); card.append(head);
  if (!location || location.deletedAt) {
    const missing = document.createElement("p"); missing.className = "location-missing"; missing.textContent = location ? "此位置已删除，可在地图管理中恢复" : `找不到位置 ${block.properties.locationId ?? ""}`; card.append(missing);
    return card;
  }
  const address = document.createElement("p"); address.className = "location-body-address"; address.textContent = location.address || "未填写地址";
  const coords = document.createElement("p"); coords.className = "location-body-coordinates"; coords.textContent = `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
  const map = document.createElement("div"); map.className = "location-body-map";
  card.append(address, coords, map);
  renderLocationMap(map, location);
  return card;
}

function createLocationRow(block: Block) {
  const row = document.createElement("div"); row.className = "block-row location-row";
  const grip = document.createElement("button"); grip.type = "button"; grip.className = "grip"; grip.setAttribute("aria-label", "位置块菜单"); grip.title = "位置块菜单"; grip.draggable = editorMode !== "preview"; grip.textContent = "⠿";
  if (editorMode === "source") {
    const source = document.createElement("pre"); source.className = "location-source"; source.contentEditable = "plaintext-only"; source.spellcheck = false; source.textContent = `\`\`\`localnotes-location\nid: ${block.properties.locationId ?? ""}\nlabel: ${block.properties.locationLabelOverride ?? ""}\n\`\`\``; source.addEventListener("input", () => scheduleDocumentSave()); row.append(grip, source);
  } else row.append(grip, renderLocationCard(block));
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "delete-block"; remove.title = "删除位置块"; remove.textContent = "×"; remove.disabled = editorMode === "preview"; remove.onclick = () => removeOwnBlock(row.closest<HTMLElement>("[data-own-block]"));
  row.append(remove); return row;
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
  shell.dataset.columnGroup = block.properties.columnGroup ?? "";
  shell.style.setProperty("--depth", String(blockDepth(block, state!.blocks)));
  if (block.type === "reference") {
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
  } else if (block.type === "location") {
    shell.append(createLocationRow(block));
  } else if (block.type === "database_table" || block.type === "data_view") {
    shell.append(createDatabaseRow(block));
  } else {
    shell.append(createEditableRow(block));
  }
  if (block.type === "location") shell.dataset.locationSignature = locationSignature(block);
  shell.addEventListener("pointerdown", () => activateOwnBlock(shell, true));
  shell.addEventListener("focusin", () => activateOwnBlock(shell, true));
  syncBlockCommentBubble(shell, block);
  return shell;
}

function activateOwnBlock(shell: HTMLElement, activateDatabase: boolean) {
  const changed = activeBlock !== shell;
  activeBlock = shell;
  if (changed) {
    renderComments();
    renderDatabases();
  }
  const block = state?.blocks.find(item => item.id === shell.dataset.id);
  if (activateDatabase && (block?.type === "database_table" || block?.type === "data_view"))
    ui.setDatabaseContext?.(true, true);
}

function commentsFor(block: Block): BlockComment[] {
  return Array.isArray(block.properties.comments) ? block.properties.comments : [];
}

function activeCommentsFor(block: Block) {
  return commentsFor(block).filter(comment => !comment.deletedAt);
}

function blockCommentSummary(block: Block) {
  const content = plainTextFromContent(block.content).replace(/\s+/g, " ").trim();
  if (content) return content.length > 54 ? `${content.slice(0, 54)}…` : content;
  if (block.type === "media") return block.content.media?.name || "媒体块";
  if (block.type === "location") return state?.locations?.find(location => location.id === block.properties.locationId)?.name || "位置块";
  if (block.type === "database_table") return "数据库表";
  if (block.type === "data_view") return "DQL 查询";
  if (block.type === "reference") return "引用块";
  return "空白块";
}

function formatCommentTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function commitBlockComments(block: Block, comments: BlockComment[]) {
  block.properties = { ...block.properties, comments };
  const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`);
  if (shell) syncBlockCommentBubble(shell, block);
  renderComments();
  refreshOpenCommentPopover(block.id);
  scheduleDocumentSave(0);
}

function addBlockComment(blockId: string, content: string) {
  const block = state?.blocks.find(item => item.id === blockId);
  const value = content.trim();
  if (!block || !value) return;
  const timestamp = new Date().toISOString();
  const id = `comment-${newId()}`;
  const comment: BlockComment = {
    id,
    content: value,
    createdAt: timestamp,
    updatedAt: timestamp,
    history: [{ id: `comment-history-${newId()}`, action: "created", content: value, timestamp }]
  };
  commitBlockComments(block, [...commentsFor(block), comment]);
}

function editBlockComment(blockId: string, commentId: string, content: string) {
  const block = state?.blocks.find(item => item.id === blockId);
  const value = content.trim();
  if (!block || !value) return;
  const timestamp = new Date().toISOString();
  const comments = commentsFor(block).map(comment => comment.id !== commentId || comment.deletedAt ? comment : {
    ...comment,
    content: value,
    updatedAt: timestamp,
    history: [...(comment.history ?? []), { id: `comment-history-${newId()}`, action: "edited" as const, content: value, timestamp }]
  });
  commitBlockComments(block, comments);
}

function deleteBlockComment(blockId: string, commentId: string) {
  const block = state?.blocks.find(item => item.id === blockId);
  if (!block) return;
  const timestamp = new Date().toISOString();
  const comments = commentsFor(block).map(comment => comment.id !== commentId || comment.deletedAt ? comment : {
    ...comment,
    deletedAt: timestamp,
    updatedAt: timestamp,
    history: [...(comment.history ?? []), { id: `comment-history-${newId()}`, action: "deleted" as const, content: comment.content, timestamp }]
  });
  commitBlockComments(block, comments);
}

function appendCommentComposer(container: HTMLElement, block: Block, autofocus = false) {
  const composer = document.createElement("div");
  composer.className = "comment-composer";
  const input = document.createElement("textarea");
  input.rows = 3;
  input.placeholder = "写下注释或评论…";
  input.setAttribute("aria-label", `为“${blockCommentSummary(block)}”添加注释`);
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "添加注释";
  add.disabled = true;
  input.addEventListener("input", () => { add.disabled = !input.value.trim(); });
  const submit = () => {
    if (!input.value.trim()) return;
    addBlockComment(block.id, input.value);
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submit(); }
  });
  composer.append(input, add);
  container.append(composer);
  if (autofocus) window.setTimeout(() => input.focus(), 0);
}

function appendCommentThread(container: HTMLElement, block: Block, includeComposer: boolean) {
  const active = activeCommentsFor(block);
  if (!active.length) {
    const empty = document.createElement("p");
    empty.className = "comment-empty";
    empty.textContent = "这个块当前没有注释。";
    container.append(empty);
  }
  for (const comment of active) {
    const item = document.createElement("article");
    item.className = "comment-item";
    item.dataset.commentId = comment.id;
    const content = document.createElement("p");
    content.className = "comment-content";
    content.textContent = comment.content;
    const meta = document.createElement("div");
    meta.className = "comment-meta";
    const time = document.createElement("time");
    time.dateTime = comment.updatedAt;
    time.textContent = formatCommentTime(comment.updatedAt);
    const actions = document.createElement("span");
    actions.className = "comment-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => {
      const editor = document.createElement("div");
      editor.className = "comment-inline-editor";
      const textarea = document.createElement("textarea");
      textarea.value = comment.content;
      textarea.rows = 3;
      textarea.setAttribute("aria-label", "编辑注释");
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "保存";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消";
      save.onclick = () => editBlockComment(block.id, comment.id, textarea.value);
      cancel.onclick = () => editor.replaceWith(content);
      editor.append(textarea, save, cancel);
      content.replaceWith(editor);
      textarea.focus();
      textarea.select();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除";
    remove.addEventListener("click", () => deleteBlockComment(block.id, comment.id));
    actions.append(edit, remove);
    meta.append(time, actions);
    item.append(content, meta);
    container.append(item);
  }

  const history = commentsFor(block).flatMap(comment => (comment.history?.length ? comment.history : [{
    id: `legacy-${comment.id}`,
    action: "created" as const,
    content: comment.content,
    timestamp: comment.createdAt
  }])).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  if (history.length) {
    const details = document.createElement("details");
    details.className = "comment-history";
    const summary = document.createElement("summary");
    summary.textContent = `注释历史 · ${history.length}`;
    details.append(summary);
    const labels = { created: "新增", edited: "编辑", deleted: "删除" } as const;
    for (const entry of history) {
      const row = document.createElement("div");
      row.className = `comment-history-entry action-${entry.action}`;
      const head = document.createElement("span");
      head.textContent = `${labels[entry.action]} · ${formatCommentTime(entry.timestamp)}`;
      const text = document.createElement("p");
      text.textContent = entry.content;
      row.append(head, text);
      details.append(row);
    }
    container.append(details);
  }
  if (includeComposer) appendCommentComposer(container, block);
}

let openCommentBlockId: string | null = null;
let commentPopoverPosition: { left: number; top: number } | null = null;
let commentPopoverListenerTimer: number | null = null;
function closeBlockCommentPopover() {
  document.querySelector(".block-comment-popover")?.remove();
  openCommentBlockId = null;
  commentPopoverPosition = null;
  if (commentPopoverListenerTimer !== null) window.clearTimeout(commentPopoverListenerTimer);
  commentPopoverListenerTimer = null;
  document.removeEventListener("pointerdown", dismissBlockCommentPopover, true);
}
function dismissBlockCommentPopover(event: PointerEvent) {
  const target = event.target as Element | null;
  if (target?.closest(".block-comment-popover, .block-comment-bubble")) return;
  closeBlockCommentPopover();
}
function renderOpenCommentPopover(anchor?: HTMLElement, autofocus = false) {
  if (!openCommentBlockId || !state) return;
  const block = state.blocks.find(item => item.id === openCommentBlockId);
  if (!block) { closeBlockCommentPopover(); return; }
  document.querySelector(".block-comment-popover")?.remove();
  const popover = document.createElement("section");
  popover.className = "block-comment-popover";
  popover.dataset.blockId = block.id;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "块注释");
  const head = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = blockCommentSummary(block);
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.title = "关闭";
  close.setAttribute("aria-label", "关闭注释窗口");
  close.onclick = closeBlockCommentPopover;
  head.append(title, close);
  popover.append(head);
  appendCommentThread(popover, block, true);
  document.body.append(popover);
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width));
    const top = Math.max(12, Math.min(window.innerHeight - Math.min(popover.offsetHeight, 420) - 12, rect.bottom + 6));
    commentPopoverPosition = { left, top };
  }
  if (commentPopoverPosition) {
    popover.style.left = `${commentPopoverPosition.left}px`;
    popover.style.top = `${commentPopoverPosition.top}px`;
  }
  document.removeEventListener("pointerdown", dismissBlockCommentPopover, true);
  if (commentPopoverListenerTimer !== null) window.clearTimeout(commentPopoverListenerTimer);
  commentPopoverListenerTimer = window.setTimeout(() => {
    document.addEventListener("pointerdown", dismissBlockCommentPopover, true);
    commentPopoverListenerTimer = null;
  }, 0);
  if (autofocus) window.setTimeout(() => popover.querySelector<HTMLTextAreaElement>(".comment-composer textarea")?.focus(), 0);
}
function showBlockCommentPopover(anchor: HTMLElement, block: Block, autofocus = false) {
  const current = document.querySelector<HTMLElement>(`.block-comment-popover[data-block-id="${CSS.escape(block.id)}"]`);
  if (current && !autofocus) { closeBlockCommentPopover(); return; }
  openCommentBlockId = block.id;
  renderOpenCommentPopover(anchor, autofocus);
}
function refreshOpenCommentPopover(blockId: string) {
  if (openCommentBlockId === blockId) renderOpenCommentPopover();
}

function syncBlockCommentBubble(shell: HTMLElement, block: Block) {
  const count = activeCommentsFor(block).length;
  let bubble = shell.querySelector<HTMLButtonElement>(":scope > .block-comment-bubble");
  shell.classList.toggle("has-comments", count > 0);
  if (!count) { bubble?.remove(); return; }
  if (!bubble) {
    bubble = document.createElement("button");
    bubble.type = "button";
    bubble.className = "block-comment-bubble";
    bubble.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const currentBlock = state?.blocks.find(item => item.id === block.id);
      if (currentBlock) showBlockCommentPopover(bubble!, currentBlock);
    });
    shell.append(bubble);
  }
  bubble.innerHTML = `<span aria-hidden="true">💬</span><span>${count}</span>`;
  bubble.title = `${count} 条注释`;
  bubble.setAttribute("aria-label", `查看 ${count} 条注释`);
}

function renderComments() {
  if (!state) return;
  commentsPanel.replaceChildren();
  const intro = document.createElement("p");
  intro.className = "comment-panel-intro";
  intro.textContent = "注释随块保存，并进入文档的撤销、重做和版本历史。";
  commentsPanel.append(intro);

  const activeId = activeBlock?.dataset.id;
  const current = activeId ? state.blocks.find(block => block.id === activeId) : undefined;
  if (current) {
    const currentCard = document.createElement("section");
    currentCard.className = "comment-current-card";
    const title = document.createElement("strong");
    title.textContent = `给当前块添加注释 · ${blockCommentSummary(current)}`;
    currentCard.append(title);
    appendCommentComposer(currentCard, current);
    commentsPanel.append(currentCard);
  } else {
    const hint = document.createElement("p");
    hint.className = "comment-empty";
    hint.textContent = "先在正文中点击一个块，即可从这里添加注释。";
    commentsPanel.append(hint);
  }

  const annotated = state.blocks.filter(block => commentsFor(block).length > 0);
  if (!annotated.length) {
    const empty = document.createElement("p");
    empty.className = "comment-empty";
    empty.textContent = "当前文档还没有注释。也可以从块的六点菜单添加。";
    commentsPanel.append(empty);
    return;
  }
  const heading = document.createElement("h3");
  heading.className = "comment-panel-heading";
  heading.textContent = `全部注释块 · ${annotated.length}`;
  commentsPanel.append(heading);
  for (const block of annotated) {
    const card = document.createElement("section");
    card.className = "comment-block-card";
    card.dataset.blockId = block.id;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "comment-block-link";
    open.textContent = blockCommentSummary(block);
    open.title = "定位到正文块";
    open.onclick = () => focusBlock(block.id);
    card.append(open);
    appendCommentThread(card, block, true);
    commentsPanel.append(card);
  }
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
function executeDatabaseCommand(command: { operation: string; [key: string]: unknown }, sourceType: string) {
  const owner = state?.note.id;
  if (!owner) return Promise.reject(new Error("文档尚未载入"));
  const previous = commandTail;
  const task = previous.catch(() => undefined).then(async () => {
    await new Promise<void>(resolve => runAfterSaveDrain(resolve));
    if (!state || state.note.id !== owner) throw new Error("文档已切换，请重试数据库操作。");
    const result = await host.executeCommand({ ...command, mutationId: newId(), clientVersion: state.note.clientVersion + 1 }, owner);
    applyServerState(result.state, sourceType);
    return result;
  });
  commandTail = task.then(() => undefined, error => { commandFailure = error; showError(error); });
  return task;
}
function executeLocationCommand(command: { operation: string; [key: string]: unknown }, sourceType: string) {
  const owner = state?.note.id;
  if (!owner) return Promise.reject(new Error("文档尚未载入"));
  const previous = commandTail;
  const task = previous.catch(() => undefined).then(async () => {
    await new Promise<void>(resolve => runAfterSaveDrain(resolve));
    if (!state || state.note.id !== owner) throw new Error("文档已切换，请重试位置操作。");
    const result = await host.executeCommand({ ...command, mutationId: newId(), expectedLocationVersion: state.locationVersion ?? 0 }, owner);
    applyServerState(result.state, sourceType);
    return result;
  });
  commandTail = task.then(() => undefined, error => { commandFailure = error; showError(error); });
  return task;
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
  if (canvasContext) {
    state.blocks = readOwnBlocks();
    // Canvas edits are optimistic and live in the same EditorState as the
    // document editor. Refresh every panel from that snapshot immediately so
    // dates, references, comments, styles and database context do not wait for
    // the Canvas save ACK before becoming visible in the right rail.
    renderAllPanels();
    ui.canvasStateChanged?.(state, true);
    return;
  }
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
  // Keep the panel context ahead of the save ACK. The queued snapshot is the
  // canonical optimistic state, so the calendar and the other right-side
  // panels can render a just-entered date/link without waiting for transport.
  renderAllPanels();
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
    const matches = [...value.matchAll(/\[\[([^\]|#]+)(?:#\^([^\]|]+)|#([^\]|]+))?(?:\|([^\]]+))?\]\]/g)];
    if (!matches.length) return;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    matches.forEach((match) => {
      fragment.append(value.slice(offset, match.index));
      const link = document.createElement("span");
      link.className = "wiki-link";
      link.contentEditable = "false";
      const title = match[1].trim();
      const blockId = match[2]?.trim();
      const heading = match[3]?.trim();
      link.dataset.title = title;
      if (blockId) link.dataset.targetBlockId = blockId;
      if (heading) {
        link.dataset.targetHeading = heading;
        link.dataset.targetScope = "heading";
      }
      link.textContent = (match[4] ?? (heading || title)).trim();
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
    const targetScope = link.dataset.targetScope as ReferenceTargetScope | undefined;
    const retained = fallbackLinks.find(candidate =>
      (!blockId || candidate.targetBlockId === blockId) &&
      (!targetScope || candidate.targetScope === targetScope) &&
      (candidate.targetText === title || state?.documents.find(document => document.id === candidate.targetDocumentId)?.title === title));
    const leafTitle = title.split("/").map(part => part.trim()).filter(Boolean).pop() ?? title;
    const document = state?.documents.find(candidate =>
      candidate.title === title || candidate.title === leafTitle || candidate.path === title || candidate.path?.endsWith(`/${title}`));
    const documentId = retained?.targetDocumentId ?? document?.id;
    if (documentId) link.dataset.targetId = documentId;
    if (retained?.targetBlockId) link.dataset.targetBlockId = retained.targetBlockId;
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

/**
 * Todo blocks have one canonical data representation (checked + body), while
 * their source representation uses the standard GFM task marker. Keep the
 * marker out of the rendered body so rich/preview modes do not show a second
 * checkbox for the same block.
 */
function todoBodyMarkdown(content: BlockContent) {
  const source = markdownFromContent(content).replace(/\r\n?/g, "\n");
  return source.replace(/^\s*[-*+]\s+\[[ xX]\]\s?/, "");
}

function todoMarkdownFromContent(content: BlockContent) {
  const body = todoBodyMarkdown(content);
  return `- [${content.checked ? "x" : " "}]${body ? ` ${body}` : ""}`;
}

function contentFromTodoMarkdown(source: string, fallback: BlockContent): BlockContent {
  const normalized = source.replace(/\r\n?/g, "\n");
  const firstLineEnd = normalized.indexOf("\n");
  const firstLine = firstLineEnd < 0 ? normalized : normalized.slice(0, firstLineEnd);
  const marker = firstLine.match(/^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/);
  const checked = marker ? marker[1].toLowerCase() === "x" : (fallback.checked ?? false);
  const body = marker ? [marker[2], ...normalized.split("\n").slice(1)].join("\n") : normalized;
  const content = contentFromMarkdown(body, fallback);
  return { ...content, checked, markdown: body };
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

type LinkDestination = { documentId: string; blockId?: string; targetScope?: ReferenceTargetScope; referenceId?: string; anchor: HTMLElement };
let sidebarLink: LinkDestination | null = null;
let sidebarSequence = 0;
let previewSequence = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function linkDestination(element: EventTarget | null): LinkDestination | null {
  const anchor = (element as HTMLElement | null)?.closest<HTMLElement>(".wiki-link, .reference-title");
  if (!anchor || !state) return null;
  const rawTitle = (anchor.dataset.targetTitle ?? anchor.dataset.title ?? "").trim();
  const leafTitle = rawTitle.split("/").map(part => part.trim()).filter(Boolean).pop() ?? rawTitle;
  const documentId = anchor.dataset.targetId ?? state.documents.find(item =>
    item.title === rawTitle || item.title === leafTitle || item.path === rawTitle || item.path?.endsWith(`/${rawTitle}`))?.id;
  return documentId ? { documentId, blockId: anchor.dataset.targetBlockId, targetScope: anchor.dataset.targetScope as ReferenceTargetScope | undefined, referenceId: anchor.dataset.referenceId, anchor } : null;
}

function ordinaryLinkFromDestination(target: LinkDestination): OrdinaryLinkSidebarEntry | null {
  const sourceBlockId = target.anchor.dataset.sourceBlockId
    ?? target.anchor.closest<HTMLElement>("[data-own-block]")?.dataset.id;
  if (!sourceBlockId) return null;
  const source = state?.blocks.find(block => block.id === sourceBlockId);
  return {
    key: `${sourceBlockId}:${target.documentId}:${target.blockId ?? ""}`,
    sourceBlockId,
    documentId: target.documentId,
    blockId: target.blockId,
    targetScope: target.targetScope,
    label: target.anchor.textContent?.trim() || state?.documents.find(document => document.id === target.documentId)?.title || target.documentId,
    excerpt: source?.content.text ?? ""
  };
}
function dismissPreview() {
  clearTimeout(previewTimer); previewSequence++;
  document.querySelector(".link-preview")?.remove();
}

function headingLevelFromMarkdown(content: BlockContent) {
  const line = markdownFromContent(content).split(/\r?\n/).find(value => value.trim()) ?? "";
  const match = line.match(/^\s*(#{1,6})[ \u3000]+/);
  return match ? match[1].length as 1 | 2 | 3 | 4 | 5 | 6 : undefined;
}

function headingLevel(block: Block) {
  return block.type === "heading"
    ? (block.properties.headingLevel ?? headingLevelFromMarkdown(block.content) ?? 1)
    : undefined;
}

/** Apply Obsidian-style section folding to each ordinary block flow. A heading
 * hides following blocks until the next heading at the same or shallower level. */
function applyHeadingCollapseVisibility() {
  if (!state) return;
  const containers: HTMLElement[] = [blockSurface,
    ...[...blockSurface.querySelectorAll<HTMLElement>(".column-track")]];
  containers.forEach(container => {
    let collapsedLevel: number | null = null;
    [...container.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches("[data-own-block]"))
      .forEach(shell => {
        const block = state!.blocks.find(item => item.id === shell.dataset.id);
        if (!block) return;
        const level = headingLevel(block);
        if (level !== undefined && collapsedLevel !== null && level <= collapsedLevel) collapsedLevel = null;
        const hidden = collapsedLevel !== null;
        shell.hidden = hidden;
        shell.classList.toggle("heading-section-hidden", hidden);
        const toggle = shell.querySelector<HTMLButtonElement>(":scope > .block-row > .heading-collapse-toggle");
        if (toggle && level !== undefined) {
          toggle.setAttribute("aria-expanded", String(!block.properties.headingCollapsed));
          toggle.textContent = block.properties.headingCollapsed ? "▸" : "▾";
          toggle.title = block.properties.headingCollapsed ? "展开标题内容" : "折叠标题内容";
          toggle.setAttribute("aria-label", toggle.title);
        }
        if (level !== undefined && !hidden && block.properties.headingCollapsed) collapsedLevel = level;
      });
  });
}

function toggleHeadingCollapse(block: Block, button: HTMLButtonElement) {
  if (block.type !== "heading") return;
  block.properties.headingCollapsed = !block.properties.headingCollapsed;
  button.setAttribute("aria-expanded", String(!block.properties.headingCollapsed));
  button.textContent = block.properties.headingCollapsed ? "▸" : "▾";
  applyHeadingCollapseVisibility();
  scheduleDocumentSave(0);
}
async function targetProjection(target: LinkDestination): Promise<ReferenceInstance> {
  const instance = state?.references.find(item => item.id === target.referenceId);
  if (instance) return instance;
  const source = await host.loadDocument(target.documentId);
  let blocks = source.blocks;
  if (target.blockId && target.targetScope === "heading") {
    blocks = headingSection(blocks, target.blockId);
  } else if (target.blockId) {
    const ids = new Set([target.blockId]);
    for (let count = -1; count !== ids.size;) {
      count = ids.size;
      blocks.forEach(block => { if (block.parentId && ids.has(block.parentId)) ids.add(block.id); });
    }
    blocks = blocks.filter(block => ids.has(block.id));
  }
  return { id: "link-preview", hostBlockId: "", targetDocumentId: target.documentId, targetBlockId: target.blockId, targetScope: target.targetScope, targetTitle: source.note.title, mode: "link", blocks, overrides: [], hiddenBlockIds: [], broken: !!target.blockId && blocks.length === 0 };
}
function readOnlyProjection(reference: ReferenceInstance, context = state) {
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
    paragraph.dataset.blockId = block.id;
    if (block.type === "location") {
      paragraph.append(renderLocationCard(block, context));
    } else if (block.type === "database_table" || block.type === "data_view") {
      paragraph.append(renderDatabaseTablePreview(block, {}, context));
    } else if (block.type === "media" && content.media) {
      paragraph.append(renderMediaPreview({ ...block, content }, true));
    } else {
      paragraph.innerHTML = block.type === "heading" && !/^\s*#{1,6}\s/.test(markdownFromContent(content))
        ? renderMarkdown("#".repeat(block.properties.headingLevel ?? 1) + " " + markdownFromContent(content))
        : content.markdown !== undefined
        ? markdownHtml(content.markdown, content.links)
        : renderLinkedHtml(content.html || escapeText(content.text));
    }
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
  const mode = document.createElement("button");
  mode.type = "button";
  mode.className = "link-display-mode";
  mode.textContent = "显示方式";
  mode.setAttribute("aria-label", "引用显示方式");
  mode.title = "选择引用显示方式";
  const ordinaryLink = !target.referenceId ? ordinaryLinkFromDestination(target) : null;
  if (ordinaryLink) {
    mode.onclick = event => {
      event.stopPropagation();
      sidebarLink = null;
      sidebarSequence++;
      showOrdinaryLinkModeMenu(mode, ordinaryLink);
    };
  } else mode.hidden = true;
  const close = document.createElement("button"); close.textContent = "×"; close.setAttribute("aria-label", "关闭分栏");
  close.onclick = () => { sidebarLink = null; sidebarSequence++; renderRelations(); };
  header.append(title, mode, close);
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
  // Ordinary [[...]] links are read-only navigation targets. New live
  // reference instances are not created from a secondary context menu.
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

function columnIndex(block: Block, fallback = 0) {
  const value = block.properties.column;
  return Number.isInteger(value) && value! >= 0 ? value! : fallback;
}

/** Convert the old hidden layout-block representation to ordinary blocks that
 * share a visual row identity. This keeps existing documents editable after
 * the column renderer was redesigned. */
function migrateLegacyColumns(blocks: Block[]) {
  const layouts = blocks.filter(block => block.properties.layout === "columns");
  if (!layouts.length) return blocks;
  const replacements = new Map<string, { group: string; parentId: string | null }>();
  for (const layout of layouts) {
    const group = `columns-${layout.id}`;
    for (const block of blocks) {
      if (block.id === layout.id) continue;
      let parent = block.parentId;
      const visited = new Set<string>();
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        if (parent === layout.id) {
          replacements.set(block.id, { group, parentId: layout.parentId });
          break;
        }
        parent = blocks.find(candidate => candidate.id === parent)?.parentId ?? null;
      }
    }
  }
  return blocks.filter(block => block.properties.layout !== "columns").map(block => {
    const replacement = replacements.get(block.id);
    if (!replacement) return block;
    const { column, columnCount: _count, columnGap: _gap, ...properties } = block.properties;
    return { ...block, parentId: replacement.parentId, properties: { ...properties, columnGroup: replacement.group, column: column ?? 0 } };
  });
}

function normalizeCanonicalBlockProperties(block: Block) {
  if (block.type === "heading") {
    const parsedLevel = headingLevelFromMarkdown(block.content);
    if (!block.properties.headingLevel) block.properties.headingLevel = parsedLevel ?? 1;
  }
  if (block.properties.columnGroup) {
    const { layout: _layout, columnCount: _count, columnGap: _gap, ...properties } = block.properties;
    block.properties = properties;
  }
  if (block.properties.databaseViewId) {
    const { databaseViewId: _view, ...properties } = block.properties;
    block.properties = properties;
  }
  return block;
}

function syncColumnGroups() {
  if (!state) return;
  const groups = new Map<string, Block[]>();
  for (const block of state.blocks) {
    const group = block.properties.columnGroup;
    if (!group) continue;
    const members = groups.get(group) ?? [];
    members.push(block);
    groups.set(group, members);
  }
  const desiredGroups = new Set(groups.keys());
  blockSurface.querySelectorAll<HTMLElement>(":scope > .columns-row").forEach(row => {
    if (!desiredGroups.has(row.dataset.columnGroup ?? "")) row.remove();
  });
  const rowByGroup = new Map<string, HTMLElement>();
  for (const [groupId, members] of groups) {
    let row = blockSurface.querySelector<HTMLElement>(`:scope > .columns-row[data-column-group="${CSS.escape(groupId)}"]`);
    if (!row) {
      row = document.createElement("div");
      row.className = "columns-row";
      row.dataset.columnGroup = groupId;
    }
    syncColumnGroupRow(row, groupId, members);
    rowByGroup.set(groupId, row);
  }
  // Rebuild the direct surface order from the persisted block order. A group is
  // represented by one row at its first member position; its members never also
  // remain as top-level shells.
  const emittedGroups = new Set<string>();
  const desired: Element[] = [];
  for (const block of state.blocks) {
    const groupId = block.properties.columnGroup;
    if (groupId) {
      if (emittedGroups.has(groupId)) continue;
      emittedGroups.add(groupId);
      const row = rowByGroup.get(groupId);
      if (row) desired.push(row);
    } else {
      const shell = blockSurface.querySelector<HTMLElement>(`:scope > [data-own-block][data-id="${CSS.escape(block.id)}"]`);
      if (shell) desired.push(shell);
    }
  }
  desired.forEach((element, index) => {
    if (blockSurface.children[index] !== element) blockSurface.insertBefore(element, blockSurface.children[index] ?? null);
  });
}

function syncColumnGroupRow(row: HTMLElement, groupId: string, members: Block[]) {
  const count = Math.max(2, ...members.map(block => columnIndex(block) + 1));
  const widths = members.find(block => block.properties.columnWidths)?.properties.columnWidths ?? Array.from({ length: count }, () => 1);
  const grid = row.querySelector<HTMLElement>(":scope > .columns-grid") ?? (() => {
    const element = document.createElement("div");
    element.className = "columns-grid";
    row.replaceChildren(element);
    return element;
  })();
  let rowGrip = row.querySelector<HTMLButtonElement>(":scope > .columns-row-grip");
  if (!rowGrip) {
    rowGrip = document.createElement("button");
    rowGrip.type = "button";
    rowGrip.className = "columns-row-grip grip";
    rowGrip.draggable = editorMode !== "preview";
    rowGrip.textContent = "⠿";
    rowGrip.title = "拖拽整组分列";
    rowGrip.setAttribute("aria-label", "拖拽整组分列");
    row.insertBefore(rowGrip, grid);
  } else rowGrip.draggable = editorMode !== "preview";
  const ordered = [...members].sort((left, right) => left.position.localeCompare(right.position) || left.id.localeCompare(right.id));
  const signature = `${editorMode}|${ordered.map(block => `${columnIndex(block)}:${block.id}`).join("|")}`;
  grid.style.gridTemplateColumns = widths.slice(0, count).flatMap((value, index) =>
    index < count - 1 ? [`minmax(0, ${Math.max(.2, value)}fr)`, "8px"] : [`minmax(0, ${Math.max(.2, value)}fr)`]
  ).join(" ");
  if (grid.dataset.signature === signature && grid.children.length) {
    ordered.forEach(block => {
      const shell = grid.querySelector<HTMLElement>(`.block-shell[data-id="${CSS.escape(block.id)}"]`);
      if (shell) syncBlockCommentBubble(shell, block);
    });
    return;
  }
  grid.dataset.signature = signature;
  grid.replaceChildren();
  for (let column = 0; column < count; column++) {
    const track = document.createElement("div");
    track.className = "column-track";
    track.dataset.column = String(column);
    const columnBlocks = ordered.filter(block => columnIndex(block) === column);
    for (const block of columnBlocks) {
      let shell = row.querySelector<HTMLElement>(`.block-shell[data-id="${CSS.escape(block.id)}"]`)
        ?? document.querySelector<HTMLElement>(`.block-shell[data-id="${CSS.escape(block.id)}"]`);
      if (shell && shell.dataset.editorMode !== editorMode) {
        shell.remove();
        shell = null;
      }
      shell ??= renderOwnBlockShell(block);
      shell.dataset.columnGroup = groupId;
      shell.dataset.column = String(column);
      shell.dataset.parentId = "";
      track.append(shell);
    }
    grid.append(track);
    if (column < count - 1) {
      const divider = document.createElement("button");
      divider.type = "button";
      divider.className = "column-divider";
      divider.dataset.column = String(column);
      divider.title = "拖拽调整两列宽度";
      divider.setAttribute("aria-label", `调整第 ${column + 1} 列宽度`);
      divider.addEventListener("pointerdown", event => beginColumnResize(event, groupId, column, row));
      grid.append(divider);
    }
  }
  const restore = row.querySelector<HTMLButtonElement>(":scope > .columns-restore");
  if (!restore) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "columns-restore";
    button.textContent = "↶";
    button.title = "还原为普通块";
    button.setAttribute("aria-label", "还原为普通块");
    button.addEventListener("click", () => restoreColumnGroup(groupId));
    row.append(button);
  }
}

let columnResize: { groupId: string; divider: number; startX: number; widths: number[]; handle: HTMLElement } | null = null;
function beginColumnResize(event: PointerEvent, groupId: string, divider: number, row: HTMLElement) {
  if (editorMode === "preview" || !state) return;
  const members = state.blocks.filter(block => block.properties.columnGroup === groupId);
  const count = Math.max(2, ...members.map(block => columnIndex(block) + 1));
  const widths = members.find(block => block.properties.columnWidths)?.properties.columnWidths?.slice() ?? Array.from({ length: count }, () => 1);
  const handle = event.currentTarget as HTMLElement;
  columnResize = { groupId, divider, startX: event.clientX, widths, handle };
  row.classList.add("is-resizing");
  handle.classList.add("is-active");
  handle.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function updateColumnResize(event: PointerEvent) {
  if (!columnResize || !state) return;
  const row = blockSurface.querySelector<HTMLElement>(`.columns-row[data-column-group="${CSS.escape(columnResize.groupId)}"]`);
  if (!row) return;
  const rect = row.querySelector<HTMLElement>(".columns-grid")?.getBoundingClientRect();
  if (!rect) return;
  const count = Math.max(2, ...state.blocks.filter(block => block.properties.columnGroup === columnResize!.groupId).map(block => columnIndex(block) + 1));
  const delta = (event.clientX - columnResize.startX) / Math.max(1, rect.width) * columnResize.widths.reduce((a, b) => a + b, 0);
  const left = Math.max(.2, columnResize.widths[columnResize.divider] + delta);
  const right = Math.max(.2, columnResize.widths[columnResize.divider + 1] - delta);
  const widths = columnResize.widths.slice(); widths[columnResize.divider] = left; widths[columnResize.divider + 1] = right;
  row.querySelector<HTMLElement>(".columns-grid")?.style.setProperty("grid-template-columns", widths.slice(0, count).flatMap((value, index, values) => index < values.length - 1 ? [`minmax(0, ${Math.max(.2, value)}fr)`, "8px"] : [`minmax(0, ${Math.max(.2, value)}fr)`]).join(" "));
  state.blocks.filter(block => block.properties.columnGroup === columnResize!.groupId).forEach(block => { block.properties = { ...block.properties, columnWidths: widths }; });
}

function finishColumnResize() {
  if (!columnResize || !state) return;
  blockSurface.querySelector<HTMLElement>(`.columns-row[data-column-group="${CSS.escape(columnResize.groupId)}"]`)?.classList.remove("is-resizing");
  columnResize.handle.classList.remove("is-active");
  columnResize = null;
  scheduleDocumentSave(0);
}
document.addEventListener("pointermove", updateColumnResize);
document.addEventListener("pointerup", finishColumnResize);
document.addEventListener("pointercancel", finishColumnResize);

type RootMoveItem = { key: string; blocks: Block[] };
function columnBlocksInVisualOrder(blocks: Block[]) {
  const columns = [...new Set(blocks.map(columnIndex))].sort((a, b) => a - b);
  return columns.flatMap(column => blocks.filter(block => columnIndex(block) === column)
    .sort((a, b) => a.position.localeCompare(b.position) || a.id.localeCompare(b.id)));
}

function positionRootMoveItems(items: RootMoveItem[]) {
  items.forEach((item, index) => {
    const base = (index + 1) * 1000;
    if (!item.key.startsWith("group:")) {
      item.blocks.forEach(block => { block.parentId = null; block.position = String(base).padStart(8, "0"); });
      return;
    }
    const rowByColumn = new Map<number, number>();
    columnBlocksInVisualOrder(item.blocks).forEach(block => {
      const column = columnIndex(block);
      const row = rowByColumn.get(column) ?? 0;
      block.parentId = null;
      block.position = String(base + row).padStart(8, "0");
      rowByColumn.set(column, row + 1);
    });
  });
}

function rootMoveItems(): RootMoveItem[] {
  if (!state) return [];
  const items: RootMoveItem[] = [];
  const seen = new Set<string>();
  state.blocks.filter(block => block.parentId === null).forEach(block => {
    if (block.properties.columnGroup) {
      const group = block.properties.columnGroup;
      if (seen.has(`group:${group}`)) return;
      seen.add(`group:${group}`);
      const members = state!.blocks.filter(item => item.parentId === null && item.properties.columnGroup === group)
        .sort((a, b) => a.position.localeCompare(b.position) || a.id.localeCompare(b.id));
      items.push({ key: `group:${group}`, blocks: members });
      return;
    }
    if (!seen.has(block.id)) {
      seen.add(block.id);
      items.push({ key: block.id, blocks: [block] });
    }
  });
  const stableIndex = new Map(items.map((item, index) => [item.key, index]));
  return items.sort((left, right) => {
    const l = left.blocks[0]?.position ?? "";
    const r = right.blocks[0]?.position ?? "";
    return l.localeCompare(r) || (stableIndex.get(left.key)! - stableIndex.get(right.key)!);
  });
}

function applyRootMoveOrder(items: RootMoveItem[]) {
  positionRootMoveItems(items);
}

function restoreColumnGroup(groupId: string) {
  if (!state) return;
  const members = state.blocks.filter(block => block.properties.columnGroup === groupId);
  // Restore in deterministic column-then-row order. Each column is sorted by
  // its own vertical position before the next column is appended.
  const restoredMembers = columnBlocksInVisualOrder(members);
  const items = rootMoveItems();
  const groupIndex = items.findIndex(item => item.key === `group:${groupId}`);
  if (groupIndex < 0) return;
  const restored = restoredMembers.map(block => {
    const { columnGroup: _group, column: _column, columnWidths: _widths, ...properties } = block.properties;
    block.properties = properties;
    block.parentId = null;
    return { key: block.id, blocks: [block] };
  });
  items.splice(groupIndex, 1, ...restored);
  applyRootMoveOrder(items);
  state.blocks = orderBlockTree(state.blocks);
  renderAllPanels();
  if (canvasContext) ui.canvasStateChanged?.(state, false);
  scheduleDocumentSave(0);
}

function render(next: EditorState) {
  document.querySelector(".block-menu")?.remove();
  closeBlockCommentPopover();
  hideInlineLinkSuggestions();
  const changed = state?.note.id !== next.note.id;
  dismissPreview();
  if (changed) { sidebarLink = null; sidebarSequence++; styleSelection = null; }
  // Upgrade the old hidden layout-block representation once when a document is
  // loaded. New columns are ordinary root blocks sharing a columnGroup.
  next.blocks = migrateLegacyColumns(next.blocks).map(normalizeCanonicalBlockProperties);
  const blockById = new Map(next.blocks.map(block => [block.id, block]));
  next.blocks.forEach(block => {
    if (block.properties.columnGroup) {
      block.parentId = null;
      return;
    }
    if (!block.parentId) return;
    const parent = blockById.get(block.parentId);
    if (block.type !== "reference") {
      block.parentId = null;
      const { column: _column, columnGroup: _group, columnWidths: _widths, ...properties } = block.properties;
      block.properties = properties;
    }
  });
  next.blocks = orderBlockTree(next.blocks);
  next.references.forEach(reference => reference.blocks = orderBlockTree(reference.blocks));
  state = next;
  activeEditable = null;
  if (changed) activeBlock = null;
  if (changed) {
    saveFailure = null;
    commandFailure = null;
    mutationVersion = next.note.clientVersion ?? 0;
    editGroup = newId();
  }
  else mutationVersion = Math.max(mutationVersion, next.note.clientVersion ?? 0);
  // Normalize blocks list: an empty doc still needs at least one shell to edit.
  if (next.blocks.length === 0 && !canvasContext) next.blocks.push(createBlock());
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
  const mounted = new Set<string>();
  blockSurface.querySelectorAll<HTMLElement>("[data-reference-host-id]").forEach(anchor => {
    const hostId = anchor.dataset.referenceHostId;
    if (!hostId) return;
    // A reference host id identifies one block instance. If a stale sync left
    // two anchors behind, keep the first and discard the duplicate marker so
    // a later drag cannot show the same reference twice.
    if (mounted.has(hostId)) { anchor.remove(); return; }
    mounted.add(hostId);
    const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(hostId)}"]`);
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

function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

type TodoStatus = "pending" | "overdue" | "complete-early" | "complete-late" | "none";

function todoStatus(checked: boolean, dueAt?: string, completedAt?: string, today = todayIsoDate()): TodoStatus {
  if (checked) {
    const completed = completedAt || today;
    return dueAt && completed > dueAt ? "complete-late" : "complete-early";
  }
  if (dueAt && today > dueAt) return "overdue";
  return dueAt ? "pending" : "none";
}

function updateTodoStatus(row: HTMLElement) {
  const indicator = row.querySelector<HTMLElement>(".todo-status-indicator");
  if (!indicator) return;
  const checked = row.querySelector<HTMLInputElement>(".todo-check")?.checked ?? false;
  const dueAt = row.querySelector<HTMLInputElement>(".todo-due-date")?.value || undefined;
  const completedAt = row.querySelector<HTMLInputElement>(".todo-completed-date")?.value || undefined;
  const status = todoStatus(checked, dueAt, completedAt);
  indicator.className = `todo-status-indicator todo-status-${status}`;
  indicator.textContent = status === "complete-early" ? "✓" : status === "complete-late" ? "✓" : status === "overdue" ? "!" : status === "pending" ? "○" : "";
  indicator.title = status === "complete-early" ? "已在目标日期前完成" : status === "complete-late" ? "已完成，但晚于目标日期" : status === "overdue" ? "已逾期，尚未完成" : status === "pending" ? "等待完成" : "";
  indicator.setAttribute("aria-label", indicator.title || "无日期状态");
}

function createBlock(type: BlockType = "paragraph", parentId: string | null = null): Block {
  return {
    id: newId(),
    parentId,
    position: "",
    type,
    content: { text: "", html: "", markdown: "", checked: false },
    properties: type === "todo" ? { todoCreatedAt: todayIsoDate() } : {},
    revision: 1
  };
}

function removeOwnBlock(shell: HTMLElement | null) {
  if (!shell) return;
  const removedActiveBlock = activeBlock === shell || (!!activeBlock && shell.contains(activeBlock));
  const removedBlock = state?.blocks.find(block => block.id === shell.dataset.id);
  const removedGroup = removedBlock?.properties.columnGroup;
  const removedReferenceIds = new Set<string>();
  shell.querySelectorAll<HTMLElement>("[data-own-block][data-type='reference']").forEach(referenceShell => {
    const reference = state?.references.find(item => item.hostBlockId === referenceShell.dataset.id);
    if (reference) removedReferenceIds.add(reference.id);
  });
  if (shell.dataset.type === "reference") {
    const reference = state?.references.find(item => item.hostBlockId === shell.dataset.id);
    if (reference) removedReferenceIds.add(reference.id);
  }
  // A [[...]] link can be promoted to a reference instance while its host
  // remains an ordinary paragraph. Deleting that host must remove the
  // promoted instance as well, otherwise the sidebar keeps a dead card.
  state?.references.filter(item => item.hostBlockId === shell.dataset.id).forEach(reference => removedReferenceIds.add(reference.id));
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
  if (removedGroup && state) {
    const remaining = state.blocks.filter(block => block.id !== removedBlock?.id && block.properties.columnGroup === removedGroup);
    const columns = [...new Set(remaining.map(columnIndex))];
    if (columns.length < 2) {
      remaining.forEach(block => {
        const { columnGroup: _group, column: _column, columnWidths: _widths, ...properties } = block.properties;
        block.properties = properties;
      });
    }
  }
  removeReferencesFromLocalState(removedReferenceIds);
  if (removedActiveBlock) {
    activeBlock = null;
    activeEditable = null;
    renderComments();
    renderDatabases();
  }
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
    if (asset) row.append(grip, renderMediaPreview(block));
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
  const checkbox = block.type === "todo" ? `<input class="todo-check" type="checkbox" ${block.content.checked ? "checked" : ""}>` : "";
  const todoDates = block.type === "todo"
    ? `<span class="todo-dates" aria-label="待办日期">
        <label title="记录创建日期"><span>创建</span><input class="todo-created-date" type="date" aria-label="记录创建日期"></label>
        <label title="目标完成日期"><span>应完成</span><input class="todo-due-date" type="date" aria-label="目标完成日期"></label>
        <label title="实际完成日期"><span>完成</span><input class="todo-completed-date" type="date" aria-label="实际完成日期"></label>
      </span>`
    : "";
  const todoStatusMarkup = block.type === "todo" ? `<span class="todo-status-indicator" aria-label="无日期状态"></span>` : "";
  row.innerHTML = `<button type="button" class="grip" aria-label="块菜单" draggable="${editorMode !== "preview"}">⠿</button>${checkbox}${todoStatusMarkup}<div class="block-text ${block.type === "heading" ? "heading" : ""}"></div>${todoDates}<button class="delete-block" title="删除块">×</button>`;
  if (block.type === "heading") {
    const grip = row.querySelector<HTMLButtonElement>(".grip")!;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "heading-collapse-toggle";
    toggle.setAttribute("aria-expanded", String(!block.properties.headingCollapsed));
    toggle.textContent = block.properties.headingCollapsed ? "▸" : "▾";
    toggle.title = block.properties.headingCollapsed ? "展开标题内容" : "折叠标题内容";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const latest = state?.blocks.find(item => item.id === block.id) ?? block;
      toggleHeadingCollapse(latest, toggle);
    });
    grip.insertAdjacentElement("afterend", toggle);
  }
  const editable = row.querySelector<HTMLElement>(".block-text")!;
  const todoCheckbox = row.querySelector<HTMLInputElement>(".todo-check");
  const todoCreatedDate = row.querySelector<HTMLInputElement>(".todo-created-date");
  const todoDueDate = row.querySelector<HTMLInputElement>(".todo-due-date");
  const todoCompletedDate = row.querySelector<HTMLInputElement>(".todo-completed-date");
  if (todoCreatedDate) todoCreatedDate.value = block.properties.todoCreatedAt ?? "";
  if (todoDueDate) todoDueDate.value = block.properties.todoDueAt ?? "";
  if (todoCompletedDate) todoCompletedDate.value = block.properties.todoCompletedAt ?? (block.content.checked ? todayIsoDate() : "");
  if (block.type === "todo" && editorMode === "source") row.querySelector<HTMLElement>(".todo-dates")!.hidden = true;
  if (editorMode === "preview") {
    todoCreatedDate?.setAttribute("disabled", "");
    todoDueDate?.setAttribute("disabled", "");
  }
  if (editorMode === "source" && todoCheckbox) todoCheckbox.hidden = true;
  if (todoCheckbox) {
    todoCheckbox.addEventListener("change", () => {
      if (todoCheckbox.checked) {
        if (todoCompletedDate && !todoCompletedDate.value) todoCompletedDate.value = todayIsoDate();
      } else if (todoCompletedDate) todoCompletedDate.value = "";
      updateTodoStatus(row);
      scheduleDocumentSave(0);
    });
  }
  if (todoDueDate || todoCompletedDate) {
    todoDueDate?.addEventListener("input", () => updateTodoStatus(row));
    todoCompletedDate?.addEventListener("input", () => updateTodoStatus(row));
    todoDueDate?.addEventListener("change", () => { updateTodoStatus(row); scheduleDocumentSave(0); });
    todoCompletedDate?.addEventListener("change", () => { updateTodoStatus(row); scheduleDocumentSave(0); });
  }
  updateTodoStatus(row);
  if (editorMode === "source") {
    editable.classList.add("markdown-source");
    editable.contentEditable = "plaintext-only";
    editable.spellcheck = false;
    editable.textContent = block.type === "todo"
      ? todoMarkdownFromContent(block.content)
      : markdownFromContent(block.content);
  } else if (editorMode === "preview") {
    editable.classList.add("markdown-preview");
    const source = block.type === "todo" ? todoBodyMarkdown(block.content) : block.content.markdown;
    editable.innerHTML = source !== undefined
      ? markdownHtml(source, block.content.links)
      : renderLinkedHtml(block.content.html || escapeText(block.content.text));
  } else {
    editable.classList.add("rich-editor");
    editable.contentEditable = "true";
    const source = block.type === "todo" ? todoBodyMarkdown(block.content) : block.content.markdown;
    editable.innerHTML = block.content.html && block.type !== "todo"
      ? renderLinkedHtml(block.content.html)
      : source !== undefined
        ? markdownHtml(source, block.content.links)
        : escapeText(block.content.text);
    editable.dataset.originalHtml = editable.innerHTML;
  }
  editable.style.backgroundColor = block.properties.background ?? "";
  editable.style.color = block.properties.textColor ?? "";
  editable.style.textAlign = block.properties.textAlign ?? "";
  if (editorMode !== "preview") {
    editable.addEventListener("focus", () => { activeEditable = editable; activeBlock = editable.closest<HTMLElement>("[data-own-block]"); });
    editable.addEventListener("input", event => {
      if (event.target !== editable) return;
      syncEmbeddedOwnerControls(editable);
      scheduleDocumentSave();
    });
    editable.addEventListener("keydown", handleBlockKeydown);
    row.querySelectorAll<HTMLInputElement>("input").forEach(input => input.addEventListener("change", () => scheduleDocumentSave(0)));
  } else row.querySelectorAll<HTMLInputElement>("input").forEach(input => input.setAttribute("disabled", ""));
  row.querySelector(".delete-block")?.addEventListener("click", () => {
    removeOwnBlock(row.closest<HTMLElement>("[data-own-block]"));
  });
  row.querySelector<HTMLButtonElement>(".delete-block")!.disabled = editorMode === "preview";
  return row;
}

function databaseForBlock(block: Block) {
  return state?.databases?.find(database => database.id === block.properties.databaseId);
}

const databaseFieldMeta: Record<DatabaseField["type"], { icon: string; label: string }> = {
  text: { icon: "T", label: "文本" }, number: { icon: "#", label: "数值" }, url: { icon: "↗", label: "网页链接" },
  media: { icon: "▧", label: "多媒体" }, formula: { icon: "ƒ", label: "公式" }, rule: { icon: "⌁", label: "规则" },
  document_relation: { icon: "@", label: "文档关系" }, record_relation: { icon: "⇄", label: "记录关系" }, rollup: { icon: "Σ", label: "汇总" }
};

function saveDatabaseFields(database: DatabaseSource, fields: DatabaseField[], title = database.title) {
  return executeDatabaseCommand({ operation: "save-database-schema", databaseId: database.id, database: { ...database, title }, fields: fields.map((field, index) => ({ ...field, position: String((index + 1) * 1000).padStart(8, "0") })) }, "database-schema");
}

function showDatabaseFieldMenu(anchor: HTMLElement, database: DatabaseSource, field?: DatabaseField) {
  document.querySelector(".database-field-menu")?.remove();
  const menu = document.createElement("div"); menu.className = "database-field-menu"; menu.setAttribute("role", "menu");
  const draft: DatabaseField = field ? { ...field } : { id: `field-${newId()}`, databaseId: database.id, key: `field_${database.fields.length + 1}`, title: "新字段", type: "text", position: "" };
  const name = document.createElement("input"); name.value = draft.title; name.placeholder = "字段名称";
  const key = document.createElement("input"); key.value = draft.key; key.placeholder = "稳定 key";
  const type = document.createElement("select");
  (Object.keys(databaseFieldMeta) as DatabaseField["type"][]).forEach(value => { const option = document.createElement("option"); option.value = value; option.textContent = `${databaseFieldMeta[value].icon} ${databaseFieldMeta[value].label}`; option.selected = draft.type === value; type.append(option); });
  const formula = document.createElement("textarea"); formula.value = draft.formula ?? ""; formula.placeholder = 'prop("数值") * 2'; formula.hidden = draft.type !== "formula" && draft.type !== "rule";
  type.onchange = () => { draft.type = type.value as DatabaseField["type"]; formula.hidden = draft.type !== "formula" && draft.type !== "rule"; };
  const actions = document.createElement("div"); actions.className = "database-field-menu-actions";
  const save = document.createElement("button"); save.textContent = field ? "保存" : "添加列"; save.onclick = () => { draft.title = name.value.trim() || "未命名字段"; draft.key = key.value.trim() || `field_${database.fields.length + 1}`; draft.formula = formula.value.trim() || undefined; const fields = field ? database.fields.map(item => item.id === field.id ? draft : item) : [...database.fields, draft]; void saveDatabaseFields(database, fields).then(() => menu.remove()); };
  actions.append(save);
  if (field) { const remove = document.createElement("button"); remove.className = "danger"; remove.textContent = "删除列"; remove.onclick = () => { if (!confirm(`删除列「${field.title}」？`)) return; void saveDatabaseFields(database, database.fields.filter(item => item.id !== field.id)).then(() => menu.remove()); }; actions.append(remove); }
  menu.append(name, key, type, formula, actions); document.body.append(menu);
  const rect = anchor.getBoundingClientRect(); menu.style.left = `${Math.min(window.innerWidth - 270, rect.left)}px`; menu.style.top = `${Math.min(window.innerHeight - 280, rect.bottom + 5)}px`;
  const close = (event: MouseEvent) => { if (!menu.contains(event.target as Node) && event.target !== anchor) { menu.remove(); document.removeEventListener("mousedown", close); } }; window.setTimeout(() => document.addEventListener("mousedown", close), 0);
}

function databaseDeclaration(block: Block) {
  const database = databaseForBlock(block);
  if (!database) return `\`\`\`localnotes-database\nid: ${block.properties.databaseId ?? ""}\nview: table\n\`\`\``;
  const fields = database.fields.map(field => `  - key: ${field.key}\n    title: ${field.title}\n    type: ${field.type}${field.formula ? `\n    formula: ${field.formula}` : ""}`).join("\n");
  return `\`\`\`localnotes-database\nid: ${database.id}\nname: ${database.title}\nview: table\nfields:\n${fields}\nquery:\n  from: current\n\`\`\``;
}

type DatabaseDeclaration = { id: string; title?: string; fields: DatabaseField[] };

/** Parse the deliberately small, reviewable database declaration format.  It is
 * intentionally line based instead of a general YAML parser: declarations are
 * authored by the editor and unknown syntax must never mutate stored data. */
function parseDatabaseDeclaration(source: string, existing?: DatabaseSource): DatabaseDeclaration | { error: string } {
  const lines = source.replace(/^```localnotes-database\s*/i, "").replace(/```\s*$/i, "").split(/\r?\n/);
  const id = lines.find(line => /^\s*id\s*:/i.test(line))?.replace(/^\s*id\s*:\s*/i, "").trim();
  if (!id) return { error: "声明缺少数据库 id" };
  if (existing && existing.id.trim() !== id.trim()) return { error: `不能在声明中更换数据库 id（${existing.id} → ${id}）` };
  const fields: DatabaseField[] = [];
  let current: Partial<DatabaseField> | null = null;
  const finish = () => {
    if (!current) return;
    const key = String(current.key ?? "").trim();
    const title = String(current.title ?? "").trim();
    const type = current.type;
    if (!key || !title || !type || !(type in databaseFieldMeta)) throw new Error("字段声明缺少 key、title 或有效 type");
    const old = existing?.fields.find(field => field.key === key);
    fields.push({ id: old?.id ?? String(current.id ?? `field-${newId()}`), databaseId: id, key, title, type: type as DatabaseField["type"], position: old?.position ?? String((fields.length + 1) * 1000).padStart(8, "0"), formula: current.formula });
    current = null;
  };
  try {
    for (const line of lines) {
      const field = line.match(/^\s*-\s*key\s*:\s*(\S+)\s*$/i);
      if (field) { finish(); current = { key: field[1] }; continue; }
      const value = line.match(/^\s*(title|type|formula)\s*:\s*(.*)$/i);
      if (value && current) {
        const name = value[1].toLowerCase();
        if (name === "title") current.title = value[2].trim();
        else if (name === "type") current.type = value[2].trim() as DatabaseField["type"];
        else current.formula = value[2].trim();
      }
    }
    finish();
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  if (!fields.length) return { error: "声明至少需要一个字段" };
  const title = lines.find(line => /^name\s*:/i.test(line))?.replace(/^name\s*:\s*/i, "").trim();
  return { id, title, fields };
}

function handleDatabaseSourceInput(block: Block, body: HTMLElement) {
  const source = sourceText(body);
  if (block.type === "data_view") {
    block.properties = { ...block.properties, dataQuery: source };
    body.classList.remove("database-source-error");
    scheduleDocumentSave();
    return;
  }
  const existing = databaseForBlock(block);
  const parsed = parseDatabaseDeclaration(source, existing);
  if ("error" in parsed) {
    body.classList.add("database-source-error");
    saveStatus.textContent = parsed.error;
    return;
  }
  body.classList.remove("database-source-error");
  block.properties = { ...block.properties, databaseId: parsed.id, databaseSource: "database" };
  if (state?.databases) {
    const index = state.databases.findIndex(database => database.id === parsed.id);
    if (index >= 0) state.databases[index] = { ...state.databases[index], fields: parsed.fields };
  }
  void executeDatabaseCommand({ operation: "save-database-schema", databaseId: parsed.id, database: { id: parsed.id, title: parsed.title ?? existing?.title ?? "新数据库" }, fields: parsed.fields }, "database-schema");
}

function createDatabaseRow(block: Block) {
  const row = document.createElement("div");
  row.className = "block-row database-row";
  const grip = document.createElement("button");
  grip.type = "button"; grip.className = "grip"; grip.textContent = "⠿"; grip.draggable = editorMode !== "preview";
  grip.title = "数据库表菜单"; grip.setAttribute("aria-label", "数据库表菜单"); row.append(grip);
  const body = document.createElement("div"); body.className = "database-block-body";
  if (editorMode === "source") {
    body.className += " markdown-source database-source"; body.contentEditable = "plaintext-only"; body.textContent = block.type === "data_view" ? (block.properties.dataQuery ?? "FROM current") : databaseDeclaration(block);
    body.addEventListener("input", () => handleDatabaseSourceInput(block, body));
  } else {
    body.append(block.type === "data_view" ? renderDataView(block) : renderDatabaseTable(block));
  }
  row.append(body);
  const remove = document.createElement("button"); remove.className = "delete-block"; remove.textContent = "×"; remove.title = "删除数据库块"; remove.disabled = editorMode === "preview";
  remove.addEventListener("click", () => removeOwnBlock(row.closest<HTMLElement>("[data-own-block]"))); row.append(remove);
  return row;
}

function renderDataView(block: Block) {
  const wrapper = document.createElement("div"); wrapper.className = "database-table data-view";
  const database = databaseForBlock(block); if (!database) { wrapper.textContent = "数据库不存在"; return wrapper; }
  const parsed = parseDql(block.properties.dataQuery ?? "FROM current");
  if ("code" in parsed) { wrapper.textContent = parsed.message; wrapper.classList.add("database-query-error"); return wrapper; }
  const result = executeDql(parsed, database, state?.databaseRecords?.[database.id] ?? [], { sources: state?.databases ?? [], records: state?.databaseRecords ?? {} });
  const table = document.createElement("table"); const head = document.createElement("thead"); const headRow = document.createElement("tr");
  result.columns.forEach(column => { const th = document.createElement("th"); th.textContent = column.title; headRow.append(th); }); head.append(headRow); table.append(head);
  const body = document.createElement("tbody"); result.rows.forEach(resultRow => {
    const tr = document.createElement("tr"); if (resultRow.grouped) tr.className = "database-group-row";
    result.columns.forEach(column => {
      const td = document.createElement("td");
      const readonly = editorMode === "preview" || resultRow.grouped || resultRow.readonlyKeys?.includes(column.key);
      if (readonly) td.textContent = formulaDisplay(resultRow.values[column.key]);
      else {
        const input = document.createElement("input"); input.className = "database-cell"; input.value = formulaDisplay(resultRow.values[column.key]);
        input.onchange = () => {
          const record = state?.databaseRecords?.[database.id]?.find(item => item.id === resultRow.recordId); if (!record || !state) return;
          const field = database.fields.find(item => item.key === column.key);
          const next = { ...record, values: { ...record.values, [column.key]: field?.type === "number" ? Number(input.value) : input.value } };
          void executeDatabaseCommand({ operation: "upsert-database-record", databaseId: database.id, record: next }, "database-record");
        };
        td.append(input);
      }
      tr.append(td);
    });
    if (resultRow.sourceDocumentId) {
      const td = document.createElement("td"); const open = document.createElement("button"); open.textContent = "打开来源";
      open.onclick = () => void host.openDocument(resultRow.sourceDocumentId!, resultRow.sourceBlockId).catch(showError); td.append(open); tr.append(td);
    }
    body.append(tr);
  }); table.append(body); wrapper.append(table);
  return wrapper;
}

/** Render a database/query block as a compact, read-only snapshot for projections.
 * References, link popovers and suggestions must never expose the source table's
 * editing controls or mutate records while they are being inspected. */
function renderDatabaseTablePreview(block: Block, limits: { rows?: number; columns?: number } = {}, context = state) {
  const wrapper = document.createElement("div");
  wrapper.className = "database-table database-table-preview";
  wrapper.dataset.databaseId = block.properties.databaseId ?? "";
  const database = context?.databases?.find(database => database.id === block.properties.databaseId);
  if (!database) { wrapper.textContent = "数据库不存在"; return wrapper; }
  const records = context?.databaseRecords?.[database.id] ?? [];
  let result: ReturnType<typeof executeDql>;
  if (block.type === "data_view") {
    const parsed = parseDql(block.properties.dataQuery ?? "FROM current");
    if ("code" in parsed) { wrapper.textContent = parsed.message; wrapper.classList.add("database-query-error"); return wrapper; }
    result = executeDql(parsed, database, records, { sources: context?.databases ?? [], records: context?.databaseRecords ?? {} });
  } else {
    result = executeDql({ from: "current" }, database, records, { sources: context?.databases ?? [], records: context?.databaseRecords ?? {} });
  }
  const columns = result.columns.slice(0, limits.columns ?? 5);
  const rows = result.rows.slice(0, limits.rows ?? 5);
  if (!columns.length || !rows.length) {
    const empty = document.createElement("div"); empty.className = "database-preview-empty"; empty.textContent = "暂无数据"; wrapper.append(empty); return wrapper;
  }
  const table = document.createElement("table");
  const head = document.createElement("thead"); const headRow = document.createElement("tr");
  columns.forEach(column => { const th = document.createElement("th"); th.textContent = `${databaseFieldMeta[column.type]?.icon ?? ""} ${column.title}`.trim(); headRow.append(th); });
  head.append(headRow); table.append(head);
  const body = document.createElement("tbody");
  rows.forEach(resultRow => {
    const tr = document.createElement("tr"); if (resultRow.grouped) tr.className = "database-group-row";
    columns.forEach(column => { const td = document.createElement("td"); td.textContent = formulaDisplay(resultRow.values[column.key]); td.title = td.textContent; tr.append(td); });
    body.append(tr);
  });
  table.append(body); wrapper.append(table);
  if (result.rows.length > rows.length) { const more = document.createElement("div"); more.className = "database-preview-empty"; more.textContent = `还有 ${result.rows.length - rows.length} 行`; wrapper.append(more); }
  return wrapper;
}

function formulaDisplay(value: unknown) {
  if (typeof value === "object" && value !== null && "code" in value) return `#ERROR ${String((value as { message?: unknown }).message ?? "计算失败")}`;
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

function relationEditor(field: DatabaseField, record: DatabaseRecord, database: DatabaseSource) {
  const select = document.createElement("select"); select.className = "database-cell database-relation"; select.multiple = true;
  const selected = new Set(Array.isArray(record.values[field.key]) ? record.values[field.key] as string[] : typeof record.values[field.key] === "string" ? [record.values[field.key] as string] : []);
  if (field.type === "document_relation") {
    (state?.documents ?? []).forEach(documentInfo => { const option = document.createElement("option"); option.value = documentInfo.id; option.textContent = documentInfo.path || documentInfo.title; option.selected = selected.has(option.value); select.append(option); });
  } else {
    const targetId = field.relationDatabaseId ?? database.id;
    const target = state?.databases?.find(item => item.id === targetId);
    (state?.databaseRecords?.[targetId] ?? []).forEach(item => { const option = document.createElement("option"); option.value = item.id; const labelField = target?.fields.find(candidate => candidate.type === "text"); option.textContent = String(item.values[labelField?.key ?? ""] ?? item.id); option.selected = selected.has(option.value); select.append(option); });
  }
  select.onchange = () => { if (!state) return; const next = { ...record, values: { ...record.values, [field.key]: [...select.selectedOptions].map(option => option.value) } }; void executeDatabaseCommand({ operation: "upsert-database-record", databaseId: database.id, record: next }, "database-record"); };
  return select;
}

function isDatabaseMedia(value: DatabaseValue | undefined): value is MediaAsset {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "url" in value && "kind" in value;
}

function computedCellText(field: DatabaseField, value: unknown) {
  if (field.type === "rule" && typeof value === "boolean") return value ? "✓ 符合" : "— 不符合";
  return formulaDisplay(value);
}

function editComputedField(td: HTMLElement, database: DatabaseSource, field: DatabaseField, value: unknown) {
  td.replaceChildren();
  const editor = document.createElement("input"); editor.className = "database-cell database-formula-source"; editor.value = field.formula ?? ""; editor.placeholder = 'prop("字段") * 2';
  const commit = () => { const formula = editor.value.trim(); if (formula === (field.formula ?? "")) { td.textContent = computedCellText(field, value); return; } void saveDatabaseFields(database, database.fields.map(item => item.id === field.id ? { ...item, formula } : item)); };
  editor.onblur = commit; editor.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); editor.blur(); } else if (event.key === "Escape") { editor.onblur = null; td.textContent = computedCellText(field, value); } };
  td.append(editor); editor.focus(); editor.select();
}

function renderDatabaseMediaCell(td: HTMLElement, database: DatabaseSource, field: DatabaseField, record: DatabaseRecord) {
  const asset = record.values[field.key];
  if (isDatabaseMedia(asset)) {
    const preview = document.createElement(asset.kind === "image" ? "img" : asset.kind === "video" ? "video" : asset.kind === "audio" ? "audio" : "a");
    preview.className = "database-media-preview";
    if (preview instanceof HTMLImageElement) { preview.src = asset.url; preview.alt = asset.name; }
    else if (preview instanceof HTMLVideoElement || preview instanceof HTMLAudioElement) { preview.src = asset.url; preview.controls = true; }
    else { preview.href = asset.url; preview.textContent = asset.name; preview.target = "_blank"; }
    td.append(preview);
  } else { const empty = document.createElement("span"); empty.className = "database-cell-empty"; empty.textContent = "无文件"; td.append(empty); }
  if (editorMode !== "preview") {
    const choose = document.createElement("button"); choose.className = "database-media-choose"; choose.textContent = asset ? "替换" : "+ 文件";
    const file = document.createElement("input"); file.type = "file"; file.hidden = true;
    choose.onclick = () => file.click(); file.onchange = async () => { const selected = file.files?.[0]; if (!selected) return; try { const stored = await host.storeMedia({ name: selected.name, mimeType: selected.type || "application/octet-stream", size: selected.size, data: await fileToBase64(selected) }); const next = { ...record, values: { ...record.values, [field.key]: stored.media } }; await executeDatabaseCommand({ operation: "upsert-database-record", databaseId: database.id, record: next }, "database-media"); } catch (error) { showError(error); } };
    td.append(choose, file);
  }
}

function renderDatabaseTable(block: Block) {
  const wrapper = document.createElement("div"); wrapper.className = "database-table"; wrapper.dataset.databaseId = block.properties.databaseId ?? "";
  const database = databaseForBlock(block);
  if (!database) { wrapper.textContent = "数据库不存在"; return wrapper; }
  const records = state?.databaseRecords?.[database.id] ?? [];
  const computed = executeDql({ from: "current" }, database, records, { sources: state?.databases ?? [], records: state?.databaseRecords ?? {} });
  const computedById = new Map(computed.rows.filter(row => !row.grouped).map(row => [row.recordId, row]));
  const table = document.createElement("table");
  const head = document.createElement("thead"); const headRow = document.createElement("tr");
  database.fields.forEach(field => {
    const th = document.createElement("th"); th.dataset.fieldKey = field.key;
    const header = document.createElement(editorMode === "preview" ? "span" : "button"); header.className = "database-field-header";
    const icon = document.createElement("span"); icon.className = "database-field-icon"; icon.textContent = databaseFieldMeta[field.type].icon; icon.title = databaseFieldMeta[field.type].label;
    const title = document.createElement("span"); title.textContent = field.title; header.append(icon, title);
    if (header instanceof HTMLButtonElement) { header.type = "button"; header.title = "字段设置"; header.onclick = () => showDatabaseFieldMenu(header, database, field); }
    th.append(header); headRow.append(th);
  });
  head.append(headRow); table.append(head);
  const body = document.createElement("tbody");
  records.forEach(record => {
    const tr = document.createElement("tr"); tr.dataset.recordId = record.id;
    database.fields.forEach((field, fieldIndex) => {
      const td = document.createElement("td"); td.dataset.fieldKey = field.key;
      if (fieldIndex === 0 && editorMode !== "preview") { const remove = document.createElement("button"); remove.className = "database-delete-row"; remove.textContent = "×"; remove.title = "删除行"; remove.onclick = () => void executeDatabaseCommand({ operation: "delete-database-record", databaseId: database.id, record: { id: record.id } }, "database-record"); td.append(remove); }
      if ((field.type === "document_relation" || field.type === "record_relation") && editorMode !== "preview") { td.append(relationEditor(field, record, database)); tr.append(td); return; }
      const computedValue = computedById.get(record.id)?.values[field.key];
      if (field.type === "media") { renderDatabaseMediaCell(td, database, field, record); tr.append(td); return; }
      if (field.type === "url" && editorMode === "preview") { const href = String(record.values[field.key] ?? ""); const link = document.createElement("a"); link.href = href; link.textContent = href || "—"; link.target = "_blank"; link.rel = "noreferrer"; td.append(link); tr.append(td); return; }
      if (field.type === "formula" || field.type === "rule") { const result = document.createElement(editorMode === "preview" ? "span" : "button"); result.className = "database-computed-cell"; result.textContent = computedCellText(field, computedValue); if (result instanceof HTMLButtonElement) { result.type = "button"; result.title = "点击编辑公式源码"; result.onclick = () => editComputedField(td, database, field, computedValue); } td.append(result); tr.append(td); return; }
      if (field.type === "rollup") { const result = document.createElement("span"); result.className = "database-computed-cell"; result.textContent = formulaDisplay(computedValue); td.append(result); tr.append(td); return; }
      if (editorMode === "preview") { td.append(document.createTextNode(formulaDisplay(computedValue))); tr.append(td); return; }
      const input = document.createElement("input"); input.className = "database-cell"; input.type = field.type === "number" ? "number" : field.type === "url" ? "url" : "text"; input.value = formulaDisplay(computedValue);
      input.dataset.fieldKey = field.key;
      input.addEventListener("change", () => {
        const next: DatabaseRecord = { ...record, values: { ...record.values, [field.key]: field.type === "number" ? Number(input.value) : input.value } };
        void executeDatabaseCommand({ operation: "upsert-database-record", databaseId: database.id, record: next }, "database-record");
      });
      td.append(input); tr.append(td);
    });
    body.append(tr);
  });
  table.append(body); wrapper.append(table);
  if (editorMode !== "preview") {
    const add = document.createElement("button"); add.className = "database-add-row"; add.textContent = "+ 添加记录";
    add.onclick = () => {
      const values: DatabaseRecord["values"] = {};
      database.fields.forEach(field => { if (field.type === "number") values[field.key] = 0; else if (field.type === "text" || field.type === "url") values[field.key] = ""; else if (field.type === "document_relation" || field.type === "record_relation") values[field.key] = []; });
      const record: DatabaseRecord = { id: `record-${newId()}`, databaseId: database.id, position: String((records.length + 1) * 1000).padStart(8, "0"), values };
      void executeDatabaseCommand({ operation: "upsert-database-record", databaseId: database.id, record }, "database-record");
    };
    const addColumn = document.createElement("button"); addColumn.className = "database-add-column"; addColumn.textContent = "+ 添加列"; addColumn.onclick = () => showDatabaseFieldMenu(addColumn, database);
    wrapper.append(add, addColumn);
  }
  return wrapper;
}

function mediaKindLabel(kind: MediaKind) {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "audio" ? "音频" : kind === "pdf" ? "PDF" : "文件";
}

function boundedMediaWidth(value: number | undefined) {
  return Math.max(10, Math.min(100, Number.isFinite(value) ? value! : 100));
}

function renderMediaPreview(block: Block, readonly = false): HTMLElement {
  const asset = block.content.media!;
  const figure = document.createElement("figure");
  figure.className = "media-preview";
  figure.dataset.mediaKind = asset.kind;
  const stage = document.createElement("div");
  stage.className = "media-stage";
  stage.dataset.mediaAlign = block.properties.textAlign ?? "left";
  if (block.properties.mediaWidth !== undefined) stage.style.width = `${boundedMediaWidth(block.properties.mediaWidth)}%`;
  let media: HTMLElement;
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
  } else if (asset.kind === "audio") {
    const audio = document.createElement("audio");
    audio.src = asset.url;
    audio.controls = true;
    audio.preload = "metadata";
    media = audio;
  } else if (asset.kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.src = asset.url;
    frame.title = asset.name;
    frame.loading = "lazy";
    media = frame;
  } else {
    const link = document.createElement("a");
    link.href = asset.url;
    link.download = asset.name;
    link.textContent = `下载 ${asset.name}`;
    link.className = "media-file-link";
    media = link;
  }
  media.classList.add("media-player");
  stage.append(media);
  if (asset.kind === "image" && editorMode !== "preview" && !readonly) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "media-resize-handle";
    handle.title = "拖拽调整图片尺寸";
    handle.setAttribute("aria-label", "拖拽调整图片尺寸");
    handle.textContent = "";
    handle.addEventListener("pointerdown", event => beginMediaResize(event, block, stage));
    stage.append(handle);
  }
  figure.append(stage);
  const caption = document.createElement("figcaption");
  caption.className = "media-caption";
  const name = document.createElement("span");
  name.className = "media-name";
  name.contentEditable = editorMode === "rich" && !readonly ? "true" : "false";
  name.dataset.placeholder = `添加 caption（${asset.name}）`;
  name.textContent = block.content.caption ?? "";
  name.addEventListener("focus", () => { activeEditable = name; activeBlock = figure.closest<HTMLElement>("[data-own-block]"); });
  name.addEventListener("input", () => {
    const current = state?.blocks.find(item => item.id === block.id);
    if (!current) return;
    const value = name.textContent?.trim() ?? "";
    current.content = { ...current.content, caption: value || undefined, text: value || asset.name };
    scheduleDocumentSave();
  });
  if (block.content.caption || editorMode === "rich") caption.append(name);
  figure.addEventListener("pointerdown", () => { activeBlock = figure.closest<HTMLElement>("[data-own-block]"); });
  figure.append(caption);
  return figure;
}

function beginMediaResize(event: PointerEvent, block: Block, stage: HTMLElement) {
  if (editorMode === "preview" || !state) return;
  const container = stage.closest<HTMLElement>(".block-row") ?? stage;
  const rect = container.getBoundingClientRect();
  const current = stage.getBoundingClientRect();
  mediaResize = { blockId: block.id, startX: event.clientX, startWidth: current.width / Math.max(1, rect.width) * 100, containerWidth: rect.width };
  stage.classList.add("is-resizing");
  try { (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId); } catch { /* synthetic events may not have an active pointer */ }
  event.preventDefault();
  event.stopPropagation();
}

function updateMediaResize(event: PointerEvent) {
  if (!mediaResize || !state) return;
  const block = state.blocks.find(item => item.id === mediaResize!.blockId);
  const stage = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(mediaResize.blockId)}"] .media-stage`);
  if (!block || !stage) return;
  const width = boundedMediaWidth(mediaResize.startWidth + (event.clientX - mediaResize.startX) / Math.max(1, mediaResize.containerWidth) * 100);
  block.properties = { ...block.properties, mediaWidth: width };
  stage.style.width = `${width}%`;
}

function finishMediaResize() {
  if (!mediaResize || !state) return;
  blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(mediaResize.blockId)}"] .media-stage`)?.classList.remove("is-resizing");
  mediaResize = null;
  scheduleDocumentSave(0);
}

document.addEventListener("pointermove", updateMediaResize);
document.addEventListener("pointerup", finishMediaResize);

function formatMediaSize(size: number) {
  if (!Number.isFinite(size) || size < 1024) return `${Math.max(0, size | 0)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function contentFromRichFragment(fragment: DocumentFragment, fallback: BlockContent): BlockContent {
  const container = document.createElement("div");
  container.append(fragment);
  const content = contentFromRichEditable(container, fallback);
  // A rich split must keep inline classes/styles in the HTML snapshot. The
  // Markdown projection cannot represent arbitrary class names reliably.
  delete content.markdown;
  return content;
}

function selectionRangeInEditable(editable: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!editable.contains(range.startContainer) || !editable.contains(range.endContainer)) return null;
  return range;
}

function placeCaretAtStart(editable: HTMLElement) {
  editable.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function insertFirstBodyBlock() {
  if (editorMode === "preview" || !state) return;
  const block = createBlock("paragraph");
  block.position = "00000000";
  state.blocks.push(block);
  const shell = renderOwnBlockShell(block);
  const first = blockSurface.querySelector<HTMLElement>(":scope > [data-own-block], :scope > .columns-row");
  blockSurface.insertBefore(shell, first ?? null);
  placeCaretAtStart(shell.querySelector<HTMLElement>(".block-text")!);
  scheduleDocumentSave(0);
}

function handleBlockKeydown(event: KeyboardEvent) {
  // Embedded reference blocks are nested inside their host editable. Resolve
  // the nearest editable so a bubbled key event cannot split the outer host.
  if ((event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text") !== event.currentTarget) return;
  if (event.defaultPrevented) return;
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  const current = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-own-block]")!;
  const currentBlock = state?.blocks.find(block => block.id === current.dataset.id);
  const next = createBlock("paragraph", current.dataset.parentId || null);
  if (currentBlock) {
    next.properties = { ...currentBlock.properties };
    delete next.properties.layout;
    delete next.properties.columnCount;
    delete next.properties.columnGap;
    delete next.properties.headingLevel;
  }

  const editable = event.currentTarget as HTMLElement;
  if (currentBlock && editorMode === "source") {
    const range = selectionRangeInEditable(editable);
    const source = sourceText(editable);
    const start = range ? (() => {
      const before = range.cloneRange();
      before.selectNodeContents(editable); before.setEnd(range.startContainer, range.startOffset);
      return before.toString().length;
    })() : source.length;
    const end = range ? (() => {
      const after = range.cloneRange();
      after.selectNodeContents(editable); after.setStart(range.endContainer, range.endOffset);
      return source.length - after.toString().length;
    })() : start;
    const beforeSource = source.slice(0, start);
    const afterSource = source.slice(end);
    if (currentBlock.type === "todo") {
      // Keep the GFM task marker with the todo block when Enter splits its body.
      const firstLineEnd = source.indexOf("\n");
      const firstLine = firstLineEnd < 0 ? source : source.slice(0, firstLineEnd);
      const marker = firstLine.match(/^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/);
      const markerLength = marker ? marker[0].length : 0;
      const body = marker ? [marker[2], ...source.split("\n").slice(1)].join("\n") : source;
      const bodyStart = marker ? Math.min(body.length, Math.max(0, start - markerLength)) : start;
      const bodyEnd = marker ? Math.min(body.length, Math.max(bodyStart, end - markerLength)) : end;
      currentBlock.content = contentFromMarkdown(body.slice(0, bodyStart), currentBlock.content);
      currentBlock.content.checked = marker ? marker[1].toLowerCase() === "x" : (currentBlock.content.checked ?? false);
      next.content = contentFromMarkdown(body.slice(bodyEnd), { ...currentBlock.content, checked: false });
      editable.textContent = todoMarkdownFromContent(currentBlock.content);
    } else {
      currentBlock.content = contentFromMarkdown(beforeSource, currentBlock.content);
      next.content = contentFromMarkdown(afterSource, currentBlock.content);
      editable.textContent = beforeSource;
    }
  } else if (currentBlock && editorMode === "rich") {
    const range = selectionRangeInEditable(editable);
    if (range) {
      const before = document.createRange();
      before.selectNodeContents(editable); before.setEnd(range.startContainer, range.startOffset);
      const after = document.createRange();
      after.selectNodeContents(editable); after.setStart(range.endContainer, range.endOffset);
      currentBlock.content = contentFromRichFragment(before.cloneContents(), currentBlock.content);
      next.content = contentFromRichFragment(after.cloneContents(), currentBlock.content);
      editable.replaceChildren(before.cloneContents());
      editable.dataset.originalHtml = "";
    }
  }
  // Keep the optimistic model in sync with the inserted DOM shell. A second
  // Enter before the save ACK must still see this block's parent/column data.
  state?.blocks.push(next);
  const shell = document.createElement("div");
  shell.className = "block-shell";
  shell.dataset.ownBlock = "true";
  shell.dataset.id = next.id;
  shell.dataset.parentId = next.parentId ?? "";
  shell.dataset.type = next.type;
  shell.dataset.editorMode = editorMode;
  shell.dataset.columnGroup = next.properties.columnGroup ?? "";
  shell.dataset.column = next.properties.column === undefined ? "" : String(next.properties.column);
  shell.style.setProperty("--depth", String(Number(current.style.getPropertyValue("--depth")) || 0));
  shell.append(createEditableRow(next));
  current.after(shell);
  placeCaretAtStart(shell.querySelector<HTMLElement>(".block-text")!);
  scheduleDocumentSave(0);
}

function readOwnBlocks(): Block[] {
  const siblingIndexes = new Map<string, number>();
  const blocks: Block[] = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")].map((shell): Block => {
    const old = state?.blocks.find((block) => block.id === shell.dataset.id);
    const oldParentId = shell.dataset.parentId || null;
    const oldParent = oldParentId ? state?.blocks.find(block => block.id === oldParentId) : undefined;
    const isReferenceChild = shell.dataset.type === "reference" && !!oldParentId;
    const parentId = isReferenceChild ? oldParentId : null;
    const columnGroup = shell.dataset.columnGroup || old?.properties.columnGroup;
    const column = shell.dataset.column === "" ? old?.properties.column : Number(shell.dataset.column);
    const siblingKey = columnGroup ? `column:${columnGroup}:${column ?? 0}` : (parentId ?? "");
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
    if (shell.dataset.type === "location") {
      const source = shell.querySelector<HTMLElement>(":scope > .block-row > .location-source")?.textContent ?? "";
      const id = source.match(/^id:\s*(.+)$/m)?.[1]?.trim() || old?.properties.locationId;
      const label = source.match(/^label:\s*(.*)$/m)?.[1]?.trim() || undefined;
      return {
        id: shell.dataset.id!, parentId, position,
        type: "location", content: old?.content ?? { text: "", html: "" },
        properties: { ...(old?.properties ?? {}), locationId: id, locationLabelOverride: label }, revision: old?.revision ?? 1
      };
    }
    if (shell.dataset.type === "database_table" || shell.dataset.type === "data_view") return {
      id: shell.dataset.id!, parentId, position, type: shell.dataset.type as BlockType,
      content: old?.content ?? { text: "", html: "" }, properties: old?.properties ?? {}, revision: old?.revision ?? 1
    };
    const editable = shell.querySelector<HTMLElement>(":scope > .block-row > .block-text");
    if (!editable) return old ?? {
      id: shell.dataset.id!, parentId, position, type: shell.dataset.type as BlockType,
      content: { text: "", html: "" }, properties: {}, revision: 1
    };
    const content = editorMode === "preview"
      ? old?.content ?? { text: "", html: "", markdown: "" }
      : editorMode === "source"
        ? shell.dataset.type === "todo"
          ? contentFromTodoMarkdown(sourceText(editable), old?.content ?? { text: "", html: "", checked: false })
          : contentFromMarkdown(sourceText(editable), old?.content ?? { text: "", html: "" })
        : contentFromRichEditable(editable, old?.content ?? { text: "", html: "" });
    const todoChecked = shell.dataset.type === "todo"
      ? (editorMode === "source" ? content.checked ?? old?.content.checked ?? false : shell.querySelector<HTMLInputElement>(".todo-check")?.checked ?? old?.content.checked ?? false)
      : false;
    const completedInput = shell.querySelector<HTMLInputElement>(".todo-completed-date")?.value || undefined;
    const todoDates: Partial<BlockProperties> = shell.dataset.type === "todo" ? {
      todoCreatedAt: shell.querySelector<HTMLInputElement>(".todo-created-date")?.value || undefined,
      todoDueAt: shell.querySelector<HTMLInputElement>(".todo-due-date")?.value || undefined,
      todoCompletedAt: todoChecked ? (completedInput || old?.properties.todoCompletedAt || todayIsoDate()) : undefined
    } : {};
    const properties: BlockProperties = editorMode === "rich"
      ? {
        ...(old?.properties ?? {}),
        background: editable.style.backgroundColor || undefined,
        textColor: editable.style.color || undefined,
        textAlign: editable.style.textAlign === "left" || editable.style.textAlign === "center" || editable.style.textAlign === "right" ? editable.style.textAlign : undefined,
        ...todoDates,
        ...(columnGroup ? { columnGroup, column } : shell.dataset.column === "" ? {} : { column: Number(shell.dataset.column) })
      }
      : {
        ...(old?.properties ?? {}),
        ...(old?.properties.textAlign ? { textAlign: old.properties.textAlign } : {}),
        ...todoDates,
        ...(columnGroup ? { columnGroup, column } : shell.dataset.column === "" ? {} : { column: Number(shell.dataset.column) })
      };
    if (shell.dataset.type === "heading") {
      properties.headingLevel = headingLevelFromMarkdown(content) ?? properties.headingLevel ?? 1;
    }
    return {
      id: shell.dataset.id!, parentId, position,
      type: shell.dataset.type as BlockType,
      content: {
        ...content,
        ...(shell.dataset.type === "todo"
          ? { checked: todoChecked }
          : {})
      },
      properties,
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
  const retainedById = new Map(retained.map(block => [block.id, block]));
  const rootItems: RootMoveItem[] = [];
  [...blockSurface.children].forEach(element => {
    if (element instanceof HTMLElement && element.classList.contains("columns-row")) {
      const groupId = element.dataset.columnGroup;
      if (!groupId) return;
      const members = [...element.querySelectorAll<HTMLElement>(".column-track > [data-own-block][data-id]")]
        .map(shell => retainedById.get(shell.dataset.id ?? ""))
        .filter((block): block is Block => Boolean(block));
      if (members.length) rootItems.push({ key: `group:${groupId}`, blocks: members });
      return;
    }
    if (!(element instanceof HTMLElement) || !element.matches("[data-own-block][data-id]")) return;
    const block = retainedById.get(element.dataset.id ?? "");
    if (block && block.parentId === null) rootItems.push({ key: block.id, blocks: [block] });
  });
  positionRootMoveItems(rootItems);
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
  const titleMarkup = inSidebar
    ? ""
    : `<button type="button" class="reference-title" data-target-id="${targetDocId}" data-reference-id="${refIdAttr}">${refTitle}</button>`;
  summary.innerHTML = `<button type="button" class="reference-expand" aria-expanded="${isOpen}" aria-label="${toggleLabel}" title="${inSidebar ? (isOpen ? "折叠此引用" : "展开此引用") : (collapsed ? "展开引用正文" : "折叠引用正文")}">${toggleIcon}</button>${titleMarkup}<button type="button" class="reference-mode-menu" aria-label="引用显示方式" title="选择引用显示方式">显示方式</button>`;
  const title = summary.querySelector<HTMLElement>(".reference-title");
  if (title && reference.targetBlockId) title.dataset.targetBlockId = reference.targetBlockId;
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
    if (source.type === "location") {
      editable.replaceChildren(renderLocationCard({ ...source, content, properties }));
    } else if (source.type === "database_table" || source.type === "data_view") {
      // Database projections are intentionally read-only. Keep the source
      // declaration available in source mode, but render a compact table in
      // rich/preview modes just like an embedded database block.
      if (editorMode === "source") {
        editable.classList.add("markdown-source");
        editable.contentEditable = "plaintext-only";
        editable.spellcheck = false;
        editable.textContent = source.type === "data_view" ? (source.properties.dataQuery ?? "FROM current") : databaseDeclaration(source);
      } else {
        editable.classList.add("markdown-preview");
        editable.replaceChildren(renderDatabaseTablePreview({ ...source, content, properties }));
      }
    } else if (editorMode === "source") {
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
      editable.innerHTML = content.html
        ? renderLinkedHtml(content.html)
        : content.markdown !== undefined
          ? markdownHtml(content.markdown, content.links)
          : escapeText(content.text);
      editable.dataset.originalHtml = editable.innerHTML;
    }
    editable.style.backgroundColor = properties.background ?? "";
    editable.style.color = properties.textColor ?? "";
    const projectedDatabase = source.type === "database_table" || source.type === "data_view";
    if (editorMode !== "preview" && !projectedDatabase) {
      editable.addEventListener("focus", () => activeEditable = editable);
      editable.addEventListener("input", () => local ? scheduleInstanceBlock(row, source) : scheduleOverride(row, source, properties));
      editable.addEventListener("keydown", event => handleReferenceRowKeydown(event, row, reference, source));
    }
    row.dataset.referenceSource = local ? "instance" : "canonical";
    row.querySelector<HTMLButtonElement>(".add-sibling")!.disabled = editorMode === "preview" || projectedDatabase;
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

function handleReferenceRowKeydown(event: KeyboardEvent, row: HTMLElement, reference: ReferenceInstance, source: Block) {
  if ((event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text") !== event.currentTarget || event.defaultPrevented) return;
  if (event.key !== "Enter" || event.shiftKey || editorMode === "preview") return;
  event.preventDefault();
  addInstanceBlock(reference, source.parentId ?? null, row);
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
  const afterId = afterRow?.dataset.targetBlockId;
  const siblings = reference.blocks.filter(item => (item.parentId ?? null) === parentId);
  const after = afterId ? siblings.find(item => item.id === afterId) : undefined;
  const used = new Set(siblings.map(item => Number(item.position)).filter(Number.isFinite));
  let position = after ? Number(after.position) + 1 : Math.max(0, ...used) + 1000;
  while (used.has(position)) position += 1;
  block.position = String(position).padStart(8, "0");
  runAfterSaveDrain(() => void post({ type: "saveInstanceBlock", referenceInstanceId: reference.id, block }, documentId).then(() => {
    const row = document.querySelector<HTMLElement>(`.reference-row[data-reference-instance-id="${CSS.escape(reference.id)}"][data-target-block-id="${CSS.escape(block.id)}"]`);
    const editable = row?.querySelector<HTMLElement>(".block-text");
    editable?.focus();
  }));
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
    shell.dataset.editorMode = editorMode;
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
      targetScope: link.targetScope,
      label: state!.documents.find(document => document.id === link.targetDocumentId)?.title ?? link.targetText,
      excerpt: block.content.text
    })));
  const liveLinkKeys = new Set(state.references
    .filter(reference => reference.mode !== "link")
    .map(reference => `${reference.hostBlockId}:${reference.targetDocumentId}:${reference.targetBlockId ?? ""}`));
  const visibleOrdinaryLinks = ordinaryLinks.filter(link =>
    !liveLinkKeys.has(`${link.sourceBlockId}:${link.documentId}:${link.blockId ?? ""}`));
  const desiredSidebarRefs = state.references.filter((reference) => reference.mode === "sidebar");
  const visibleReferences = state.references.filter(reference => reference.mode !== "link");
  let showCards: ReferenceInstance[] = visibleReferences;
  let introOrEmpty: "intro" | "empty" | null = null;
  if (desiredSidebarRefs.length === 0)
    introOrEmpty = showCards.length > 0 ? "intro" : visibleOrdinaryLinks.length ? null : "empty";
  else if (!showCards.length && !visibleOrdinaryLinks.length) introOrEmpty = "empty";
  // Index existing cards by their data-reference-id so we can decide reuse vs. rebuild.
  const existingCards = new Map<string, HTMLElement>();
  referenceSidebarPanel.querySelectorAll<HTMLElement>(".reference-card[data-reference-id]").forEach((el) => {
    existingCards.set(el.dataset.referenceId!, el);
  });
  const documentGroups = new Map<string, { title: string; references: ReferenceInstance[]; links: typeof ordinaryLinks }>();
  const groupFor = (documentId: string, title: string) => {
    const existing = documentGroups.get(documentId);
    if (existing) return existing;
    const group = { title, references: [], links: [] as typeof ordinaryLinks };
    documentGroups.set(documentId, group);
    return group;
  };
  showCards.forEach(reference => groupFor(
    reference.targetDocumentId,
    state!.documents.find(document => document.id === reference.targetDocumentId)?.title ?? reference.targetTitle
  ).references.push(reference));
  visibleOrdinaryLinks.forEach(link => groupFor(link.documentId, link.label || link.documentId).links.push(link));

  // Collect everything into the fragment BEFORE replaceChildren, so the panel is never
  // temporarily blank even if showCards is empty or an error occurs mid-render.
  const fragment = document.createDocumentFragment();
  for (const [documentId, group] of documentGroups) {
    const section = document.createElement("section");
    section.className = "reference-document-group";
    section.dataset.documentId = documentId;
    const header = document.createElement("header");
    header.className = "reference-document-head";
    const title = document.createElement("button");
    title.type = "button";
    title.className = "reference-document-title reference-title";
    title.dataset.targetId = documentId;
    title.textContent = group.title || "未命名文档";
    title.title = "打开源文档";
    const total = document.createElement("span");
    total.className = "reference-document-count";
    total.textContent = `${group.references.length + group.links.length} 项`;
    header.append(title, total);
    section.append(header);
    const items = document.createElement("div");
    items.className = "reference-document-items";
    for (const reference of group.references) {
      const existing = existingCards.get(reference.id);
      const sig = rowSignature(reference);
      const card = existing && (existing as HTMLElement & { __rowSig?: string }).__rowSig === sig
        ? existing
        : renderReference(reference, true);
      (card as HTMLElement & { __rowSig?: string }).__rowSig = sig;
      items.append(card);
      existingCards.delete(reference.id);
    }
    for (const link of group.links) {
      const entry = document.createElement("section");
      // Ordinary [[...]] links and live reference instances share one visual
      // list item in the grouped sidebar. The link remains read-only; only
      // its presentation is aligned with the live reference card.
      entry.className = "linked-reference-entry reference-card sidebar";
      entry.dataset.linkKey = link.key;
      const linkTitle = document.createElement("button");
      linkTitle.type = "button";
      linkTitle.className = "reference-title";
      linkTitle.dataset.targetId = link.documentId;
      linkTitle.dataset.sourceBlockId = link.sourceBlockId;
      if (link.blockId) linkTitle.dataset.targetBlockId = link.blockId;
      linkTitle.textContent = link.label || "未命名链接";
      linkTitle.title = "悬停预览 · 单击分栏 · 双击打开源";
      const summary = document.createElement("div");
      summary.className = "reference-card-summary linked-reference-summary";
      summary.append(linkTitle);
      const modeMenu = document.createElement("button");
      modeMenu.type = "button";
      modeMenu.className = "reference-mode-menu";
      modeMenu.setAttribute("aria-label", "引用显示方式");
      modeMenu.title = "选择引用显示方式";
      modeMenu.textContent = "显示方式";
      modeMenu.addEventListener("click", event => {
        event.stopPropagation();
        showOrdinaryLinkModeMenu(modeMenu, link);
      });
      summary.append(modeMenu);
      const excerpt = document.createElement("p");
      excerpt.className = "linked-reference-excerpt";
      excerpt.textContent = link.excerpt || "（空白段落）";
      entry.append(summary, excerpt);
      entry.addEventListener("click", event => {
        if ((event.target as HTMLElement).closest("button")) return;
        linkTitle.click();
      });
      items.append(entry);
    }
    section.append(items);
    fragment.append(section);
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
  const actions: Array<{ label: string; run: () => void; danger?: boolean }> = [
    { label: "复制块链接", run: () => copyBlockLink(block) },
    { label: activeCommentsFor(block).length ? "管理注释" : "添加注释", run: () => {
      const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`);
      if (shell) showBlockCommentPopover(shell.querySelector<HTMLElement>(".block-comment-bubble") ?? anchor, block, true);
    } },
    { label: "删除块", run: () => {
      removeOwnBlock(anchor.closest<HTMLElement>("[data-own-block]"));
    }, danger: true }
  ];
  if (block.type === "database_table") {
    const databaseActions = [
      ...(block.properties.databaseSource === "gfm" ? [{ label: "升级为智能数据库表", run: () => { block.properties = { ...block.properties, databaseSource: "database" }; renderAllPanels(); scheduleDocumentSave(0); } }] : []),
      { label: "转换为 Markdown 表格", run: () => convertDatabaseBlockToMarkdown(block) },
      { label: "导出 Markdown", run: () => exportDatabase(block, false) },
      { label: "导出 CSV", run: () => exportDatabase(block, true) }
    ];
    actions.splice(3, 0, ...databaseActions);
  }
  else if (block.type === "data_view") actions.splice(3, 0, { label: "刷新 DQL 查询", run: () => { renderAllPanels(); } });
  else if (block.type === "paragraph" && parseGfmTable(markdownFromContent(block.content))) actions.splice(3, 0, { label: "转换为普通数据表", run: () => convertGfmBlockToDatabase(block) });
  showMenu(anchor, actions);
}

type OrdinaryLinkSidebarEntry = {
  key: string;
  sourceBlockId: string;
  documentId: string;
  blockId?: string;
  targetScope?: ReferenceTargetScope;
  label: string;
  excerpt: string;
};

function ordinaryLinkReference(link: OrdinaryLinkSidebarEntry) {
  return state?.references.find(reference =>
    reference.hostBlockId === link.sourceBlockId &&
    reference.targetDocumentId === link.documentId &&
    (reference.targetBlockId ?? "") === (link.blockId ?? ""));
}

function setOrdinaryLinkReferenceMode(link: OrdinaryLinkSidebarEntry, mode: ReferenceMode) {
  if (!state) return;
  const existing = ordinaryLinkReference(link);
  if (existing) {
    setReferenceMode(existing, mode);
    return;
  }
  const hostReference = state.references.find(reference => reference.hostBlockId === link.sourceBlockId);
  if (hostReference) {
    saveStatus.textContent = "同一正文块已有其他引用，请将其拆分到独立块后再设置显示方式";
    return;
  }
  void post({
    type: "createReference",
    hostBlockId: link.sourceBlockId,
    targetDocumentId: link.documentId,
    targetBlockId: link.blockId,
    targetScope: link.targetScope
  }).then(() => {
    const created = ordinaryLinkReference(link);
    if (created && mode !== "inline") setReferenceMode(created, mode);
  });
}

function showOrdinaryLinkModeMenu(anchor: HTMLElement, link: OrdinaryLinkSidebarEntry) {
  const existing = ordinaryLinkReference(link);
  showMenu(anchor, [
    { label: "仅标题链接", run: () => { if (existing) setReferenceMode(existing, "link"); else renderRelations(); } },
    { label: "正文直显", run: () => setOrdinaryLinkReferenceMode(link, "inline") },
    { label: "折叠卡片", run: () => setOrdinaryLinkReferenceMode(link, "collapsed") },
    { label: "右侧分栏", run: () => setOrdinaryLinkReferenceMode(link, "sidebar") }
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

async function copyBlockLink(block: Block) {
  if (!state) return;
  const document = state.documents.find(item => item.id === state!.note.id);
  const notebook = document?.notebookName ?? "当前笔记本";
  const link = `[[${notebook}/${state.note.title}#^${block.id}]]`;
  try {
    await navigator.clipboard?.writeText(link);
    saveStatus.textContent = "块链接已复制，可粘贴到 [[ 联想中使用";
  } catch {
    showError("无法访问剪贴板，请手动复制块链接");
  }
}

function suggestionPreview(blocks: Block[]) {
  return blocks.slice(0, 6).map(block => {
    if (block.type === "database_table" || block.type === "data_view") return renderDatabaseTablePreview(block).outerHTML;
    const source = markdownFromContent(block.content);
    return source ? markdownHtml(source, block.content.links) : escapeText(block.content.text || "");
  }).filter(Boolean).join("<hr>");
}

function suggestionItems(query: string): LinkSuggestion[] {
  if (!state) return [];
  const result = queryLinkSuggestions(query, state, suggestionPreview);
  linkMenuStage = result.stage;
  linkMenuTrail = result.trail;
  return result.items;
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
  const context = document.createElement("div");
  context.className = "link-suggestion-context";
  const stageLabel = linkMenuStage === "notebook" ? "选择笔记本" : linkMenuStage === "document" ? "选择文档" : "选择正文块";
  context.innerHTML = `<span>笔记本 / 文档 / 块</span><strong>${escapeText(linkMenuTrail.length ? `${linkMenuTrail.join(" / ")} · ${stageLabel}` : stageLabel)}</strong>`;
  linkSuggestions.append(context);
  if (!linkMenuItems.length) {
    const empty = document.createElement("div");
    empty.className = "link-suggestion-empty";
    empty.textContent = linkMenuStage === "notebook" ? "没有匹配的笔记本" : linkMenuStage === "document" ? "该笔记本没有匹配的文档" : "该文档没有匹配的正文块";
    linkSuggestions.append(empty);
  }
  linkMenuItems.forEach((item, index) => {
    const button = document.createElement("button");
    button.className = `link-suggestion ${index === linkMenuIndex ? "active" : ""}`;
    button.dataset.kind = item.kind;
    if ((item.kind === "target" || item.kind === "heading") && item.blockId) button.dataset.blockId = item.blockId;
    if (item.kind === "target" && !item.blockId) {
      // The document target is an insertion shortcut, not a document preview.
      // Keep it deliberately compact so the block-level results remain scannable.
      button.textContent = "整篇文档";
      button.setAttribute("aria-label", "整篇文档");
    } else if ((item.kind === "target" || item.kind === "heading") && item.blockId) {
      button.setAttribute("aria-label", `${item.label} · ${item.meta}`);
      const preview = document.createElement("span");
      preview.className = "link-suggestion-block-line";
      preview.innerHTML = item.preview || escapeText(item.label);
      button.append(preview);
    } else {
      button.innerHTML = `<strong>${escapeText(item.title)}</strong><span>${escapeText(item.meta)}</span>`;
    }
    if (item.preview && !((item.kind === "target" || item.kind === "heading") && item.blockId)) {
      const preview = document.createElement("div");
      preview.className = "link-suggestion-preview";
      preview.innerHTML = item.preview;
      button.append(preview);
    }
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

function activeInlineQueryRange() {
  const selection = window.getSelection();
  if (!activeEditable || !selection?.rangeCount || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(activeEditable);
  try { beforeRange.setEnd(selection.anchorNode!, selection.anchorOffset); } catch { return null; }
  const marker = beforeRange.toString().lastIndexOf("[[");
  if (marker < 0) return null;
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
  if (!startNode) return null;
  range.setStart(startNode, Math.min(startOffset, startNode.length));
  return { selection, range };
}

function replaceInlineSuggestionQuery(value: string) {
  const active = activeInlineQueryRange();
  if (!active || !activeEditable) return;
  active.range.deleteContents();
  const text = document.createTextNode(`[[${value}`);
  active.range.insertNode(text);
  active.range.setStartAfter(text);
  active.range.collapse(true);
  active.selection.removeAllRanges();
  active.selection.addRange(active.range);
  activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertInlineSuggestion(item: LinkSuggestion) {
  if (item.kind === "notebook") {
    replaceInlineSuggestionQuery(`${item.title}/`);
    return;
  }
  if (item.kind === "document") {
    replaceInlineSuggestionQuery(`${item.notebookName}/${item.title}/`);
    return;
  }
  const active = activeInlineQueryRange();
  if (!active || !activeEditable) return;
  const { selection, range } = active;
  range.deleteContents();
  const targetLabel = item.kind === "heading" ? item.label : item.label;
  const targetTitle = item.kind === "heading" ? (item.documentTitle ?? item.label) : item.label;
  const sourceTarget = item.kind === "heading"
    ? `${item.notebookName ? `${item.notebookName}/` : ""}${item.documentTitle ?? item.label}#${item.label}`
    : `${item.notebookName && item.documentTitle ? `${item.notebookName}/` : ""}${item.documentTitle ?? item.label}${item.blockId ? `#^${item.blockId}` : ""}`;
  if (editorMode === "source") {
    const source = `[[${sourceTarget}]]`;
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
  link.dataset.targetTitle = targetTitle;
  if (item.kind === "heading") {
    link.dataset.targetHeading = item.label;
    link.dataset.targetScope = "heading";
  }
  link.textContent = targetLabel;
  range.insertNode(link);
  range.setStartAfter(link);
  range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range);
  hideInlineLinkSuggestions();
  activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertCalendarLink(targetDocumentId: string, targetBlockId?: string, targetScope?: ReferenceTargetScope, label = "日记") {
  if (canvasContext) {
    if (!ui.canvasInsertCalendarLink?.(targetDocumentId, targetBlockId, targetScope, label)) showError(new Error("请先在 Canvas 中选择一个内容块"));
    return;
  }
  if (editorMode === "preview") return;
  const editable = lastEditorCaret?.editable?.isConnected ? lastEditorCaret.editable : activeEditable;
  if (!editable) { saveStatus.textContent = "请先把光标放在正文中"; return; }
  const selection = window.getSelection();
  const range = selection?.rangeCount && editable.contains(selection.anchorNode)
    ? selection.getRangeAt(0).cloneRange()
    : lastEditorCaret?.editable === editable ? lastEditorCaret.range.cloneRange() : null;
  if (!range) { saveStatus.textContent = "请先把光标放在正文中"; return; }
  const target = state?.documents.find(document => document.id === targetDocumentId);
  const notebook = target?.notebookName ?? "日记";
  const title = target?.title ?? "日记";
  const sourceTarget = `${notebook}/${title}${targetBlockId ? targetScope === "heading" ? `#${label}` : `#^${targetBlockId}` : ""}`;
  range.deleteContents();
  if (editorMode === "source") {
    const text = document.createTextNode(`[[${sourceTarget}|📅 ${label}]]`);
    range.insertNode(text); range.setStartAfter(text); range.collapse(true);
  } else {
    const link = document.createElement("span");
    link.className = "wiki-link calendar-link"; link.contentEditable = "false";
    link.dataset.targetId = targetDocumentId; link.dataset.targetTitle = title;
    if (targetBlockId) link.dataset.targetBlockId = targetBlockId;
    if (targetScope === "heading") { link.dataset.targetHeading = label; link.dataset.targetScope = "heading"; }
    link.textContent = `📅 ${label}`;
    range.insertNode(link); range.setStartAfter(link); range.collapse(true);
  }
  selection?.removeAllRanges(); selection?.addRange(range);
  activeEditable = editable; editable.focus({ preventScroll: true });
  editable.dispatchEvent(new Event("input", { bubbles: true }));
  saveStatus.textContent = "已插入日记普通链接";
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

function addBlock(type: BlockType, options: { focusFirst?: boolean } = {}) {
  if (editorMode === "preview") return;
  if (!state) return;
  const block = createBlock(type);
  if (type === "heading") block.properties.headingLevel = 1;
  state.blocks.push(block);
  const shell = renderOwnBlockShell(block);
  blockSurface.append(shell);
  if (options.focusFirst !== false) shell.querySelector<HTMLElement>(".block-text")?.focus();
  scheduleDocumentSave(0);
}

function insertLocationBlock(locationId: string) {
  if (canvasContext) {
    if (!ui.canvasInsertLocationBlock?.(locationId)) showError(new Error("位置不存在或未选择 Canvas 内容块"));
    return;
  }
  if (editorMode === "preview" || !state) return;
  const location = state.locations?.find(item => item.id === locationId && !item.deletedAt);
  if (!location) { showError(new Error("位置不存在或已删除")); return; }
  const block = createBlock("location");
  block.properties = { ...block.properties, locationId };
  state.blocks.push(block);
  const anchor = activeBlock?.dataset.id ? state.blocks.find(item => item.id === activeBlock?.dataset.id && item.id !== block.id) : undefined;
  if (anchor) insertBlocksRelative([block], anchor, "after");
  else { block.parentId = null; block.position = nextPosition(null); }
  renderAllPanels();
  blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`)?.scrollIntoView({ block: "nearest" });
  activeBlock = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`) ?? null;
  scheduleDocumentSave(0);
}

function focusFirstBodyBlock() {
  const first = blockSurface.querySelector<HTMLElement>(":scope > [data-own-block] .block-text")
    ?? blockSurface.querySelector<HTMLElement>("[data-own-block] .block-text");
  if (first) {
    first.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(first);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return;
  }
  addBlock("paragraph", { focusFirst: true });
}

function addDatabaseTable() {
  if (editorMode === "preview" || !state) return;
  const databaseId = `db-${newId()}`;
  const fields: DatabaseField[] = [
    { id: `field-${newId()}`, databaseId, key: "name", title: "名称", type: "text", position: "00001000" },
    { id: `field-${newId()}`, databaseId, key: "amount", title: "金额", type: "number", position: "00002000" },
    { id: `field-${newId()}`, databaseId, key: "total", title: "合计", type: "formula", formula: 'prop("amount") * 1', position: "00003000" }
  ];
  void executeDatabaseCommand({ operation: "create-database", databaseId, database: { id: databaseId, title: "新数据库", fields, recordCount: 0 }, fields }, "create-database").then(() => {
    const block = createBlock("database_table"); block.properties.databaseId = databaseId; block.properties.databaseSource = "database"; state!.blocks.push(block); state!.blocks = orderBlockTree(state!.blocks); renderAllPanels();
    const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`);
    if (shell) activateOwnBlock(shell, true);
    scheduleDocumentSave(0);
  }).catch(showError);
}

function addDataView() {
  if (editorMode === "preview" || !state) return;
  const database = state.databases?.[0];
  if (!database) { saveStatus.textContent = "请先插入一个数据库表"; return; }
  const block = createBlock("data_view"); block.properties.databaseId = database.id; block.properties.dataQuery = `TABLE ${database.fields.map(field => field.key).join(", ")}\nFROM current\nLIMIT 50`;
  state.blocks.push(block); state.blocks = orderBlockTree(state.blocks); renderAllPanels();
  const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`);
  if (shell) activateOwnBlock(shell, true);
  scheduleDocumentSave(0);
}

function parseGfmTable(source: string) {
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2 || !/^\|?\s*:?-{3,}/.test(lines[1])) return null;
  const cells = (line: string) => line.replace(/^\||\|$/g, "").split("|").map(value => value.trim());
  const headers = cells(lines[0]);
  const rows = lines.slice(2).map(cells).filter(row => row.some(Boolean));
  return headers.length ? { headers, rows } : null;
}

function convertGfmBlockToDatabase(block: Block) {
  if (!state) return;
  const parsed = parseGfmTable(markdownFromContent(block.content));
  if (!parsed) { saveStatus.textContent = "当前块不是可转换的 GFM 表格"; return; }
  const databaseId = `db-${newId()}`;
  const usedKeys = new Set<string>();
  const fields: DatabaseField[] = parsed.headers.map((title, index) => {
    const base = title.toLowerCase().replace(/[^a-z0-9_]+/g, "_") || `field_${index + 1}`;
    let key = base; let suffix = 2; while (usedKeys.has(key)) key = `${base}_${suffix++}`; usedKeys.add(key);
    return { id: `field-${newId()}`, databaseId, key, title, type: "text", position: String((index + 1) * 1000).padStart(8, "0") };
  });
  let chain = executeDatabaseCommand({ operation: "create-database", databaseId, database: { id: databaseId, title: block.content.text || "数据表", fields, recordCount: 0 }, fields }, "create-database").then(() => {
    return parsed.rows.reduce((tail, values, rowIndex) => tail.then(() => executeDatabaseCommand({ operation: "upsert-database-record", databaseId, record: { id: `record-${newId()}`, databaseId, position: String((rowIndex + 1) * 1000).padStart(8, "0"), sourceDocumentId: state!.note.id, sourceBlockId: block.id, values: Object.fromEntries(fields.map((field, index) => [field.key, values[index] ?? ""])) } }, "database-record").then(() => undefined)), Promise.resolve());
  }).then(() => {
    const current = state?.blocks.find(item => item.id === block.id); if (!current || !state) return;
    current.type = "database_table"; current.properties = { ...current.properties, databaseId, databaseSource: "gfm" }; current.content = { text: "", html: "" };
    renderAllPanels();
    const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(current.id)}"]`);
    if (shell) activateOwnBlock(shell, true);
    scheduleDocumentSave(0);
  });
  void chain.catch(showError);
}

function convertDatabaseBlockToMarkdown(block: Block) {
  const database = databaseForBlock(block); if (!database || !state) return;
  const records = state.databaseRecords?.[database.id] ?? [];
  const header = `| ${database.fields.map(field => field.title).join(" | ")} |`;
  const divider = `| ${database.fields.map(() => "---").join(" | ")} |`;
  const rows = records.map(record => `| ${database.fields.map(field => String(record.values[field.key] ?? "")).join(" | ")} |`);
  block.type = "paragraph"; block.properties = { ...block.properties, databaseId: undefined }; block.content = { text: [header, divider, ...rows].join("\n"), html: "", markdown: [header, divider, ...rows].join("\n") };
  renderAllPanels(); scheduleDocumentSave(0);
}

function exportDatabase(block: Block, csv: boolean) {
  const database = databaseForBlock(block); if (!database || !state) return;
  void host.executeCommand({ operation: csv ? "export-database-csv" : "export-database-markdown", databaseId: database.id }, state.note.id)
    .then(result => { if (result.content) downloadText(result.content, result.fileName ?? `${database.title}.${csv ? "csv" : "md"}`, result.mimeType ?? "text/plain"); })
    .catch(showError);
}

function mediaKindForMime(mimeType: string): MediaKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  return "file";
}

function filesFromTransfer(transfer: DataTransfer | null | undefined) {
  if (!transfer) return [];
  const files = [...transfer.items]
    .filter(item => item.kind === "file")
    .map(item => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (files.length) return files;
  return [...transfer.files];
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

async function insertMediaFiles(files: readonly File[], anchor?: HTMLElement | null) {
  if (!state || editorMode === "preview") return;
  const accepted = files.filter(file => file.size >= 0);
  if (!accepted.length) {
    showError(new Error("请选择可读取的媒体文件。"));
    return;
  }
  const anchorShell = anchor?.closest<HTMLElement>("[data-own-block]") ?? activeBlock;
  let anchorBlock = anchorShell?.dataset.id ? state.blocks.find(block => block.id === anchorShell.dataset.id) : undefined;
  const failures: string[] = [];
  let inserted = 0;
  for (const file of accepted) {
    try {
      const data = await fileToBase64(file);
      const result = await host.storeMedia({ name: file.name, mimeType: file.type, size: file.size, data });
      const asset = result.media;
      const block = createBlock("media");
      block.parentId = anchorBlock?.parentId ?? null;
      if (anchorBlock?.properties.columnGroup) {
        block.properties = {
          columnGroup: anchorBlock.properties.columnGroup,
          column: columnIndex(anchorBlock),
          columnWidths: anchorBlock.properties.columnWidths
        };
      }
      block.position = anchorBlock ? anchorBlock.position : nextPosition(block.parentId);
      block.content = { text: asset.name, html: "", media: asset };
      state.blocks.push(block);
      if (anchorBlock) {
        insertBlocksRelative([block], anchorBlock, "after");
        anchorBlock = block;
      }
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
  const group = `columns-${newId()}`;
  const position = nextPosition(null);
  const first = createBlock("paragraph");
  first.position = position;
  first.properties = { columnGroup: group, column: 0, columnWidths: [1, 1] };
  const second = createBlock("paragraph");
  second.position = position;
  second.properties = { columnGroup: group, column: 1, columnWidths: [1, 1] };
  state.blocks.push(first, second);
  state.blocks = orderBlockTree(state.blocks);
  renderAllPanels();
  blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(first.id)}"] .block-text`)?.focus();
  scheduleDocumentSave(0);
}

function addColumnChild(groupId: string, column: number) {
  if (editorMode === "preview" || !state) return;
  const members = state.blocks.filter(block => block.properties.columnGroup === groupId && columnIndex(block) === column);
  if (!members.length) return;
  const child = createBlock("paragraph");
  child.position = String((Math.max(0, ...members.map(block => Number(block.position))) + 1000)).padStart(8, "0");
  child.properties = { columnGroup: groupId, column, columnWidths: members.find(block => block.properties.columnWidths)?.properties.columnWidths };
  state.blocks.push(child);
  state.blocks = orderBlockTree(state.blocks);
  renderAllPanels();
  blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(child.id)}"] .block-text`)?.focus();
  scheduleDocumentSave(0);
}

function restoreColumns(shell: HTMLElement) {
  if (!state) return;
  if (shell.dataset.columnGroup) restoreColumnGroup(shell.dataset.columnGroup);
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
  const ids = selectedBlockIds.size > 1 ? selectedBlockIds : new Set([shell.dataset.id!]);
  blockSurface.querySelectorAll<HTMLElement>("[data-own-block]").forEach(target => {
    const id = target.dataset.id;
    if (!id || !ids.has(id)) return;
    const block = state!.blocks.find(item => item.id === id);
    if (!block) return;
    block.properties = { ...block.properties, textAlign: value };
    const text = target.querySelector<HTMLElement>(":scope > .block-row > .block-text");
    if (text) text.style.textAlign = value;
    const mediaStage = target.querySelector<HTMLElement>(":scope > .block-row .media-stage");
    if (mediaStage) mediaStage.dataset.mediaAlign = value;
  });
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
  const previewOnlyDisabled = ["add-paragraph", "add-heading", "add-todo", "add-columns", "add-media", "add-database", "add-query", "bold", "italic", "highlight", "outdent", "indent", "move-up", "move-down", "align"];
  previewOnlyDisabled.forEach(id => {
    const button = document.querySelector<HTMLButtonElement>(`#${id}`);
    if (button) button.disabled = editorMode === "preview";
  });
  document.querySelectorAll<HTMLInputElement>("#text-color, #background-color").forEach(input => input.disabled = editorMode !== "rich");
}

async function switchEditorMode(next: EditorMode) {
  if (next === editorMode) return;
  const activeId = activeBlock?.dataset.id;
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
  renderAllPanels();
  if (activeId) {
    const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(activeId)}"]`);
    if (shell) activateOwnBlock(shell, true);
  }
  saveStatus.textContent = editorMode === "preview" ? "预览模式" : editorMode === "source" ? "Markdown 源码模式" : "编辑模式";
}

function selectedOwnBlock() { return selectedReferenceRow() ? null : activeEditable?.closest<HTMLElement>("[data-own-block]") ?? activeBlock; }
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
    if (block?.properties.columnGroup) saveStatus.textContent = "分列中的块请使用左右拖拽调整";
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
document.querySelector("#add-database")?.addEventListener("click", addDatabaseTable);
document.querySelector("#add-query")?.addEventListener("click", addDataView);
document.querySelector("#add-location")?.addEventListener("click", () => ui.showLocations?.());
document.querySelector<HTMLInputElement>("#media-file-input")?.addEventListener("change", event => {
  const input = event.target as HTMLInputElement;
  const files = input.files ? [...input.files] : [];
  input.value = "";
  void insertMediaFiles(files, activeBlock);
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
document.addEventListener("selectionchange", () => {
  rememberStyleSelection();
  rememberEditorCaret();
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode) return;
  const anchorElement = selection.anchorNode instanceof Element
    ? selection.anchorNode
    : selection.anchorNode.parentElement;
  const card = anchorElement?.closest<HTMLElement>(".reference-card:not(.sidebar)");
  if (!card) return;
  const referenceId = card.dataset.referenceId;
  const reference = referenceId ? state?.references.find(item => item.id === referenceId) : undefined;
  const modeAnchor = card.querySelector<HTMLElement>(".reference-mode-menu");
  if (reference && modeAnchor) showReferenceMenu(modeAnchor, undefined, reference);
});
document.addEventListener("paste", event => {
  const target = event.target as HTMLElement | null;
  if (!target?.closest(".block-text[contenteditable='true'], .media-name[contenteditable='true']")) return;
  const files = filesFromTransfer(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  void insertMediaFiles(files, target.closest<HTMLElement>("[data-own-block]") ?? activeBlock);
}, true);
document.addEventListener("copy", event => {
  const remembered = styleSelection;
  if (!remembered || remembered.editable === remembered.endEditable || !event.clipboardData) return;
  const text = selectedEditableRanges(remembered.start, remembered.end).map(range => range.toString()).join("\n");
  if (!text) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", text);
});
document.addEventListener("pointerdown", beginCrossBlockSelection, true);
document.addEventListener("pointermove", updateCrossBlockSelection, true);
document.addEventListener("pointerup", finishCrossBlockSelection, true);
document.addEventListener("pointercancel", finishCrossBlockSelection, true);
document.addEventListener("input", (event) => {
  const input = event as InputEvent;
  if (event.target !== editTarget || Date.now() - editTime > 900 || input.inputType && !["insertText", "deleteContentBackward", "deleteContentForward", "insertCompositionText", "insertFromComposition"].includes(input.inputType)) editGroup = newId();
  editTarget = event.target; editTime = Date.now();
  const editable = (event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text[contenteditable='true'], .block-text[contenteditable='plaintext-only']");
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
  const editable = (event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text[contenteditable='true'], .block-text[contenteditable='plaintext-only']");
  if (editable && !linkSuggestions.hidden) handleInlineLinkKeys(event);
}, true);
titleInput.addEventListener("input", () => scheduleDocumentSave());
titleInput.addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (editorMode === "preview") return;
  insertFirstBodyBlock();
});
document.querySelectorAll<HTMLButtonElement>(".icon-tools button").forEach((button) => button.addEventListener("mousedown", (event) => event.preventDefault()));
updateEditorModeUi();

// ─────────────────────────────────────────────────────────────────────────────
// Drag & drop for block reordering
// ─────────────────────────────────────────────────────────────────────────────

function clearDropIndicator() {
  document.querySelectorAll(".block-shell").forEach(el => {
    el.classList.remove("drop-before", "drop-after", "drop-child", "drop-column-side", "drop-column-left", "drop-column-right");
  });
  document.querySelectorAll(".columns-row").forEach(el => el.classList.remove("drop-before", "drop-after"));
  document.querySelectorAll(".column-divider").forEach(el => el.classList.remove("drop-target"));
  dropIndicator = null;
  columnDropIndicator = null;
}

function setDropIndicator(targetShell: HTMLElement, position: "before" | "after" | "child") {
  clearDropIndicator();
  targetShell.classList.add(position === "child" ? "drop-child" : position === "before" ? "drop-before" : "drop-after");
  dropIndicator = { targetId: targetShell.dataset.id!, position };
}

function setGroupDropIndicator(row: HTMLElement, groupId: string, position: "before" | "after") {
  clearDropIndicator();
  row.classList.add(position === "before" ? "drop-before" : "drop-after");
  dropIndicator = { groupId, position: position === "before" ? "group-before" : "group-after" };
}

function setColumnDropIndicator(targetShell: HTMLElement, side: "left" | "right") {
  clearDropIndicator();
  targetShell.classList.add("drop-column-side", side === "left" ? "drop-column-left" : "drop-column-right");
  dropIndicator = { targetId: targetShell.dataset.id!, position: side === "left" ? "column-left" : "column-right" };
}

function setColumnDividerIndicator(divider: HTMLElement, targetShell: HTMLElement, side: "left" | "right") {
  clearDropIndicator();
  divider.classList.add("drop-target");
  targetShell.classList.add("drop-column-side", side === "left" ? "drop-column-left" : "drop-column-right");
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
  const grip = (event.target as HTMLElement).closest<HTMLElement>(".grip");
  if (!grip) return;
  const groupRow = grip.classList.contains("columns-row-grip")
    ? grip.closest<HTMLElement>(".columns-row[data-column-group]")
    : null;
  if (groupRow?.dataset.columnGroup) {
    const groupId = groupRow.dataset.columnGroup;
    const members = state?.blocks.filter(block => block.properties.columnGroup === groupId) ?? [];
    if (!members.length) return;
    draggingColumnGroup = groupId;
    draggingBlockId = members[0].id;
    draggingBlockIds = members.map(block => block.id);
    draggingBlockIds.forEach(id => blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(id)}"]`)?.classList.add("is-dragging"));
    setDragPreview(event, members.map(block => blockSummaryForDrag(block)));
    return;
  }
  const shell = grip.closest<HTMLElement>(".block-shell[data-own-block]");
  if (!shell?.dataset.id) return;
  // Prevent dragging reference rows (they stay within their card)
  if (grip.closest(".reference-row")) return;
  draggingBlockId = shell.dataset.id;
  draggingBlockIds = selectedBlockIds.has(shell.dataset.id) && selectedBlockIds.size > 1
    ? [...selectedBlockIds]
    : [shell.dataset.id];
  draggingBlockIds.forEach(id => blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(id)}"]`)?.classList.add("is-dragging"));
  // Build the drag image from every selected block. The native browser ghost only
  // captures the element that initiated drag, so a multi-selection otherwise looks
  // like a single block even though all selected IDs will move together.
  if (event.dataTransfer) {
    event.dataTransfer.setData("text/x-block-id", shell.dataset.id);
    event.dataTransfer.setData("text/x-source-document-id", state?.note.id ?? "");
    const text = draggingBlockIds.map(id => {
      const item = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(id)}"]`);
      return item?.querySelector<HTMLElement>(".block-text")?.textContent?.trim() || "空白块";
    });
    setDragPreview(event, text);
  }
}

function blockSummaryForDrag(block: Block) {
  return plainTextFromContent(block.content).trim() || (block.type === "media" ? block.content.media?.name : block.type === "database_table" ? "数据库表" : "空白块") || "空白块";
}

function setDragPreview(event: DragEvent, values: string[]) {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData("text/plain", values.join("\n"));
  event.dataTransfer.effectAllowed = "move";
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost drag-ghost-multi";
  values.forEach((value, index) => {
    const item = document.createElement("div");
    item.className = "drag-ghost-item";
    item.dataset.index = String(index + 1);
    item.textContent = value.length > 100 ? `${value.slice(0, 100)}…` : value;
    ghost.append(item);
  });
  ghost.style.position = "absolute";
  ghost.style.top = "-1000px";
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost, 14, 14);
  setTimeout(() => ghost.remove(), 0);
}

function handleDragOver(event: DragEvent) {
  if (event.dataTransfer?.types.includes("Files")) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    blockSurface.classList.add("media-drop-active");
    return;
  }
  const sourceDocumentId = event.dataTransfer?.getData("text/x-source-document-id");
  // Same-document drags use the same payload for the native drag preview, but
  // must continue through the ordering/column drop-zone logic. Only a block
  // whose source document differs from the active document is an import.
  const externalBlock = event.dataTransfer?.types.includes("text/x-block-id") && Boolean(sourceDocumentId) && sourceDocumentId !== state?.note.id;
  if (externalBlock && state) {
    event.preventDefault();
    if (event.dataTransfer) { event.dataTransfer.dropEffect = "copy"; }
    blockSurface.classList.add("external-block-drop-active");
    return;
  }
  if (!draggingBlockId) return;
  const row = (event.target as HTMLElement).closest<HTMLElement>(".columns-row[data-column-group]");
  if (draggingColumnGroup) {
    if (row?.dataset.columnGroup) {
      if (row.dataset.columnGroup === draggingColumnGroup) return;
      const rowRect = row.getBoundingClientRect();
      setGroupDropIndicator(row, row.dataset.columnGroup, event.clientY < rowRect.top + rowRect.height / 2 ? "before" : "after");
    } else {
      const ordinaryShell = (event.target as HTMLElement).closest<HTMLElement>(".block-shell[data-own-block]");
      if (!ordinaryShell || ordinaryShell.dataset.columnGroup) return;
      const ordinaryRect = ordinaryShell.getBoundingClientRect();
      setDropIndicator(ordinaryShell, event.clientY < ordinaryRect.top + ordinaryRect.height / 2 ? "before" : "after");
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    return;
  }
  if (row?.dataset.columnGroup) {
    const rowRect = row.getBoundingClientRect();
    const edge = Math.min(28, Math.max(14, rowRect.height * .12));
    if (event.clientY <= rowRect.top + edge) {
      setGroupDropIndicator(row, row.dataset.columnGroup, "before");
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      return;
    }
    if (event.clientY >= rowRect.bottom - edge) {
      setGroupDropIndicator(row, row.dataset.columnGroup, "after");
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      return;
    }
  }
  const shell = (event.target as HTMLElement).closest<HTMLElement>(".block-shell[data-own-block]");
  const divider = (event.target as HTMLElement).closest<HTMLElement>(".column-divider");
  if (divider) {
    const grid = divider.closest<HTMLElement>(".columns-grid");
    const index = Number(divider.dataset.column);
    const tracks = grid ? [...grid.querySelectorAll<HTMLElement>(":scope > .column-track")] : [];
    const next = tracks[index + 1]?.querySelector<HTMLElement>(":scope > .block-shell[data-own-block]");
    const previous = tracks[index]?.querySelector<HTMLElement>(":scope > .block-shell[data-own-block]:last-child");
    if (next) setColumnDividerIndicator(divider, next, "left");
    else if (previous) setColumnDividerIndicator(divider, previous, "right");
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    return;
  }
  if (!shell || !shell.dataset.id || shell.dataset.id === draggingBlockId) {
    if (!shell && event.currentTarget === blockSurface) {
      clearDropIndicator();
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }
    return;
  }

  // Reference rows are not valid drop targets for own blocks
  if (shell.closest(".reference-row")) return;

  // Block being dragged cannot be dropped into its own subtree
  if (isDescendant(draggingBlockId, shell.dataset.id)) return;
  if (draggingColumnGroup && shell.dataset.columnGroup === draggingColumnGroup) return;

  const rect = shell.getBoundingClientRect();
  const horizontalRect = shell.querySelector<HTMLElement>(":scope > .block-row > .block-text")?.getBoundingClientRect() ?? rect;
  const relX = (event.clientX - horizontalRect.left) / Math.max(1, horizontalRect.width);
  const relY = (event.clientY - rect.top) / Math.max(1, rect.height);
  const horizontalEdge = Math.min(0.12, 32 / Math.max(1, horizontalRect.width));
  if (relX < horizontalEdge) setColumnDropIndicator(shell, "left");
  else if (relX > 1 - horizontalEdge) setColumnDropIndicator(shell, "right");
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
  if (event.dataTransfer?.types.includes("text/x-block-id")) {
    const related = event.relatedTarget as Node | null;
    if (!related || !blockSurface.contains(related)) blockSurface.classList.remove("external-block-drop-active");
  }
  const related = event.relatedTarget as HTMLElement | null;
  const shell = (event.target as HTMLElement).closest<HTMLElement>(".block-shell[data-own-block]");
  if (!shell || (related && shell.contains(related))) return;
  shell.classList.remove("drop-before", "drop-after", "drop-child", "drop-column-side", "drop-column-left", "drop-column-right");
}

function clearBlockColumnPlacement(block: Block) {
  const { columnGroup: _group, column: _column, columnWidths: _widths, ...properties } = block.properties;
  block.properties = properties;
  block.parentId = null;
}

function setColumnMember(block: Block, groupId: string, column: number, widths?: number[]) {
  block.parentId = null;
  block.properties = { ...block.properties, columnGroup: groupId, column, columnWidths: widths ?? [1, 1] };
}

function normalizeColumnGroup(groupId: string) {
  if (!state) return;
  const members = state.blocks.filter(block => block.properties.columnGroup === groupId);
  const columns = [...new Set(members.map(columnIndex))].sort((a, b) => a - b);
  if (columns.length < 2) {
    const items = rootMoveItems();
    const groupIndex = items.findIndex(item => item.key === `group:${groupId}`);
    const restored = members
      .sort((a, b) => a.position.localeCompare(b.position) || a.id.localeCompare(b.id))
      .map(block => {
        const { columnGroup: _group, column: _column, columnWidths: _widths, ...properties } = block.properties;
        block.properties = properties;
        block.parentId = null;
        return { key: block.id, blocks: [block] };
      });
    if (groupIndex >= 0) {
      items.splice(groupIndex, 1, ...restored);
      applyRootMoveOrder(items);
    }
    return;
  }
  const remap = new Map(columns.map((column, index) => [column, index]));
  const widths = members.find(block => block.properties.columnWidths)?.properties.columnWidths ?? [];
  members.forEach(block => {
    block.properties = { ...block.properties, column: remap.get(columnIndex(block)) ?? 0, columnWidths: columns.map(column => widths[column] ?? 1) };
  });
}

function insertBlocksRelative(blocks: Block[], target: Block, position: "before" | "after") {
  if (!state) return;
  const groupId = target.properties.columnGroup;
  const column = groupId ? columnIndex(target) : undefined;
  const movedIds = new Set(blocks.map(block => block.id));
  const siblings = state.blocks.filter(candidate => !movedIds.has(candidate.id) && candidate.parentId === null &&
    (groupId ? candidate.properties.columnGroup === groupId && columnIndex(candidate) === column : !candidate.properties.columnGroup));
  siblings.sort((left, right) => left.position.localeCompare(right.position) || left.id.localeCompare(right.id));
  const targetIndex = siblings.findIndex(candidate => candidate.id === target.id);
  const insertion = Math.max(0, targetIndex + (position === "after" ? 1 : 0));
  siblings.splice(Math.min(insertion, siblings.length), 0, ...blocks);
  siblings.forEach((candidate, index) => { candidate.position = String((index + 1) * 1000).padStart(8, "0"); });
}

function handleDrop(event: DragEvent) {
  event.preventDefault();
  const files = event.dataTransfer?.files ? [...event.dataTransfer.files] : [];
  if (files.length) {
    blockSurface.classList.remove("media-drop-active");
    clearDropIndicator();
    draggingBlockId = null;
    draggingColumn = null;
    void insertMediaFiles(files, event.target as HTMLElement);
    return;
  }
  const externalBlockId = event.dataTransfer?.getData("text/x-block-id");
  const sourceDocumentId = event.dataTransfer?.getData("text/x-source-document-id");
  if (externalBlockId && sourceDocumentId && state && sourceDocumentId !== state.note.id && !draggingBlockId) {
    event.preventDefault();
    const choice = window.prompt("将此块插入当前文档：输入 1 作为引用，输入 2 复制一份", "1");
    const mode = choice === "2" ? "copy" : choice === "1" ? "reference" : null;
    if (mode) {
      const targetShell = (event.target as HTMLElement).closest<HTMLElement>(".block-shell[data-own-block]");
      const targetBlockId = targetShell?.dataset.id;
      const targetRect = targetShell?.getBoundingClientRect();
      const insertAfter = !!targetRect && event.clientY > targetRect.top + targetRect.height / 2;
      void host.executeCommand({ operation: "transfer-block", sourceDocumentId, targetDocumentId: state.note.id, blockId: externalBlockId, mode, beforeBlockId: targetBlockId, insertAfter }, state.note.id)
        .then(result => applyServerState(result.state, "transfer-block"))
        .catch(showError);
    }
    clearDropIndicator();
    blockSurface.classList.remove("external-block-drop-active");
    return;
  }
  if (!draggingBlockId || !state) {
    clearDropIndicator();
    draggingBlockId = null;
    return;
  }
  const targetId = dropIndicator?.targetId;
  const targetGroupId = dropIndicator?.groupId;
  const position = dropIndicator?.position;
  const draggedBlocks = state.blocks.filter(block => draggingBlockIds.includes(block.id));
  const draggedBlock = draggedBlocks.find(block => block.id === draggingBlockId) ?? draggedBlocks[0];
  const targetBlock = targetId ? state.blocks.find(block => block.id === targetId) : undefined;
  if (!draggedBlock) { clearDropIndicator(); draggingBlockId = null; return; }
  if (targetBlock && draggedBlocks.some(block => block.id === targetBlock.id)) { clearDropIndicator(); draggingBlockId = null; draggingBlockIds = []; return; }
  const rootItemsBeforeMove = rootMoveItems();
  if (draggingColumnGroup) {
    const groupId = draggingColumnGroup;
    const items = rootMoveItems();
    const sourceIndex = items.findIndex(item => item.key === `group:${groupId}`);
    if (sourceIndex < 0) { clearDropIndicator(); draggingColumnGroup = null; draggingBlockId = null; draggingBlockIds = []; return; }
    let targetIndex = -1;
    let offset = 0;
    if ((position === "group-before" || position === "group-after") && targetGroupId) {
      targetIndex = items.findIndex(item => item.key === `group:${targetGroupId}`);
      offset = position === "group-after" ? 1 : 0;
    } else if (targetBlock && !targetBlock.properties.columnGroup && (position === "before" || position === "after")) {
      targetIndex = items.findIndex(item => item.key === targetBlock.id);
      offset = position === "after" ? 1 : 0;
    }
    if (targetIndex >= 0 && targetIndex !== sourceIndex) {
      const [moved] = items.splice(sourceIndex, 1);
      const insertion = Math.max(0, Math.min(items.length, targetIndex - (sourceIndex < targetIndex ? 1 : 0) + offset));
      items.splice(insertion, 0, moved);
      applyRootMoveOrder(items);
      state.blocks = orderBlockTree(state.blocks);
      renderAllPanels();
      scheduleDocumentSave(0);
    }
    clearDropIndicator();
    draggingColumnGroup = null;
    draggingBlockId = null;
    draggingBlockIds = [];
    return;
  }
  const affectedGroups = new Set(draggedBlocks.map(block => block.properties.columnGroup).filter((id): id is string => Boolean(id)));
  draggedBlocks.forEach(clearBlockColumnPlacement);
  affectedGroups.forEach(normalizeColumnGroup);
  if ((position === "group-before" || position === "group-after") && targetGroupId) {
    const movedIds = new Set(draggedBlocks.map(block => block.id));
    const items = rootMoveItems().filter(item => !item.blocks.some(block => movedIds.has(block.id)));
    const targetIndex = items.findIndex(item => item.key === `group:${targetGroupId}`);
    if (targetIndex >= 0) {
      const movedItems = draggedBlocks.map(block => ({ key: block.id, blocks: [block] }));
      const insertion = targetIndex + (position === "group-after" ? 1 : 0);
      items.splice(Math.min(items.length, insertion), 0, ...movedItems);
      applyRootMoveOrder(items);
    } else {
      // The target group may have dissolved because the dragged block was its
      // last member in one column. Reuse the old group's member positions so a
      // drop above/below still lands at the visible group location.
      const previousGroup = rootItemsBeforeMove.find(item => item.key === `group:${targetGroupId}`);
      const remainingTargetIds = new Set((previousGroup?.blocks ?? []).map(block => block.id).filter(id => !movedIds.has(id)));
      const targetIndices = items.flatMap((item, index) => item.blocks.some(block => remainingTargetIds.has(block.id)) ? [index] : []);
      const insertion = targetIndices.length
        ? (position === "group-after" ? Math.max(...targetIndices) + 1 : Math.min(...targetIndices))
        : Math.min(items.length, rootItemsBeforeMove.findIndex(item => item.key === `group:${targetGroupId}`));
      const movedItems = draggedBlocks.map(block => ({ key: block.id, blocks: [block] }));
      items.splice(Math.max(0, insertion), 0, ...movedItems);
      applyRootMoveOrder(items);
    }
  } else if (!targetBlock) {
    draggedBlocks.forEach(block => { block.position = nextPosition(null); });
  } else if (position === "column-left" || position === "column-right") {
    let groupId = targetBlock.properties.columnGroup;
    if (!groupId) {
      groupId = `columns-${newId()}`;
      const targetPosition = targetBlock.position;
      setColumnMember(targetBlock, groupId, position === "column-left" ? 1 : 0, [1, 1]);
      draggedBlocks.forEach(block => setColumnMember(block, groupId!, position === "column-left" ? 0 : 1, [1, 1]));
      targetBlock.position = targetPosition;
      draggedBlocks.forEach((block, index) => { block.position = String(Number(targetPosition) + index).padStart(8, "0"); });
    } else {
      const targetColumn = columnIndex(targetBlock);
      const insertedColumn = position === "column-left" ? targetColumn : targetColumn + 1;
      state.blocks.filter(block => block.properties.columnGroup === groupId).forEach(block => {
        if (columnIndex(block) >= insertedColumn) block.properties = { ...block.properties, column: columnIndex(block) + 1 };
      });
      const widths = state.blocks.find(block => block.properties.columnGroup === groupId)?.properties.columnWidths ?? [];
      const nextWidths = [...widths.slice(0, insertedColumn), 1, ...widths.slice(insertedColumn)];
      state.blocks.filter(block => block.properties.columnGroup === groupId).forEach(block => {
        block.properties = { ...block.properties, columnWidths: nextWidths };
      });
      draggedBlocks.forEach((block, index) => {
        setColumnMember(block, groupId!, insertedColumn, nextWidths);
        block.position = String(Number(targetBlock.position) + index).padStart(8, "0");
      });
      normalizeColumnGroup(groupId);
    }
  } else if (targetBlock) {
    if (targetBlock.properties.columnGroup) {
      draggedBlocks.forEach(block => setColumnMember(block, targetBlock.properties.columnGroup!, columnIndex(targetBlock), targetBlock.properties.columnWidths));
    }
    insertBlocksRelative(draggedBlocks, targetBlock, position === "after" ? "after" : "before");
  }
  if (targetBlock?.properties.columnGroup) normalizeColumnGroup(targetBlock.properties.columnGroup);
  state.blocks = orderBlockTree(state.blocks);
  renderAllPanels();
  recalculateDepths();
  scheduleDocumentSave(0);
  clearDropIndicator();
  draggingBlockId = null;
  draggingBlockIds = [];
}

function handleDragEnd() {
  blockSurface.classList.remove("media-drop-active");
  blockSurface.classList.remove("external-block-drop-active");
  clearDropIndicator();
  document.querySelectorAll(".column-grip").forEach(el => el.classList.remove("is-dragging"));
  draggingColumn = null;
  draggingColumnGroup = null;
  document.querySelectorAll(".block-shell").forEach(el => el.classList.remove("is-dragging"));
  draggingBlockId = null;
  draggingBlockIds = [];
}

// Register drag events on block surface (delegated)
blockSurface.addEventListener("dragstart", handleDragStart as EventListener);
blockSurface.addEventListener("dragover", handleDragOver as EventListener);
blockSurface.addEventListener("dragleave", handleDragLeave as EventListener);
blockSurface.addEventListener("drop", handleDrop as EventListener);
blockSurface.addEventListener("dragend", handleDragEnd);

void host.request("ready", {}).catch(showError);
function clear() {
  canvasContext = false;
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
async function createDiaryDocument(documentId: string, headingTitle: string) {
  // A Canvas reuses the document-shaped state for its panels, but its layout
  // owns persistence. Saving a diary heading through render()/enqueueDocumentSave
  // here would therefore try to send the diary blocks to the active Canvas.
  // Write the diary document directly while keeping the Canvas state mounted.
  if (canvasContext) {
    await flush();
    const loaded = await host.loadDocument(documentId);
    const exists = loaded.blocks.some(block => {
      const source = markdownFromContent(block.content).split(/\r?\n/).find(value => value.trim()) ?? "";
      return /^\s*#(?:[ \u3000]+|$)/.test(source) && source.replace(/^\s*#[ \u3000]*/, "").trim() === headingTitle;
    });
    if (!exists) {
      const position = String((loaded.blocks.length + 1) * 1000).padStart(8, "0");
      loaded.blocks.push({
        id: newId(), parentId: null, position, type: "heading",
        content: { text: headingTitle, html: `<h1>${escapeText(headingTitle)}</h1>`, markdown: `# ${headingTitle}` },
        properties: { headingLevel: 1 }, revision: 1
      });
      await host.saveDocument({ documentId, mutationId: newId(), clientVersion: (loaded.note.clientVersion ?? 0) + 1, title: loaded.note.title, blocks: loaded.blocks });
    }
    return;
  }
  await flush();
  const loaded = await host.loadDocument(documentId);
  const exists = loaded.blocks.some(block => {
    const source = markdownFromContent(block.content).split(/\r?\n/).find(value => value.trim()) ?? "";
    return /^\s*#(?:[ \u3000]+|$)/.test(source) && source.replace(/^\s*#[ \u3000]*/, "").trim() === headingTitle;
  });
  if (!exists) {
    const position = String((loaded.blocks.length + 1) * 1000).padStart(8, "0");
    loaded.blocks.push({
      id: newId(), parentId: null, position, type: "heading",
      content: { text: headingTitle, html: `<h1>${escapeText(headingTitle)}</h1>`, markdown: `# ${headingTitle}` },
      properties: { headingLevel: 1 }, revision: 1
    });
  }
  render(loaded);
  enqueueDocumentSave();
  await flush();
}
return {
  flush: async () => { await historyTail; await flush(); },
  showError,
  focusBlock,
  clear,
  undo: () => moveHistory("undo"),
  redo: () => moveHistory("redo"),
  restoreHistory,
  createDiaryDocument,
  insertCalendarLink,
  readOnlyProjection,
  contentFromMarkdown,
  retry: () => { saveFailure = null; commandFailure = null; enqueueDocumentSave(); },
  load: (next: EditorState) => { canvasContext = false; render(next); },
  loadCanvas: (next: EditorState) => { canvasContext = true; render(next); },
  setCanvasActiveBlock: (block?: Block) => {
    activeBlock = block ? blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`) : null;
    renderComments();
    renderDatabases();
    const isDatabase = block?.type === "database_table" || block?.type === "data_view";
    ui.setDatabaseContext?.(!!isDatabase, !!isDatabase);
  }
};
}
