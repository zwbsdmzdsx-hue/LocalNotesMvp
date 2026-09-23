import type { CanvasDocument, CanvasNode, WorkspaceApi, WorkspaceDocument } from "./workspace-api";
import { markdownFromContent, renderMarkdown } from "./markdown";
import type { EditorState } from "../../protocol/types";

type CanvasCallbacks = {
  onOpenDocument(documentId: string): void;
  onOpenCanvas(canvasId: string): void;
  onError(error: unknown): void;
  onWorkspaceChanged(): void;
  onLoadDocumentPreview(documentId: string): Promise<EditorState>;
};

export type CanvasManager = {
  open(canvasId: string): void;
  close(): void;
  isOpen(): boolean;
  activeId(): string | null;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

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

  const item = (id: string | undefined) => workspace.snapshot().documents.find(entry => entry.id === id);

  function closeSuggestions() {
    suggestionPopup?.remove();
    suggestionPopup = null;
    suggestionInput = null;
    suggestionNode = null;
  }

  function linkTargetSource(title: string, blockId?: string) {
    const doc = workspace.snapshot().documents.find(entry => entry.title === title || entry.title.endsWith(title));
    if (!doc) return null;
    return blockId ? `[[${doc.title}#^${blockId}]]` : `[[${doc.title}]]`;
  }

  function showLinkSuggestions(input: HTMLTextAreaElement, node: CanvasNode) {
    const source = input.value;
    const marker = source.lastIndexOf("[[");
    if (marker < 0 || source.indexOf("]]", marker) >= 0) { closeSuggestions(); return; }
    const query = source.slice(marker + 2);
    if (!query.trim() && !source.endsWith("[[")) { closeSuggestions(); return; }
    const hits = workspace.search(query.replace(/^.*?\//, "").replace(/#\^.*$/, ""), 24);
    const docs = workspace.snapshot().documents
      .filter(entry => !query.trim() || entry.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .map(entry => ({ id: entry.id, title: entry.title, blockId: undefined as string | undefined, excerpt: entry.kind === "canvas" ? "Canvas" : "整篇文档" }));
    const merged = [...docs, ...hits.filter(hit => hit.kind === "block").map(hit => ({ id: hit.documentId, title: hit.documentTitle, blockId: hit.blockId ?? undefined, excerpt: hit.excerpt }))]
      .filter((candidate, index, all) => all.findIndex(other => `${other.id}:${other.blockId ?? ""}` === `${candidate.id}:${candidate.blockId ?? ""}`) === index);
    closeSuggestions();
    const popup = document.createElement("div");
    popup.className = "canvas-link-suggestions";
    const rect = input.getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${Math.min(window.innerHeight - 260, rect.bottom + 4)}px`;
    const heading = document.createElement("div");
    heading.className = "canvas-link-suggestions-head";
    heading.textContent = "插入引用";
    popup.append(heading);
    if (!merged.length) {
      const empty = document.createElement("div"); empty.className = "canvas-link-empty"; empty.textContent = "没有匹配的文档或块"; popup.append(empty);
    }
    merged.slice(0, 12).forEach(candidate => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "canvas-link-suggestion";
      button.innerHTML = `<span aria-hidden="true">${candidate.blockId ? "¶" : candidate.id.startsWith("canvas-") ? "◇" : "▤"}</span><strong></strong><small></small>`;
      button.querySelector("strong")!.textContent = candidate.title;
      button.querySelector("small")!.textContent = candidate.blockId ? candidate.excerpt : "整篇文档";
      button.onmousedown = event => {
        event.preventDefault();
        const replacement = linkTargetSource(candidate.title, candidate.blockId);
        if (!replacement) return;
        const marker = input.value.lastIndexOf("[[");
        input.value = `${input.value.slice(0, marker)}${replacement}`;
        node.content = input.value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        closeSuggestions();
      };
      popup.append(button);
    });
    document.body.append(popup);
    suggestionPopup = popup;
    suggestionInput = input;
    suggestionNode = node;
  }

  function renderInlineLinks(container: HTMLElement, source: string) {
    container.innerHTML = renderMarkdown(source);
    container.querySelectorAll<HTMLElement>(".wiki-link").forEach(link => {
      const title = link.dataset.targetTitle ?? link.textContent?.trim() ?? "";
      const target = workspace.snapshot().documents.find(entry => entry.title === title || entry.title.endsWith(title));
      if (!target) return;
      link.dataset.targetId = target.id;
      link.title = `打开 ${target.title}`;
      link.onclick = event => { event.preventDefault(); event.stopPropagation(); target.kind === "canvas" ? callbacks.onOpenCanvas(target.id) : callbacks.onOpenDocument(target.id); };
    });
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
          }
          saveState.textContent = "已保存";
        }
      }).catch(error => {
        saveState.textContent = "保存失败";
        callbacks.onError(error);
      });
  }

  function scheduleSave(delay = 0) {
    if (!current) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveState.textContent = "保存中";
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!current) return;
      queueSnapshot(current.id, structuredClone(current.nodes), structuredClone(current.viewport));
    }, delay);
  }

  function nodeLabel(node: CanvasNode, target?: WorkspaceDocument) {
    if (node.kind === "text") return "自由卡片";
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
      for (const block of documentState.blocks.slice(0, 12)) {
        const line = document.createElement("div");
        line.className = `canvas-document-line type-${block.type}`;
        line.innerHTML = renderMarkdown(markdownFromContent(block.content));
        fragment.append(line);
      }
      container.replaceChildren(fragment);
      if (!documentState.blocks.length) container.innerHTML = `<span class="canvas-preview-loading">空白文档</span>`;
    } catch {
      if (token === renderToken && container.isConnected) container.textContent = "无法载入文档预览";
    }
  }

  function selectNode(nodeId: string, additive: boolean) {
    if (!additive) selected.clear();
    if (additive && selected.has(nodeId)) selected.delete(nodeId);
    else selected.add(nodeId);
    stage.querySelectorAll<HTMLElement>(".canvas-node").forEach(node => node.classList.toggle("selected", selected.has(node.dataset.nodeId!)));
  }

  function beginMove(event: PointerEvent, nodeId: string) {
    if (!current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectNode(nodeId, event.shiftKey);
    const start = { x: event.clientX, y: event.clientY };
    const moving = current.nodes.filter(node => selected.has(node.id)).map(node => ({ node, x: node.x, y: node.y }));
    const pointerId = event.pointerId;
    const move = (next: PointerEvent) => {
      if (!current || next.pointerId !== pointerId) return;
      const dx = (next.clientX - start.x) / current.viewport.zoom;
      const dy = (next.clientY - start.y) / current.viewport.zoom;
      moving.forEach(entry => {
        entry.node.x = Math.round(entry.x + dx);
        entry.node.y = Math.round(entry.y + dy);
        const element = stage.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(entry.node.id)}"]`);
        if (element) { element.style.left = `${entry.node.x}px`; element.style.top = `${entry.node.y}px`; }
      });
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      scheduleSave();
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
    current.nodes = current.nodes.filter(node => node.id !== nodeId);
    selected.delete(nodeId);
    renderNodes();
    scheduleSave();
  }

  function toggleCanvasMode(node: CanvasNode) {
    node.displayMode = node.displayMode === "icon" ? "preview" : "icon";
    if (node.displayMode === "icon") { node.width = 112; node.height = 112; }
    else { node.width = 300; node.height = 210; }
    renderNodes();
    scheduleSave();
  }

  function openTarget(target: WorkspaceDocument | undefined) {
    if (!target) return;
    target.kind === "canvas" ? callbacks.onOpenCanvas(target.id) : callbacks.onOpenDocument(target.id);
  }

  function renderNodes() {
    if (!current) return;
    const token = ++renderToken;
    stage.replaceChildren();
    empty.hidden = current.nodes.length > 0;
    for (const node of current.nodes) {
      const target = item(node.targetId);
      const element = document.createElement("article");
      element.className = `canvas-node canvas-node-${node.kind}${node.displayMode === "icon" ? " icon-mode" : ""}${selected.has(node.id) ? " selected" : ""}`;
      element.dataset.nodeId = node.id;
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
      element.style.width = `${node.width}px`;
      element.style.height = `${node.height}px`;
      element.style.zIndex = String(node.zIndex);
      element.onclick = event => { event.stopPropagation(); selectNode(node.id, event.shiftKey); };

      const head = document.createElement("header");
      head.className = "canvas-node-head";
      const grip = document.createElement("button");
      grip.className = "canvas-node-grip";
      grip.type = "button";
      grip.title = "拖动";
      grip.setAttribute("aria-label", `拖动${nodeLabel(node, target)}`);
      grip.textContent = "⠿";
      grip.onpointerdown = event => beginMove(event, node.id);
      const label = document.createElement("span");
      label.className = "canvas-node-label";
      label.textContent = nodeLabel(node, target);
      head.append(grip, label);

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
      if (node.kind !== "text") {
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
      if (node.kind === "text") {
        const textarea = document.createElement("textarea");
        textarea.className = "canvas-note-text";
        textarea.placeholder = "写下想法，输入 [[ 插入引用...";
        textarea.value = node.content ?? "";
        const preview = document.createElement("div");
        preview.className = "canvas-note-preview";
        body.classList.add("canvas-note-editing");
        const syncPreview = () => {
          node.content = textarea.value;
          renderInlineLinks(preview, node.content);
          preview.hidden = document.activeElement === textarea && !textarea.value.trim();
          scheduleSave(450);
        };
        textarea.oninput = () => {
          syncPreview();
          showLinkSuggestions(textarea, node);
        };
        textarea.onfocus = () => { body.classList.add("canvas-note-editing"); preview.hidden = true; };
        textarea.onblur = () => { window.setTimeout(() => { closeSuggestions(); body.classList.remove("canvas-note-editing"); preview.hidden = false; }, 120); };
        preview.onclick = () => textarea.focus();
        renderInlineLinks(preview, node.content ?? "");
        preview.hidden = !!(node.content ?? "").trim() && document.activeElement === textarea;
        body.append(textarea, preview);
      } else if (node.kind === "document" && target) {
        void renderDocumentPreview(body, target.id, token);
      } else if (node.kind === "canvas" && target) {
        if (node.displayMode === "icon") {
          const icon = document.createElement("button");
          icon.type = "button";
          icon.className = "canvas-link-icon";
          icon.title = `打开 ${target.title}`;
          icon.innerHTML = `<span aria-hidden="true">◇</span><strong></strong>`;
          icon.querySelector("strong")!.textContent = target.title;
          icon.onclick = () => openTarget(target);
          body.append(icon);
        } else renderCanvasThumbnail(body, target.id);
      } else body.innerHTML = `<span class="canvas-missing">目标已删除</span>`;
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

  function addText(point = nextPosition()) {
    if (!current) return;
    const maxZ = Math.max(0, ...current.nodes.map(node => node.zIndex));
    const node: CanvasNode = { id: uid("canvas-note"), kind: "text", x: Math.round(point.x), y: Math.round(point.y), width: 280, height: 180, zIndex: maxZ + 1, content: "" };
    current.nodes.push(node);
    selected = new Set([node.id]);
    renderNodes();
    scheduleSave();
    requestAnimationFrame(() => stage.querySelector<HTMLTextAreaElement>(`[data-node-id="${CSS.escape(node.id)}"] textarea`)?.focus());
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
      id: uid("canvas-link"), kind: target.kind, targetId: target.id,
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
      { label: "插入文档", icon: "▤", run: () => showLibrary(point) },
      { label: "插入引用", icon: "↗", run: () => openReferenceComposer(point) }
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
    const node: CanvasNode = { id: uid("canvas-reference"), kind: "text", x: Math.round(point.x), y: Math.round(point.y), width: 320, height: 150, zIndex: Math.max(0, ...current.nodes.map(item => item.zIndex)) + 1, content: "[[" };
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
      if (restored) { current = restored; selected.clear(); renderNodes(); }
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
    if (!event.dataTransfer?.types.includes("text/x-workspace-item-id")) return;
    event.preventDefault();
    viewport.classList.add("drop-active");
    event.dataTransfer.dropEffect = "copy";
  });
  viewport.addEventListener("dragleave", event => {
    if (!(event.relatedTarget instanceof Node && viewport.contains(event.relatedTarget))) viewport.classList.remove("drop-active");
  });
  viewport.addEventListener("drop", event => {
    viewport.classList.remove("drop-active");
    const id = event.dataTransfer?.getData("text/x-workspace-item-id");
    if (!id) return;
    event.preventDefault();
    addReference(id, worldPoint(event.clientX, event.clientY), true);
  });

  let panning: { pointerId: number; clientX: number; clientY: number; x: number; y: number } | null = null;
  viewport.addEventListener("pointerdown", event => {
    if (!current || (!(event.button === 1 || event.button === 0 && event.altKey)) || (event.target as Element).closest(".canvas-node,.canvas-library")) return;
    event.preventDefault();
    panning = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: current.viewport.x, y: current.viewport.y };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-panning");
  });
  viewport.addEventListener("pointermove", event => {
    if (!current || !panning || panning.pointerId !== event.pointerId) return;
    current.viewport.x = panning.x + event.clientX - panning.clientX;
    current.viewport.y = panning.y + event.clientY - panning.clientY;
    applyViewport();
  });
  viewport.addEventListener("pointerup", event => {
    if (!panning || panning.pointerId !== event.pointerId) return;
    panning = null;
    viewport.classList.remove("is-panning");
    scheduleSave();
  });
  viewport.addEventListener("wheel", event => {
    if (!current) return;
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
    selected.clear();
    title.value = canvas.title;
    editor.hidden = true;
    view.hidden = false;
    document.body.dataset.workspaceMode = "canvas";
    renderNodes();
    viewport.focus({ preventScroll: true });
  }

  function close() {
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

  return { open, close, isOpen: () => !view.hidden, activeId: () => current?.id ?? null };
}
