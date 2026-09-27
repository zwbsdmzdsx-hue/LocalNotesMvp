import { blockWikiLink, queryLinkSuggestions, suggestionWikiTarget, type LinkSuggestion } from "./link-suggestions";
import { createRegisteredBlock as createCanonicalBlock } from "./block-modules";
import { editableContent } from "./block-content";
import type { BlockType, BlockContent, BlockProperties, Block, BlockComment, MediaAsset, ReferenceMode, ReferenceInstance, ReferenceTargetScope, EditorState, SaveMutation, RequestMap, StyleSheet } from "../../protocol/types";
import type { EditorHostApi } from "./editor-host-api";
import type { HistoryModel } from "./history";
import { orderBlockTree } from "./block-tree";
import { markdownFromContent, plainTextFromContent } from "./markdown";
import { createLinkRendering } from "./link-rendering";
import { visibleSheetBlocks, retainInactiveSheetBlocks } from "./database-sheet-tabs";
import { databaseBlockMenuActions } from "./database-block-row";
import { mountMediaEditor } from "./media-editor";
import { renderTextBlockRow, type TextBlockVariant } from "./text-block-editor";
import { headingLevelFromMarkdown, applyHeadingCollapseVisibility as applyHeadingVisibility, toggleHeadingSection } from "./heading-block-editor";
import { blockDepth, columnIndex, normalizeLoadedBlocks, clearColumnPlacement, setColumnMember } from "./block-layout";
import { blockSummaryForDrag, isBlockDescendant } from "./block-drag";
import { renderLocationRow } from "./location-block-editor";
import { referenceParentId, retainedReferenceHosts, removeReferencesForBlock, isEmbeddedReferenceBlock } from "./reference-instance-editor";
import { createReferenceEditorController } from "./reference-editor-controller";
import type { SurfaceKind } from "./panel-context";
import type { OrdinaryLinkSidebarEntry } from "./reference-sidebar-panel";
import { linkDestination as resolveLinkDestination, ordinaryLinkFromDestination, projectLinkTarget, readOnlyProjection as renderReadOnlyProjection } from "./reference-preview";
import type { LinkDestination } from "./reference-preview";
import { syncOrdinaryReferenceBody as syncOrdinaryReferenceBodyUi, renderReferenceCard, referenceRowSignature } from "./reference-card";
import { ordinaryReferenceMenuActions, referenceMenuActions } from "./reference-menu";
import type { BlockEditorServices } from "./block-editor";
import { activeCommentsFor, blockCommentSummary, commentsFor, appendCommentThread, type CommentActions } from "./block-comments";
import { DocumentSaveSession } from "./document-session";
import { hasMediaTransfer, mediaFromTransfer } from "./media-source";
import { blockModules } from "./block-modules";
import { renderReferenceRowContent as renderRegisteredReferenceRowContent } from "./reference-row-content";
import { createBlockProjection } from "./block-projection";
import { createDatabaseEditorController } from "./database-editor-controller";
import { textareaLinkSuggestions } from "./textarea-link-suggestions";
import type { OverrideNoticeAction } from "./override-notices-panel";
import { cleanCss, scopeCss } from "./style-rules";
import type { StyleScope } from "./styles-panel";

