import type { Block, BlockContent, EditorState, LinkToken, MediaAsset, ReadingAnchor, ReferenceInstance, ReferenceTargetScope } from "../../protocol/types";
import type { EditorHostApi } from "./editor-host-api";
import { createRegisteredBlock as createBlock, readingBlockRole } from "./block-modules";
import { DocumentSaveSession } from "./document-session";
import { fileToBase64, mediaFromUrl } from "./media-source";
import { loadReadingPdf, pointOnReadingPage, renderReadingCover, renderReadingPage, selectedReadingAnchor } from "./reading-pdf";
import { readingCoverLabel, readingFormat, renderReadingDocument, type ReadingOutlineItem } from "./reading-renderer";
import { markdownFromContent, renderMarkdown } from "./markdown";
import { headingInfo } from "./link-suggestions";
import { textareaLinkSuggestions } from "./textarea-link-suggestions";
import { hasReadingMark, readingInspectorField, readingInspectorMatches, readingInspectorTab, type ReadingAnnotationType } from "./reading-annotation";

type ReadingCallbacks = { contentFromMarkdown(source: string, fallback: BlockContent): BlockContent; onError(error: unknown): void; onHistoryChanged?(state: EditorState): void;
  onStateChanged?(state: EditorState): void; renderProjection?(reference: ReferenceInstance, context: EditorState): HTMLElement };
type ReaderState = { page: number; zoom: number; placingNote: boolean; highlightColor: string; selectedId?: string };
type Pane = { root: HTMLElement; pageHost: HTMLElement; pageInput: HTMLInputElement; pageCount: HTMLElement; noteButton: HTMLButtonElement; annotationButton: HTMLButtonElement; generation: number; sheet?: HTMLElement; marks?: HTMLElement; textLayer?: HTMLElement };
type Snapshot = { documentId: string; title: string; blocks: Block[] };

