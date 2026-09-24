import type { CanvasCurve, CanvasDocument, CanvasNode, CanvasPoint, CanvasStroke, WorkspaceApi, WorkspaceDocument } from "./workspace-api";
import { markdownFromContent, renderMarkdown } from "./markdown";
import { queryLinkSuggestions, headingInfo, type LinkSuggestion } from "./link-suggestions";
import type { BlockContent, EditorCommand, EditorState, LinkToken, ReferenceInstance, ReferenceMode, MediaAsset } from "../../protocol/types";

type CanvasCallbacks = {
  onOpenDocument(documentId: string, blockId?: string): void;
  onOpenCanvas(canvasId: string): void;
  onError(error: unknown): void;
  onWorkspaceChanged(): void;
  onLoadDocumentPreview(documentId: string): Promise<EditorState>;
  executeCommand(command: EditorCommand, documentId: string): Promise<{ state: EditorState }>;
  renderProjection(reference: ReferenceInstance, context: EditorState): HTMLElement;
  contentFromMarkdown(source: string, fallback: BlockContent): BlockContent;
  storeMedia?(file: File): Promise<MediaAsset>;
  onStateChanged?(state: EditorState): void;
  onHistoryChanged?(model: NonNullable<CanvasDocument["history"]>): void;
  onActiveBlockChanged?(block?: import("../../protocol/types").Block): void;
};