// The existing renderer and editing operations are shared by browser and desktop.
export function mountEditor(host: EditorHostApi, ui: {
  showReferences?(): void;
  showLocations?(): void;
  showHistory?(): void;
  showBacklinks?(): void;
  setDatabaseContext?(visible: boolean, activate?: boolean): void;
  setDatabaseSelection?(blockId: string | null): void;
  updateHistory?(model: HistoryModel): void;
  canvasUndo?(): void;
  canvasRedo?(): void;
  canvasStateChanged?(state: EditorState, persist: boolean): void;
  canvasInsertCalendarLink?(targetDocumentId: string, targetBlockId?: string, targetScope?: ReferenceTargetScope, label?: string): boolean;
  canvasInsertLocationBlock?(locationId: string): boolean;
  readingFlush?(): Promise<void>;
  readingStateChanged?(state: EditorState): void;
  readingInsertCalendarLink?(documentId: string, blockId?: string, scope?: ReferenceTargetScope, label?: string): boolean;
  readingInsertLocationBlock?(locationId: string): boolean;
  surfaceStateChanged?(state: EditorState, surface: SurfaceKind): void;
  clearPanelContext?(): void;
  setBacklinkTarget?(blockId: string | null, state?: EditorState): void;
  setCommentSelection?(blockId: string | null): void;
  showStyleScope?(scope: StyleScope): void;
  setReferencePanelState?(state: EditorState, previewActive: boolean): void;
  showReferenceLoading?(): void;
  showReferencePreview?(reference: ReferenceInstance, referenceId?: string, ordinaryLink?: OrdinaryLinkSidebarEntry | null): void;
  showReferenceError?(message: string): void;
  clearReferencePanel?(): void;
  beforeNavigation?(): Promise<void>;
  routeDocumentLoaded?(state: EditorState): void;
  routeFocusBlock?(blockId: string): void;
} = {}) {
  const cellLinkSuggestions = textareaLinkSuggestions(() => state);
const titleInput = document.querySelector<HTMLInputElement>("#title")!;
const blockSurface = document.querySelector<HTMLDivElement>("#blocks")!;
const saveStatus = document.querySelector<HTMLSpanElement>("#status")!;
const linkSuggestions = document.querySelector<HTMLDivElement>("#link-suggestions")!;
const editorElement = document.querySelector<HTMLElement>(".editor")!;
type EditorMode = "rich" | "source" | "preview";
let editorMode = (localStorage.getItem("lnm-editor-mode") as EditorMode | null) ?? "rich";
if (!["rich", "source", "preview"].includes(editorMode)) editorMode = "rich";
// The shell owns right-panel visibility; editor state is published to registered panels.
let state: EditorState | null = null;
const { renderLinkedHtml, resolveWikiTargets, markdownHtml, contentFromMarkdown, contentFromRichEditable } = createLinkRendering(() => state);
const { renderTextProjection, renderReadingAnnotationPreview } = createBlockProjection({ markdownHtml, renderLinkedHtml, resolveWikiTargets });
let activeSheetDatabaseId: string | null = null;
const activeDatabaseViews = new Map<string, string>();
const databaseController = createDatabaseEditorController({
  state: () => state,
  mode: () => editorMode,
  host,
  blockSurface,
  setActiveSheet: databaseId => { activeSheetDatabaseId = databaseId; },
  clearActiveBlock: () => { activeBlock = null; },
  activeViews: activeDatabaseViews,
  newId,
  fileToBase64,
  downloadText,
  executeCommand: executeDatabaseCommand,
  renderAll: renderAllPanels,
  scheduleSave: scheduleDocumentSave,
  showError,
  setStatus: message => { saveStatus.textContent = message; },
  sourceText,
  createBlock: type => createBlock(type),
  activateBlock: block => {
    const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`);
    if (shell) activateOwnBlock(shell, true);
  },
  showBlockMenu: showOwnBlockMenu,
  removeBlock: removeOwnBlock,
  cellSuggestions: cellLinkSuggestions,
  markdownHtml
});
// Canvas reuses the document-shaped state for the right sidebar. Its layout
// and history are persisted by CanvasManager, so shared document saves/history
// must stay disabled while this context is active.
let canvasContext = false;
let readingContext = false;
let mutationVersion = 0;
let commandTail: Promise<void> = Promise.resolve();
let commandFailure: Error | null = null;
let historyTail: Promise<void> = Promise.resolve();
let historyBusy = false;
let editGroup = newId();
let editTarget: EventTarget | null = null;
let editTime = 0;
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
const selectedBlockIds = new Set<string>();
let blockSelectionDrag: { pointerId: number; active: boolean; startId: string } | null = null;
type Message = { [K in Exclude<keyof RequestMap, "saveDocument">]: { type: K } & RequestMap[K] }[Exclude<keyof RequestMap, "saveDocument">];
function post(message: Message, sourceDocumentId = state?.note.id): Promise<void> {
  const { type, ...payload } = message;
  if (type === "openDocument" || type === "navigateBack" || type === "navigateForward") {
    return historyTail.then(() => flush()).then(() => ui.beforeNavigation?.()).then(() => host.request(type, payload as RequestMap[typeof type], sourceDocumentId))
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
    if (readingContext) await ui.readingFlush?.();
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
  const databaseCell = captureDatabaseCell();
  next.blocks = orderBlockTree(next.blocks);
  next.references.forEach(reference => reference.blocks = orderBlockTree(reference.blocks));
  state = next;
  if (sourceType.startsWith("history-")) { blockSurface.replaceChildren(); ui.clearReferencePanel?.(); activeEditable = null; activeBlock = null; }
  // Sync DOM. This rebuilds only what changed (rows added/moved/removed, cards added/removed).
  renderAllPanels();
  restoreDatabaseCell(databaseCell);
  if (canvasContext) ui.canvasStateChanged?.(state, false);
  if (readingContext) ui.readingStateChanged?.(state);
  // For text-edit commands, restore caret. For structural commands we don't restore —
  // structural changes inherently move focus and re-render is correct.
  if (sourceType === "saveOverride" || sourceType === "saveInstanceBlock") restoreCaret(caret);
  publishHistory();
  saveStatus.textContent = "已同步本地数据库";
}

function moveHistory(direction: "undo" | "redo") { return runHistory("history-" + direction); }
function restoreHistory(id: string) { return runHistory("history-restore", id); }
function runHistory(operation: string, entryId?: string) {
  if (readingContext) return Promise.resolve();
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
function captureDatabaseCell() {
  const input = document.activeElement;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || !input.matches(".database-cell[data-field-key]")) return null;
  const recordId = input.closest<HTMLElement>("[data-record-id]")?.dataset.recordId;
  const blockId = input.closest<HTMLElement>("[data-own-block]")?.dataset.id;
  const fieldKey = input.dataset.fieldKey;
  if (!recordId || !blockId || !fieldKey) return null;
  let selection: [number, number] | null = null;
  try { if (input.selectionStart !== null && input.selectionEnd !== null) selection = [input.selectionStart, input.selectionEnd]; } catch { /* Number inputs have no text selection. */ }
  return { documentId: state?.note.id, blockId, recordId, fieldKey, value: input.value, selection };
}

function restoreDatabaseCell(cell: ReturnType<typeof captureDatabaseCell>) {
  if (!cell || state?.note.id !== cell.documentId) return;
  const input = blockSurface.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-own-block][data-id="${CSS.escape(cell.blockId)}"] [data-record-id="${CSS.escape(cell.recordId)}"] .database-cell[data-field-key="${CSS.escape(cell.fieldKey)}"]`);
  if (!input) return;
  input.value = cell.value;
  input.focus();
  if (cell.selection) input.setSelectionRange(...cell.selection);
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
  const documentWithCaret = document as Document & { caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null; caretPositionFromPoint?: (clientX: number, clientY: number) => { offsetNode: Node; offset: number } | null };
  if (documentWithCaret.caretRangeFromPoint) return documentWithCaret.caretRangeFromPoint(x, y);
  const position = documentWithCaret.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange(); range.setStart(position.offsetNode, position.offset); range.collapse(true); return range;
}
function textSelectionEndpointAtPoint(x: number, y: number): TextSelectionEndpoint | null {
  const range = caretRangeAtPoint(x, y); if (!range) return null;
  const editable = editableForSelectionNode(range.startContainer); if (!editable || !editable.isConnected) return null;
  return { node: range.startContainer, offset: range.startOffset, editable };
}
function selectedEditableRanges(start: TextSelectionEndpoint, end: TextSelectionEndpoint): Range[] {
  const editables = [...blockSurface.querySelectorAll<HTMLElement>(".block-text.rich-editor")];
  const startIndex = editables.indexOf(start.editable); const endIndex = editables.indexOf(end.editable);
  if (startIndex < 0 || endIndex < 0) return [];
  const forward = startIndex < endIndex || (startIndex === endIndex && (start.node === end.node ? start.offset <= end.offset : Boolean(start.node.compareDocumentPosition(end.node) & Node.DOCUMENT_POSITION_FOLLOWING)));
  return editables.slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1).map(editable => {
    const range = document.createRange(); range.selectNodeContents(editable);
    if (editable === start.editable) { if (forward) range.setStart(start.node, start.offset); else range.setEnd(start.node, start.offset); }
    if (editable === end.editable) { if (forward) range.setEnd(end.node, end.offset); else range.setStart(end.node, end.offset); }
    return range;
  }).filter(range => !range.collapsed);
}
function clearCrossBlockHighlight() {
  (CSS as typeof CSS & { highlights?: { delete(name: string): boolean } }).highlights?.delete("cross-block-selection");
}
function renderCrossBlockHighlight(start: TextSelectionEndpoint, end: TextSelectionEndpoint) {
  const registry = (CSS as typeof CSS & { highlights?: { set(name: string, value: unknown): void } }).highlights;
  const HighlightConstructor = (window as typeof window & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (registry && HighlightConstructor) registry.set("cross-block-selection", new HighlightConstructor(...selectedEditableRanges(start, end)));
}
function clearBlockSelection() {
  selectedBlockIds.clear(); blockSurface.querySelectorAll<HTMLElement>("[data-own-block].block-selected").forEach(shell => shell.classList.remove("block-selected"));
}
function setCrossBlockSelection(start: TextSelectionEndpoint, end: TextSelectionEndpoint) {
  const selection = window.getSelection(); if (!selection) return; selection.removeAllRanges();
  const range = document.createRange();
  try {
    const order = start.node === end.node ? start.offset <= end.offset : Boolean(start.node.compareDocumentPosition(end.node) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (order) { range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset); }
    else { range.setStart(end.node, end.offset); range.setEnd(start.node, start.offset); }
    selection.addRange(range); selection.setBaseAndExtent?.(start.node, start.offset, end.node, end.offset);
  } catch { /* cross-root selections are rejected by some browsers */ }
}
function beginCrossBlockSelection(event: PointerEvent) {
  if (event.button !== 0 || editorMode !== "rich") return;
  const target = event.target as HTMLElement | null;
  const shell = target?.closest<HTMLElement>("[data-own-block]");
  if (shell && !target?.closest(".block-text.rich-editor") && !target?.closest("a,button,input,textarea,select,video,audio,.media-name")) {
    clearBlockSelection(); blockSelectionDrag = { pointerId: event.pointerId, active: false, startId: shell.dataset.id! }; updateBlockSelectionAtPoint(event.clientX, event.clientY); event.preventDefault(); return;
  }
  const editable = target?.closest<HTMLElement>(".block-text.rich-editor"); if (!editable || target?.closest("a,button,input,video,audio")) return;
  clearBlockSelection(); const endpoint = textSelectionEndpointAtPoint(event.clientX, event.clientY); if (!endpoint || endpoint.editable !== editable) return;
  clearCrossBlockHighlight(); crossBlockSelection = { start: endpoint, end: endpoint, pointerId: event.pointerId, active: false };
}
function updateBlockSelectionAtPoint(x: number, y: number) {
  const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-own-block]"); if (!target?.dataset.id) return;
  const shells = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")]; const startIndex = shells.findIndex(shell => shell.dataset.id === blockSelectionDrag?.startId); const endIndex = shells.indexOf(target); if (startIndex < 0 || endIndex < 0) return;
  shells.slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1).forEach(shell => { if (shell.dataset.id) selectedBlockIds.add(shell.dataset.id); shell.classList.add("block-selected"); });
}
function selectBlockRange(startId: string, endId: string) {
  const shells = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")]; const startIndex = shells.findIndex(shell => shell.dataset.id === startId); const endIndex = shells.findIndex(shell => shell.dataset.id === endId); if (startIndex < 0 || endIndex < 0) return;
  selectedBlockIds.clear(); shells.forEach(shell => shell.classList.remove("block-selected")); shells.slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1).forEach(shell => { if (shell.dataset.id) { selectedBlockIds.add(shell.dataset.id); shell.classList.add("block-selected"); } });
}
function updateCrossBlockSelection(event: PointerEvent) {
  const drag = crossBlockSelection;
  if (!drag && blockSelectionDrag?.pointerId === event.pointerId && (event.buttons & 1)) { updateBlockSelectionAtPoint(event.clientX, event.clientY); blockSelectionDrag.active = true; event.preventDefault(); return; }
  if (!drag || drag.pointerId !== event.pointerId || !(event.buttons & 1)) return;
  const endpoint = textSelectionEndpointAtPoint(event.clientX, event.clientY); if (!endpoint || endpoint.editable === drag.start.editable) return;
  drag.end = endpoint; const startShell = drag.start.editable.closest<HTMLElement>("[data-own-block]"); const endShell = endpoint.editable.closest<HTMLElement>("[data-own-block]"); if (startShell?.dataset.id && endShell?.dataset.id) selectBlockRange(startShell.dataset.id, endShell.dataset.id);
  setCrossBlockSelection(drag.start, endpoint); renderCrossBlockHighlight(drag.start, endpoint); drag.active = true; event.preventDefault();
}
function finishCrossBlockSelection(event: PointerEvent) {
  if (blockSelectionDrag?.pointerId === event.pointerId) { if (blockSelectionDrag.active || selectedBlockIds.size) { document.querySelectorAll<HTMLElement>("[data-own-block]").forEach(shell => shell.classList.toggle("block-selected", Boolean(shell.dataset.id && selectedBlockIds.has(shell.dataset.id)))); activeBlock = document.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape([...selectedBlockIds][0] ?? "")}"]`); saveStatus.textContent = `已选择 ${selectedBlockIds.size} 个块`; event.preventDefault(); } blockSelectionDrag = null; return; }
  const drag = crossBlockSelection; if (!drag || drag.pointerId !== event.pointerId) return; if (drag.active) { event.preventDefault(); setCrossBlockSelection(drag.start, drag.end); rememberStyleSelection(); } crossBlockSelection = null;
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
function applyManagedStyles() {
  document.querySelectorAll<HTMLStyleElement>("style[data-managed-style]").forEach(el => el.remove());
  const styles = [...(state?.systemStyles ?? []), ...(state?.notebookStyles ?? []), ...(state?.documentStyles ?? [])].filter(style => style.enabled && style.css.trim());
  styles.forEach(style => { const tag = document.createElement("style"); tag.dataset.managedStyle = style.id; tag.textContent = scopeCss(style.css, ".editor .block-text"); document.head.append(tag); });
}
function saveManagedStyle(style: StyleSheet, documentId: string) {
  if (state?.note.id !== documentId) { showError("文档已切换，请重新打开样式面板"); return; }
  void host.executeCommand({ operation: "save-style", ...style }, documentId)
    .then(result => applyServerState(result.state, "save-style")).catch(showError);
}
function deleteManagedStyle(styleId: string, scope: StyleScope, documentId: string) {
  if (state?.note.id !== documentId) { showError("文档已切换，请重新打开样式面板"); return; }
  void host.executeCommand({ operation: "delete-style", styleId, scope }, documentId)
    .then(result => applyServerState(result.state, "delete-style")).catch(showError);
}
function downloadText(content: string, fileName: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
  const link = document.createElement("a"); link.href = url; link.download = fileName; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function syncDatabaseSelection() {
  const block = state?.blocks.find(item => item.id === activeBlock?.dataset.id);
  const selectedId = block && blockModules.require(block.type).editor.activatesDatabasePanel && databaseController.databaseForBlock(block)
    ? block.id : null;
  ui.setDatabaseContext?.(!!selectedId);
  ui.setDatabaseSelection?.(selectedId);
}

function renderAllPanels() {
  if (!state) return;
  // Main area: diff the blockSurface (preserve focusable rows, replace structural diff).
  syncBlockSurface();
  // Right-side panels: each is a self-contained diff.
  renderRelations();
  syncDatabaseSelection();
  applyManagedStyles();
  titleInput.value = state.note.title;
  ui.setCommentSelection?.(activeBlock?.dataset.id ?? null);
  ui.surfaceStateChanged?.(state, canvasContext ? "canvas" : "document");
}

let openCommentBlockId: string | null = null;
function commitBlockComments(block: Block, comments: BlockComment[]) {
  block.properties = { ...block.properties, comments };
  const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`);
  if (shell) syncBlockCommentBubble(shell, block);
  renderAllPanels();
  if (openCommentBlockId === block.id) {
    const anchor = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"] .block-comment-bubble`);
    if (anchor) showBlockCommentPopover(anchor, block, false);
  }
  scheduleDocumentSave(0);
}
function addBlockComment(blockId: string, content: string) {
  const block = state?.blocks.find(item => item.id === blockId); const value = content.trim(); if (!block || !value) return;
  const timestamp = new Date().toISOString();
  commitBlockComments(block, [...commentsFor(block), { id: `comment-${newId()}`, content: value, createdAt: timestamp, updatedAt: timestamp, history: [{ id: `comment-history-${newId()}`, action: "created" as const, content: value, timestamp }] }]);
}
function editBlockComment(blockId: string, commentId: string, content: string) {
  const block = state?.blocks.find(item => item.id === blockId); const value = content.trim(); if (!block || !value) return;
  const timestamp = new Date().toISOString();
  commitBlockComments(block, commentsFor(block).map(comment => comment.id !== commentId || comment.deletedAt ? comment : { ...comment, content: value, updatedAt: timestamp, history: [...(comment.history ?? []), { id: `comment-history-${newId()}`, action: "edited" as const, content: value, timestamp }] }));
}
function deleteBlockComment(blockId: string, commentId: string) {
  const block = state?.blocks.find(item => item.id === blockId); if (!block) return;
  const timestamp = new Date().toISOString();
  commitBlockComments(block, commentsFor(block).map(comment => comment.id !== commentId || comment.deletedAt ? comment : { ...comment, deletedAt: timestamp, updatedAt: timestamp, history: [...(comment.history ?? []), { id: `comment-history-${newId()}`, action: "deleted" as const, content: comment.content, timestamp }] }));
}
function closeBlockCommentPopover() { document.querySelector(".block-comment-popover")?.remove(); openCommentBlockId = null; }
function showBlockCommentPopover(anchor: HTMLElement, block: Block, autofocus = false) {
  closeBlockCommentPopover(); openCommentBlockId = block.id;
  const popover = document.createElement("section"); popover.className = "block-comment-popover"; popover.dataset.blockId = block.id;
  const head = document.createElement("header"); const title = document.createElement("strong"); title.textContent = blockCommentSummary(block, state ?? undefined);
  const close = document.createElement("button"); close.type = "button"; close.textContent = "×"; close.onclick = closeBlockCommentPopover; head.append(title, close); popover.append(head);
  appendCommentThread(popover, block, true, { add: addBlockComment, edit: editBlockComment, delete: deleteBlockComment }, state ?? undefined); document.body.append(popover);
  const rect = anchor.getBoundingClientRect(); popover.style.position = "fixed"; popover.style.left = `${Math.max(12, Math.min(window.innerWidth - 360, rect.right - 340))}px`; popover.style.top = `${Math.min(window.innerHeight - 420, rect.bottom + 6)}px`;
  if (autofocus) window.setTimeout(() => popover.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 0);
}
function syncBlockCommentBubble(shell: HTMLElement, block: Block) {
  let bubble = shell.querySelector<HTMLButtonElement>(":scope > .block-row > .block-comment-bubble");
  const active = activeCommentsFor(block).length;
  if (!active) { bubble?.remove(); return; }
  if (!bubble) { bubble = document.createElement("button"); bubble.type = "button"; bubble.className = "block-comment-bubble"; bubble.title = "查看注释"; shell.querySelector<HTMLElement>(":scope > .block-row")?.append(bubble); }
  bubble.textContent = `💬 ${active}`; bubble.onclick = event => { event.stopPropagation(); showBlockCommentPopover(bubble!, block, false); };
}
function renderComments() { ui.setCommentSelection?.(activeBlock?.dataset.id ?? null); }

function syncColumnGroups() {
  if (!state) return;
  // Rebuilding a column grid temporarily detaches its children. Preserve the
  // active editor caret across that DOM operation so a normal input event does
  // not lose focus after the first character.
  const caret = captureCaret();
  const groups = new Map<string, Block[]>(); state.blocks.forEach(block => { const id = block.properties.columnGroup; if (id) groups.set(id, [...(groups.get(id) ?? []), block]); });
  const wanted = new Set(groups.keys()); blockSurface.querySelectorAll<HTMLElement>(":scope > .columns-row").forEach(row => { if (!wanted.has(row.dataset.columnGroup ?? "")) row.remove(); });
  const rows = new Map<string, HTMLElement>();
  for (const [groupId, members] of groups) {
    let row = blockSurface.querySelector<HTMLElement>(`:scope > .columns-row[data-column-group="${CSS.escape(groupId)}"]`);
    if (!row) { row = document.createElement("div"); row.className = "columns-row"; row.dataset.columnGroup = groupId; blockSurface.append(row); }
    syncColumnGroupRow(row, groupId, members); rows.set(groupId, row);
  }
  const emitted = new Set<string>(); const desired: Element[] = [];
  for (const block of state.blocks) {
    const group = block.properties.columnGroup;
    if (group) { if (!emitted.has(group)) { emitted.add(group); const row = rows.get(group); if (row) desired.push(row); } }
    else { const shell = blockSurface.querySelector<HTMLElement>(`:scope > [data-own-block][data-id="${CSS.escape(block.id)}"]`); if (shell) desired.push(shell); }
  }
  desired.forEach((element, index) => { if (blockSurface.children[index] !== element) blockSurface.insertBefore(element, blockSurface.children[index] ?? null); });
  restoreCaret(caret);
}
function syncColumnGroupRow(row: HTMLElement, groupId: string, members: Block[]) {
  const count = Math.max(2, ...members.map(block => columnIndex(block) + 1));
  const widths = members.find(block => block.properties.columnWidths)?.properties.columnWidths ?? Array.from({ length: count }, () => 1);
  let grid = row.querySelector<HTMLElement>(":scope > .columns-grid"); if (!grid) { grid = document.createElement("div"); grid.className = "columns-grid"; row.replaceChildren(grid); }
  let grip = row.querySelector<HTMLButtonElement>(":scope > .columns-row-grip"); if (!grip) { grip = document.createElement("button"); grip.type = "button"; grip.className = "columns-row-grip grip"; grip.draggable = editorMode !== "preview"; grip.textContent = "⠿"; grip.title = "拖拽整组分列"; row.insertBefore(grip, grid); }
  else grip.draggable = editorMode !== "preview";
  const ordered = [...members].sort((a, b) => a.position.localeCompare(b.position) || a.id.localeCompare(b.id));
  grid.style.gridTemplateColumns = widths.slice(0, count).flatMap((value, index) => index < count - 1 ? [`minmax(0, ${Math.max(.2, value)}fr)`, "8px"] : [`minmax(0, ${Math.max(.2, value)}fr)`]).join(" ");
  grid.replaceChildren();
  for (let column = 0; column < count; column++) {
    const track = document.createElement("div"); track.className = "column-track"; track.dataset.column = String(column); track.dataset.editorMode = editorMode;
    ordered.filter(block => columnIndex(block) === column).forEach(block => { const shell = blockSurface.querySelector<HTMLElement>(`.block-shell[data-id="${CSS.escape(block.id)}"]`) ?? renderOwnBlockShell(block); shell.dataset.columnGroup = groupId; shell.dataset.column = String(column); shell.dataset.parentId = ""; track.append(shell); }); grid.append(track);
    if (column < count - 1) { const divider = document.createElement("button"); divider.type = "button"; divider.className = "column-divider"; divider.dataset.column = String(column); divider.title = "拖拽调整两列宽度"; divider.addEventListener("pointerdown", event => beginColumnResize(event, groupId, column, row)); grid.append(divider); }
  }
  let restore = row.querySelector<HTMLButtonElement>(":scope > .columns-restore"); if (!restore) { restore = document.createElement("button"); restore.type = "button"; restore.className = "columns-restore"; restore.textContent = "↶"; restore.title = "还原为普通块"; restore.onclick = () => restoreColumnGroup(groupId); row.append(restore); }
}
let columnResize: { groupId: string; divider: number; startX: number; widths: number[]; handle: HTMLElement } | null = null;
function beginColumnResize(event: PointerEvent, groupId: string, divider: number, row: HTMLElement) { if (editorMode === "preview" || !state) return; const members = state.blocks.filter(block => block.properties.columnGroup === groupId); const count = Math.max(2, ...members.map(block => columnIndex(block) + 1)); const widths = members.find(block => block.properties.columnWidths)?.properties.columnWidths?.slice() ?? Array.from({ length: count }, () => 1); columnResize = { groupId, divider, startX: event.clientX, widths, handle: event.currentTarget as HTMLElement }; row.classList.add("is-resizing"); event.preventDefault(); }
function updateColumnResize(event: PointerEvent) { if (!columnResize || !state) return; const row = blockSurface.querySelector<HTMLElement>(`.columns-row[data-column-group="${CSS.escape(columnResize.groupId)}"]`); const rect = row?.querySelector<HTMLElement>(".columns-grid")?.getBoundingClientRect(); if (!rect) return; const total = columnResize.widths.reduce((a, b) => a + b, 0); const delta = (event.clientX - columnResize.startX) / Math.max(1, rect.width) * total; const widths = columnResize.widths.slice(); widths[columnResize.divider] = Math.max(.2, widths[columnResize.divider] + delta); widths[columnResize.divider + 1] = Math.max(.2, widths[columnResize.divider + 1] - delta); state.blocks.filter(block => block.properties.columnGroup === columnResize!.groupId).forEach(block => { block.properties = { ...block.properties, columnWidths: widths }; }); if (row) row.querySelector<HTMLElement>(".columns-grid")!.style.gridTemplateColumns = widths.flatMap((value, index) => index < widths.length - 1 ? [`minmax(0, ${value}fr)`, "8px"] : [`minmax(0, ${value}fr)`]).join(" "); }
function finishColumnResize() { if (!columnResize) return; blockSurface.querySelector<HTMLElement>(`.columns-row[data-column-group="${CSS.escape(columnResize.groupId)}"]`)?.classList.remove("is-resizing"); columnResize = null; scheduleDocumentSave(0); }
document.addEventListener("pointermove", updateColumnResize); document.addEventListener("pointerup", finishColumnResize); document.addEventListener("pointercancel", finishColumnResize);

function existingBlockShell(blockId: string, embedded: boolean) {
  const shells = [...blockSurface.querySelectorAll<HTMLElement>(`[data-own-block][data-id="${CSS.escape(blockId)}"]`)]
    .filter(shell => shell.dataset.id === blockId);
  // Column members live below a `.columns-row`, so callers must search the
  // whole surface instead of only its direct children. Prefer the ordinary
  // shell for a regular block; a projected reference shell is only selected
  // when the block is known to be embedded.
  if (!embedded) return shells.find(shell => !shell.closest("[data-reference-host-id]")) ?? shells[0];
  if (shells.length < 2) return shells.find(shell => shell.closest("[data-reference-host-id]")) ?? shells[0];
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
  const sheets = visibleSheetBlocks(state.blocks, activeSheetDatabaseId, groupedIds);
  activeSheetDatabaseId = sheets.activeDatabaseId;
  const visibleBlocks = sheets.visible;
  const visibleIds = new Set(visibleBlocks.map(block => block.id));
  blockSurface.querySelectorAll<HTMLElement>(":scope > [data-own-block]").forEach((shell) => {
    const id = shell.dataset.id!;
    if (!visibleIds.has(id)) shell.remove();
  });
  let prev: Element | null = null;
  for (const block of visibleBlocks) {
    const id = block.id;
    const editor = blockModules.require(block.type).editor;
    const embedded = isEmbeddedReferenceBlock(block, state.blocks, blockSurface);
    let existing: HTMLElement | null = existingBlockShell(id, embedded) ?? null;
    if (existing && (existing.dataset.editorMode !== editorMode || editor.remountOnUpdate)) {
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
      editor.reconcile?.(existing, block, blockEditorServices);
      shell = existing;
    } else {
      shell = renderOwnBlockShell(block);
    }
    if (editor.ordinaryReferenceHost) syncOrdinaryReferenceBody(shell, block);
    // An inline reference shell is owned by its anchor. It must not be moved
    // back to the root flow while syncing a dragged sibling block.
    if (embedded && shell.closest("[data-reference-host-id]")) continue;
    const nextSibling: Element | null = prev ? prev.nextElementSibling : blockSurface.firstElementChild;
    if (nextSibling !== shell) blockSurface.insertBefore(shell, nextSibling);
    prev = shell;
  }
  syncColumnGroups();
  mountEmbeddedReferences();
  if (state) applyHeadingVisibility(blockSurface, state.blocks);
}

function syncOrdinaryReferenceBody(shell: HTMLElement, block: Block) {
  const reference = state?.references.find(item => item.hostBlockId === block.id && (item.mode === "inline" || item.mode === "collapsed"));
  syncOrdinaryReferenceBodyUi(shell, reference, item => renderReference(item, false), rowSignature, () => {
    const current = state?.references.find(item => item.id === reference?.id);
    if (current) removeOrdinaryLinkReference(current);
  });
}

function createLocationRow(block: Block) {
  return renderLocationRow(block, state!, editorMode, () => scheduleDocumentSave(),
    row => removeOwnBlock(row.closest<HTMLElement>("[data-own-block]")));
}

/** Compact representation of a reference's currently visible rows. Includes mode, hidden
 * list, overrides fingerprint, and any visible row ids/parents/positions. Used by both
 * syncBlockSurface and renderRelations to decide whether to reuse existing DOM or rebuild.
 */
function rowSignature(r: ReferenceInstance): string {
  return referenceRowSignature(r, editorMode);
}

const blockEditorServices: BlockEditorServices = {
  state: () => state!,
  mode: () => editorMode,
  textRow: createEditableRow,
  mediaRow: block => mediaEditor.renderBlockRow(block,
    row => removeOwnBlock(row.closest<HTMLElement>("[data-own-block]"))),
  locationRow: createLocationRow,
  databaseRow: block => databaseController.renderRow(block),
  referenceCard: reference => renderReference(reference, false),
  referenceSignature: rowSignature,
  detachReference: hostBlockId => {
    const reference = state?.references.find(item => item.hostBlockId === hostBlockId);
    if (reference) referenceEditor.detachReferenceAsPlainText(reference);
  }
};

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
  blockModules.require(block.type).editor.mount(shell, block, blockEditorServices);
  shell.addEventListener("pointerdown", () => activateOwnBlock(shell, true));
  shell.addEventListener("focusin", () => activateOwnBlock(shell, true));
  syncBlockCommentBubble(shell, block);
  return shell;
}