const id = (prefix: string) => `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
const position = (count: number) => String((count + 1) * 1000).padStart(8, "0");
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export type ReadingManager = {
  open(state: EditorState): void;
  close(): void;
  isOpen(): boolean;
  activeId(): string | null;
  applyState(state: EditorState): void;
  refreshContext(state: EditorState): void;
  focusBlock(blockId: string): void;
  restoreHistory(entryId: string): Promise<void>;
  flush(): Promise<void>;
  insertCalendarLink(documentId: string, blockId?: string, scope?: ReferenceTargetScope, label?: string): boolean;
  insertLocationBlock(locationId: string): boolean;
};

export function mountReadingManager(host: EditorHostApi, callbacks: ReadingCallbacks): ReadingManager {
  const workspace = document.querySelector<HTMLElement>(".workspace")!;
  const editor = workspace.querySelector<HTMLElement>(".editor")!;
  const view = document.createElement("section"); view.className = "reading-view"; view.hidden = true;
  view.innerHTML = `<header class="reading-bar"><span class="reading-mark" aria-hidden="true">▧</span><input class="reading-title" aria-label="读书笔记名称" maxlength="120"><span class="reading-save-state" role="status">已保存</span><span class="reading-bar-spacer"></span><button type="button" data-reading-action="upload" title="添加 PDF、Markdown、文本、Word、PPT 或代码文件">＋ 读物</button><button type="button" data-reading-action="url" title="添加网络读物地址">链接</button><input class="reading-file-input" type="file" accept=".pdf,.md,.markdown,.txt,.doc,.docx,.ppt,.pptx,.asm,.bat,.c,.cc,.clj,.cpp,.cr,.cs,.css,.dart,.ex,.exs,.fs,.fsx,.gd,.go,.h,.hpp,.html,.ini,.ipynb,.java,.jl,.js,.jsx,.json,.kt,.less,.lua,.m,.mm,.pas,.php,.pl,.ps1,.py,.r,.rb,.rs,.sass,.scala,.scss,.sh,.sql,.swift,.toml,.ts,.tsx,.vb,.vbs,.vue,.wasm,.xml,.xsl,.yaml,.yml,.zig,text/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation" multiple hidden></header><div class="reading-layout"><aside class="reading-shelf"><header><strong>书架</strong><span class="reading-book-count"></span><button type="button" class="reading-shelf-toggle" aria-label="折叠书架" title="折叠书架">‹</button></header><div class="reading-book-list"></div></aside><div class="reading-readers"></div><aside class="reading-inspector"><header><strong>读书笔记</strong><button type="button" class="reading-inspector-toggle" aria-label="折叠读书笔记右栏" title="折叠读书笔记右栏">›</button></header><nav class="reading-inspector-tabs" role="tablist"><button type="button" role="tab" data-reading-inspector-tab="outline" aria-selected="true">目录</button><button type="button" role="tab" data-reading-inspector-tab="highlight" aria-selected="false">高亮</button><button type="button" role="tab" data-reading-inspector-tab="note" aria-selected="false">注释</button><button type="button" role="tab" data-reading-inspector-tab="bookmark" aria-selected="false">书签</button></nav><div class="reading-inspector-list"></div></aside></div>`;
  workspace.append(view);
  const title = view.querySelector<HTMLInputElement>(".reading-title")!;
  const saveLabel = view.querySelector<HTMLElement>(".reading-save-state")!;
  const shelf = view.querySelector<HTMLElement>(".reading-shelf")!;
  const bookList = view.querySelector<HTMLElement>(".reading-book-list")!;
  const bookCount = view.querySelector<HTMLElement>(".reading-book-count")!;
  const readers = view.querySelector<HTMLElement>(".reading-readers")!;
  const inspector = view.querySelector<HTMLElement>(".reading-inspector")!;
  const inspectorList = view.querySelector<HTMLElement>(".reading-inspector-list")!;
  const fileInput = view.querySelector<HTMLInputElement>(".reading-file-input")!;
  let current: EditorState | null = null;
  const versions = new Map<string, number>();
  const openBooks = new Set<string>();
  const collapsedBooks = new Set<string>();
  const readerStates = new Map<string, ReaderState>();
  const panes = new Map<string, Pane>();
  const outlines = new Map<string, ReadingOutlineItem[]>();
  const imports = new Set<Promise<void>>();
  let lastOpenCount = 0;
  let activeBookId: string | null = null;
  let lastInput: HTMLTextAreaElement | null = null;
  let annotationTooltip: HTMLElement | null = null;
  let annotationTooltipTimer: ReturnType<typeof setTimeout> | undefined;
  const composers = new Map<string, HTMLElement>();
  const linkSuggestions = textareaLinkSuggestions(() => current);
  const saveSession = new DocumentSaveSession<Snapshot>(async snapshot => {
    const version = versions.get(snapshot.documentId);
    if (version === undefined) throw new Error("读书笔记版本未知");
    const result = await host.saveDocument({ ...snapshot, mutationId: id("reading-save"), clientVersion: version + 1 });
    versions.set(snapshot.documentId, result.clientVersion);
    if (current?.note.id === snapshot.documentId) {
      current.note.clientVersion = result.clientVersion;
      current.history = result.history;
      callbacks.onHistoryChanged?.(structuredClone(current));
    }
  }, (phase, error) => {
    saveLabel.textContent = phase === "pending" ? "未保存" : phase === "saving" ? "保存中" : phase === "saved" ? "已保存" : "保存失败 · 点击重试";
    saveLabel.classList.toggle("is-error", phase === "failed");
    if (phase === "failed") callbacks.onError(error);
  });

  function books() { return current?.blocks.filter(block => readingBlockRole(block) === "book" && block.content.media) ?? []; }
  function annotations(bookId: string) {
    return current?.blocks.filter(block => {
      const role = readingBlockRole(block);
      return (role === "bookmark" || role === "highlight" || role === "note" || role === "attachment")
        && block.parentId === bookId && block.properties.readingAnchor?.bookId === bookId;
    }) ?? [];
  }
  function bookFor(id: string) { return books().find(block => block.id === id); }
  function linkDocument(link: LinkToken) {
    if (!current) return undefined;
    const raw = link.targetText.trim();
    const leaf = raw.split("/").map(part => part.trim()).filter(Boolean).pop() ?? raw;
    return current.documents.find(item => item.id === link.targetDocumentId)
      ?? current.documents.find(item => item.title === raw || item.title === leaf || item.path === raw || item.path?.endsWith(`/${raw}`));
  }
  function linkReference(link: LinkToken): ReferenceInstance | null {
    const document = linkDocument(link);
    const source = document?.blocks ? structuredClone(document.blocks) : [];
    if (!document || !source.length) return document ? {
      id: `reading-link-${document.id}-${link.targetBlockId ?? "document"}`,
      hostBlockId: "", targetDocumentId: document.id, targetBlockId: link.targetBlockId,
      targetScope: link.targetScope, targetTitle: document.title, mode: "link", blocks: [], overrides: [], hiddenBlockIds: [], broken: !!link.targetBlockId
    } : null;
    let blocks = source;
    if (link.targetBlockId) {
      const target = source.find(block => block.id === link.targetBlockId);
      if (!target) blocks = [];
      else if (link.targetScope === "heading" || headingInfo(target)) {
        const level = headingInfo(target)?.level ?? 1;
        const start = source.indexOf(target);
        blocks = source.slice(start).filter((block, index) => index === 0 || !headingInfo(block) || (headingInfo(block)?.level ?? 1) > level);
      } else {
        const ids = new Set([target.id]);
        for (let size = -1; size !== ids.size;) {
          size = ids.size;
          source.forEach(block => { if (block.parentId && ids.has(block.parentId)) ids.add(block.id); });
        }
        blocks = source.filter(block => ids.has(block.id));
      }
    }
    return { id: `reading-link-${document.id}-${link.targetBlockId ?? "document"}`, hostBlockId: "", targetDocumentId: document.id,
      targetBlockId: link.targetBlockId, targetScope: link.targetScope, targetTitle: document.title, mode: "link", blocks,
      overrides: [], hiddenBlockIds: [], broken: !!link.targetBlockId && blocks.length === 0 };
  }
  function renderAnnotationContent(block: Block) {
    const root = document.createElement("div"); root.className = "reading-annotation-preview";
    const source = markdownFromContent(block.content);
    root.innerHTML = source ? renderMarkdown(source) : "";
    const links = block.content.links ?? [];
    root.querySelectorAll<HTMLElement>(".wiki-link").forEach(anchor => {
      const title = anchor.dataset.targetTitle ?? anchor.dataset.title ?? anchor.textContent?.trim() ?? "";
      const blockId = anchor.dataset.targetBlockId;
      const link = links.find(candidate => (candidate.targetBlockId ?? "") === (blockId ?? "") && (candidate.targetText === title || candidate.alias === anchor.textContent?.trim()))
        ?? links.find(candidate => candidate.targetText === title || candidate.alias === anchor.textContent?.trim());
      const reference = link ? linkReference(link) : null;
      if (!reference) {
        anchor.classList.add("reading-annotation-link");
        return;
      }
      const wrapper = document.createElement("div"); wrapper.className = "reading-annotation-reference";
      const label = document.createElement("span"); label.className = "reading-annotation-reference-label"; label.textContent = anchor.textContent?.trim() || reference.targetTitle;
      wrapper.append(label);
      if (callbacks.renderProjection) wrapper.append(callbacks.renderProjection(reference, current!));
      else if (reference.blocks.length) wrapper.append(document.createTextNode(reference.blocks.map(item => item.content.text).filter(Boolean).join("\n")));
      else wrapper.append(Object.assign(document.createElement("span"), { textContent: reference.broken ? "引用目标不存在" : "暂无内容" }));
      anchor.replaceWith(wrapper);
    });
    if (!root.textContent?.trim() && !root.children.length) root.textContent = "（空注释）";
    return root;
  }
  function stateFor(bookId: string) {
    let state = readerStates.get(bookId);
    if (!state) { state = { page: 1, zoom: 1, placingNote: false, highlightColor: "#ffdb66" }; readerStates.set(bookId, state); }
    return state;
  }
  function scheduleSave() {
    if (!current) return;
    saveSession.schedule({ documentId: current.note.id, title: current.note.title, blocks: structuredClone(current.blocks) }, 300);
    callbacks.onStateChanged?.(structuredClone(current));
  }
  function appendBook(asset: MediaAsset) {
    if (!current) return;
    const name = asset.name.replace(/\.(pdf|md|markdown|mdown|txt|doc|docx|ppt|pptx)$/i, "") || "未命名读物";
    const format = readingFormat(asset);
    const block = createBlock({ id: id("book"), type: "reading_book", position: position(current.blocks.length), content: { text: name, markdown: name, media: { ...asset, kind: format === "pdf" ? "pdf" : "file" } }, properties: { readingFormat: format } });
    current.blocks.push(block); scheduleSave(); renderShelf(); renderReaders(); renderInspector();
  }
  function addFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    for (const file of selected) {
      if (readingFormat({ name: file.name, mimeType: file.type || "application/octet-stream" }) === "unsupported") { callbacks.onError(new Error("该文件类型暂不支持读书笔记渲染")); continue; }
      const documentId = current?.note.id;
      const task = (async () => {
        const data = await fileToBase64(file);
        const result = await host.storeMedia({ name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, data });
        if (current?.note.id !== documentId) throw new Error("读书笔记已切换，读物导入未完成");
        appendBook(result.media);
      })();
      imports.add(task);
      void task.then(() => imports.delete(task), error => { imports.delete(task); callbacks.onError(error); });
    }
  }
  function addUrl(raw: string) {
    try {
      const asset = mediaFromUrl(raw);
      appendBook(asset);
    } catch (error) { callbacks.onError(error); }
  }
  function createAnnotation(bookId: string, type: ReadingAnnotationType, anchor: ReadingAnchor, text: string, color?: string) {
    if (!current || !bookFor(bookId) || anchor.bookId !== bookId || !Number.isInteger(anchor.page) || anchor.page < 1 || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) throw new Error("PDF 标注位置无效");
    const block = createBlock({ id: id("reading-block"), type, parentId: bookId, position: position(current.blocks.length), content: callbacks.contentFromMarkdown(text, { text: "", html: "" }), properties: { readingAnchor: structuredClone(anchor), ...(color ? { readingColor: color } : {}) } });
    current.blocks.push(block); scheduleSave(); selectInspector(readingInspectorTab(type)); refreshAnnotations(bookId);
    return block;
  }
  function removeAnnotation(bookId: string, annotationId: string) {
    if (!current) return;
    current.blocks = current.blocks.filter(block => block.id !== annotationId || block.parentId !== bookId);
    scheduleSave(); refreshAnnotations(bookId);
  }
  function removeBook(bookId: string) {
    if (!current || !bookFor(bookId) || !confirm("移除这本 PDF 及其全部书签、高亮和阅读笔记？")) return;
    current.blocks = current.blocks.filter(block => block.id !== bookId && block.parentId !== bookId);
    composers.delete(bookId); openBooks.delete(bookId); collapsedBooks.delete(bookId); readerStates.delete(bookId); scheduleSave(); renderShelf(); renderReaders();
  }
  function renderShelf() {
    const all = books(); bookCount.textContent = `${all.length} 本`;
    bookList.replaceChildren();
    if (!all.length) { const empty = document.createElement("p"); empty.className = "reading-empty"; empty.textContent = "书架为空"; bookList.append(empty); return; }
    all.forEach(book => {
      const card = document.createElement("article"); card.className = "reading-book"; card.dataset.bookId = book.id; card.classList.toggle("is-open", openBooks.has(book.id));
      const cover = document.createElement("button"); cover.type = "button"; cover.className = "reading-book-cover"; cover.title = openBooks.has(book.id) ? "关闭阅读窗口" : "打开阅读窗口"; cover.setAttribute("aria-label", `${openBooks.has(book.id) ? "关闭" : "打开"}：${book.content.text}`);
      const canvas = document.createElement("canvas"); const fallback = document.createElement("span"); fallback.textContent = readingCoverLabel(book.content.media!); cover.append(canvas, fallback);
      if (readingFormat(book.content.media!) === "pdf") void renderReadingCover(book.content.media!, canvas).then(() => { if (canvas.isConnected) fallback.remove(); }).catch(() => { canvas.remove(); });
      else { canvas.remove(); cover.classList.add("reading-generic-cover"); }
      cover.onclick = () => { activeBookId = book.id; if (openBooks.has(book.id)) openBooks.delete(book.id); else openBooks.add(book.id); renderShelf(); renderReaders(); };
      const name = document.createElement("strong"); name.textContent = book.content.text || book.content.media?.name || "未命名 PDF";
      const count = document.createElement("small"); count.textContent = `${annotations(book.id).length} 条标注`;
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "reading-book-remove"; remove.title = "移除读物"; remove.setAttribute("aria-label", `移除：${book.content.text}`); remove.textContent = "×"; remove.onclick = () => removeBook(book.id);
      card.append(cover, name, count, remove); bookList.append(card);
    });
  }
  function renderReaders() {
    panes.clear(); readers.replaceChildren();
    const selected = books().filter(book => openBooks.has(book.id));
    const visible = selected.filter(book => !collapsedBooks.has(book.id));
    if (!visible.some(book => book.id === activeBookId)) activeBookId = visible[0]?.id ?? null;
    if (lastOpenCount < 2 && visible.length >= 2) setShelfCollapsed(true);
    lastOpenCount = visible.length;
    readers.classList.toggle("is-compare", visible.length >= 2);
    readers.classList.toggle("is-empty", !selected.length);
    if (!selected.length) { const empty = document.createElement("div"); empty.className = "reading-empty-state"; empty.textContent = books().length ? "从书架打开读物" : "添加读物开始阅读"; readers.append(empty); renderInspector(); return; }
    selected.forEach(book => readers.append(collapsedBooks.has(book.id) ? renderCollapsedPane(book) : renderPane(book)));
    renderInspector();
  }
  function renderCollapsedPane(book: Block) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "reading-pane-collapsed"; button.dataset.bookId = book.id;
    button.title = `展开：${book.content.text}`; button.setAttribute("aria-label", `展开：${book.content.text}`);
    button.textContent = readingCoverLabel(book.content.media!);
    button.onclick = () => { collapsedBooks.delete(book.id); activeBookId = book.id; renderReaders(); };
    return button;
  }
  function renderPane(book: Block) {
    const state = stateFor(book.id);
    const root = document.createElement("section"); root.className = "reading-pane"; root.dataset.bookId = book.id; root.classList.toggle("is-active", activeBookId === book.id);
    root.addEventListener("pointerdown", () => activateBook(book.id));
    root.addEventListener("focusin", () => activateBook(book.id));
    const header = document.createElement("header"); header.className = "reading-pane-head";
    const name = document.createElement("strong"); name.textContent = book.content.text;
    const collapse = document.createElement("button"); collapse.type = "button"; collapse.textContent = "□"; collapse.title = "折叠阅读窗口"; collapse.setAttribute("aria-label", `折叠：${book.content.text}`); collapse.onclick = () => { collapsedBooks.add(book.id); renderReaders(); };
    const close = document.createElement("button"); close.type = "button"; close.textContent = "×"; close.title = "关闭阅读窗口"; close.setAttribute("aria-label", `关闭：${book.content.text}`); close.onclick = () => { openBooks.delete(book.id); collapsedBooks.delete(book.id); renderShelf(); renderReaders(); };
    const headerActions = document.createElement("span"); headerActions.className = "reading-pane-head-actions"; headerActions.append(collapse, close);
    header.append(name, headerActions);
    const toolbar = document.createElement("div"); toolbar.className = "reading-pane-tools";
    const control = (text: string, label: string, action: () => void) => { const button = document.createElement("button"); button.type = "button"; button.textContent = text; button.title = label; button.setAttribute("aria-label", label); button.onclick = action; toolbar.append(button); return button; };
    const format = readingFormat(book.content.media!);
    if (format === "pdf") control("‹", "上一页", () => { state.page = Math.max(1, state.page - 1); void drawPage(book.id); });
    const pageInput = document.createElement("input"); pageInput.type = "number"; pageInput.min = "1"; pageInput.value = String(state.page); pageInput.setAttribute("aria-label", `页码：${book.content.text}`);
    pageInput.onchange = () => { state.page = Math.max(1, Number(pageInput.value) || 1); void drawPage(book.id); }; toolbar.append(pageInput);
    const pageCount = document.createElement("span"); pageCount.className = "reading-page-count"; pageCount.textContent = format === "pdf" ? "/ …" : ""; toolbar.append(pageCount);
    if (format === "pdf") {
      control("›", "下一页", () => { state.page += 1; void drawPage(book.id); });
      control("−", "缩小页面", () => { state.zoom = Math.max(.6, +(state.zoom - .2).toFixed(2)); void drawPage(book.id); });
      control("+", "放大页面", () => { state.zoom = Math.min(2.5, +(state.zoom + .2).toFixed(2)); void drawPage(book.id); });
      control("⚑", "添加书签", () => { createAnnotation(book.id, "reading_bookmark", { bookId: book.id, page: state.page, x: 0, y: 0 }, `第 ${state.page} 页`); renderInspector(); });
    }
    const annotationButton = control("☷", "标注面板", () => { activateBook(book.id); selectInspector("note"); });
    const color = document.createElement("input"); color.type = "color"; color.value = state.highlightColor; color.title = "高亮颜色"; color.setAttribute("aria-label", "高亮颜色"); color.oninput = () => { state.highlightColor = color.value; }; if (format === "pdf") toolbar.append(color);
    const highlight = control("▰", "高亮所选文字", () => {
      const pane = panes.get(book.id);
      const anchor = pane?.sheet && pane.textLayer ? selectedReadingAnchor(pane.textLayer, pane.sheet, book.id, state.page) : null;
      if (!anchor) { callbacks.onError(new Error("请先选择 PDF 中的文字")); return; }
      createAnnotation(book.id, "reading_highlight", anchor, anchor.quote ?? "", state.highlightColor);
      document.getSelection()?.removeAllRanges();
    });
    highlight.onmousedown = event => event.preventDefault(); if (format !== "pdf") highlight.hidden = true;
    const noteButton = control("✎", "在读物中添加笔记", () => {
      const pane = panes.get(book.id);
      const anchor = pane?.sheet && pane.textLayer ? selectedReadingAnchor(pane.textLayer, pane.sheet, book.id, state.page) : null;
      if (anchor) { state.placingNote = false; noteButton.setAttribute("aria-pressed", "false"); showComposer(book.id, anchor); document.getSelection()?.removeAllRanges(); }
      else {
        state.placingNote = !state.placingNote;
        noteButton.setAttribute("aria-pressed", String(state.placingNote));

      }
    });
    noteButton.onmousedown = event => event.preventDefault(); noteButton.setAttribute("aria-pressed", String(state.placingNote)); if (format !== "pdf") noteButton.hidden = true;
    const body = document.createElement("div"); body.className = "reading-pane-body";
    const pageScroll = document.createElement("div"); pageScroll.className = "reading-page-scroll";
    const pageHost = document.createElement("div"); pageHost.className = "reading-page-host"; pageScroll.append(pageHost);
    body.append(pageScroll); root.append(header, toolbar, body);
    const resize = document.createElement("button"); resize.type = "button"; resize.className = "reading-pane-resize"; resize.title = "调整阅读窗口宽度"; resize.setAttribute("aria-label", `调整宽度：${book.content.text}`);
    let startX = 0; let startWidth = 0;
    resize.onpointerdown = event => { startX = event.clientX; startWidth = root.getBoundingClientRect().width; resize.setPointerCapture(event.pointerId); root.classList.add("is-resizing"); };
    resize.onpointermove = event => { if (!resize.hasPointerCapture(event.pointerId)) return; root.style.flexBasis = `${Math.max(300, Math.min(900, startWidth + event.clientX - startX))}px`; };
    resize.onpointerup = event => { if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId); root.classList.remove("is-resizing"); };
    root.append(resize);
    panes.set(book.id, { root, pageHost, pageInput, pageCount, noteButton, annotationButton, generation: 0 });
    void drawPage(book.id);
    return root;
  }
  async function drawPage(bookId: string) {
    const pane = panes.get(bookId); const book = bookFor(bookId); if (!pane || !book?.content.media) return;
    const state = stateFor(bookId); const generation = ++pane.generation;
    hideAnnotationTooltip();
    const slot = document.createElement("div"); slot.className = "reading-page-slot"; slot.textContent = "正在打开读物…"; pane.pageHost.replaceChildren(slot);
    pane.sheet = undefined; pane.marks = undefined; pane.textLayer = undefined;
    try {
      const format = readingFormat(book.content.media);
      if (format !== "pdf") {
        const rendered = await renderReadingDocument(book.content.media, slot);
        outlines.set(book.id, rendered.outline ?? []);
        if (generation !== pane.generation || !pane.root.isConnected) return;
        pane.sheet = rendered.sheet;
        pane.textLayer = rendered.textLayer;
        pane.pageInput.hidden = true; pane.pageCount.textContent = format.toUpperCase();
        renderInspector();
        return;
      }
      const pdf = await loadReadingPdf(book.content.media);
      if (generation !== pane.generation || !pane.root.isConnected) return;
      state.page = Math.max(1, Math.min(pdf.numPages, state.page));
      pane.pageInput.value = String(state.page); pane.pageInput.max = String(pdf.numPages); pane.pageCount.textContent = `/ ${pdf.numPages}`;
      const width = Math.max(250, pane.pageHost.clientWidth - 28);
      const rendered = await renderReadingPage(pdf, state.page, width, state.zoom, slot);
      if (generation !== pane.generation || !pane.root.isConnected) return;
      pane.sheet = rendered.sheet; pane.marks = rendered.marks; pane.textLayer = rendered.textLayer;
      try {
        const outline = await pdf.getOutline();
        outlines.set(book.id, (outline ?? []).map(item => ({ level: 1, text: item.title ?? "" })).filter(item => item.text));
        renderInspector();
      } catch { outlines.set(book.id, []); }
      rendered.sheet.onclick = event => {
        if (!state.placingNote || (event.target as Element).closest("button")) return;
        const point = pointOnReadingPage(rendered.sheet, event.clientX, event.clientY);
        state.placingNote = false; pane.noteButton.setAttribute("aria-pressed", "false");
        showComposer(bookId, { bookId, page: state.page, ...point });
      };
      renderMarks(bookId);
    } catch (error) {
      if (generation !== pane.generation) return;
      const message = document.createElement("p"); message.className = "reading-load-error"; message.textContent = error instanceof Error ? error.message : "读物无法读取";
      const link = document.createElement("a"); link.href = book.content.media.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "在浏览器打开原文件";
      slot.replaceChildren(message, link);
    }
  }
  function hideAnnotationTooltip() {
    annotationTooltip?.remove(); annotationTooltip = null;
  }
  function scheduleHideAnnotationTooltip() {
    clearTimeout(annotationTooltipTimer);
    annotationTooltipTimer = setTimeout(() => {
      if (!annotationTooltip?.matches(":hover")) hideAnnotationTooltip();
    }, 260);
  }
  function showAnnotationTooltip(anchor: HTMLButtonElement, block: Block) {
    clearTimeout(annotationTooltipTimer);
    hideAnnotationTooltip();
    const tooltip = document.createElement("aside"); tooltip.className = "reading-note-tooltip"; tooltip.setAttribute("role", "tooltip");
    const heading = document.createElement("strong"); heading.textContent = `第 ${block.properties.readingAnchor?.page ?? 1} 页的注释`;
    tooltip.append(heading, renderAnnotationContent(block));
    tooltip.addEventListener("pointerenter", () => clearTimeout(annotationTooltipTimer));
    tooltip.addEventListener("pointerleave", scheduleHideAnnotationTooltip);
    document.body.append(tooltip); annotationTooltip = tooltip;
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - tooltip.offsetWidth - 8, rect.left));
    const top = rect.bottom + tooltip.offsetHeight + 8 <= window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - tooltip.offsetHeight - 8);
    tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
  }
  function renderMarks(bookId: string) {
    const pane = panes.get(bookId); if (!pane?.marks) return;
    const state = stateFor(bookId); pane.marks.replaceChildren();
    annotations(bookId).filter(block => block.properties.readingAnchor?.page === state.page).forEach(block => {
      const anchor = block.properties.readingAnchor!;
      if (hasReadingMark(block.type, anchor)) {
        (anchor.rects ?? []).forEach(rect => { const mark = document.createElement("span"); mark.className = "reading-highlight-mark"; mark.style.left = `${clamp(rect.x) * 100}%`; mark.style.top = `${clamp(rect.y) * 100}%`; mark.style.width = `${clamp(rect.width) * 100}%`; mark.style.height = `${clamp(rect.height) * 100}%`; mark.style.background = block.properties.readingColor ?? "#ffdb66"; pane.marks!.append(mark); });
      }
      if (readingBlockRole(block) === "note") {
        const pin = document.createElement("button"); pin.type = "button"; pin.className = "reading-note-pin"; pin.textContent = "✎"; pin.title = block.content.text; pin.setAttribute("aria-label", `阅读笔记：${block.content.text}`);
        pin.style.left = `${clamp(anchor.x) * 100}%`; pin.style.top = `${clamp(anchor.y) * 100}%`;
        pin.addEventListener("pointerenter", () => showAnnotationTooltip(pin, block));
        pin.addEventListener("pointerleave", scheduleHideAnnotationTooltip);
        pin.onclick = event => { event.stopPropagation(); focusBlock(block.id); };
        pane.marks!.append(pin);
      }
    });
  }
  function activateBook(bookId: string) {
    if (activeBookId === bookId) return;
    activeBookId = bookId; linkSuggestions.close();
    panes.forEach((pane, id) => pane.root.classList.toggle("is-active", id === bookId));
    renderInspector();
  }
  function setInspectorCollapsed(collapsed: boolean) {
    inspector.classList.toggle("is-collapsed", collapsed);
    const button = view.querySelector<HTMLButtonElement>(".reading-inspector-toggle")!;
    button.textContent = collapsed ? "‹" : "›";
    button.title = collapsed ? "展开读书笔记右栏" : "折叠读书笔记右栏";
    button.setAttribute("aria-label", button.title);
  }
  function selectInspector(tab: string) {
    setInspectorCollapsed(false);
    view.querySelectorAll<HTMLButtonElement>("[data-reading-inspector-tab]").forEach(button => button.setAttribute("aria-selected", String(button.dataset.readingInspectorTab === tab)));
    renderInspector();
  }
  function refreshAnnotationPreview(block: Block) {
    if (readingBlockRole(block) !== "note") return;
    const row = inspectorList.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(block.id)}"]`);
    const preview = row?.querySelector<HTMLElement>(".reading-annotation-preview");
    if (preview) preview.replaceWith(renderAnnotationContent(block));
  }
  function bindAnnotationInput(input: HTMLTextAreaElement, block: Block) {
    input.value = markdownFromContent(block.content);
    input.addEventListener("focus", () => { lastInput = input; stateFor(block.parentId!).selectedId = block.id; });
    linkSuggestions.bind(input, () => {
      block.content = callbacks.contentFromMarkdown(input.value, block.content);
      block.revision += 1; scheduleSave(); renderMarks(block.parentId!); refreshAnnotationPreview(block);
    });
  }
  function refreshAnnotations(bookId: string) {
    const count = bookList.querySelector<HTMLElement>(`[data-book-id="${CSS.escape(bookId)}"] small`);
    if (count) count.textContent = `${annotations(bookId).length} 条标注`;
    renderMarks(bookId);
    renderInspector();
  }
  function renderInspector() {
    const active = view.querySelector<HTMLButtonElement>(".reading-inspector-tabs [aria-selected='true']")?.dataset.readingInspectorTab ?? "outline";
    inspectorList.replaceChildren();
    inspector.querySelector("header strong")!.textContent = bookFor(activeBookId ?? "")?.content.text ?? "读书笔记";
    const composer = activeBookId ? composers.get(activeBookId) : undefined;
    if (active === "note" && composer) inspectorList.append(composer);
    const items = activeBookId ? annotations(activeBookId) : [];
    if (active === "outline") {
      const allBooks = books().filter(book => book.id === activeBookId);
      if (!allBooks.length) { const empty = document.createElement("p"); empty.className = "reading-empty"; empty.textContent = "暂无目录"; inspectorList.append(empty); return; }
      allBooks.forEach(book => {
        const row = document.createElement("button"); row.type = "button"; row.className = "reading-inspector-row";
        row.textContent = `${readingCoverLabel(book.content.media!)} · ${book.content.text}`;
        row.onclick = () => focusBlock(book.id); inspectorList.append(row);
        (outlines.get(book.id) ?? []).forEach(item => {
          const heading = document.createElement("button"); heading.type = "button"; heading.className = "reading-inspector-row reading-inspector-outline"; heading.style.paddingLeft = `${7 + Math.min(5, item.level - 1) * 10}px`; heading.textContent = item.text; heading.onclick = () => { openBooks.add(book.id); renderShelf(); renderReaders(); };
          inspectorList.append(heading);
        });
      });
      return;
    }
    const matches = items.filter(block => readingInspectorMatches(block, active as "bookmark" | "highlight" | "note")).sort((a, b) => {
      const ap = a.properties.readingAnchor?.page ?? 0; const bp = b.properties.readingAnchor?.page ?? 0;
      return ap - bp || a.position.localeCompare(b.position);
    });
    if (!matches.length) { const empty = document.createElement("p"); empty.className = "reading-empty"; empty.textContent = active === "highlight" ? "暂无高亮" : active === "note" ? "暂无注释" : "暂无书签"; inspectorList.append(empty); return; }
    matches.forEach(block => {
      const anchor = block.properties.readingAnchor;
      const book = anchor ? bookFor(anchor.bookId) : undefined;
      const row = document.createElement("article"); row.className = "reading-inspector-row reading-inspector-annotation"; row.dataset.annotationId = block.id;
      const jump = document.createElement("button"); jump.type = "button"; jump.className = "reading-inspector-jump"; jump.textContent = `${book?.content.text ?? "读物"} · ${anchor?.page ?? 1} 页`; jump.onclick = () => focusBlock(block.id);
      const field = readingInspectorField(block, current ?? undefined);
      const text = document.createElement(field.element); text.className = "reading-inspector-text"; text.textContent = field.text;
      if (field.editable && text instanceof HTMLTextAreaElement) {
        text.setAttribute("aria-label", field.ariaLabel);
        bindAnnotationInput(text, block);
      }
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
      remove.setAttribute("aria-label", "删除标注：" + block.content.text);
      remove.onclick = () => removeAnnotation(block.parentId!, block.id);
      if (field.showPreview) row.append(jump, renderAnnotationContent(block));
      row.append(text, remove); inspectorList.append(row);
    });
  }
  function showComposer(bookId: string, anchor: ReadingAnchor) {
    activateBook(bookId);
    const existing = composers.get(bookId);
    if (existing) { selectInspector("note"); existing.querySelector("textarea")?.focus(); return; }
    const form = document.createElement("div"); form.className = "reading-note-composer";
    const positionLabel = document.createElement("small"); positionLabel.textContent = bookFor(bookId)?.content.text + " · " + anchor.page + " 页"; form.append(positionLabel);
    if (anchor.quote) { const quote = document.createElement("blockquote"); quote.textContent = anchor.quote; form.append(quote); }
    const input = document.createElement("textarea"); input.placeholder = "阅读笔记，输入 [[ 引用"; input.setAttribute("aria-label", "新阅读笔记");
    input.onfocus = () => { lastInput = input; };
    linkSuggestions.bind(input, () => {});
    const actions = document.createElement("div");
    const save = document.createElement("button"); save.type = "button"; save.textContent = "保存笔记"; save.onclick = () => {
      const value = input.value.trim(); if (!value) { input.focus(); return; }
      composers.delete(bookId); linkSuggestions.close(); createAnnotation(bookId, "reading_note", anchor, value);
    };
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "取消"; cancel.onclick = () => { composers.delete(bookId); linkSuggestions.close(); renderInspector(); };
    actions.append(save, cancel); form.append(input, actions); composers.set(bookId, form);
    selectInspector("note"); input.focus();
  }
  function insertCalendarLink(documentId: string, blockId?: string, scope?: ReferenceTargetScope, label = "日记") {
    if (!current || !activeBookId) return false;
    const target = current.documents.find(doc => doc.id === documentId);
    if (!target) return false;
    const source = "[[" + (target.notebookName ? target.notebookName + "/" : "") + target.title
      + (blockId ? scope === "heading" ? "#" + label : "#^" + blockId : "") + "|📅 " + label + "]]";
    if (!lastInput?.isConnected || !inspectorList.contains(lastInput)) {
      showComposer(activeBookId, { bookId: activeBookId, page: stateFor(activeBookId).page, x: 0, y: 0 });
    }
    if (!lastInput) return false;
    lastInput.setRangeText(source, lastInput.selectionStart, lastInput.selectionEnd, "end");
    lastInput.dispatchEvent(new Event("input")); lastInput.focus(); return true;
  }
  function insertLocationBlock(locationId: string) {
    const location = current?.locations?.find(item => item.id === locationId && !item.deletedAt);
    if (!current || !activeBookId || !location) return false;
    const bookId = activeBookId;
    current.blocks.push(createBlock({ id: id("reading-location"), type: "location", parentId: bookId,
      position: position(current.blocks.length), content: { text: location.name },
      properties: { locationId, readingAnchor: { bookId, page: stateFor(bookId).page, x: 0, y: 0 } } }));
    scheduleSave(); selectInspector("note"); return true;
  }
  function render() { if (!current) return; title.value = current.note.title; renderShelf(); renderReaders(); }
  view.querySelector<HTMLButtonElement>('[data-reading-action="upload"]')!.onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files) void addFiles(fileInput.files); fileInput.value = ""; };
  view.querySelector<HTMLButtonElement>('[data-reading-action="url"]')!.onclick = () => {
    const existing = view.querySelector(".reading-url-form"); if (existing) { existing.remove(); return; }
    const form = document.createElement("div"); form.className = "reading-url-form";
    const input = document.createElement("input"); input.type = "url"; input.placeholder = "https://…/book.pdf"; input.setAttribute("aria-label", "PDF 地址");
    const add = document.createElement("button"); add.type = "button"; add.textContent = "添加"; add.onclick = () => { if (!input.value.trim()) return; addUrl(input.value); form.remove(); };
    input.onkeydown = event => { if (event.key === "Enter") add.click(); if (event.key === "Escape") form.remove(); };
    form.append(input, add); view.querySelector(".reading-bar")!.append(form); input.focus();
  };
  title.onchange = () => { if (!current) return; current.note.title = title.value.trim() || "未命名读书笔记"; scheduleSave(); };
  saveLabel.onclick = () => { if (saveLabel.classList.contains("is-error")) scheduleSave(); };
  function setShelfCollapsed(collapsed: boolean) {
    shelf.classList.toggle("is-collapsed", collapsed);
    const button = view.querySelector<HTMLButtonElement>(".reading-shelf-toggle")!;
    button.textContent = collapsed ? "›" : "‹";
    button.title = collapsed ? "展开书架" : "折叠书架";
    button.setAttribute("aria-label", button.title);
  }
  view.querySelector<HTMLButtonElement>(".reading-shelf-toggle")!.onclick = () => setShelfCollapsed(!shelf.classList.contains("is-collapsed"));
  view.querySelector<HTMLButtonElement>(".reading-inspector-toggle")!.onclick = () => setInspectorCollapsed(!inspector.classList.contains("is-collapsed"));
  view.querySelectorAll<HTMLButtonElement>(".reading-inspector-tabs [data-reading-inspector-tab]").forEach(tab => tab.onclick = () => {
    view.querySelectorAll<HTMLButtonElement>(".reading-inspector-tabs [data-reading-inspector-tab]").forEach(item => item.setAttribute("aria-selected", String(item === tab)));
    renderInspector();
  });
  function open(state: EditorState) {
    hideAnnotationTooltip(); activeBookId = null; composers.clear(); lastInput = null; linkSuggestions.close();
    current = structuredClone(state); versions.set(state.note.id, state.note.clientVersion);
    openBooks.clear(); collapsedBooks.clear(); readerStates.clear(); panes.clear(); outlines.clear(); lastOpenCount = 0; setShelfCollapsed(false);
    editor.hidden = true; view.hidden = false; document.body.dataset.workspaceMode = "reading"; render();
  }
  function close() {
    if (view.hidden) return;
    hideAnnotationTooltip(); linkSuggestions.close(); composers.clear(); activeBookId = null; lastInput = null;
    view.hidden = true; current = null; openBooks.clear(); collapsedBooks.clear(); readerStates.clear(); panes.clear(); outlines.clear(); lastOpenCount = 0; readers.replaceChildren(); bookList.replaceChildren();
    editor.hidden = false; document.body.dataset.workspaceMode = "document";
  }
  function focusBlock(blockId: string) {
    const block = current?.blocks.find(item => item.id === blockId);
    if (!block) return;
    const bookId = readingBlockRole(block) === "book" ? block.id : block.parentId;
    if (!bookId || !bookFor(bookId)) return;
    openBooks.add(bookId); activeBookId = bookId;
    if (readingBlockRole(block) === "bookmark" || readingBlockRole(block) === "highlight" || readingBlockRole(block) === "note")
      selectInspector(readingInspectorTab(block.type as ReadingAnnotationType));
    const reader = stateFor(bookId);
    if (block.properties.readingAnchor) reader.page = block.properties.readingAnchor.page;
    reader.selectedId = blockId;
    collapsedBooks.delete(bookId); renderShelf(); renderReaders();
    requestAnimationFrame(() => {
      panes.get(bookId)?.root.scrollIntoView({ block: "nearest", inline: "nearest" });
      inspectorList.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }
  async function restoreHistory(entryId: string) {
    await Promise.all(imports);
    await saveSession.flush();
    if (!current) return;
    const documentId = current.note.id;
    const result = await host.executeCommand({ operation: "history-restore", entryId, expectedVersion: current.note.clientVersion }, documentId);
    if (current?.note.id !== documentId) return;
    current = structuredClone(result.state);
    versions.set(documentId, current.note.clientVersion);
    openBooks.forEach(bookId => { if (!bookFor(bookId)) openBooks.delete(bookId); });
    render();
    callbacks.onHistoryChanged?.(structuredClone(current));
  }
  return { open, close, isOpen: () => !view.hidden, activeId: () => current?.note.id ?? null,
    focusBlock, insertCalendarLink, insertLocationBlock,
    applyState: state => { if (current?.note.id !== state.note.id) return; current = structuredClone(state); versions.set(state.note.id, state.note.clientVersion); render(); },
    refreshContext: state => {
      if (current?.note.id !== state.note.id) return;
      // Refresh shared catalogs and projections without replacing a local annotation draft.
      current.documents = structuredClone(state.documents);
      current.references = structuredClone(state.references);
      current.backlinks = structuredClone(state.backlinks);
      current.overrideNotices = structuredClone(state.overrideNotices);
      current.locations = structuredClone(state.locations);
      current.locationVersion = state.locationVersion;
      callbacks.onStateChanged?.(structuredClone(current));
    },
    restoreHistory,
    flush: async () => { await Promise.all(imports); await saveSession.flush(); } };
}