export type CanvasManager = {
  open(canvasId: string): void;
  close(): void;
  isOpen(): boolean;
  activeId(): string | null;
  flush(): Promise<void>;
  refreshReferences(): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  restoreHistory(entryId: string): Promise<void>;
  applyEditorState(state: EditorState, persist?: boolean): void;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function todoStatus(checked: boolean, dueAt?: string, completedAt?: string) {
  if (checked) return dueAt && (completedAt || todayIsoDate()) > dueAt ? "complete-late" : "complete-early";
  if (dueAt && todayIsoDate() > dueAt) return "overdue";
  return dueAt ? "pending" : "none";
}

export function mountCanvasManager(workspace: WorkspaceApi, callbacks: CanvasCallbacks): CanvasManager {
  const host = document.querySelector<HTMLElement>(".workspace")!;
  const editor = host.querySelector<HTMLElement>(".editor")!;
  const view = document.createElement("section");
  view.className = "canvas-view";
  view.hidden = true;
  view.innerHTML = `
    <header class="canvas-bar">
      <span class="canvas-mark" aria-hidden="true">◇</span>
      <input class="canvas-title" aria-label="Canvas 名称" maxlength="120">
      <span class="canvas-save-state" role="status">已保存</span>
      <span class="canvas-bar-spacer"></span>
      <button type="button" data-canvas-action="add" title="新建自由卡片" aria-label="新建自由卡片">＋</button>
      <button type="button" data-canvas-action="insert" title="插入文档或 Canvas" aria-label="插入文档或 Canvas">⌘</button>
      <button type="button" data-canvas-action="media" title="插入媒体" aria-label="插入媒体">▧</button>
      <button type="button" data-canvas-action="draw" title="手绘" aria-label="手绘">✎</button>
      <button type="button" data-canvas-action="curve" title="绘制曲线" aria-label="绘制曲线">⌁</button>
      <button type="button" data-canvas-action="undo" title="撤销" aria-label="撤销">↶</button>
      <button type="button" data-canvas-action="redo" title="重做" aria-label="重做">↷</button>
      <button type="button" data-canvas-action="fit" title="适合全部内容" aria-label="适合全部内容">⊡</button>
      <output class="canvas-zoom">100%</output>
    </header>
    <div class="canvas-viewport" tabindex="0" aria-label="无限画布">
      <div class="canvas-stage"></div>
      <div class="canvas-empty" hidden>空白 Canvas</div>
      <div class="canvas-library" hidden></div>
    </div>`;
  host.append(view);

  const viewport = view.querySelector<HTMLElement>(".canvas-viewport")!;
  const stage = view.querySelector<HTMLElement>(".canvas-stage")!;
  const empty = view.querySelector<HTMLElement>(".canvas-empty")!;
  const library = view.querySelector<HTMLElement>(".canvas-library")!;
  const title = view.querySelector<HTMLInputElement>(".canvas-title")!;
  const saveState = view.querySelector<HTMLElement>(".canvas-save-state")!;
  const zoomLabel = view.querySelector<HTMLOutputElement>(".canvas-zoom")!;
  const undo = view.querySelector<HTMLButtonElement>("[data-canvas-action=undo]")!;
  const redo = view.querySelector<HTMLButtonElement>("[data-canvas-action=redo]")!;
  let current: CanvasDocument | null = null;
  let selected = new Set<string>();
  let renderToken = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveTail = Promise.resolve();
  let libraryPoint: { x: number; y: number } | null = null;
  let suggestionPopup: HTMLElement | null = null;
  let suggestionInput: HTMLTextAreaElement | null = null;
  let suggestionNode: CanvasNode | null = null;
  let catalog: EditorState | null = null;
  let menuIndex = 0;
  let menuItems: LinkSuggestion[] = [];
  let composing = false;
  let modePopup: HTMLElement | null = null;
  let referenceTail = Promise.resolve();
  let saveError: unknown = null;
  let drawMode = false;
  let drawing: { pointerId: number; points: CanvasPoint[]; node: CanvasNode } | null = null;
  let curveMode = false;
  let pendingCurveEndpoint: { nodeId: string; side: CanvasCurve["start"]["side"] } | null = null;
  let curveStylePopup: HTMLElement | null = null;
  let curveStyleDismiss: ((event: PointerEvent) => void) | null = null;
  let nodeMenuPopup: HTMLElement | null = null;
  let nodeMenuDismiss: ((event: PointerEvent) => void) | null = null;
  let iconPreviewPopup: HTMLElement | null = null;
  let iconPreviewTimer: ReturnType<typeof setTimeout> | null = null;

  function emitState() {
    if (!current || !catalog) return;
    const saved = workspace.canvas(current.id);
    const next = structuredClone(catalog);
    next.note.title = current.title;
    next.blocks = current.nodes.flatMap(node => node.block ? [structuredClone(node.block)] : []);
    next.references = structuredClone(current.references);
    if (saved?.history) {
      next.history = saved.history;
      callbacks.onHistoryChanged?.(saved.history);
    }
    callbacks.onStateChanged?.(next);
  }

  function applyEditorState(next: EditorState, persist = false) {
    if (!current || current.id !== next.note.id) return;
    catalog = structuredClone(next);
    current.title = next.note.title;
    current.references = structuredClone(next.references);
    if (next.history) {
      current.history = structuredClone(next.history);
      current.canUndo = next.history.canUndo;
      current.canRedo = next.history.canRedo;
      updateHistoryButtons();
    }
    const blocks = new Map(next.blocks.map(block => [block.id, block]));
    const existingBlockIds = new Set<string>();
    current.nodes = current.nodes.filter(node => {
      if (!node.block) return true;
      existingBlockIds.add(node.block.id);
      return blocks.has(node.block.id);
    });
    current.nodes.forEach(node => {
      if (node.block) {
        const block = blocks.get(node.block.id);
        if (block) node.block = structuredClone(block);
      }
    });
    for (const block of next.blocks) {
      if (existingBlockIds.has(block.id)) continue;
      const point = nextPosition();
      current.nodes.push({
        id: block.id,
        kind: "block",
        x: point.x,
        y: point.y,
        width: 320,
        height: 180,
        zIndex: Math.max(0, ...current.nodes.map(node => node.zIndex)) + 1,
        block: structuredClone(block)
      });
    }
    if (persist) {
      renderNodes();
      scheduleSave();
    } else {
      renderNodes();
    }
  }

  const item = (id: string | undefined) => workspace.snapshot().documents.find(entry => entry.id === id);

  function closeSuggestions() {
    suggestionPopup?.remove();
    suggestionPopup = null;
    suggestionInput = null;
    suggestionNode = null;
  }

  function activeQuery(input: HTMLTextAreaElement) {
    if (input.selectionStart !== input.selectionEnd) return null;
    const end = input.selectionStart;
    const before = input.value.slice(0, end);
    const start = before.lastIndexOf("[[");
    if (start < 0 || before.slice(start).includes("]]") || before.slice(start).includes("\n")) return null;
    return { start, end, query: before.slice(start + 2) };
  }

  function popupAt(popup: HTMLElement, anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(340, innerWidth - 16);
    popup.style.width = width + "px";
    popup.style.left = Math.max(8, Math.min(innerWidth - width - 8, rect.left)) + "px";
    popup.style.top = Math.max(8, Math.min(innerHeight - popup.offsetHeight - 8, rect.bottom + 4)) + "px";
  }

  function showLinkSuggestions(input: HTMLTextAreaElement, node: CanvasNode) {
    if (composing) return;
    const query = activeQuery(input);
    if (!query || !catalog) { closeSuggestions(); return; }
    const result = queryLinkSuggestions(query.query, catalog,
      blocks => blocks.slice(0, 1).map(block => renderMarkdown(markdownFromContent(block.content)) ||
        (block.type === "database_table" ? "▦ 数据库表" : block.type === "media" ? "▧ 媒体" : block.type === "data_view" ? "▦ 查询视图" : "📍 位置")).join(""));
    // Keep direct document-name completion as a shortcut, while hierarchical
    // notebook/document/block queries share exactly the document resolver.
    if (!query.query.includes("/") && !query.query.includes("#")) {
      const needle = query.query.toLocaleLowerCase();
      for (const doc of catalog.documents.filter(doc => !needle || doc.title.toLocaleLowerCase().includes(needle))) {
        result.items.push({ kind: "target", id: doc.id, title: doc.title, label: doc.title, meta: doc.notebookName ?? "",
          notebookName: doc.notebookName, documentTitle: doc.title });
      }
    }
    closeSuggestions();
    menuItems = result.items;
    menuIndex = 0;
    suggestionInput = input;
    suggestionNode = node;
    const popup = document.createElement("div");
    popup.className = "canvas-link-suggestions";
    popup.setAttribute("role", "listbox");
    popup.setAttribute("aria-label", "插入引用");
    const heading = document.createElement("div");
    heading.className = "canvas-link-suggestions-head";
    heading.textContent = [...result.trail, result.stage === "notebook" ? "选择笔记本或文档" : result.stage === "document" ? "选择文档" : "选择正文块"].join(" / ");
    popup.append(heading);
    if (!menuItems.length) {
      const empty = document.createElement("div"); empty.className = "canvas-link-empty"; empty.textContent = "没有匹配内容"; popup.append(empty);
    }
    menuItems.forEach((candidate, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "canvas-link-suggestion" + (index === menuIndex ? " active" : "");
      button.dataset.kind = candidate.kind;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === menuIndex));
      if ((candidate.kind === "target" || candidate.kind === "heading") && candidate.blockId) {
        button.dataset.blockId = candidate.blockId;
        const line = document.createElement("span"); line.className = "link-suggestion-block-line";
        line.innerHTML = candidate.preview || renderMarkdown(candidate.label);
        button.append(line);
      } else {
        const label = document.createElement("strong"); label.textContent = candidate.title;
        const meta = document.createElement("small"); meta.textContent = candidate.meta;
        button.append(label, meta);
      }
      button.onmousedown = event => event.preventDefault();
      button.onclick = () => insertSuggestion(candidate, input, node);
      popup.append(button);
    });
    document.body.append(popup);
    suggestionPopup = popup;
    popupAt(popup, input);
  }

  function insertSuggestion(candidate: LinkSuggestion, input: HTMLTextAreaElement, node: CanvasNode) {
    const query = activeQuery(input);
    if (!query || !node.block) return;
    if (candidate.kind === "notebook" || candidate.kind === "document") {
      const trail = candidate.kind === "notebook" ? candidate.title : candidate.notebookName + "/" + candidate.title;
      input.setRangeText("[[" + trail + "/", query.start, query.end, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      return;
    }
    const doc = catalog?.documents.find(doc => doc.id === candidate.id);
    if (!doc) return;
    // IDs are authoritative in links; text remains a reviewable Markdown label.
    const targetText = (doc.notebookName ? doc.notebookName + "/" : "") + doc.title;
    const source = "[[" + targetText + (candidate.scope === "heading" ? "#" + candidate.label : candidate.blockId ? "#^" + candidate.blockId : "") + "]]";
    // Direct title shortcut preserves existing compact Markdown, but still binds ID.
    const replacement = !query.query.includes("/") && !candidate.blockId ? "[[" + doc.title + "]]" : source;
    const token: LinkToken = { targetDocumentId: doc.id, targetBlockId: candidate.blockId, targetScope: candidate.scope,
      targetText: replacement.slice(2, -2).split("#")[0], start: query.start, end: query.start + replacement.length };
    input.setRangeText(replacement, query.start, query.end, "end");
    node.block.content.links = [...(node.block.content.links ?? []), token];
    closeSuggestions();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    showReferenceModes(input, node, token);
  }

  function showReferenceModes(anchor: HTMLElement, node: CanvasNode, token: LinkToken) {
    modePopup?.remove();
    const popup = document.createElement("div");
    popup.className = "canvas-reference-modes context-menu";
    popup.setAttribute("role", "menu");
    popup.setAttribute("aria-label", "引用显示方式");
    const label = document.createElement("strong"); label.textContent = "引用显示方式"; popup.append(label);
    (["link", "inline", "collapsed"] as ReferenceMode[]).forEach(mode => {
      const button = document.createElement("button"); button.type = "button";
      button.textContent = mode === "link" ? "仅标题链接" : mode === "inline" ? "正文直显" : "折叠卡片";
      button.onmousedown = event => event.preventDefault();
      button.onclick = () => {
        popup.remove(); modePopup = null;
        void changeReferenceMode(node, token, mode);
      };
      popup.append(button);
    });
    document.body.append(popup); modePopup = popup; popupAt(popup, anchor);
  }

  function matchingReference(node: CanvasNode, token: LinkToken) {
    return current?.references.find(ref => ref.hostBlockId === node.id &&
      ref.targetDocumentId === token.targetDocumentId && ref.targetBlockId === token.targetBlockId && ref.targetScope === token.targetScope);
  }

  async function changeReferenceMode(node: CanvasNode, token: LinkToken, mode: ReferenceMode) {
    const owner = current?.id;
    if (!owner || !token.targetDocumentId) return;
    const task = referenceTail.then(async () => {
      await flush();
      if (current?.id !== owner) return;
      let reference = matchingReference(node, token);
      if (!reference && mode !== "link") {
        const result = await callbacks.executeCommand({ operation: "create-reference", hostBlockId: node.id,
          targetDocumentId: token.targetDocumentId, targetBlockId: token.targetBlockId, targetScope: token.targetScope }, owner);
        current.references = result.state.references;
        reference = matchingReference(node, token);
      }
      if (reference && reference.mode !== mode) {
        const result = await callbacks.executeCommand({ operation: "set-reference-mode", referenceInstanceId: reference.id, mode }, owner);
        current.references = result.state.references;
      }
      const saved = workspace.canvas(owner);
      if (saved && current?.id === owner) {
        current.version = saved.version; current.canUndo = saved.canUndo; current.canRedo = saved.canRedo;
        updateHistoryButtons();
        stage.querySelector<HTMLTextAreaElement>('[data-node-id="' + CSS.escape(node.id) + '"] textarea')?.blur();
        refreshReferences();
      }
    });
    referenceTail = task.catch(error => { callbacks.onError(error); saveState.textContent = "引用保存失败"; });
    await referenceTail;
  }

  function resolveLink(link: HTMLElement, node?: CanvasNode): LinkToken | undefined {
    const title = link.dataset.targetTitle ?? "";
    const blockId = link.dataset.targetBlockId;
    const pinned = node?.block?.content.links?.find(token => token.targetText === title &&
      (!blockId || token.targetBlockId === blockId) && token.targetScope === link.dataset.targetScope);
    if (pinned?.targetDocumentId) return pinned;
    const docs = catalog?.documents ?? [];
    const doc = docs.find(doc => (doc.notebookName ? doc.notebookName + "/" : "") + doc.title === title)
      ?? (docs.filter(doc => doc.title === title).length === 1 ? docs.find(doc => doc.title === title) : undefined);
    if (!doc) return;
    const heading = link.dataset.targetHeading;
    return { targetDocumentId: doc.id, targetBlockId: blockId ?? (heading ? doc.blocks?.find(block => headingInfo(block)?.title === heading)?.id : undefined),
      targetScope: heading ? "heading" : undefined, targetText: title, start: 0, end: 0 };
  }

  function renderInlineLinks(container: HTMLElement, source: string, node?: CanvasNode) {
    container.innerHTML = renderMarkdown(source);
    container.querySelectorAll<HTMLElement>(".wiki-link").forEach(link => {
      const token = resolveLink(link, node);
      if (!token?.targetDocumentId) return;
      const target = item(token.targetDocumentId);
      if (!target) { link.textContent = "引用目标已删除"; return; }
      link.dataset.targetId = target.id;
      const reference = node && matchingReference(node, token);
      if (reference && reference.mode !== "link") {
        const card = document.createElement("span");
        card.className = "canvas-live-reference";
        card.dataset.referenceId = reference.id;
        const header = document.createElement("span"); header.className = "canvas-reference-head";
        const toggle = document.createElement("button"); toggle.type = "button";
        toggle.textContent = reference.mode === "collapsed" ? "▸" : "▾";
        toggle.setAttribute("aria-label", reference.mode === "collapsed" ? "展开引用" : "折叠引用");
        toggle.onclick = event => { event.stopPropagation(); void changeReferenceMode(node!, token, reference.mode === "collapsed" ? "inline" : "collapsed"); };
        const open = document.createElement("button"); open.type = "button"; open.textContent = target.title; open.title = "打开源文档";
        open.onclick = event => { event.stopPropagation(); callbacks.onOpenDocument(target.id, token.targetBlockId); };
        const modes = document.createElement("button"); modes.type = "button"; modes.textContent = "⋯"; modes.setAttribute("aria-label", "引用显示方式");
        modes.onclick = event => { event.stopPropagation(); showReferenceModes(modes, node!, token); };
        header.append(toggle, open, modes); card.append(header);
        if (reference.mode !== "collapsed") {
          const body = document.createElement("span"); body.className = "canvas-reference-content"; body.textContent = "载入引用…"; card.append(body);
          void callbacks.onLoadDocumentPreview(reference.targetDocumentId).then(context => {
            if (!body.isConnected) return;
            body.replaceChildren(callbacks.renderProjection(reference, context));
            body.querySelectorAll<HTMLElement>(".preview-block").forEach(row => {
              const block = reference.blocks.find(block => block.id === row.dataset.blockId);
              if (!block || !["paragraph", "heading", "todo"].includes(block.type)) return;
              row.title = "双击编辑此处引用内容（不修改源块）";
              row.ondblclick = event => {
                if ((event.target as Element).closest("textarea, button, a, input, .wiki-link")) return;
                event.preventDefault(); event.stopPropagation();
                const content = reference.overrides.find(override => override.targetBlockId === block.id)?.patch.content ?? block.content;
                const input = document.createElement("textarea");
                input.className = "canvas-reference-edit"; input.setAttribute("aria-label", "编辑引用内容");
                input.value = markdownFromContent(content);
                row.replaceChildren(input); input.focus();
                input.onkeydown = event => { event.stopPropagation(); if (event.key === "Escape") { input.value = markdownFromContent(content); input.blur(); } };
                input.onblur = () => {
                  const owner = current?.id;
                  if (!owner || input.value === markdownFromContent(content)) { input.remove(); refreshReferences(); return; }
                  const nextContent = callbacks.contentFromMarkdown(input.value, content);
                  referenceTail = referenceTail.then(async () => {
                    await flush();
                    await callbacks.executeCommand({ operation: "save-override", referenceInstanceId: reference.id,
                      targetBlockId: block.id, content: nextContent, properties: block.properties }, owner);
                    if (current?.id !== owner) return;
                    const saved = workspace.canvas(owner)!;
                    current.version = saved.version; current.canUndo = saved.canUndo; current.canRedo = saved.canRedo;
                    input.remove(); updateHistoryButtons(); refreshReferences(); emitState();
                  }).catch(error => { input.classList.add("save-error"); callbacks.onError(error); });
                };
              };
            });
          }).catch(() => { if (body.isConnected) body.textContent = "无法载入引用"; });
        }
        link.replaceWith(card);
      } else {
        link.title = "打开 " + target.title + " · 右键选择引用显示方式";
        link.onclick = event => { event.preventDefault(); event.stopPropagation(); target.kind === "canvas" ? callbacks.onOpenCanvas(target.id) : callbacks.onOpenDocument(target.id, token.targetBlockId); };
        if (node) link.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); showReferenceModes(link, node, token); };
      }
    });
  }

  function refreshReferences() {
    if (!current) return;
    const owner = current.id;
    const saved = workspace.canvas(owner);
    if (saved) current.references = saved.references;
    stage.querySelectorAll<HTMLElement>(".canvas-note-preview").forEach(preview => {
      if (preview.querySelector(".canvas-reference-edit")) return;
      const node = current?.nodes.find(node => node.id === preview.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId);
      if (node?.block) renderInlineLinks(preview, markdownFromContent(node.block.content), node);
    });
    emitState();
    // Reload the document-shaped projection as well, so backlinks, styles,
    // database metadata and source previews in the shared right sidebar use
    // the same fresh snapshot as the Canvas reference cards.
    void callbacks.onLoadDocumentPreview(owner).then(next => {
      if (!current || current.id !== owner) return;
      catalog = next;
      const latest = workspace.canvas(owner);
      if (latest) {
        current.references = latest.references;
        current.history = latest.history;
        current.canUndo = latest.canUndo;
        current.canRedo = latest.canRedo;
      }
      emitState();
    }).catch(() => undefined);
  }

  function applyViewport() {
    if (!current) return;
    stage.style.transform = `translate(${current.viewport.x}px, ${current.viewport.y}px) scale(${current.viewport.zoom})`;
    viewport.style.setProperty("--canvas-grid-x", `${current.viewport.x}px`);
    viewport.style.setProperty("--canvas-grid-y", `${current.viewport.y}px`);
    viewport.style.setProperty("--canvas-grid-size", `${24 * current.viewport.zoom}px`);
    zoomLabel.value = `${Math.round(current.viewport.zoom * 100)}%`;
  }

  function updateHistoryButtons() {
    undo.disabled = !current?.canUndo;
    redo.disabled = !current?.canRedo;
  }

  function worldPoint(clientX: number, clientY: number) {
    const rect = viewport.getBoundingClientRect();
    const viewportState = current?.viewport ?? { x: 0, y: 0, zoom: 1 };
    return {
      x: (clientX - rect.left - viewportState.x) / viewportState.zoom,
      y: (clientY - rect.top - viewportState.y) / viewportState.zoom
    };
  }

  function nextPosition() {
    if (!current?.nodes.length) return { x: 140, y: 100 };
    const top = Math.min(...current.nodes.map(node => node.y));
    const right = Math.max(...current.nodes.map(node => node.x + node.width));
    return { x: right + 36, y: top };
  }

  function queueSnapshot(canvasId: string, nodes: CanvasNode[], viewportState: CanvasDocument["viewport"]) {
      saveState.textContent = "保存中";
      saveTail = saveTail.catch(() => undefined).then(async () => {
        saveError = null;
        const latest = workspace.canvas(canvasId);
        if (!latest) throw new Error("Canvas 已被删除");
        await workspace.execute({
          type: "saveCanvas",
          canvasId,
          nodes,
          viewport: viewportState,
          mutationId: uid("canvas-mutation"),
          expectedVersion: latest.version
        });
        if (current?.id === canvasId) {
          const saved = workspace.canvas(canvasId);
          if (saved) {
            current.version = saved.version;
            current.canUndo = saved.canUndo;
            current.canRedo = saved.canRedo;
            updateHistoryButtons();
            emitState();
          }
          saveState.textContent = "已保存";
          callbacks.onWorkspaceChanged();
        }
      }).catch(error => {
        saveError = error;
        saveState.textContent = "保存失败";
        callbacks.onError(error);
      });
  }

  function scheduleSave(delay = 0) {
    if (!current) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveState.textContent = "保存中";
    // Publish the optimistic Canvas snapshot before the persistence debounce.
    // The right rail reads the same snapshot, so a newly typed link or todo
    // date is visible immediately and is then reconciled again by the ACK.
    emitState();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!current) return;
      queueSnapshot(current.id, structuredClone(current.nodes), structuredClone(current.viewport));
    }, delay);
  }

  async function flush() {
    if (saveTimer && current) {
      clearTimeout(saveTimer); saveTimer = null;
      queueSnapshot(current.id, structuredClone(current.nodes), structuredClone(current.viewport));
    }
    await saveTail;
    if (saveError) throw saveError;
  }

  function nodeLabel(node: CanvasNode, target?: WorkspaceDocument) {
    if (node.kind === "block") return node.block?.type === "heading" ? "标题块" : node.block?.type === "todo" ? "待办块" : "正文块";
    if (node.kind === "draw") return "手绘";
    if (node.kind === "curve") return "曲线";
    if (node.kind === "media") return node.media?.name || "媒体";
    if (!target) return "目标已删除";
    return target.title;
  }

  function renderCanvasThumbnail(container: HTMLElement, targetId: string) {
    const target = workspace.canvas(targetId);
    if (!target) {
      container.textContent = "Canvas 已删除";
      return;
    }
    const caption = document.createElement("strong");
    caption.textContent = target.title;
    const miniature = document.createElement("div");
    miniature.className = "canvas-miniature";
    if (!target.nodes.length) miniature.innerHTML = `<span>空白 Canvas</span>`;
    else {
      const minX = Math.min(...target.nodes.map(node => node.x));
      const minY = Math.min(...target.nodes.map(node => node.y));
      const maxX = Math.max(...target.nodes.map(node => node.x + node.width));
      const maxY = Math.max(...target.nodes.map(node => node.y + node.height));
      const width = Math.max(1, maxX - minX);
      const height = Math.max(1, maxY - minY);
      target.nodes.slice(0, 24).forEach(node => {
        const tile = document.createElement("i");
        tile.className = `mini-${node.kind}`;
        tile.style.left = `${((node.x - minX) / width) * 86 + 5}%`;
        tile.style.top = `${((node.y - minY) / height) * 76 + 8}%`;
        tile.style.width = `${clamp((node.width / width) * 86, 7, 46)}%`;
        tile.style.height = `${clamp((node.height / height) * 76, 7, 46)}%`;
        miniature.append(tile);
      });
    }
    container.append(caption, miniature);
  }

  async function renderDocumentPreview(container: HTMLElement, documentId: string, token: number) {
    container.innerHTML = `<span class="canvas-preview-loading">载入文档...</span>`;
    try {
      const documentState = await callbacks.onLoadDocumentPreview(documentId);
      if (token !== renderToken || !container.isConnected) return;
      const fragment = document.createDocumentFragment();
      const collapsed = new Set<string>(documentState.blocks.filter(block => block.type === "heading" && block.properties.headingCollapsed).map(block => block.id));
      for (const block of documentState.blocks.slice(0, 12)) {
        const line = document.createElement("div");
        line.className = `canvas-document-line type-${block.type}`;
        line.dataset.blockId = block.id;
        const level = block.type === "heading" ? (block.properties.headingLevel ?? 1) : undefined;
        if (level !== undefined) {
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "canvas-heading-collapse-toggle";
          toggle.textContent = collapsed.has(block.id) ? "▸" : "▾";
          toggle.setAttribute("aria-expanded", String(!collapsed.has(block.id)));
          toggle.setAttribute("aria-label", collapsed.has(block.id) ? "展开标题内容" : "折叠标题内容");
          toggle.onclick = event => {
            event.stopPropagation();
            if (collapsed.has(block.id)) collapsed.delete(block.id); else collapsed.add(block.id);
            applyCanvasPreviewHeadingCollapse(container, documentState.blocks.slice(0, 12), collapsed);
          };
          line.append(toggle);
        }
        const content = document.createElement("span");
        content.innerHTML = renderMarkdown(markdownFromContent(block.content));
        line.append(content);
        fragment.append(line);
      }
      container.replaceChildren(fragment);
      applyCanvasPreviewHeadingCollapse(container, documentState.blocks.slice(0, 12), collapsed);
      if (!documentState.blocks.length) container.innerHTML = `<span class="canvas-preview-loading">空白文档</span>`;
    } catch {
      if (token === renderToken && container.isConnected) container.textContent = "无法载入文档预览";
    }
  }

  function applyCanvasPreviewHeadingCollapse(container: HTMLElement, blocks: import("../../protocol/types").Block[], collapsed: Set<string>) {
    let collapsedLevel: number | null = null;
    container.querySelectorAll<HTMLElement>(":scope > .canvas-document-line").forEach(line => {
      const block = blocks.find(item => item.id === line.dataset.blockId);
      if (!block) return;
      const level = block.type === "heading" ? (block.properties.headingLevel ?? 1) : undefined;
      if (level !== undefined && collapsedLevel !== null && level <= collapsedLevel) collapsedLevel = null;
      const hidden = collapsedLevel !== null;
      line.hidden = hidden;
      if (level !== undefined) {
        const toggle = line.querySelector<HTMLButtonElement>(".canvas-heading-collapse-toggle");
        if (toggle) {
          toggle.textContent = collapsed.has(block.id) ? "▸" : "▾";
          toggle.setAttribute("aria-expanded", String(!collapsed.has(block.id)));
          toggle.setAttribute("aria-label", collapsed.has(block.id) ? "展开标题内容" : "折叠标题内容");
        }
        if (!hidden && collapsed.has(block.id)) collapsedLevel = level;
      }
    });
  }

  function hideIconPreview() {
    if (iconPreviewTimer) { clearTimeout(iconPreviewTimer); iconPreviewTimer = null; }
    iconPreviewPopup?.remove();
    iconPreviewPopup = null;
  }

  function scheduleHideIconPreview() {
    if (iconPreviewTimer) clearTimeout(iconPreviewTimer);
    iconPreviewTimer = setTimeout(() => hideIconPreview(), 160);
  }

  function showIconPreview(anchor: HTMLElement, node: CanvasNode, target?: WorkspaceDocument) {
    if (!target) return;
    if (iconPreviewTimer) { clearTimeout(iconPreviewTimer); iconPreviewTimer = null; }
    iconPreviewPopup?.remove();
    const popup = document.createElement("div");
    popup.className = "canvas-icon-hover-preview";
    popup.setAttribute("role", "tooltip");
    const heading = document.createElement("strong");
    heading.textContent = target.title;
    popup.append(heading);
    const content = document.createElement("div");
    content.className = "canvas-icon-hover-content";
    popup.append(content);
    document.body.append(popup);
    iconPreviewPopup = popup;
    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(innerWidth - 336, rect.left + rect.width / 2 - 160))}px`;
    popup.style.top = `${Math.max(8, Math.min(innerHeight - 236, rect.bottom + 8))}px`;
    popup.addEventListener("pointerenter", () => { if (iconPreviewTimer) clearTimeout(iconPreviewTimer); });
    popup.addEventListener("pointerleave", scheduleHideIconPreview);
    if (node.kind === "canvas") renderCanvasThumbnail(content, target.id);
    else void renderDocumentPreview(content, target.id, renderToken);
  }

  function selectNode(nodeId: string, additive: boolean) {
    if (!additive) selected.clear();
    if (additive && selected.has(nodeId)) selected.delete(nodeId);
    else selected.add(nodeId);
    stage.querySelectorAll<HTMLElement>(".canvas-node").forEach(node => node.classList.toggle("selected", selected.has(node.dataset.nodeId!)));
    renderConnections();
    const active = current?.nodes.find(node => node.id === nodeId);
    callbacks.onActiveBlockChanged?.(active?.block);
  }

  function beginMove(event: PointerEvent, nodeId: string) {
    if (!current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectNode(nodeId, event.shiftKey);
    const start = { x: event.clientX, y: event.clientY };
    const moving = current.nodes.filter(node => selected.has(node.id)).map(node => ({ node, x: node.x, y: node.y }));
    const pointerId = event.pointerId;
    const grip = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    let moved = false;
    if (grip) grip.dataset.dragged = "false";
    const move = (next: PointerEvent) => {
      if (!current || next.pointerId !== pointerId) return;
      const dx = (next.clientX - start.x) / current.viewport.zoom;
      const dy = (next.clientY - start.y) / current.viewport.zoom;
      if (!moved && Math.hypot(next.clientX - start.x, next.clientY - start.y) > 3) {
        moved = true;
        if (grip) grip.dataset.dragged = "true";
      }
      moving.forEach(entry => {
        entry.node.x = Math.round(entry.x + dx);
        entry.node.y = Math.round(entry.y + dy);
        const element = stage.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(entry.node.id)}"]`);
        if (element) { element.style.left = `${entry.node.x}px`; element.style.top = `${entry.node.y}px`; }
      });
      renderConnections();
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      if (moved) scheduleSave();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  function beginResize(event: PointerEvent, node: CanvasNode) {
    if (!current || event.button !== 0 || node.displayMode === "icon") return;
    event.preventDefault();
    event.stopPropagation();
    selectNode(node.id, false);
    const start = { x: event.clientX, y: event.clientY, width: node.width, height: node.height };
    const element = stage.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`)!;
    const move = (next: PointerEvent) => {
      node.width = Math.round(clamp(start.width + (next.clientX - start.x) / current!.viewport.zoom, 180, 900));
      node.height = Math.round(clamp(start.height + (next.clientY - start.y) / current!.viewport.zoom, 110, 760));
      element.style.width = `${node.width}px`;
      element.style.height = `${node.height}px`;
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      scheduleSave();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  function removeNode(nodeId: string) {
    if (!current) return;
    closeNodeMenu();
    current.nodes = current.nodes.filter(node => node.id !== nodeId);
    selected.delete(nodeId);
    renderNodes();
    scheduleSave();
  }

  function toggleCanvasMode(node: CanvasNode) {
    node.displayMode = node.displayMode === "icon" ? "preview" : "icon";
    if (node.displayMode === "icon") { node.width = 112; node.height = 112; }
    else { node.width = 300; node.height = 210; }
    closeNodeMenu();
    renderNodes();
    scheduleSave();
  }

  function isReferenceBlock(node: CanvasNode) {
    if (node.kind !== "block" || !node.block) return false;
    if (node.block.content.links?.length) return true;
    const source = node.block.content.markdown ?? node.block.content.text ?? "";
    return /\[\[[^\]]+\]\]/.test(source);
  }

  function closeNodeMenu() {
    if (nodeMenuDismiss) {
      document.removeEventListener("pointerdown", nodeMenuDismiss);
      nodeMenuDismiss = null;
    }
    nodeMenuPopup?.remove();
    nodeMenuPopup = null;
  }

  function focusNodeEditor(node: CanvasNode) {
    const element = stage.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`);
    const body = element?.querySelector<HTMLElement>(".canvas-node-body");
    const preview = body?.querySelector<HTMLElement>(".canvas-note-preview");
    body?.classList.add("canvas-note-editing");
    if (preview) preview.hidden = true;
    body?.querySelector<HTMLTextAreaElement>("textarea.canvas-note-text")?.focus();
  }

  function setReferenceDisplay(node: CanvasNode, display: "preview" | "icon") {
    if (!isReferenceBlock(node)) return;
    node.referenceDisplay = display;
    if (display === "icon") {
      node.width = 112;
      node.height = 112;
    } else {
      node.width = Math.max(node.width, 260);
      node.height = Math.max(node.height, 150);
    }
    closeNodeMenu();
    renderNodes();
    scheduleSave();
  }

  function setNodeFontSize(node: CanvasNode, delta: number | null) {
    if (!node.block) return;
    if (delta === null) delete node.fontSize;
    else node.fontSize = clamp((node.fontSize ?? 14) + delta, 10, 48);
    closeNodeMenu();
    renderNodes();
    scheduleSave();
  }

  function showNodeMenu(anchor: HTMLElement, node: CanvasNode) {
    closeNodeMenu();
    const popup = document.createElement("div");
    popup.className = "canvas-node-menu canvas-context-menu";
    popup.setAttribute("role", "menu");
    popup.setAttribute("aria-label", `${nodeLabel(node, item(node.targetId))}操作`);
    popup.addEventListener("pointerdown", event => event.stopPropagation());
    const add = (label: string, icon: string, run: () => void, danger = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.className = danger ? "danger" : "";
      const mark = document.createElement("span"); mark.textContent = icon;
      const text = document.createElement("span"); text.textContent = label;
      button.append(mark, text);
      button.onclick = event => { event.stopPropagation(); run(); };
      popup.append(button);
    };
    if (node.block) {
      add("编辑块内容", "✎", () => { closeNodeMenu(); focusNodeEditor(node); });
      add("增大字号", "A+", () => setNodeFontSize(node, 2));
      add("减小字号", "A−", () => setNodeFontSize(node, -2));
      add("重置字号", "A", () => setNodeFontSize(node, null));
      if (isReferenceBlock(node)) {
        add("显示正文预览", "▤", () => setReferenceDisplay(node, "preview"));
        add("显示自定义 Icon", "◇", () => setReferenceDisplay(node, "icon"));
        add("设置引用 Icon", "✦", () => {
          const value = window.prompt("设置引用 Icon", node.referenceIcon ?? "↗");
          if (value === null) return;
          node.referenceIcon = value.trim() || "↗";
          setReferenceDisplay(node, "icon");
        });
      }
    }
    if ((node.kind === "document" || node.kind === "canvas") && item(node.targetId)) {
      add("打开目标", "↗", () => { closeNodeMenu(); openTarget(item(node.targetId)); });
      add(node.displayMode === "icon" ? "显示内容缩略图" : "显示为 Icon", "▣", () => toggleCanvasMode(node));
    }
    if (node.kind === "media") {
      add("编辑说明", "✎", () => {
        const value = window.prompt("媒体说明", node.caption ?? "");
        if (value === null) return;
        node.caption = value.trim(); closeNodeMenu(); renderNodes(); scheduleSave();
      });
    }
    add("删除此块", "×", () => removeNode(node.id), true);
    document.body.append(popup);
    nodeMenuPopup = popup;
    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(innerWidth - popup.offsetWidth - 8, rect.left))}px`;
    popup.style.top = `${Math.max(8, Math.min(innerHeight - popup.offsetHeight - 8, rect.bottom + 4))}px`;
    requestAnimationFrame(() => {
      if (nodeMenuPopup !== popup) return;
      const dismiss = (event: PointerEvent) => {
        if (!popup.contains(event.target as Node) && event.target !== anchor) {
          closeNodeMenu();
        }
      };
      nodeMenuDismiss = dismiss;
      document.addEventListener("pointerdown", dismiss);
    });
  }

  function openTarget(target: WorkspaceDocument | undefined) {
    if (!target) return;
    target.kind === "canvas" ? callbacks.onOpenCanvas(target.id) : callbacks.onOpenDocument(target.id);
  }

  function endpointPoint(endpoint: CanvasCurve["start"]): CanvasPoint | null {
    const node = current?.nodes.find(candidate => candidate.id === endpoint.nodeId && candidate.kind !== "curve" && candidate.kind !== "draw");
    if (!node) return null;
    if (endpoint.side === "top") return { x: node.x + node.width / 2, y: node.y };
    if (endpoint.side === "right") return { x: node.x + node.width, y: node.y + node.height / 2 };
    if (endpoint.side === "bottom") return { x: node.x + node.width / 2, y: node.y + node.height };
    return { x: node.x, y: node.y + node.height / 2 };
  }

  function nearestEdge(node: CanvasNode, point: CanvasPoint): CanvasCurve["start"] {
    const candidates: Array<{ side: CanvasCurve["start"]["side"]; point: CanvasPoint }> = [
      { side: "top", point: { x: node.x + node.width / 2, y: node.y } },
      { side: "right", point: { x: node.x + node.width, y: node.y + node.height / 2 } },
      { side: "bottom", point: { x: node.x + node.width / 2, y: node.y + node.height } },
      { side: "left", point: { x: node.x, y: node.y + node.height / 2 } }
    ];
    candidates.sort((a, b) => ((a.point.x - point.x) ** 2 + (a.point.y - point.y) ** 2) - ((b.point.x - point.x) ** 2 + (b.point.y - point.y) ** 2));
    return { nodeId: node.id, side: candidates[0].side };
  }

  function pathForPoints(points: CanvasPoint[]) {
    return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  }

  function curveDash(dash: CanvasCurve["dash"]) {
    return dash === "dashed" ? "10 7" : dash === "dotted" ? "2 7" : "none";
  }

  function curvePointAt(start: CanvasPoint, control1: CanvasPoint, control2: CanvasPoint, end: CanvasPoint, t = 0.5) {
    const inverse = 1 - t;
    return {
      x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * control1.x + 3 * inverse * t ** 2 * control2.x + t ** 3 * end.x,
      y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * control1.y + 3 * inverse * t ** 2 * control2.y + t ** 3 * end.y
    };
  }

  function renderConnections() {
    if (!current) return;
    stage.querySelector("svg.canvas-connections")?.remove();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("canvas-connections");
    svg.setAttribute("aria-label", "Canvas 手绘和连接线");
    svg.setAttribute("width", "10000"); svg.setAttribute("height", "10000");
    svg.style.pointerEvents = "none";
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.id = "canvas-arrow"; marker.setAttribute("markerWidth", "8"); marker.setAttribute("markerHeight", "8"); marker.setAttribute("refX", "7"); marker.setAttribute("refY", "4"); marker.setAttribute("orient", "auto");
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path"); arrow.setAttribute("d", "M0,0 L8,4 L0,8 z"); arrow.setAttribute("fill", "context-stroke"); marker.append(arrow); defs.append(marker); svg.append(defs);
    const addPath = (node: CanvasNode, pathData: string, stroke: string, width: number, dash: string, hit = false) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathData); path.setAttribute("fill", "none"); path.setAttribute("stroke", hit ? "transparent" : stroke); path.setAttribute("stroke-width", String(hit ? Math.max(16, width + 12) : width));
      path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round"); if (dash !== "none") path.setAttribute("stroke-dasharray", dash);
      path.dataset.nodeId = node.id; path.style.pointerEvents = hit ? "stroke" : "none";
      if (!hit) path.classList.add("canvas-connection-visible");
      path.addEventListener("click", event => { event.stopPropagation(); selectNode(node.id, (event as MouseEvent).shiftKey); if (node.kind === "curve" && node.curve) showCurveStyleEditor(node); });
      svg.append(path);
    };
    for (const node of current.nodes) {
      if (node.kind === "draw" && node.strokes) {
        for (const stroke of node.strokes) if (stroke.points.length > 1) addPath(node, pathForPoints(stroke.points), stroke.color, stroke.width, "none");
        const hit = node.strokes.find(stroke => stroke.points.length > 1);
        if (hit) addPath(node, pathForPoints(hit.points), "transparent", Math.max(8, hit.width), "none", true);
      }
      if (node.kind !== "curve" || !node.curve) continue;
      const start = endpointPoint(node.curve.start); const end = endpointPoint(node.curve.end);
      if (!start || !end) continue;
      const pathData = `M${start.x.toFixed(1)} ${start.y.toFixed(1)} C${node.curve.control1.x.toFixed(1)} ${node.curve.control1.y.toFixed(1)} ${node.curve.control2.x.toFixed(1)} ${node.curve.control2.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
      addPath(node, pathData, node.curve.color, node.curve.width, curveDash(node.curve.dash));
      addPath(node, pathData, "transparent", node.curve.width, "none", true);
      if (node.curve.label?.trim()) {
        const midpoint = curvePointAt(start, node.curve.control1, node.curve.control2, end);
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", String(midpoint.x));
        label.setAttribute("y", String(midpoint.y - 7));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("class", "canvas-curve-label");
        label.textContent = node.curve.label;
        label.setAttribute("aria-label", `曲线描述：${node.curve.label}`);
        label.style.pointerEvents = "none";
        svg.append(label);
      }
      if (selected.has(node.id)) {
        [node.curve.control1, node.curve.control2].forEach((point, index) => {
          const handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          handle.setAttribute("cx", String(point.x)); handle.setAttribute("cy", String(point.y)); handle.setAttribute("r", "6"); handle.setAttribute("class", "canvas-curve-control"); handle.style.pointerEvents = "all";
          handle.addEventListener("pointerdown", event => {
            event.preventDefault(); event.stopPropagation();
            const pointerId = event.pointerId;
            const move = (next: PointerEvent) => { if (next.pointerId !== pointerId || !current) return; const nextPoint = worldPoint(next.clientX, next.clientY); if (index === 0) node.curve!.control1 = nextPoint; else node.curve!.control2 = nextPoint; renderConnections(); };
            const up = (next: PointerEvent) => { if (next.pointerId !== pointerId) return; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); scheduleSave(); };
            window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
          });
          svg.append(handle);
          const guide = document.createElementNS("http://www.w3.org/2000/svg", "line");
          guide.setAttribute("x1", String(index === 0 ? start.x : end.x)); guide.setAttribute("y1", String(index === 0 ? start.y : end.y)); guide.setAttribute("x2", String(point.x)); guide.setAttribute("y2", String(point.y)); guide.setAttribute("class", "canvas-curve-guide"); guide.style.pointerEvents = "none"; svg.insertBefore(guide, handle);
        });
      }
    }
    stage.prepend(svg);
  }

  function renderNodes() {
    if (!current) return;
    const token = ++renderToken;
    stage.replaceChildren();
    renderConnections();
    empty.hidden = current.nodes.length > 0;
    for (const node of current.nodes) {
      if (node.kind === "draw" || node.kind === "curve") continue;
      const target = item(node.targetId);
      const element = document.createElement("article");
      // Keep the historical `.canvas-node-text` hook for existing integrations
      // while the semantic class now reflects the canonical Block-backed kind.
      const kindClass = node.kind === "block" ? "canvas-node-block canvas-node-text" : `canvas-node-${node.kind}`;
      element.className = `canvas-node ${kindClass}${node.displayMode === "icon" ? " icon-mode" : ""}${node.referenceDisplay === "icon" ? " reference-icon-mode" : ""}${selected.has(node.id) ? " selected" : ""}`;
      element.dataset.nodeId = node.id;
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
      element.style.width = `${node.width}px`;
      element.style.height = `${node.height}px`;
      element.style.zIndex = String(node.zIndex);
      element.addEventListener("pointerdown", event => {
        if (!curveMode || node.kind === "curve" || node.kind === "draw") return;
        // Capture the gesture before a textarea, grip, or open button can
        // consume it. Curve mode is intentionally a two-node gesture.
        event.preventDefault();
        event.stopPropagation();
        pickCurveEndpoint(node, event);
      }, true);
      element.onclick = event => {
        event.stopPropagation();
        if (curveMode && node.kind !== "curve" && node.kind !== "draw") { pickCurveEndpoint(node, event); return; }
        selectNode(node.id, event.shiftKey);
      };

      const head = document.createElement("header");
      head.className = "canvas-node-head";
      const grip = document.createElement("button");
      grip.className = "canvas-node-grip";
      grip.type = "button";
      grip.title = "拖动";
      grip.setAttribute("aria-label", `拖动${nodeLabel(node, target)}`);
      grip.textContent = "⠿";
      grip.onpointerdown = event => beginMove(event, node.id);
      grip.onclick = event => {
        event.stopPropagation();
        if (grip.dataset.dragged === "true") { grip.dataset.dragged = "false"; return; }
        showNodeMenu(grip, node);
      };
      const label = document.createElement("span");
      label.className = "canvas-node-label";
      label.textContent = nodeLabel(node, target);
      head.append(grip, label);
      if (node.block) {
        const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "✎";
        edit.setAttribute("aria-label", "编辑块源码");
        edit.onclick = event => {
          event.stopPropagation();
          const body = element.querySelector<HTMLElement>(".canvas-node-body");
          body?.classList.add("canvas-note-editing");
          const preview = body?.querySelector<HTMLElement>(".canvas-note-preview"); if (preview) preview.hidden = true;
          body?.querySelector<HTMLTextAreaElement>("textarea.canvas-note-text")?.focus();
        };
        head.append(edit);
      }

      if (node.kind === "canvas") {
        const mode = document.createElement("button");
        mode.type = "button";
        mode.className = "canvas-node-mode";
        mode.title = node.displayMode === "icon" ? "显示内容缩略图" : "显示为图标";
        mode.setAttribute("aria-label", mode.title);
        mode.textContent = node.displayMode === "icon" ? "▣" : "◇";
        mode.onclick = event => { event.stopPropagation(); toggleCanvasMode(node); };
        head.append(mode);
      }
      if (node.kind === "document" || node.kind === "canvas") {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "canvas-node-open";
        open.title = "打开";
        open.setAttribute("aria-label", `打开${nodeLabel(node, target)}`);
        open.textContent = "↗";
        open.disabled = !target;
        open.onclick = event => { event.stopPropagation(); openTarget(target); };
        head.append(open);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "canvas-node-remove";
      remove.title = "从 Canvas 移除";
      remove.setAttribute("aria-label", `移除${nodeLabel(node, target)}`);
      remove.textContent = "×";
      remove.onclick = event => { event.stopPropagation(); removeNode(node.id); };
      head.append(remove);
      element.append(head);

      const body = document.createElement("div");
      body.className = "canvas-node-body";
      if (node.kind === "block" && node.block && isReferenceBlock(node) && node.referenceDisplay === "icon") {
        const icon = document.createElement("button");
        icon.type = "button";
        icon.className = "canvas-reference-icon";
        icon.title = "打开引用目标";
        icon.setAttribute("aria-label", "打开引用目标");
        icon.innerHTML = `<span aria-hidden="true"></span><strong></strong>`;
        icon.querySelector("span")!.textContent = node.referenceIcon || "↗";
        const token = node.block.content.links?.find(link => link.targetDocumentId);
        const targetDoc = token ? item(token.targetDocumentId) : undefined;
        icon.querySelector("strong")!.textContent = targetDoc?.title ?? "引用";
        icon.addEventListener("pointerenter", () => showIconPreview(icon, { ...node, kind: "document", targetId: targetDoc?.id }, targetDoc));
        icon.addEventListener("pointerleave", scheduleHideIconPreview);
        icon.onclick = event => {
          event.stopPropagation();
          if (targetDoc) callbacks.onOpenDocument(targetDoc.id, token?.targetBlockId);
        };
        body.append(icon);
      } else if (node.kind === "block" && node.block) {
        const textarea = document.createElement("textarea");
        textarea.className = "canvas-note-text";
        textarea.placeholder = "写下想法，输入 [[ 插入引用...";
        const storedText = node.block.content.markdown ?? node.block.content.text ?? "";
        textarea.value = node.block.type === "heading"
          ? storedText.replace(/^#{1,6}\s+/, "")
          : node.block.type === "todo"
            ? storedText.replace(/^[-*+]\s+\[[ xX]\]\s+/, "")
            : storedText;
        const preview = document.createElement("div");
        preview.className = "canvas-note-preview";
        body.classList.toggle("canvas-note-editing", !textarea.value.trim());
        const syncPreview = () => {
          const prefix = node.block!.type === "heading"
            ? `${"#".repeat(node.block!.properties.headingLevel ?? 1)} `
            : node.block!.type === "todo"
              ? `- [${node.block!.content.checked ? "x" : " "}] `
              : "";
          node.block!.content = callbacks.contentFromMarkdown(`${prefix}${textarea.value}`, node.block!.content);
          node.block!.revision += 1;
          renderInlineLinks(preview, `${prefix}${textarea.value}`, node);
          preview.hidden = body.classList.contains("canvas-note-editing");
          scheduleSave(450);
        };
        textarea.oninput = () => {
          syncPreview();
          if (!composing) { modePopup?.remove(); modePopup = null; showLinkSuggestions(textarea, node); }
        };
        textarea.onfocus = () => { body.classList.add("canvas-note-editing"); preview.hidden = true; };
        textarea.onblur = () => { closeSuggestions(); body.classList.remove("canvas-note-editing"); preview.hidden = false; };
        textarea.addEventListener("compositionstart", () => { composing = true; closeSuggestions(); });
        textarea.addEventListener("compositionend", () => { composing = false; syncPreview(); showLinkSuggestions(textarea, node); });
        textarea.addEventListener("click", () => showLinkSuggestions(textarea, node));
        textarea.addEventListener("keydown", event => {
          if (event.isComposing || composing || event.keyCode === 229) return;
          if (event.key === "Escape") { event.preventDefault(); closeSuggestions(); modePopup?.remove(); modePopup = null; return; }
          if (!suggestionPopup || suggestionInput !== textarea) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            menuIndex = (menuIndex + (event.key === "ArrowDown" ? 1 : -1) + menuItems.length) % Math.max(1, menuItems.length);
            suggestionPopup.querySelectorAll<HTMLElement>("[role=option]").forEach((option, index) => {
              option.classList.toggle("active", index === menuIndex); option.setAttribute("aria-selected", String(index === menuIndex));
              if (index === menuIndex) option.scrollIntoView({ block: "nearest" });
            });
          } else if ((event.key === "Enter" || event.key === "Tab") && menuItems[menuIndex]) {
            event.preventDefault(); insertSuggestion(menuItems[menuIndex], textarea, node);
          }
        });
        preview.onclick = event => {
          if (!(event.target as Element).closest(".canvas-live-reference, .wiki-link, button, a, input")) {
            body.classList.add("canvas-note-editing"); preview.hidden = true; textarea.focus();
          }
        };
        const initialPrefix = node.block.type === "heading"
          ? `${"#".repeat(node.block.properties.headingLevel ?? 1)} `
          : node.block.type === "todo"
            ? `- [${node.block.content.checked ? "x" : " "}] `
            : "";
        renderInlineLinks(preview, `${initialPrefix}${textarea.value}`, node);
        preview.hidden = body.classList.contains("canvas-note-editing");
        if (node.block.type === "todo") {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "canvas-todo-check";
          checkbox.checked = !!node.block.content.checked;
          checkbox.setAttribute("aria-label", "完成待办");
          checkbox.onchange = () => {
            node.block!.content.checked = checkbox.checked;
            node.block!.properties.todoCompletedAt = checkbox.checked
              ? (node.block!.properties.todoCompletedAt || todayIsoDate())
              : undefined;
            const completedInput = body.querySelector<HTMLInputElement>(".todo-completed-date");
            if (completedInput) completedInput.value = node.block!.properties.todoCompletedAt ?? "";
            const indicator = body.querySelector<HTMLElement>(".canvas-todo-status");
            const status = todoStatus(checkbox.checked, node.block!.properties.todoDueAt, node.block!.properties.todoCompletedAt);
            if (indicator) {
              indicator.className = `canvas-todo-status todo-status-${status}`;
              indicator.textContent = status === "complete-early" || status === "complete-late" ? "✓" : status === "overdue" ? "!" : status === "pending" ? "○" : "";
            }
            syncPreview();
          };
          body.prepend(checkbox);
          const dates = document.createElement("span");
          dates.className = "canvas-todo-dates";
          dates.setAttribute("aria-label", "待办日期");
          const dateControl = (className: string, labelText: string, value: string | undefined, disabled = false) => {
            const label = document.createElement("label");
            label.title = labelText;
            const caption = document.createElement("span"); caption.textContent = labelText;
            const input = document.createElement("input");
            input.type = "date"; input.className = className; input.setAttribute("aria-label", labelText); input.value = value ?? ""; input.disabled = disabled;
            input.addEventListener("change", () => {
              const property = className === "todo-created-date" ? "todoCreatedAt" : className === "todo-due-date" ? "todoDueAt" : "todoCompletedAt";
              const next = input.value || undefined;
              node.block!.properties[property] = next;
              if (property === "todoCompletedAt") {
                node.block!.content.checked = !!next;
                checkbox.checked = !!next;
              }
              const indicator = body.querySelector<HTMLElement>(".canvas-todo-status");
              const status = todoStatus(!!node.block!.content.checked, node.block!.properties.todoDueAt, node.block!.properties.todoCompletedAt);
              if (indicator) {
                indicator.className = `canvas-todo-status todo-status-${status}`;
                indicator.textContent = status === "complete-early" || status === "complete-late" ? "✓" : status === "overdue" ? "!" : status === "pending" ? "○" : "";
              }
              if (property === "todoCompletedAt") syncPreview();
              scheduleSave(0);
            });
            label.append(caption, input); dates.append(label);
          };
          dateControl("todo-created-date", "创建", node.block.properties.todoCreatedAt);
          dateControl("todo-due-date", "应完成", node.block.properties.todoDueAt);
          dateControl("todo-completed-date", "完成", node.block.properties.todoCompletedAt);
          const status = document.createElement("span");
          status.className = "canvas-todo-status";
          const todoState = todoStatus(!!node.block.content.checked, node.block.properties.todoDueAt, node.block.properties.todoCompletedAt);
          status.classList.add(`todo-status-${todoState}`);
          status.textContent = todoState === "complete-early" || todoState === "complete-late" ? "✓" : todoState === "overdue" ? "!" : todoState === "pending" ? "○" : "";
          dates.prepend(status);
          body.append(dates);
        }
        body.append(textarea, preview);
      } else if (node.kind === "media" && node.media) {
        const media = node.media;
        if (media.kind === "image") {
          const image = document.createElement("img"); image.className = "canvas-media-preview"; image.src = media.url; image.alt = node.caption || media.name; body.append(image);
        } else if (media.kind === "video") {
          const video = document.createElement("video"); video.className = "canvas-media-preview"; video.src = media.url; video.controls = true; body.append(video);
        } else if (media.kind === "audio") {
          const audio = document.createElement("audio"); audio.className = "canvas-media-preview"; audio.src = media.url; audio.controls = true; body.append(audio);
        } else if (media.kind === "pdf") {
          const frame = document.createElement("iframe"); frame.className = "canvas-media-pdf"; frame.src = media.url; frame.title = media.name; body.append(frame);
        } else {
          const link = document.createElement("a"); link.className = "canvas-media-file"; link.href = media.url; link.download = media.name; link.textContent = `下载 ${media.name}`; body.append(link);
        }
        if (node.caption) { const caption = document.createElement("div"); caption.className = "canvas-media-caption"; caption.textContent = node.caption; body.append(caption); }
      } else if (node.kind === "document" && target) {
        if (node.displayMode === "icon") {
          const icon = document.createElement("button");
          icon.type = "button";
          icon.className = "canvas-link-icon";
          icon.title = `打开 ${target.title}`;
          icon.innerHTML = `<span aria-hidden="true">▤</span><strong></strong>`;
          icon.querySelector("strong")!.textContent = target.title;
          icon.onclick = event => { event.stopPropagation(); openTarget(target); };
          icon.addEventListener("pointerenter", () => showIconPreview(icon, node, target));
          icon.addEventListener("pointerleave", scheduleHideIconPreview);
          body.append(icon);
        } else void renderDocumentPreview(body, target.id, token);
      } else if (node.kind === "canvas" && target) {
        if (node.displayMode === "icon") {
          const icon = document.createElement("button");
          icon.type = "button";
          icon.className = "canvas-link-icon";
          icon.title = `打开 ${target.title}`;
          icon.innerHTML = `<span aria-hidden="true">◇</span><strong></strong>`;
          icon.querySelector("strong")!.textContent = target.title;
          icon.onclick = event => { event.stopPropagation(); openTarget(target); };
          icon.addEventListener("pointerenter", () => showIconPreview(icon, node, target));
          icon.addEventListener("pointerleave", scheduleHideIconPreview);
          body.append(icon);
        } else renderCanvasThumbnail(body, target.id);
      } else body.innerHTML = `<span class="canvas-missing">目标已删除</span>`;
      if (node.fontSize && node.block) {
        body.style.fontSize = `${clamp(node.fontSize, 10, 48)}px`;
        const textarea = body.querySelector<HTMLTextAreaElement>("textarea.canvas-note-text");
        if (textarea) textarea.style.fontSize = `${clamp(node.fontSize, 10, 48)}px`;
      }
      element.append(body);
      if (node.displayMode !== "icon") {
        const resize = document.createElement("button");
        resize.type = "button";
        resize.className = "canvas-resize-handle";
        resize.title = "调整大小";
        resize.setAttribute("aria-label", `调整${nodeLabel(node, target)}大小`);
        resize.onpointerdown = event => beginResize(event, node);
        element.append(resize);
      }
      element.ondblclick = event => {
        if ((event.target as Element).closest("button,textarea")) return;
        openTarget(target);
      };
      stage.append(element);
    }
    applyViewport();
    updateHistoryButtons();
  }

  function addBlock(point = nextPosition(), type: "paragraph" | "heading" | "todo" = "paragraph") {
    if (!current) return;
    const maxZ = Math.max(0, ...current.nodes.map(node => node.zIndex));
    const blockId = uid("canvas-block");
    const node: CanvasNode = {
      id: blockId, kind: "block", x: Math.round(point.x), y: Math.round(point.y), width: 280, height: 180, zIndex: maxZ + 1,
      block: { id: blockId, parentId: null, position: String((current.nodes.length + 1) * 1000).padStart(8, "0"), type, content: { text: "", html: "", markdown: "", checked: type === "todo" ? false : undefined }, properties: type === "heading" ? { headingLevel: 1 } : type === "todo" ? { todoCreatedAt: todayIsoDate() } : {}, revision: 1 }
    };
    current.nodes.push(node);
    selected = new Set([node.id]);
    renderNodes();
    scheduleSave();
    requestAnimationFrame(() => stage.querySelector<HTMLTextAreaElement>(`[data-node-id="${CSS.escape(node.id)}"] textarea`)?.focus());
  }

  const addText = (point = nextPosition()) => addBlock(point, "paragraph");

  function toggleDrawMode() {
    closeCurveStyleEditor();
    drawMode = !drawMode;
    curveMode = false; pendingCurveEndpoint = null;
    viewport.classList.toggle("draw-mode", drawMode);
    viewport.classList.remove("curve-mode");
    updateCanvasModeButtons();
    saveState.textContent = drawMode ? "手绘模式：拖动空白区域开始绘制" : "已保存";
  }

  function toggleCurveMode() {
    closeCurveStyleEditor();
    curveMode = !curveMode;
    drawMode = false; pendingCurveEndpoint = null;
    viewport.classList.toggle("curve-mode", curveMode);
    viewport.classList.remove("draw-mode");
    library.hidden = true;
    closeNodeMenu();
    updateCanvasModeButtons();
    saveState.textContent = curveMode ? "曲线模式：依次点击两个块的边缘" : "已保存";
  }

  function updateCanvasModeButtons() {
    const draw = view.querySelector<HTMLButtonElement>("[data-canvas-action=draw]");
    const curve = view.querySelector<HTMLButtonElement>("[data-canvas-action=curve]");
    if (draw) { draw.classList.toggle("active", drawMode); draw.setAttribute("aria-pressed", String(drawMode)); }
    if (curve) { curve.classList.toggle("active", curveMode); curve.setAttribute("aria-pressed", String(curveMode)); }
  }

  function pickCurveEndpoint(node: CanvasNode, event: MouseEvent) {
    if (!current || node.kind === "curve" || node.kind === "draw") return;
    const endpoint = nearestEdge(node, worldPoint(event.clientX, event.clientY));
    if (!pendingCurveEndpoint) {
      pendingCurveEndpoint = endpoint;
      selected = new Set([node.id]);
      saveState.textContent = "请选择曲线终点";
      renderNodes();
      return;
    }
    if (pendingCurveEndpoint.nodeId === endpoint.nodeId) return;
    const startPoint = endpointPoint(pendingCurveEndpoint) ?? worldPoint(event.clientX, event.clientY);
    const endPoint = endpointPoint(endpoint) ?? worldPoint(event.clientX, event.clientY);
    const curve: CanvasCurve = {
      start: pendingCurveEndpoint,
      end: endpoint,
      control1: { x: startPoint.x + (endPoint.x - startPoint.x) / 3, y: startPoint.y },
      control2: { x: endPoint.x - (endPoint.x - startPoint.x) / 3, y: endPoint.y },
      color: "#175cd3", width: 2, dash: "solid"
    };
    const id = uid("canvas-curve");
    current.nodes.push({ id, kind: "curve", x: Math.min(startPoint.x, endPoint.x), y: Math.min(startPoint.y, endPoint.y), width: Math.max(80, Math.abs(endPoint.x - startPoint.x)), height: Math.max(64, Math.abs(endPoint.y - startPoint.y)), zIndex: Math.max(0, ...current.nodes.map(item => item.zIndex)) + 1, curve });
    selected = new Set([id]);
    pendingCurveEndpoint = null; curveMode = false; viewport.classList.remove("curve-mode"); updateCanvasModeButtons();
    renderNodes(); scheduleSave(); showCurveStyleEditor(current.nodes.find(item => item.id === id)!);
  }

  function closeCurveStyleEditor() {
    if (curveStyleDismiss) {
      document.removeEventListener("pointerdown", curveStyleDismiss);
      curveStyleDismiss = null;
    }
    curveStylePopup?.remove();
    curveStylePopup = null;
  }

  function showCurveStyleEditor(node: CanvasNode) {
    if (!node.curve) return;
    closeCurveStyleEditor();
    const popup = document.createElement("div"); popup.className = "canvas-curve-style context-menu"; popup.setAttribute("aria-label", "曲线样式");
    const heading = document.createElement("strong"); heading.textContent = "曲线样式"; popup.append(heading);
    const colorLabel = document.createElement("label"); colorLabel.textContent = "颜色 ";
    const color = document.createElement("input"); color.type = "color"; color.value = node.curve.color; colorLabel.append(color);
    const widthLabel = document.createElement("label"); widthLabel.textContent = "粗细 ";
    const width = document.createElement("input"); width.type = "range"; width.min = "1"; width.max = "10"; width.value = String(node.curve.width);
    const output = document.createElement("output"); output.value = `${node.curve.width}px`; widthLabel.append(width, output);
    const dashLabel = document.createElement("label"); dashLabel.textContent = "线型 ";
    const dash = document.createElement("select");
    [["solid", "实线"], ["dashed", "虚线"], ["dotted", "点线"]].forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; dash.append(option); });
    dash.value = node.curve.dash; dashLabel.append(dash);
    const description = document.createElement("label"); description.textContent = "描述 ";
    const descriptionInput = document.createElement("input"); descriptionInput.type = "text"; descriptionInput.value = node.curve.label ?? ""; descriptionInput.placeholder = "连接说明"; descriptionInput.maxLength = 120; description.append(descriptionInput);
    popup.append(colorLabel, widthLabel, dashLabel, description);
    const update = () => { node.curve!.color = color.value; node.curve!.width = Number(width.value); node.curve!.dash = dash.value as CanvasCurve["dash"]; node.curve!.label = descriptionInput.value.trim() || undefined; output.value = `${node.curve!.width}px`; renderConnections(); scheduleSave(120); };
    color.oninput = width.oninput = dash.oninput = descriptionInput.oninput = update;
    document.body.append(popup); curveStylePopup = popup;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && popup.contains(event.target)) return;
      closeCurveStyleEditor();
    };
    curveStyleDismiss = dismiss;
    window.setTimeout(() => {
      if (curveStylePopup === popup) document.addEventListener("pointerdown", dismiss);
    }, 0);
    popup.addEventListener("keydown", event => { if (event.key === "Escape") closeCurveStyleEditor(); });
    const selectedPath = stage.querySelector<SVGPathElement>(`path[data-node-id="${CSS.escape(node.id)}"]`);
    const rect = selectedPath?.getBoundingClientRect() ?? viewport.getBoundingClientRect();
    popup.style.left = `${Math.min(window.innerWidth - 220, rect.left + 12)}px`; popup.style.top = `${Math.min(window.innerHeight - 180, rect.top + 12)}px`;
  }

  async function insertMediaFiles(files: readonly File[], point = nextPosition()) {
    if (!current || !callbacks.storeMedia) return;
    try {
      for (const [index, file] of files.entries()) {
        const media = await callbacks.storeMedia(file);
        const width = media.kind === "audio" ? 320 : 360;
        const height = media.kind === "audio" ? 120 : media.kind === "pdf" ? 300 : 240;
        const id = uid("canvas-media");
        current.nodes.push({ id, kind: "media", x: Math.round(point.x + index * 24), y: Math.round(point.y + index * 24), width, height, zIndex: Math.max(0, ...current.nodes.map(item => item.zIndex)) + 1, media });
      }
      renderNodes(); scheduleSave();
    } catch (error) { callbacks.onError(error); }
  }

  function chooseMedia(point = nextPosition()) {
    const input = document.createElement("input"); input.type = "file"; input.multiple = true; input.accept = "image/*,video/*,audio/*,application/pdf,*/*";
    input.onchange = () => { if (input.files?.length) void insertMediaFiles([...input.files], point); input.remove(); };
    document.body.append(input); input.click();
  }

  function addReference(targetId: string, point = nextPosition(), centerOnPoint = false) {
    if (!current) return;
    const target = item(targetId);
    if (!target) return;
    if (target.kind === "canvas" && !workspace.canLinkCanvas(current.id, target.id)) {
      callbacks.onError(new Error("这个 Canvas 引用会形成循环，已阻止插入"));
      return;
    }
    const maxZ = Math.max(0, ...current.nodes.map(node => node.zIndex));
    const width = target.kind === "canvas" ? 300 : 320;
    const height = target.kind === "canvas" ? 210 : 240;
    const node: CanvasNode = {
      id: uid("canvas-link"), kind: target.kind === "canvas" ? "canvas" : "document", targetId: target.id,
      x: Math.round(point.x - (centerOnPoint ? width / 2 : 0)), y: Math.round(point.y - (centerOnPoint ? height / 2 : 0)), width,
      height, zIndex: maxZ + 1, displayMode: "preview"
    };
    current.nodes.push(node);
    selected = new Set([node.id]);
    library.hidden = true;
    renderNodes();
    scheduleSave();
  }

  function showLibrary(point = nextPosition()) {
    if (!current) return;
    libraryPoint = point;
    library.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = "插入到 Canvas";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索文档或 Canvas";
    const list = document.createElement("div");
    list.className = "canvas-library-list";
    const entries = workspace.snapshot().documents.filter(entry => entry.id !== current!.id);
    const render = () => {
      list.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase();
      entries.filter(entry => !query || entry.title.toLocaleLowerCase().includes(query)).forEach(entry => {
        const button = document.createElement("button");
        button.type = "button";
        button.innerHTML = `<span aria-hidden="true">${entry.kind === "canvas" ? "◇" : "▤"}</span><span></span><small>${entry.kind === "canvas" ? "Canvas" : "文档"}</small>`;
        button.querySelectorAll("span")[1].textContent = entry.title;
        button.onclick = () => addReference(entry.id, libraryPoint ?? nextPosition());
        list.append(button);
      });
      if (!list.children.length) list.innerHTML = `<span class="canvas-library-empty">没有匹配项目</span>`;
    };
    search.oninput = render;
    library.append(heading, search, list);
    library.hidden = false;
    render();
    search.focus();
  }

  function showCanvasContextMenu(event: MouseEvent) {
    if (!current || (event.target as Element).closest(".canvas-node,.canvas-bar,.canvas-library")) return;
    event.preventDefault();
    document.querySelector(".canvas-context-menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "canvas-context-menu";
    const point = worldPoint(event.clientX, event.clientY);
    const actions = [
      { label: "新建块", icon: "＋", run: () => addText(point) },
      { label: "新建标题块", icon: "H", run: () => addBlock(point, "heading") },
      { label: "新建待办块", icon: "□", run: () => addBlock(point, "todo") },
      { label: "插入文档", icon: "▤", run: () => showLibrary(point) },
      { label: "插入引用", icon: "↗", run: () => openReferenceComposer(point) },
      { label: "插入媒体", icon: "▧", run: () => chooseMedia(point) },
      { label: "开始手绘", icon: "✎", run: toggleDrawMode },
      { label: "绘制曲线", icon: "⌁", run: toggleCurveMode }
    ];
    actions.forEach(action => {
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = `<span aria-hidden="true">${action.icon}</span><span>${action.label}</span>`;
      button.onclick = () => { menu.remove(); action.run(); };
      menu.append(button);
    });
    document.body.append(menu);
    menu.style.left = `${Math.min(window.innerWidth - 190, event.clientX)}px`;
    menu.style.top = `${Math.min(window.innerHeight - 150, event.clientY)}px`;
    const close = (next: MouseEvent) => {
      if (!menu.contains(next.target as Node)) { menu.remove(); document.removeEventListener("mousedown", close); }
    };
    setTimeout(() => document.addEventListener("mousedown", close), 0);
  }

  function openReferenceComposer(point = nextPosition()) {
    if (!current) return;
    const blockId = uid("canvas-reference");
    const node: CanvasNode = {
      id: blockId, kind: "block", x: Math.round(point.x), y: Math.round(point.y), width: 320, height: 150, zIndex: Math.max(0, ...current.nodes.map(item => item.zIndex)) + 1,
      block: { id: blockId, parentId: null, position: String((current.nodes.length + 1) * 1000).padStart(8, "0"), type: "paragraph", content: { text: "[[", html: "[[", markdown: "[[" }, properties: {}, revision: 1 }
    };
    current.nodes.push(node);
    selected = new Set([node.id]);
    renderNodes();
    scheduleSave();
    requestAnimationFrame(() => {
      const input = stage.querySelector<HTMLTextAreaElement>(`[data-node-id="${CSS.escape(node.id)}"] .canvas-note-text`);
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
      if (input) showLinkSuggestions(input, node);
    });
  }

  async function moveHistory(direction: "undo" | "redo") {
    if (!current) return;
    try {
      await referenceTail;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        queueSnapshot(current.id, structuredClone(current.nodes), structuredClone(current.viewport));
      }
      await saveTail;
      const latest = workspace.canvas(current.id);
      if (!latest) return;
      await workspace.execute({ type: direction === "undo" ? "undoCanvas" : "redoCanvas", canvasId: current.id, expectedVersion: latest.version });
      const restored = workspace.canvas(current.id);
      if (restored) { current = restored; selected.clear(); renderNodes(); emitState(); }
    } catch (error) { callbacks.onError(error); }
  }

  async function restoreHistory(entryId: string) {
    if (!current) return;
    try {
      await referenceTail;
      await flush();
      const latest = workspace.canvas(current.id);
      if (!latest) return;
      await workspace.execute({ type: "restoreCanvas", canvasId: current.id, entryId, expectedVersion: latest.version });
      const restored = workspace.canvas(current.id);
      if (restored) { current = restored; selected.clear(); renderNodes(); emitState(); }
    } catch (error) { callbacks.onError(error); }
  }

  function fitContent() {
    if (!current) return;
    if (!current.nodes.length) current.viewport = { x: 80, y: 80, zoom: 1 };
    else {
      const rect = viewport.getBoundingClientRect();
      const minX = Math.min(...current.nodes.map(node => node.x));
      const minY = Math.min(...current.nodes.map(node => node.y));
      const maxX = Math.max(...current.nodes.map(node => node.x + node.width));
      const maxY = Math.max(...current.nodes.map(node => node.y + node.height));
      const zoom = clamp(Math.min((rect.width - 100) / Math.max(1, maxX - minX), (rect.height - 100) / Math.max(1, maxY - minY)), .25, 1.35);
      current.viewport = { x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom, zoom };
    }
    applyViewport();
    scheduleSave();
  }

  view.querySelector<HTMLButtonElement>("[data-canvas-action=add]")!.onclick = () => addText();
  view.querySelector<HTMLButtonElement>("[data-canvas-action=insert]")!.onclick = () => library.hidden ? showLibrary() : library.hidden = true;
  view.querySelector<HTMLButtonElement>("[data-canvas-action=media]")!.onclick = () => chooseMedia();
  view.querySelector<HTMLButtonElement>("[data-canvas-action=draw]")!.onclick = toggleDrawMode;
  view.querySelector<HTMLButtonElement>("[data-canvas-action=curve]")!.onclick = toggleCurveMode;
  undo.onclick = () => void moveHistory("undo");
  redo.onclick = () => void moveHistory("redo");
  view.querySelector<HTMLButtonElement>("[data-canvas-action=fit]")!.onclick = fitContent;

  title.onchange = () => {
    if (!current) return;
    const value = title.value.trim() || "未命名 Canvas";
    title.value = value;
    current.title = value;
    void workspace.execute({ type: "renameDocument", id: current.id, name: value }).then(callbacks.onWorkspaceChanged).catch(callbacks.onError);
  };

  viewport.onclick = event => {
    if (event.target === viewport || event.target === stage) { selected.clear(); library.hidden = true; renderNodes(); }
  };
  viewport.addEventListener("contextmenu", showCanvasContextMenu);
  viewport.ondblclick = event => {
    if ((event.target as Element).closest(".canvas-node,.canvas-library,.canvas-bar")) return;
    addText(worldPoint(event.clientX, event.clientY));
  };
  viewport.addEventListener("dragover", event => {
    const hasWorkspaceItem = event.dataTransfer?.types.includes("text/x-workspace-item-id");
    const hasFiles = Boolean(event.dataTransfer?.files?.length);
    if (!hasWorkspaceItem && !hasFiles) return;
    event.preventDefault();
    viewport.classList.add("drop-active");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  viewport.addEventListener("dragleave", event => {
    if (!(event.relatedTarget instanceof Node && viewport.contains(event.relatedTarget))) viewport.classList.remove("drop-active");
  });
  viewport.addEventListener("drop", event => {
    viewport.classList.remove("drop-active");
    const files = event.dataTransfer?.files ? [...event.dataTransfer.files] : [];
    if (files.length) {
      event.preventDefault();
      void insertMediaFiles(files, worldPoint(event.clientX, event.clientY));
      return;
    }
    const id = event.dataTransfer?.getData("text/x-workspace-item-id");
    if (!id) return;
    event.preventDefault();
    addReference(id, worldPoint(event.clientX, event.clientY), true);
  });

  let panning: { pointerId: number; clientX: number; clientY: number; x: number; y: number } | null = null;
  viewport.addEventListener("pointerdown", event => {
    if (drawMode && event.button === 0 && !(event.target as Element).closest(".canvas-node,.canvas-library,.canvas-bar")) {
      event.preventDefault();
      const point = worldPoint(event.clientX, event.clientY);
      const node: CanvasNode = { id: uid("canvas-draw"), kind: "draw", x: point.x, y: point.y, width: 320, height: 220, zIndex: Math.max(0, ...current!.nodes.map(item => item.zIndex)) + 1, strokes: [{ points: [point], color: "#182230", width: 2 }] };
      current!.nodes.push(node); selected = new Set([node.id]); drawing = { pointerId: event.pointerId, points: node.strokes![0].points, node };
      viewport.setPointerCapture(event.pointerId); renderConnections();
      return;
    }
    if (!current || (!(event.button === 1 || event.button === 0 && event.altKey)) || (event.target as Element).closest(".canvas-node,.canvas-library")) return;
    event.preventDefault();
    panning = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: current.viewport.x, y: current.viewport.y };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-panning");
  });
  viewport.addEventListener("pointermove", event => {
    if (drawing && drawing.pointerId === event.pointerId && current) {
      const point = worldPoint(event.clientX, event.clientY);
      const previous = drawing.points[drawing.points.length - 1];
      if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 2) drawing.points.push(point);
      renderConnections();
      return;
    }
    if (!current || !panning || panning.pointerId !== event.pointerId) return;
    current.viewport.x = panning.x + event.clientX - panning.clientX;
    current.viewport.y = panning.y + event.clientY - panning.clientY;
    applyViewport();
  });
  viewport.addEventListener("pointerup", event => {
    if (drawing && drawing.pointerId === event.pointerId) {
      const finished = drawing;
      drawing = null;
      if (finished.points.length < 2 && current) current.nodes = current.nodes.filter(node => node.id !== finished.node.id);
      renderNodes();
      if (finished.points.length >= 2) scheduleSave();
      return;
    }
    if (!panning || panning.pointerId !== event.pointerId) return;
    panning = null;
    viewport.classList.remove("is-panning");
    scheduleSave();
  });
  viewport.addEventListener("wheel", event => {
    if (!current) return;
    if ((event.target as Element).closest(".canvas-node-body,.canvas-library") && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = viewport.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const before = { x: (px - current.viewport.x) / current.viewport.zoom, y: (py - current.viewport.y) / current.viewport.zoom };
      current.viewport.zoom = clamp(current.viewport.zoom * Math.exp(-event.deltaY * .002), .25, 2.5);
      current.viewport.x = px - before.x * current.viewport.zoom;
      current.viewport.y = py - before.y * current.viewport.zoom;
    } else {
      current.viewport.x -= event.deltaX;
      current.viewport.y -= event.deltaY;
    }
    applyViewport();
    scheduleSave(180);
  }, { passive: false });

  document.addEventListener("keydown", event => {
    if (!current || view.hidden) return;
    const target = event.target as HTMLElement;
    const editing = target.matches("input,textarea,[contenteditable=true]");
    if (!editing && (event.key === "Delete" || event.key === "Backspace") && selected.size) {
      event.preventDefault();
      current.nodes = current.nodes.filter(node => !selected.has(node.id));
      selected.clear();
      renderNodes();
      scheduleSave();
    }
    if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void moveHistory(event.shiftKey ? "redo" : "undo");
    }
    if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      void moveHistory("redo");
    }
  });

  function open(canvasId: string) {
    const canvas = workspace.canvas(canvasId);
    if (!canvas) { callbacks.onError(new Error("Canvas 不存在")); return; }
    current = canvas;
    closeSuggestions(); modePopup?.remove(); modePopup = null; closeCurveStyleEditor(); closeNodeMenu(); hideIconPreview();
    drawMode = false; curveMode = false; pendingCurveEndpoint = null; viewport.classList.remove("draw-mode", "curve-mode");
    void callbacks.onLoadDocumentPreview(canvasId).then(state => {
      if (current?.id !== canvasId) return;
      catalog = state;
      const saved = workspace.canvas(canvasId);
      if (saved) {
        current.references = saved.references;
        current.history = saved.history;
        current.canUndo = saved.canUndo;
        current.canRedo = saved.canRedo;
      }
      emitState();
      const input = document.activeElement;
      const node = current.nodes.find(node => node.id === input?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId);
      if (input instanceof HTMLTextAreaElement && node) showLinkSuggestions(input, node);
      refreshReferences();
    }).catch(callbacks.onError);
    selected.clear();
    title.value = canvas.title;
    editor.hidden = true;
    view.hidden = false;
    document.body.dataset.workspaceMode = "canvas";
    renderNodes();
    viewport.focus({ preventScroll: true });
  }

  function close() {
    closeSuggestions(); modePopup?.remove(); modePopup = null; closeCurveStyleEditor(); closeNodeMenu(); hideIconPreview();
    drawMode = false; curveMode = false; pendingCurveEndpoint = null; drawing = null; viewport.classList.remove("draw-mode", "curve-mode");
    if (saveTimer && current) {
      clearTimeout(saveTimer);
      saveTimer = null;
      queueSnapshot(current.id, structuredClone(current.nodes), structuredClone(current.viewport));
    }
    current = null;
    selected.clear();
    library.hidden = true;
    view.hidden = true;
    editor.hidden = false;
    document.body.dataset.workspaceMode = "document";
  }

  return { open, close, flush: async () => { await flush(); await referenceTail; await flush(); }, refreshReferences, undo: () => moveHistory("undo"), redo: () => moveHistory("redo"), restoreHistory, applyEditorState, isOpen: () => !view.hidden, activeId: () => current?.id ?? null };
}