function activateOwnBlock(shell: HTMLElement, activateDatabase: boolean) {
  const changed = activeBlock !== shell;
  activeBlock = shell;
  if (changed) {
    ui.setCommentSelection?.(shell.dataset.id ?? null);
    syncDatabaseSelection();
  }
  const block = state?.blocks.find(item => item.id === shell.dataset.id);
  if (activateDatabase && block && blockModules.require(block.type).editor.activatesDatabasePanel)
    ui.setDatabaseContext?.(true, true);
}

function handleOverrideNoticeAction(action: OverrideNoticeAction) {
  if (action.kind === "open") postAfterFlush({ type: "openDocument", documentId: action.documentId });
  else if (action.kind === "delete") postAfterFlush({ type: "deleteInstanceBlock", referenceInstanceId: action.referenceInstanceId, blockId: action.blockId });
  else postAfterFlush({ type: "resetOverride", referenceInstanceId: action.referenceInstanceId, targetBlockId: action.blockId });
}
function showError(error: unknown) {
  saveStatus.textContent = "保存失败：" + (error instanceof Error ? error.message : String(error));
}
function executeAfterSaveCommand(command: { operation: string; [key: string]: unknown }, sourceType: string,
  changedMessage: string, version: (current: EditorState) => Record<string, unknown>) {
  const owner = state?.note.id;
  if (!owner) return Promise.reject(new Error("文档尚未载入"));
  const previous = commandTail;
  const task = previous.catch(() => undefined).then(async () => {
    if (readingContext) await ui.readingFlush?.();
    await saveSession.flush();
    if (!state || state.note.id !== owner) throw new Error(changedMessage);
    const result = await host.executeCommand({ ...command, mutationId: newId(), ...version(state) }, owner);
    applyServerState(result.state, sourceType);
    return result;
  });
  commandTail = task.then(() => undefined, error => { commandFailure = error; showError(error); });
  return task;
}
function executeDatabaseCommand(command: { operation: string; [key: string]: unknown }, sourceType: string) {
  return executeAfterSaveCommand(command, sourceType, "文档已切换，请重试数据库操作。",
    current => ({ clientVersion: current.note.clientVersion + 1 }));
}
function executeLocationCommand(command: { operation: string; [key: string]: unknown }, sourceType: string) {
  return executeAfterSaveCommand(command, sourceType, "文档已切换，请重试位置操作。",
    current => ({ expectedLocationVersion: current.locationVersion ?? 0 }));
}
async function flush() {
  await saveSession.flush();
  await commandTail;
  if (commandFailure) throw commandFailure;
}

type DocumentSnapshot = Pick<SaveMutation, "documentId" | "title" | "blocks" | "historyGroup">;
const saveSession = new DocumentSaveSession<DocumentSnapshot>(async snapshot => {
  const mutation: SaveMutation = {
    ...snapshot,
    mutationId: newId(),
    clientVersion: Math.max(mutationVersion, state?.note.id === snapshot.documentId ? state.note.clientVersion : 0) + 1
  };
  const ack = await host.saveDocument(mutation);
  mutationVersion = ack.clientVersion;
  if (state?.note.id !== snapshot.documentId) return;
  state.note.clientVersion = ack.clientVersion;
  if (ack.history) { state.history = ack.history; publishHistory(); }
}, (phase, error) => {
  if (phase === "pending" || phase === "saving") saveStatus.textContent = "正在保存...";
  if (phase === "saved") {
    saveStatus.textContent = "已保存到本地数据库";
    if (state?.references.some(reference => reference.targetDocumentId === state?.note.id)) void refreshLiveReferences();
    const link = sidebarLink;
    if (link && state && link.documentId === state.note.id && !link.referenceId) void showLinkSidebar(link, false);
  }
  if (phase === "failed") {
    mutationVersion = state?.note.clientVersion ?? 0;
    const message = error instanceof Error ? error.message : String(error ?? "本地数据库拒绝了这次保存");
    saveStatus.textContent = `保存失败：${message}`;
    showError(message);
  }
});

function enqueueDocumentSave() {
  if (!state?.note.id) return;
  if (readingContext) return;
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
  const snapshot: DocumentSnapshot = {
    documentId: state.note.id,
    historyGroup: editGroup,
    title: titleInput.value.trim() || "未命名笔记",
    blocks: readOwnBlocks()
  };
  state.blocks = snapshot.blocks;
  // Keep the panel context ahead of the save ACK. The queued snapshot is the
  // canonical optimistic state, so the calendar and the other right-side
  // panels can render a just-entered date/link without waiting for transport.
  renderAllPanels();
  saveSession.schedule(snapshot);
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

function runAfterSaveDrain(action: () => void) {
  void saveSession.flush().then(action).catch(showError);
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

let sidebarLink: LinkDestination | null = null;
let sidebarSequence = 0;
let previewSequence = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function dismissPreview() {
  clearTimeout(previewTimer); previewSequence++;
  document.querySelector(".link-preview")?.remove();
}

function toggleHeadingCollapse(block: Block, button: HTMLButtonElement) {
  if (state && toggleHeadingSection(block, button, blockSurface, state.blocks)) scheduleDocumentSave(0);
}
async function showLinkPreview(target: LinkDestination) {
  const sequence = ++previewSequence;
  try {
    const reference = await projectLinkTarget(target, state!, documentId => host.loadDocument(documentId));
    if (sequence !== previewSequence || !target.anchor.isConnected) return;
    const popup = document.createElement("aside");
    popup.className = "link-preview"; popup.setAttribute("role", "tooltip");
    const title = document.createElement("div"); title.className = "preview-title"; title.textContent = reference.targetTitle;
    popup.append(title, renderReadOnlyProjection(reference, state!, { renderText: renderTextProjection, resolveWikiTargets }));
    document.body.append(popup);
    const rect = target.anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(innerWidth - popup.offsetWidth - 8, rect.left))}px`;
    popup.style.top = `${Math.max(8, Math.min(innerHeight - popup.offsetHeight - 8, rect.bottom + 6))}px`;
    popup.addEventListener("mouseleave", dismissPreview);
  } catch { if (sequence === previewSequence) dismissPreview(); }
}
async function showLinkSidebar(target: LinkDestination, activate = true) {
  dismissPreview(); sidebarLink = target;
  const sequence = ++sidebarSequence;
  const owner = state?.note.id;
  if (activate) ui.showReferences?.();
  ui.showReferenceLoading?.();
  try {
    const reference = await projectLinkTarget(target, state!, documentId => host.loadDocument(documentId));
    if (sequence !== sidebarSequence || owner !== state?.note.id) return;
    ui.showReferencePreview?.(reference, target.referenceId, target.referenceId ? null : ordinaryLinkFromDestination(target, state!));
  } catch (error) {
    if (sequence !== sidebarSequence || owner !== state?.note.id) return;
    ui.showReferenceError?.("无法加载分栏预览：" + (error instanceof Error ? error.message : String(error)));
    showError(error);
  }
}
function closeSidebarPreview() {
  sidebarLink = null;
  sidebarSequence++;
  renderRelations();
}
function showSidebarOrdinaryModeMenu(anchor: HTMLElement, link: OrdinaryLinkSidebarEntry) {
  sidebarLink = null;
  sidebarSequence++;
  showOrdinaryLinkModeMenu(anchor, link);
}
document.addEventListener("mouseover", event => {
  const target = resolveLinkDestination(event.target, state);
  if (!target || target.anchor.contains(event.relatedTarget as Node | null)) return;
  dismissPreview(); previewTimer = setTimeout(() => void showLinkPreview(target), 400);
});
document.addEventListener("mouseout", event => {
  const target = resolveLinkDestination(event.target, state);
  if (!target || target.anchor.contains(event.relatedTarget as Node | null)) return;
  if ((event.relatedTarget as HTMLElement | null)?.closest?.(".link-preview")) return;
  dismissPreview();
});
document.addEventListener("click", event => {
  const target = resolveLinkDestination(event.target, state);
  if (!target) return;
  event.preventDefault();
  if (event.detail < 2) void showLinkSidebar(target);
});
document.addEventListener("dblclick", event => {
  const target = resolveLinkDestination(event.target, state);
  if (!target) return;
  event.preventDefault(); dismissPreview(); sidebarSequence++;
  postAfterFlush({ type: "openDocument", documentId: target.documentId, blockId: target.blockId });
});
document.addEventListener("contextmenu", event => {
  const target = resolveLinkDestination(event.target, state);
  if (!target) return;
  event.preventDefault();
  const instance = state?.references.find(item => item.id === target.referenceId);
  if (instance) showReferenceMenu(target.anchor, undefined, instance);
  else if (target.anchor.classList.contains("wiki-link") && editorMode !== "preview") {
    showMenu(target.anchor, [{ label: "修改显示文字", run: () => {
      const value = window.prompt("引用显示文字（留空恢复默认）", target.anchor.textContent ?? "");
      if (value === null) return;
      const label = value.trim();
      if (label.includes("]") || label.includes("|")) { showError(new Error("显示文字不能包含 ] 或 |")); return; }
      const fallback = target.anchor.dataset.targetHeading || target.anchor.dataset.targetTitle || "链接";
      target.anchor.textContent = label || fallback;
      const editable = target.anchor.closest<HTMLElement>(".block-text[contenteditable]");
      editable?.dispatchEvent(new Event("input", { bubbles: true }));
    } }]);
  }
});
document.addEventListener("keydown", event => { if (event.key === "Escape") dismissPreview(); });

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

function render(next: EditorState, preserveReadingBlocks = false) {
  readingContext = preserveReadingBlocks;
  document.querySelector(".block-menu")?.remove();
  closeBlockCommentPopover();
  hideInlineLinkSuggestions();
  const changed = state?.note.id !== next.note.id;
  dismissPreview();
  if (changed) { sidebarLink = null; sidebarSequence++; styleSelection = null; }
  // Upgrade legacy layout metadata once when a document is loaded. New columns
  // are ordinary root blocks sharing a columnGroup.
  if (!preserveReadingBlocks) next.blocks = normalizeLoadedBlocks(next.blocks);
  next.blocks = orderBlockTree(next.blocks);
  next.references.forEach(reference => reference.blocks = orderBlockTree(reference.blocks));
  state = next;
  if (changed) { ui.setBacklinkTarget?.(null); activeSheetDatabaseId = null; activeDatabaseViews.clear(); }
  activeEditable = null;
  if (changed) activeBlock = null;
  if (changed) {
    commandFailure = null;
    mutationVersion = next.note.clientVersion ?? 0;
    editGroup = newId();
  }
  else mutationVersion = Math.max(mutationVersion, next.note.clientVersion ?? 0);
  // Normalize blocks list: an empty doc still needs at least one shell to edit.
  if (next.blocks.length === 0 && !canvasContext && !preserveReadingBlocks) next.blocks.push(createBlock());
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


function createBlock(type: BlockType = "paragraph", parentId: string | null = null): Block {
  return createCanonicalBlock({ id: newId(), type, parentId, content: { checked: false } });
}

function removeOwnBlock(shell: HTMLElement | null) {
  if (!shell) return;
  const removedActiveBlock = activeBlock === shell || (!!activeBlock && shell.contains(activeBlock));
  const removedBlock = state?.blocks.find(block => block.id === shell.dataset.id);
  const removedGroup = removedBlock?.properties.columnGroup;
  const removedReferenceIds = removeReferencesForBlock(shell, state, blockSurface);
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
    ui.setCommentSelection?.(null);
    syncDatabaseSelection();
  }
  recalculateDepths();
  if (!blockSurface.querySelector("[data-own-block]")) addBlock("paragraph");
  scheduleDocumentSave(0);
}

function createEditableRow(block: Block, variant?: TextBlockVariant) {
  return renderTextBlockRow(block, editorMode, {
    markdownHtml,
    renderLinkedHtml,
    toggleHeading: (item, button) => {
      const latest = state?.blocks.find(candidate => candidate.id === item.id) ?? item;
      toggleHeadingCollapse(latest, button);
    },
    saveTodo: () => scheduleDocumentSave(0),
    focus: editable => {
      activeEditable = editable;
      activeBlock = editable.closest<HTMLElement>("[data-own-block]");
    },
    input: editable => {
      syncEmbeddedOwnerControls(editable);
      scheduleDocumentSave();
    },
    keydown: handleBlockKeydown,
    remove: row => removeOwnBlock(row.closest<HTMLElement>("[data-own-block]"))
  }, variant);
}

const mediaEditor = mountMediaEditor(blockSurface, {
  mode: () => editorMode,
  canEdit: () => !!state,
  select: (figure, editable) => {
    if (editable) activeEditable = editable;
    activeBlock = figure.closest<HTMLElement>("[data-own-block]");
  },
  changeCaption: (block, value) => {
    const current = state?.blocks.find(item => item.id === block.id);
    if (!current) return;
    const asset = block.content.media!;
    current.content = { ...current.content, caption: value || undefined, text: value || asset.name };
    scheduleDocumentSave();
  },
  resize: (blockId, width) => {
    const block = state?.blocks.find(item => item.id === blockId);
    if (block) block.properties = { ...block.properties, mediaWidth: width };
  },
  finishResize: () => scheduleDocumentSave(0)
});
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

function contentFromRichFragment(fragment: DocumentFragment, fallback: BlockContent): BlockContent {
  const container = document.createElement("div"); container.append(fragment); const content = contentFromRichEditable(container, fallback); delete content.markdown; return content;
}
function selectionRangeInEditable(editable: HTMLElement) {
  const selection = window.getSelection(); if (!selection?.rangeCount) return null; const range = selection.getRangeAt(0); return editable.contains(range.startContainer) && editable.contains(range.endContainer) ? range : null;
}
function placeCaretAtStart(editable: HTMLElement) { editable.focus(); const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(editable); range.collapse(true); selection?.removeAllRanges(); selection?.addRange(range); }
function handleBlockKeydown(event: KeyboardEvent) {
  if ((event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text") !== event.currentTarget || event.defaultPrevented || event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault(); const current = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-own-block]")!; const currentBlock = state?.blocks.find(block => block.id === current.dataset.id); const next = createBlock("paragraph", current.dataset.parentId || null);
  if (currentBlock) { next.properties = { ...currentBlock.properties }; delete next.properties.layout; delete next.properties.columnCount; delete next.properties.columnGap; delete next.properties.headingLevel; }
  const editable = event.currentTarget as HTMLElement; const range = selectionRangeInEditable(editable);
  if (currentBlock && editorMode === "source") { const source = sourceText(editable); const start = range ? (() => { const before = range.cloneRange(); before.selectNodeContents(editable); before.setEnd(range.startContainer, range.startOffset); return before.toString().length; })() : source.length; const end = range ? (() => { const after = range.cloneRange(); after.selectNodeContents(editable); after.setStart(range.endContainer, range.endOffset); return source.length - after.toString().length; })() : start; currentBlock.content = contentFromMarkdown(source.slice(0, start), currentBlock.content); next.content = contentFromMarkdown(source.slice(end), currentBlock.content); editable.textContent = source.slice(0, start); }
  else if (currentBlock && editorMode === "rich" && range) { const before = document.createRange(); before.selectNodeContents(editable); before.setEnd(range.startContainer, range.startOffset); const after = document.createRange(); after.selectNodeContents(editable); after.setStart(range.endContainer, range.endOffset); currentBlock.content = contentFromRichFragment(before.cloneContents(), currentBlock.content); next.content = contentFromRichFragment(after.cloneContents(), currentBlock.content); editable.replaceChildren(before.cloneContents()); }
  state?.blocks.push(next); const shell = renderOwnBlockShell(next); current.after(shell); scheduleDocumentSave(0);
  const refreshed = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(next.id)}"] .block-text`);
  if (refreshed) placeCaretAtStart(refreshed);
}

function readOwnBlocks(): Block[] {
  const siblingIndexes = new Map<string, number>();
  const blocks: Block[] = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")].map((shell): Block => {
    const old = state?.blocks.find((block) => block.id === shell.dataset.id);
    const parentId = referenceParentId(shell);
    const columnGroup = shell.dataset.columnGroup || old?.properties.columnGroup;
    const column = shell.dataset.column === "" ? old?.properties.column : Number(shell.dataset.column);
    const siblingKey = columnGroup ? `column:${columnGroup}:${column ?? 0}` : (parentId ?? "");
    const siblingIndex = (siblingIndexes.get(siblingKey) ?? 0) + 1;
    siblingIndexes.set(siblingKey, siblingIndex);
    const position = String(siblingIndex * 1000).padStart(8, "0");
    const type = shell.dataset.type as BlockType;
    const { content, properties } = blockModules.require(type).readSnapshot(shell, old, {
      mode: editorMode, columnGroup, column, sourceText,
      contentFromMarkdown, contentFromRichEditable, headingLevelFromMarkdown
    });
    return {
      id: shell.dataset.id!, parentId, position,
      type, content, properties, revision: old?.revision ?? 1
    };
  });
  const { retained, removedReferenceIds } = retainedReferenceHosts(blocks, state?.references ?? []);
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
  // Inactive sheets are deliberately absent from the DOM. Keep their canonical
  // blocks in the snapshot, and retain sheet positions when another tab is open.
  return orderBlockTree(retainInactiveSheetBlocks(retained, state?.blocks ?? [], activeSheetDatabaseId));
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

const referenceEditor = createReferenceEditorController({
  state: () => state,
  mode: () => editorMode,
  newId,
  createBlock: (type, parentId) => createBlock(type, parentId),
  sourceText,
  contentFromMarkdown,
  contentFromRichEditable,
  post,
  postAfterFlush,
  runAfterSaveDrain,
  renderOwnBlockShell,
  removeReferencesFromLocalState,
  enqueueDocumentSave,
  flushSave: () => saveSession.flush(),
  setEditGroup: () => editGroup,
  setStatus: message => { saveStatus.textContent = message; },
  surface: blockSurface
});

function renderReference(reference: ReferenceInstance, inSidebar = false) {
  return renderReferenceCard(reference, inSidebar, {
    state: state!,
    mode: editorMode,
    collapsedIds: sidebarCollapsedIds,
    blockDepth,
    renderReferenceRowContent: (source, services) =>
      renderRegisteredReferenceRowContent(services, blockModules.require(source.type).referenceRow),
    referenceRowClass: source => blockModules.require(source.type).referenceRowClass?.(source) ?? "",
    renderReadingAnnotation: renderReadingAnnotationPreview,
    databaseDeclaration: databaseController.declaration,
    markdownHtml,
    renderLinkedHtml,
    onToggleMode: setReferenceMode,
    onModeMenu: (anchor, item) => showReferenceMenu(anchor, undefined, item),
    onFocus: editable => { activeEditable = editable; },
    onInput: (row, source, properties, local) =>
      local ? referenceEditor.scheduleInstanceBlock(row, source) : referenceEditor.scheduleOverride(row, source, properties, editGroup),
    onKeydown: referenceEditor.handleRowKeydown,
    onAddSibling: (item, source, row) => referenceEditor.addInstanceBlock(item, source.parentId ?? null, row),
    onHide: (row, item, source, local) => {
      row.style.opacity = "0.35";
      saveStatus.textContent = local ? "正在删除本地块..." : "正在隐藏源块...";
      const command = local
        ? { type: "deleteInstanceBlock" as const, referenceInstanceId: item.id, blockId: source.id }
        : { type: "hideReferenceBlock" as const, referenceInstanceId: item.id, targetBlockId: source.id };
      void post(command, state?.note.id).then(() => { row.style.opacity = ""; });
    },
    onReset: (item, source) => postAfterFlush({ type: "resetOverride", referenceInstanceId: item.id, targetBlockId: source.id }),
    onRestoreHidden: item => {
      const documentId = state?.note.id;
      runAfterSaveDrain(() => item.hiddenBlockIds.forEach(id =>
        post({ type: "resetOverride", referenceInstanceId: item.id, targetBlockId: id }, documentId)));
    }
  });
}

function renderRelations() {
  if (!state) return;
  if (sidebarLink?.referenceId && !state.references.some(item => item.id === sidebarLink?.referenceId)) {
    sidebarLink = null;
    sidebarSequence++;
  }
  ui.setReferencePanelState?.(state, !!sidebarLink);
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
    { label: "查看引用此块", run: () => {
      ui.setBacklinkTarget?.(block.id);
      ui.showBacklinks?.();
    } },
    { label: activeCommentsFor(block).length ? "管理注释" : "添加注释", run: () => {
      const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`);
      if (shell) showBlockCommentPopover(shell.querySelector<HTMLElement>(".block-comment-bubble") ?? anchor, block, true);
    } },
    { label: "删除块", run: () => {
      removeOwnBlock(anchor.closest<HTMLElement>("[data-own-block]"));
    }, danger: true }
  ];
  actions.splice(3, 0, ...databaseBlockMenuActions(block, {
    changed: () => { renderAllPanels(); scheduleDocumentSave(0); },
    convertToDatabase: () => databaseController.convertFromGfm(block),
    convertToMarkdown: () => databaseController.convertToMarkdown(block),
    export: csv => databaseController.exportBlock(block, csv),
    refresh: renderAllPanels
  }));
  showMenu(anchor, actions);
}

function ordinaryLinkReference(link: OrdinaryLinkSidebarEntry) {
  return state?.references.find(reference =>
    reference.hostBlockId === link.sourceBlockId &&
    reference.targetDocumentId === link.documentId &&
    (reference.targetBlockId ?? "") === (link.blockId ?? "") &&
    (reference.targetRecordId ?? "") === (link.targetRecordId ?? "") &&
    (reference.targetFieldKey ?? "") === (link.targetFieldKey ?? ""));
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
    targetRecordId: link.targetRecordId,
    targetFieldKey: link.targetFieldKey,
    targetScope: link.targetScope
  }).then(() => {
    const created = ordinaryLinkReference(link);
    if (created && mode !== "inline") setReferenceMode(created, mode);
  });
}

function showOrdinaryLinkModeMenu(anchor: HTMLElement, link: OrdinaryLinkSidebarEntry) {
  const existing = ordinaryLinkReference(link);
  showMenu(anchor, ordinaryReferenceMenuActions(link, existing, {
    setMode: setReferenceMode,
    createMode: setOrdinaryLinkReferenceMode,
    refresh: renderRelations
  }));
}

function showReferenceMenu(anchor: HTMLElement, _block: Block | undefined, reference?: ReferenceInstance) {
  if (!reference) return;
  showMenu(anchor, referenceMenuActions(reference, {
    setMode: setReferenceMode,
    openSource: documentId => postAfterFlush({ type: "openDocument", documentId }),
    remove: item => {
      const hostBlock = state?.blocks.find(block => block.id === item.hostBlockId);
      if (!hostBlock || blockModules.require(hostBlock.type).editor.ordinaryReferenceHost !== false) {
        removeOrdinaryLinkReference(item);
        return;
      }
      const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(item.hostBlockId)}"]`);
      removeOwnBlock(shell);
    },
    detach: referenceEditor.detachReferenceAsPlainText,
    reset: item => postAfterFlush({ type: "resetReference", referenceInstanceId: item.id })
  }));
}

function setReferenceMode(reference: ReferenceInstance, mode: ReferenceMode) {
  postAfterFlush({ type: "setReferenceMode", referenceInstanceId: reference.id, mode });
}

async function copyBlockLink(block: Block) {
  if (!state) return;
  const document = state.documents.find(item => item.id === state!.note.id);
  const notebook = document?.notebookName ?? "当前笔记本";
  const link = blockWikiLink(notebook, state.note.title, block.id);
  try {
    await navigator.clipboard?.writeText(link);
    saveStatus.textContent = "块链接已复制，可粘贴到 [[ 联想中使用";
  } catch {
    showError("无法访问剪贴板，请手动复制块链接");
  }
}

function removeOrdinaryLinkReference(reference: ReferenceInstance) {
  if (!state) return;
  const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(reference.hostBlockId)}"]`);
  const editable = shell?.querySelector<HTMLElement>(":scope > .block-row > .block-text");
  if (!editable) return;
  const link = [...editable.querySelectorAll<HTMLElement>(".wiki-link")].find(item =>
    item.dataset.targetId === reference.targetDocumentId &&
    (item.dataset.targetBlockId ?? "") === (reference.targetBlockId ?? "") &&
    (item.dataset.targetRecordId ?? "") === (reference.targetRecordId ?? "") &&
    (item.dataset.targetFieldKey ?? "") === (reference.targetFieldKey ?? ""));
  if (link) link.remove();
  else if (editorMode === "source") {
    const source = editable.textContent ?? "";
    const token = (state.blocks.find(block => block.id === reference.hostBlockId)?.content.links ?? []).find(item =>
      item.targetDocumentId === reference.targetDocumentId && item.targetRecordId === reference.targetRecordId && item.targetFieldKey === reference.targetFieldKey);
    if (token && token.start >= 0 && token.end > token.start) editable.textContent = source.slice(0, token.start) + source.slice(token.end);
  }
  removeReferencesFromLocalState(new Set([reference.id]));
  scheduleDocumentSave(0);
  postAfterFlush({ type: "removeReference", referenceInstanceId: reference.id });
}

function suggestionPreview(blocks: Block[]) { return blocks.slice(0, 6).map(block => markdownHtml(markdownFromContent(block.content), block.content.links)).filter(Boolean).join("<hr>"); }
function suggestionItems(query: string): LinkSuggestion[] { if (!state) return []; const result = queryLinkSuggestions(query, state, suggestionPreview); linkMenuStage = result.stage; linkMenuTrail = result.trail; return result.items; }
function updateInlineLinkSuggestions(editable: HTMLElement) {
  const selection = window.getSelection(); if (!selection?.rangeCount || !selection.isCollapsed || !selection.anchorNode) return hideInlineLinkSuggestions(); const before = document.createRange(); before.selectNodeContents(editable); try { before.setEnd(selection.anchorNode, selection.anchorOffset); } catch { return hideInlineLinkSuggestions(); }
  const text = before.toString(); const marker = text.lastIndexOf("[["); if (marker < 0 || text.slice(marker).includes("]]")) return hideInlineLinkSuggestions(); activeEditable = editable; linkMenuItems = suggestionItems(text.slice(marker + 2)); linkMenuIndex = 0; renderInlineLinkSuggestions(editable);
}
function renderInlineLinkSuggestions(editable: HTMLElement) {
  linkSuggestions.replaceChildren();
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
    if (item.kind === "record" || item.kind === "cell") {
      button.dataset.recordId = item.recordId;
      if (item.fieldKey) button.dataset.fieldKey = item.fieldKey;
    }
    if ((item.kind === "target" || item.kind === "heading") && item.blockId) button.dataset.blockId = item.blockId;
    if (item.kind === "target" && !item.blockId) {
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
    button.addEventListener("mousedown", event => { event.preventDefault(); insertInlineSuggestion(item); });
    linkSuggestions.append(button);
  });
  linkSuggestions.hidden = false;
}
function hideInlineLinkSuggestions() { linkSuggestions.hidden = true; linkMenuItems = []; }
function activeInlineQueryRange() { const selection = window.getSelection(); if (!activeEditable || !selection?.rangeCount || !selection.isCollapsed) return null; const before = document.createRange(); before.selectNodeContents(activeEditable); try { before.setEnd(selection.anchorNode!, selection.anchorOffset); } catch { return null; } const marker = before.toString().lastIndexOf("[["); if (marker < 0) return null; const walker = document.createTreeWalker(activeEditable, NodeFilter.SHOW_TEXT); let offset = 0; let node: Text | null = null; let start = 0; let current: Node | null; while ((current = walker.nextNode())) { const length = current.textContent?.length ?? 0; if (offset + length >= marker) { node = current as Text; start = marker - offset; break; } offset += length; } if (!node) return null; const range = selection.getRangeAt(0).cloneRange(); range.setStart(node, Math.min(start, node.length)); return { selection, range }; }
function replaceInlineSuggestionQuery(value: string) { const active = activeInlineQueryRange(); if (!active) return; active.range.deleteContents(); const text = document.createTextNode(`[[${value}`); active.range.insertNode(text); active.range.setStartAfter(text); active.range.collapse(true); active.selection.removeAllRanges(); active.selection.addRange(active.range); activeEditable?.dispatchEvent(new Event("input", { bubbles: true })); }
function insertInlineSuggestion(item: LinkSuggestion) {
  if (item.kind === "notebook") return replaceInlineSuggestionQuery(`${item.title}/`);
  if (item.kind === "document") return replaceInlineSuggestionQuery(`${item.notebookName}/${item.title}/`);
  const active = activeInlineQueryRange();
  if (!active || !activeEditable) return;
  const target = suggestionWikiTarget(item, { headingByTitle: true }).text;
  if (editorMode === "source") { replaceInlineSuggestionQuery(target); hideInlineLinkSuggestions(); return; }
  const link = document.createElement("span");
  link.className = "wiki-link"; link.contentEditable = "false";
  link.dataset.targetId = item.id;
  if ("blockId" in item && item.blockId) link.dataset.targetBlockId = item.blockId;
  if (item.kind === "record" || item.kind === "cell") {
    link.dataset.targetRecordId = item.recordId;
    if (item.fieldKey) link.dataset.targetFieldKey = item.fieldKey;
  }
  if ("scope" in item && item.scope) link.dataset.targetScope = item.scope;
  link.dataset.targetTitle = item.label; link.textContent = item.label;
  active.range.deleteContents(); active.range.insertNode(link); active.range.setStartAfter(link); active.range.collapse(true);
  active.selection.removeAllRanges(); active.selection.addRange(active.range); hideInlineLinkSuggestions(); activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
}
function handleInlineLinkKeys(event: KeyboardEvent) { if (linkSuggestions.hidden || !linkMenuItems.length) return; if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); linkMenuIndex = (linkMenuIndex + (event.key === "ArrowDown" ? 1 : -1) + linkMenuItems.length) % linkMenuItems.length; const editable = activeEditable; if (editable) renderInlineLinkSuggestions(editable); } else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insertInlineSuggestion(linkMenuItems[linkMenuIndex]); } else if (event.key === "Escape") { event.preventDefault(); hideInlineLinkSuggestions(); } }
function insertCalendarLink(targetDocumentId: string, targetBlockId?: string, targetScope?: ReferenceTargetScope, label = "日记") {
  if (readingContext) {
    if (!ui.readingInsertCalendarLink?.(targetDocumentId, targetBlockId, targetScope, label)) showError(new Error("请先打开并选择一份读物"));
    return;
  }
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

function addBlock(type: BlockType, options: { focusFirst?: boolean } = {}) {
  if (editorMode === "preview") return;
  if (!state) return;
  const block = createBlock(type);
  state.blocks.push(block);
  const shell = renderOwnBlockShell(block);
  blockSurface.append(shell);
  if (options.focusFirst !== false) shell.querySelector<HTMLElement>(".block-text")?.focus();
  scheduleDocumentSave(0);
}

function insertLocationBlock(locationId: string) {
  if (readingContext) {
    if (!ui.readingInsertLocationBlock?.(locationId)) showError(new Error("请先打开读物，或检查位置是否存在"));
    return;
  }
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

function filesFromTransfer(transfer: DataTransfer | null | undefined) {
  if (!transfer) return [];
  const files = [...transfer.items].filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
  return files.length ? files : [...transfer.files];
}
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error ?? new Error("读取媒体文件失败")); reader.onload = () => { const value = String(reader.result ?? ""); const comma = value.indexOf(","); comma < 0 ? reject(new Error("媒体文件编码失败")) : resolve(value.slice(comma + 1)); }; reader.readAsDataURL(file); });
}
type MediaDropPlacement = { targetId?: string; groupId?: string; position: "before" | "after" | "column-left" | "column-right" | "group-before" | "group-after" };
function mediaPlacementFromAnchor(anchor?: HTMLElement | null): MediaDropPlacement | null { const shell = anchor?.closest<HTMLElement>("[data-own-block]") ?? activeBlock; return shell?.dataset.id ? { targetId: shell.dataset.id, position: "after" } : null; }
function insertMediaAssets(assets: readonly MediaAsset[], placement: MediaDropPlacement | null) {
  if (!state || !assets.length) return;
  const target = placement?.targetId ? state.blocks.find(block => block.id === placement.targetId) : undefined; const append = Number(nextPosition(null));
  const blocks = assets.map((asset, index) => { const block = createBlock("media"); block.content = { text: asset.name, html: "", media: asset }; block.position = String(append + index * 1000).padStart(8, "0"); state!.blocks.push(block); return block; });
  if (target && (placement?.position === "column-left" || placement?.position === "column-right") && !target.parentId) placeBlocksInColumn(blocks, target, placement.position);
  else if (target) { blocks.forEach(block => { block.parentId = target.parentId; if (target.properties.columnGroup) setColumnMember(block, target.properties.columnGroup, columnIndex(target), target.properties.columnWidths); }); insertBlocksRelative(blocks, target, placement?.position === "before" ? "before" : "after"); }
  state.blocks = orderBlockTree(state.blocks); renderAllPanels(); scheduleDocumentSave(0);
}
async function insertMediaFiles(files: readonly File[], anchor?: HTMLElement | null, placement = mediaPlacementFromAnchor(anchor)) {
  if (!state || editorMode === "preview") return; const documentState = state; const accepted = files.filter(file => file.size >= 0); if (!accepted.length) { showError(new Error("请选择可读取的媒体文件。")); return; }
  const assets: MediaAsset[] = []; const failures: string[] = [];
  for (const file of accepted) { try { const data = await fileToBase64(file); assets.push((await host.storeMedia({ name: file.name, mimeType: file.type, size: file.size, data })).media); } catch (error) { failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); } }
  if (state !== documentState) { showError(new Error("媒体读取期间文档已切换，请在目标文档中重新插入。")); return; }
  insertMediaAssets(assets, placement); if (failures.length) showError(new Error(`部分媒体未插入：${failures.join("；")}`));
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
    try { await flush(); } catch { return; }
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
      post({ type: "saveInstanceBlock", referenceInstanceId: reference.id, block: referenceEditor.blockFromReferenceRow(row, block) });
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
  if (event.kind === "documentLoaded") {
    if (ui.routeDocumentLoaded) ui.routeDocumentLoaded(event.payload.state);
    else render(structuredClone(event.payload.state));
  }
  if (event.kind === "focusBlock") {
    if (ui.routeFocusBlock) ui.routeFocusBlock(event.payload.blockId);
    else focusBlock(event.payload.blockId);
  }
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
document.querySelector("#add-database")?.addEventListener("click", databaseController.addTable);
document.querySelector("#add-query")?.addEventListener("click", databaseController.addDataView);
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
  ui.showStyleScope?.("notebook");
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
  const media = !files.length && (event.clipboardData?.types.includes("text/uri-list") || event.clipboardData?.types.includes("text/html"))
    ? mediaFromTransfer(event.clipboardData) : null;
  if (!files.length && !media) return;
  event.preventDefault();
  if (files.length) void insertMediaFiles(files, target);
  else if (media) insertMediaAssets([media], mediaPlacementFromAnchor(target));
}, true);
document.addEventListener("copy", event => {
  const remembered = styleSelection;
  if (!remembered || remembered.editable === remembered.endEditable || !event.clipboardData) return;
  const text = selectedEditableRanges(remembered.start, remembered.end).map(range => range.toString()).join("\n");
  if (!text) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", text);
});
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
document.addEventListener("pointerdown", beginCrossBlockSelection, true);
document.addEventListener("pointermove", updateCrossBlockSelection, true);
document.addEventListener("pointerup", finishCrossBlockSelection, true);
document.addEventListener("pointercancel", finishCrossBlockSelection, true);
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
        clearColumnPlacement(block);
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
  const siblings = state.blocks.filter(candidate => !movedIds.has(candidate.id) && candidate.parentId === target.parentId &&
    (groupId ? candidate.properties.columnGroup === groupId && columnIndex(candidate) === column : !candidate.properties.columnGroup));
  siblings.sort((left, right) => left.position.localeCompare(right.position) || left.id.localeCompare(right.id));
  const targetIndex = siblings.findIndex(candidate => candidate.id === target.id);
  const insertion = Math.max(0, targetIndex + (position === "after" ? 1 : 0));
  siblings.splice(Math.min(insertion, siblings.length), 0, ...blocks);
  siblings.forEach((candidate, index) => { candidate.position = String((index + 1) * 1000).padStart(8, "0"); });
}

function placeBlocksInColumn(blocks: Block[], target: Block, position: "column-left" | "column-right") {
  if (!state) return;
  let groupId = target.properties.columnGroup;
  if (!groupId) {
    groupId = `columns-${newId()}`;
    const targetPosition = target.position;
    setColumnMember(target, groupId, position === "column-left" ? 1 : 0, [1, 1]);
    blocks.forEach(block => setColumnMember(block, groupId!, position === "column-left" ? 0 : 1, [1, 1]));
    target.position = targetPosition;
    blocks.forEach((block, index) => { block.position = String(Number(targetPosition) + index).padStart(8, "0"); });
  } else {
    const targetColumn = columnIndex(target);
    const insertedColumn = position === "column-left" ? targetColumn : targetColumn + 1;
    state.blocks.filter(block => block.properties.columnGroup === groupId).forEach(block => {
      if (columnIndex(block) >= insertedColumn) block.properties = { ...block.properties, column: columnIndex(block) + 1 };
    });
    const widths = state.blocks.find(block => block.properties.columnGroup === groupId)?.properties.columnWidths ?? [];
    const nextWidths = [...widths.slice(0, insertedColumn), 1, ...widths.slice(insertedColumn)];
    state.blocks.filter(block => block.properties.columnGroup === groupId).forEach(block => {
      block.properties = { ...block.properties, columnWidths: nextWidths };
    });
    blocks.forEach((block, index) => {
      setColumnMember(block, groupId!, insertedColumn, nextWidths);
      block.position = String(Number(target.position) + index).padStart(8, "0");
    });
    normalizeColumnGroup(groupId);
  }
}

function clearDropIndicator() { dropIndicator = null; blockSurface.querySelectorAll<HTMLElement>(".drop-before,.drop-after,.drop-column-left,.drop-column-right,.drop-group-before,.drop-group-after,.drop-media").forEach(el => el.classList.remove("drop-before", "drop-after", "drop-column-left", "drop-column-right", "drop-group-before", "drop-group-after", "drop-media")); }
function setDropIndicator(shell: HTMLElement, position: "before" | "after") { clearDropIndicator(); dropIndicator = { targetId: shell.dataset.id, position }; shell.classList.add(position === "before" ? "drop-before" : "drop-after"); }
function setColumnDropIndicator(shell: HTMLElement, side: "left" | "right") { clearDropIndicator(); dropIndicator = { targetId: shell.dataset.id, position: side === "left" ? "column-left" : "column-right" }; shell.classList.add(side === "left" ? "drop-column-left" : "drop-column-right"); }
function setGroupDropIndicator(row: HTMLElement, groupId: string, side: "before" | "after") {
  clearDropIndicator();
  dropIndicator = { groupId, position: side === "before" ? "group-before" : "group-after" };
  // Column rows use the same visible insertion-line contract as ordinary rows.
  row.classList.add(side === "before" ? "drop-before" : "drop-after");
}
function setColumnDividerIndicator(_divider: HTMLElement, shell: HTMLElement, side: "left" | "right") { setColumnDropIndicator(shell, side); }
function setDragPreview(event: DragEvent, values: string[]) {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", values.join("\n"));
  const ghost = document.createElement("div"); ghost.className = "drag-ghost drag-ghost-multi"; ghost.style.position = "absolute"; ghost.style.top = "-1000px";
  values.forEach((value, index) => { const item = document.createElement("div"); item.className = "drag-ghost-item"; item.dataset.index = String(index + 1); item.textContent = value.length > 100 ? `${value.slice(0, 100)}…` : value; ghost.append(item); });
  document.body.append(ghost); event.dataTransfer.setDragImage(ghost, 14, 14); setTimeout(() => ghost.remove(), 0);
}
function handleDragStart(event: DragEvent) { const grip = (event.target as HTMLElement).closest<HTMLElement>(".grip"); if (!grip || !state) return; const row = grip.matches(".columns-row-grip") ? grip.closest<HTMLElement>(".columns-row[data-column-group]") : null; if (row?.dataset.columnGroup) { draggingColumnGroup = row.dataset.columnGroup; draggingBlockIds = state.blocks.filter(block => block.properties.columnGroup === draggingColumnGroup).map(block => block.id); draggingBlockId = draggingBlockIds[0] ?? null; setDragPreview(event, draggingBlockIds.map(id => state!.blocks.find(block => block.id === id)).filter((block): block is Block => Boolean(block)).map(blockSummaryForDrag)); return; } const shell = grip.closest<HTMLElement>(".block-shell[data-own-block]"); if (!shell?.dataset.id || grip.closest(".reference-row")) return; draggingBlockId = shell.dataset.id; draggingBlockIds = selectedBlockIds.has(draggingBlockId) && selectedBlockIds.size > 1 ? [...selectedBlockIds] : [draggingBlockId]; event.dataTransfer?.setData("text/x-block-id", draggingBlockId); event.dataTransfer?.setData("text/x-source-document-id", state.note.id); setDragPreview(event, draggingBlockIds.map(id => state!.blocks.find(block => block.id === id)).filter((block): block is Block => Boolean(block)).map(blockSummaryForDrag)); }
function updateMediaDropIndicator(event: DragEvent) { const shell = (event.target as HTMLElement).closest<HTMLElement>(".block-shell[data-own-block]"); if (!shell) return clearDropIndicator(); const rect = shell.getBoundingClientRect(); const x = (event.clientX - rect.left) / Math.max(1, rect.width); const y = (event.clientY - rect.top) / Math.max(1, rect.height); x < .18 ? setColumnDropIndicator(shell, "left") : x > .82 ? setColumnDropIndicator(shell, "right") : setDropIndicator(shell, y < .5 ? "before" : "after"); }
function updateBlockDropIndicator(event: DragEvent) {
  const target = event.target as HTMLElement;
  const shell = target.closest<HTMLElement>(".block-shell[data-own-block]");
  if (shell && shell.dataset.id !== draggingBlockId) {
    const rect = shell.getBoundingClientRect();
    const x = (event.clientX - rect.left) / Math.max(1, rect.width);
    const y = (event.clientY - rect.top) / Math.max(1, rect.height);
    if (x < .18) setColumnDropIndicator(shell, "left");
    else if (x > .82) setColumnDropIndicator(shell, "right");
    else setDropIndicator(shell, y < .5 ? "before" : "after");
    return;
  }
  const row = target.closest<HTMLElement>(".columns-row[data-column-group]");
  if (row?.dataset.columnGroup) {
    const rect = row.getBoundingClientRect();
    setGroupDropIndicator(row, row.dataset.columnGroup, event.clientY < rect.top + rect.height / 2 ? "before" : "after");
    return;
  }
  clearDropIndicator();
}
function handleDragOver(event: DragEvent) {
  if (!draggingBlockId && (hasMediaTransfer(event.dataTransfer) || event.dataTransfer?.types.includes("text/plain"))) {
    event.preventDefault(); blockSurface.classList.add("media-drop-active"); updateMediaDropIndicator(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    return;
  }
  if (!draggingBlockId) return;
  updateBlockDropIndicator(event);
  event.preventDefault();
}
function handleDragLeave(event: DragEvent) { if (!(event.relatedTarget instanceof Node) || !blockSurface.contains(event.relatedTarget)) { blockSurface.classList.remove("media-drop-active", "external-block-drop-active"); clearDropIndicator(); } }
function handleDragEnd() { blockSurface.classList.remove("media-drop-active", "external-block-drop-active"); clearDropIndicator(); draggingBlockId = null; draggingBlockIds = []; draggingColumnGroup = null; }

function handleDrop(event: DragEvent) {
  event.preventDefault();
  const files = filesFromTransfer(event.dataTransfer);
  const media = !files.length && !draggingBlockId && !event.dataTransfer?.types.includes("text/x-block-id")
    ? mediaFromTransfer(event.dataTransfer) : null;
  if (files.length || media) {
    updateMediaDropIndicator(event);
    const placement = dropIndicator && dropIndicator.position !== "child" ? { ...dropIndicator } as MediaDropPlacement : null;
    blockSurface.classList.remove("media-drop-active");
    clearDropIndicator();
    draggingBlockId = null;
    if (files.length) void insertMediaFiles(files, event.target as HTMLElement, placement);
    else if (media) insertMediaAssets([media], placement);
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
  draggedBlocks.forEach(clearColumnPlacement);
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
    placeBlocksInColumn(draggedBlocks, targetBlock, position);
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

// Register drag events on block surface (delegated)
blockSurface.addEventListener("dragstart", handleDragStart as EventListener);
blockSurface.addEventListener("dragover", handleDragOver as EventListener);
blockSurface.addEventListener("dragleave", handleDragLeave as EventListener);
blockSurface.addEventListener("drop", handleDrop as EventListener);
blockSurface.addEventListener("dragend", handleDragEnd);

void host.request("ready", {}).catch(showError);
function clear() {
  canvasContext = false;
  readingContext = false;
  ui.setBacklinkTarget?.(null);
  state = null;
  activeEditable = null;
  sidebarLink = null;
  sidebarSequence++;
  dismissPreview();
  hideInlineLinkSuggestions();
  titleInput.value = "";
  blockSurface.replaceChildren();
  ui.clearReferencePanel?.();
  editGroup = newId();
  ui.clearPanelContext?.();
  ui.updateHistory?.({ documentId: "", entries: [], currentId: "", canUndo: false, canRedo: false });
  saveStatus.textContent = "请选择或新建笔记";
}
async function createDiaryDocument(documentId: string, headingTitle: string) {
  const fromCanvas = canvasContext || readingContext;
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
  // Canvas owns the active surface's persistence. Save the diary document
  // directly without replacing the mounted Canvas state.
  if (fromCanvas) {
    if (!exists) await host.saveDocument({ documentId, mutationId: newId(), clientVersion: (loaded.note.clientVersion ?? 0) + 1, title: loaded.note.title, blocks: loaded.blocks });
    return;
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
  addBlockComment,
  editBlockComment,
  deleteBlockComment,
  applyStyleToSelection,
  saveManagedStyle,
  deleteManagedStyle,
  saveDatabaseQuery: databaseController.saveDatabaseQuery,
  saveDatabaseSchema: databaseController.saveDatabaseSchema,
  exportDatabaseById: databaseController.exportDatabaseById,
  executeLocationCommand: (command: { operation: string; [key: string]: unknown }, label: string) => executeLocationCommand(command, label).then(() => undefined),
  insertLocationBlock,
  handleOverrideNoticeAction,
  rowSignature,
  renderReference,
  closeSidebarPreview,
  showSidebarOrdinaryModeMenu,
  createDiaryDocument,
  insertCalendarLink,
  readOnlyProjection: (reference: ReferenceInstance, context = state!) => renderReadOnlyProjection(reference, context, { renderText: renderTextProjection, resolveWikiTargets }),
  contentFromMarkdown,
  retry: () => { commandFailure = null; enqueueDocumentSave(); },
  load: (next: EditorState) => { canvasContext = false; render(next); },
  loadCanvas: (next: EditorState) => { canvasContext = true; render(next); },
  loadReading: (next: EditorState) => { canvasContext = false; render(structuredClone(next), true); },
  showBacklinksFor: (blockId: string, context?: EditorState) => ui.setBacklinkTarget?.(blockId, context),
  setCanvasActiveBlock: (block?: Block) => {
    activeBlock = block ? blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`) : null;
    ui.setCommentSelection?.(block?.id ?? null);
    syncDatabaseSelection();
    const isDatabase = !!block && !!blockModules.require(block.type).editor.activatesDatabasePanel;
    ui.setDatabaseContext?.(!!isDatabase, !!isDatabase);
  }
};
}
