import type { Notebook, Bookmark, WorkspaceSnapshot, SearchHit } from "./workspace-api";
import type { HostTransport } from "./editor-host-api";
import { MockSaveStore } from "./mock-save-store";
import type { HostRequest, HostResponse, HostEvent, EditorState, RequestMap, BlockContent, BlockProperties, Backlink, OverrideNotice, BlockType, Block } from "../../protocol/types";

const block = (blockId: string, text: string) => ({ id: blockId, parentId: null, position: "00001000", type: "paragraph" as const, content: { text, html: text }, properties: {}, revision: 1 });

export class BrowserMockHost implements HostTransport {
  private listeners = new Set<(message: HostResponse | HostEvent) => void>();
  docs = new Map<string, EditorState>();
  private history = ["alpha"];
  private index = 0;
  current = "alpha";
  failNextSave = false;
  lastRequest: HostRequest | null = null;
  private saves!: MockSaveStore;
  private moves = new Map<string, Map<string, { parentId: string | null; position: string }>>();

  // ── Notebook / bookmark / document hierarchy ────────────────────────
  notebooks: Notebook[] = [
    { id: "nb-default",   name: "默认笔记本" },
    { id: "nb-research",  name: "研究" },
    { id: "nb-life",      name: "生活" }
  ];

  bookmarks: Bookmark[] = [
    { id: "bk-inbox",    notebookId: "nb-default",  name: "收集",     color: "#3B82F6" },
    { id: "bk-daily",    notebookId: "nb-default",  name: "日记",     color: "#16A34A" },
    { id: "bk-projects", notebookId: "nb-default",  name: "项目",     color: "#7C3AED" },
    { id: "bk-sources",  notebookId: "nb-research", name: "参考资料", color: "#EA580C" },
    { id: "bk-notes",    notebookId: "nb-research", name: "笔记",     color: "#0891B2" },
    { id: "bk-life",     notebookId: "nb-life",     name: "日常",     color: "#DB2777" }
  ];

  documentByBookmark = new Map<string, string[]>([
    ["bk-inbox",    ["alpha", "beta"]],
    ["bk-daily",    ["gamma", "delta"]],
    ["bk-projects", ["epsilon"]],
    ["bk-sources",  ["zeta"]],
    ["bk-notes",    ["eta"]],
    ["bk-life",     ["theta"]]
  ]);

  /** 哪些笔记本当前处于打开状态（tab 栏中可见） */
  openNotebookIds: string[] = ["nb-default"];

  private activeNotebookId = "nb-default";
  private activeBookmarkId = "bk-inbox";
  titleByDocument = new Map<string, string>([
    ["alpha", "Alpha"], ["beta", "Beta"], ["gamma", "Gamma"], ["delta", "Delta"],
    ["epsilon", "Epsilon"], ["zeta", "Zeta"], ["eta", "Eta"], ["theta", "Theta"]
  ]);
  constructor() {
    const all: Array<{ id: string; title: string; blocks: Array<{ id: string; text: string }> }> = [
      { id: "alpha",   title: "Alpha",   blocks: [{ id: "a1", text: "浏览器编辑器核心" }] },
      { id: "beta",    title: "Beta",    blocks: [{ id: "b1", text: "Beta 的内容" }, { id: "b2", text: "Beta 文档中的其他块" }] },
      { id: "gamma",   title: "Gamma",   blocks: [{ id: "g1", text: "Gamma 日记" }, { id: "g2", text: "今日复盘" }] },
      { id: "delta",   title: "Delta",   blocks: [{ id: "d1", text: "Delta 灵感收集" }] },
      { id: "epsilon", title: "Epsilon", blocks: [{ id: "e1", text: "Epsilon 项目计划" }] },
      { id: "zeta",    title: "Zeta",    blocks: [{ id: "z1", text: "Zeta 参考资料" }] },
      { id: "eta",     title: "Eta",     blocks: [{ id: "h1", text: "Eta 研究笔记" }] },
      { id: "theta",   title: "Theta",   blocks: [{ id: "t1", text: "Theta 日常" }] }
    ];
    for (const d of all) {
      const state: EditorState = {
        note: { id: d.id, title: d.title, isSticky: false, clientVersion: 0 },
        blocks: d.blocks.map(b => block(b.id, b.text)),
        documents: this.allDocuments().map(x => ({ id: x.id, title: x.title })),
        backlinks: [],
        overrideNotices: [],
        references: []
      };
      if (d.id === "alpha") state.blocks.push({ ...block("ar1", ""), type: "reference" });
      this.docs.set(d.id, state);
    }
    const alpha = this.docs.get("alpha")!;
    alpha.references = [{
      id: "ref1", hostBlockId: "ar1", targetDocumentId: "beta", targetBlockId: "b1", targetTitle: "Beta",
      mode: "inline", blocks: [block("b1", "Beta 的内容")], overrides: [], hiddenBlockIds: []
    }];
    this.saves = new MockSaveStore(this.docs);
  }
  private allDocuments() {
    return [...this.titleByDocument.entries()].map(([id, title]) => ({ id, title }));
  }
  shellSnapshot(): WorkspaceSnapshot {
    return {
      notebooks: this.notebooks,
      bookmarks: this.bookmarks,
      openNotebookIds: this.openNotebookIds,
      activeNotebookId: this.activeNotebookId,
      activeBookmarkId: this.activeBookmarkId,
      documentIds: this.documentByBookmark.get(this.activeBookmarkId) ?? []
    };
  }

  setActiveNotebook(id: string) {
    if (this.notebooks.some(n => n.id === id)) {
      this.activeNotebookId = id;
      // 自动选该笔记本下第一个书签
      const first = this.bookmarks.find(b => b.notebookId === id);
      if (first) this.activeBookmarkId = first.id;
    }
  }

  openNotebook(id: string) {
    if (!this.openNotebookIds.includes(id)) this.openNotebookIds.push(id);
    this.setActiveNotebook(id);
  }

  closeNotebook(id: string) {
    this.openNotebookIds = this.openNotebookIds.filter(nb => nb !== id);
    if (this.activeNotebookId === id) {
      this.activeNotebookId = this.openNotebookIds[0] ?? "";
      if (this.activeNotebookId) this.setActiveNotebook(this.activeNotebookId);
    }
  }

  setActiveWorkspace(id: string) { if (this.notebooks.some(w => w.id === id)) this.activeNotebookId = id; }
  setActiveBookmark(id: string) { if (this.bookmarks.some(b => b.id === id)) this.activeBookmarkId = id; }
  getDocumentTitle(id: string) { return this.titleByDocument.get(id) ?? id; }
  /** Search across ALL documents' titles and block content. Returns up to `limit` hits
   * grouped by document. Each hit includes the matched block id and an excerpt around
   * the match so the shell can show context. */
  searchDocuments(query: string, limit = 50): SearchHit[] {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return [];
    const hits: SearchHit[] = [];
    for (const [docId, docState] of this.docs.entries()) {
      const title = (docState.note.title || "").toLocaleLowerCase();
      if (title.includes(q)) {
        hits.push({ kind: "title", documentId: docId, documentTitle: docState.note.title, blockId: null, excerpt: docState.note.title });
      }
      for (const block of docState.blocks) {
        const text = (block.content?.text ?? "").toLocaleLowerCase();
        const idx = text.indexOf(q);
        if (idx < 0) continue;
        const raw = block.content?.text ?? "";
        const start = Math.max(0, idx - 30);
        const end = Math.min(raw.length, idx + q.length + 50);
        const excerpt = (start > 0 ? "…" : "") + raw.slice(start, end) + (end < raw.length ? "…" : "");
        hits.push({ kind: "block", documentId: docId, documentTitle: docState.note.title, blockId: block.id, excerpt });
      }
      if (hits.length >= limit) break;
    }
    return hits;
  }
  /** Notebook mutations */
  renameNotebook(id: string, name: string) {
    const nb = this.notebooks.find(n => n.id === id);
    if (nb) nb.name = name;
  }
  removeNotebook(id: string) {
    if (this.notebooks.length <= 1) return; // keep at least one
    // Move bookmarks under it to first remaining notebook
    const fallback = this.notebooks.find(n => n.id !== id)!.id;
    this.bookmarks.filter(b => b.notebookId === id).forEach(b => { b.notebookId = fallback; });
    this.bookmarks = this.bookmarks.filter(b => b.notebookId === id ? false : true);
    // Actually reassign instead — fix above:
    this.bookmarks.forEach(b => { if (b.notebookId === id) b.notebookId = fallback; });
    this.openNotebookIds = this.openNotebookIds.filter(nb => nb !== id);
    this.notebooks = this.notebooks.filter(n => n.id !== id);
    if (this.activeNotebookId === id) this.setActiveNotebook(this.openNotebookIds[0] ?? this.notebooks[0].id);
  }
  /** Bookmark mutations */
  renameBookmark(id: string, name: string) {
    const bk = this.bookmarks.find(b => b.id === id);
    if (bk) bk.name = name;
  }
  recolorBookmark(id: string, color: string) {
    const bk = this.bookmarks.find(b => b.id === id);
    if (bk) bk.color = color;
  }
  removeBookmark(id: string) {
    const bk = this.bookmarks.find(b => b.id === id);
    if (!bk) return;
    // Move documents under it to first bookmark in same notebook
    const fallback = this.bookmarks.find(b => b.notebookId === bk.notebookId && b.id !== id);
    if (fallback) {
      const docs = this.documentByBookmark.get(id) ?? [];
      const target = this.documentByBookmark.get(fallback.id) ?? [];
      this.documentByBookmark.set(fallback.id, [...target, ...docs]);
    }
    this.documentByBookmark.delete(id);
    this.bookmarks = this.bookmarks.filter(b => b.id !== id);
    if (this.activeBookmarkId === id) {
      const next = this.bookmarks.find(b => b.notebookId === this.activeNotebookId);
      if (next) this.activeBookmarkId = next.id;
    }
  }
  /** Document mutations */
  renameDocument(id: string, title: string) {
    this.setDocumentTitle(id, title);
  }
  removeDocument(id: string) {
    this.titleByDocument.delete(id);
    this.docs.delete(id);
    this.history = this.history.filter(documentId => documentId !== id);
    this.index = Math.min(this.index, this.history.length - 1);
    for (const list of this.documentByBookmark.values()) {
      const idx = list.indexOf(id);
      if (idx >= 0) list.splice(idx, 1);
    }
    // Remove references to/from this document
    for (const doc of this.docs.values()) {
      doc.references = doc.references.filter(r => r.targetDocumentId !== id);
      doc.documents = doc.documents.filter(d => d.id !== id);
    }
    if (this.current === id) {
      const next = [...this.documentByBookmark.values()].flat()[0];
      this.current = next ?? "";
      if (this.current && !this.history.includes(this.current)) this.history.push(this.current);
      this.index = Math.max(0, this.history.indexOf(this.current));
    }
  }
  recolorDocument(_id: string, _color: string) { /* documents don't carry color in this mock */ }
  setDocumentTitle(id: string, title: string) {
    if (this.titleByDocument.has(id)) {
      this.titleByDocument.set(id, title);
      const state = this.docs.get(id);
      if (state) state.note.title = title;
      for (const d of this.docs.values()) {
        const doc = d.documents.find(x => x.id === id);
        if (doc) doc.title = title;
      }
    }
  }
  notebooksPush(nb: { id: string; name: string }) {
    this.notebooks.push(nb);
  }

  bookmarksPush(bk: { id: string; notebookId: string; name: string; color: string }) {
    this.bookmarks.push(bk);
    if (!this.documentByBookmark.has(bk.id)) this.documentByBookmark.set(bk.id, []);
  }
  /** Convenience for the in-browser shell to mint a new document and surface it under the active bookmark. */
  createDocument(title: string) {
    const id = "doc-" + Math.random().toString(36).slice(2, 8);
    this.titleByDocument.set(id, title);
    const docsList = this.allDocuments();
    this.docs.set(id, {
      note: { id, title, isSticky: false, clientVersion: 0 },
      blocks: [],
      documents: docsList,
      backlinks: [],
      overrideNotices: [],
      references: []
    });
    const list = this.documentByBookmark.get(this.activeBookmarkId) ?? [];
    list.push(id);
    this.documentByBookmark.set(this.activeBookmarkId, list);
    return id;
  }
  subscribe(listener: (message: HostResponse | HostEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private respond<K extends keyof RequestMap>(request: HostRequest<K>, payload: unknown, ok = true, error?: string) {
    const response: HostResponse = { protocolVersion: 1, requestId: request.requestId, kind: request.kind, ok, payload: payload as never, error: error ? { code: "mock_error", message: error } : undefined };
    for (const listener of this.listeners) listener(response);
  }
  private state(documentId = this.current) {
    this.refreshReferenceSnapshots();
    const result = structuredClone(this.docs.get(documentId)!);
    result.backlinks = this.computeBacklinks(documentId);
    result.overrideNotices = this.computeOverrideNotices(documentId);
    return result;
  }
  private computeBacklinks(targetDocumentId: string): Backlink[] {
    const out: Backlink[] = [];
    for (const doc of this.docs.values()) {
      if (doc.note.id === targetDocumentId) continue;
      // Each reference instance whose targetDocumentId matches → backlink
      for (const ref of doc.references) {
        if (ref.targetDocumentId !== targetDocumentId) continue;
        // Excerpt: use the first visible block content
        const sourceDocTitle = doc.note.title;
        let excerpt = ref.targetTitle;
        let sourceBlockId: string | undefined;
        const first = ref.blocks.find(b => b.scopeType !== "reference_instance");
        if (first) {
          excerpt = first.content.text || ref.targetTitle;
          sourceBlockId = first.id;
        }
        out.push({
          sourceDocumentId: doc.note.id,
          sourceTitle: sourceDocTitle,
          sourceBlockId: sourceBlockId ?? "",
          excerpt: excerpt.slice(0, 80)
        });
      }
      // Also wiki-style [[Title]] links between docs
      for (const block of doc.blocks) {
        const html = block.content.html || "";
        const targetDoc = this.docs.get(targetDocumentId);
        if (!targetDoc) continue;
        const pattern = new RegExp(`\\[\\[${this.escapeRegex(targetDoc.note.title)}(?:#[^\\]|]+)?(?:\\|[^\\]]+)?\\]\\]`, "g");
        if (pattern.test(html)) {
          out.push({
            sourceDocumentId: doc.note.id,
            sourceTitle: doc.note.title,
            sourceBlockId: block.id,
            excerpt: (block.content.text || "").slice(0, 80)
          });
        }
      }
    }
    return out;
  }
  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  private computeOverrideNotices(targetDocumentId: string): OverrideNotice[] {
    const out: OverrideNotice[] = [];
    for (const doc of this.docs.values()) {
      if (doc.note.id === targetDocumentId) continue;
      for (const ref of doc.references) {
        if (ref.targetDocumentId !== targetDocumentId) continue;
        // overrides
        for (const ov of ref.overrides) {
          const source = this.docs.get(ref.targetDocumentId)?.blocks.find(b => b.id === ov.targetBlockId);
          out.push({
            referenceInstanceId: ref.id,
            targetBlockId: ov.targetBlockId,
            sourceUpdated: !!source && source.revision > ov.baseRevision,
            hostTitle: doc.note.title,
            hostDocumentId: doc.note.id,
            excerpt: (ref.blocks.find(b => b.id === ov.targetBlockId)?.content.text ?? "").slice(0, 60),
            kind: "content_style"
          });
        }
        // hidden blocks
        for (const hidden of ref.hiddenBlockIds) {
          out.push({
            referenceInstanceId: ref.id,
            targetBlockId: hidden,
            sourceUpdated: false,
            hostTitle: doc.note.title,
            hostDocumentId: doc.note.id,
            excerpt: (ref.blocks.find(b => b.id === hidden)?.content.text ?? "").slice(0, 60),
            kind: "hide"
          });
        }
        // instance blocks added at this host
        const localBlocks = ref.blocks.filter(b => b.scopeType === "reference_instance");
        for (const lb of localBlocks) {
          out.push({
            referenceInstanceId: ref.id,
            targetBlockId: lb.id,
            sourceUpdated: false,
            hostTitle: doc.note.title,
            hostDocumentId: doc.note.id,
            excerpt: (lb.content.text ?? "").slice(0, 60),
            kind: "insert"
          });
        }
        // moved (instance blocks whose parentId differs from target source parentId)
        for (const moved of ref.blocks.filter(b => b.scopeType !== "reference_instance")) {
          const source = this.docs.get(ref.targetDocumentId)?.blocks.find(b => b.id === moved.id);
          if (!source) continue;
          if (source.parentId !== moved.parentId || source.position !== moved.position) {
            out.push({
              referenceInstanceId: ref.id,
              targetBlockId: moved.id,
              sourceUpdated: source.revision !== moved.revision,
              hostTitle: doc.note.title,
              hostDocumentId: doc.note.id,
              excerpt: (moved.content.text ?? "").slice(0, 60),
              kind: "move"
            });
          }
        }
      }
    }
    return out;
  }
  private refreshReferenceSnapshots() {
    for (const document of this.docs.values()) {
      for (const reference of document.references) {
        const source = this.docs.get(reference.targetDocumentId);
        reference.broken = !source || !!reference.targetBlockId && !source.blocks.some(block => block.id === reference.targetBlockId);
        if (!source) { reference.blocks = []; continue; }
        reference.targetTitle = source.note.title;
        const sourceBlocks = reference.targetBlockId
          ? this.subtree(source.blocks, reference.targetBlockId)
          : source.blocks;
        reference.blocks = [...structuredClone(sourceBlocks), ...reference.blocks.filter(block => block.scopeType === "reference_instance")];
        for (const block of reference.blocks) {
          const move = this.moves.get(reference.id)?.get(block.id);
          if (move) Object.assign(block, move);
        }
        reference.blocks.sort((a, b) => a.position.localeCompare(b.position));
      }
    }
  }
  private subtree(blocks: EditorState["blocks"], rootId: string) {
    const included = new Set<string>([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of blocks) {
        if (candidate.parentId && included.has(candidate.parentId) && !included.has(candidate.id)) {
          included.add(candidate.id);
          changed = true;
        }
      }
    }
    return blocks.filter((candidate) => included.has(candidate.id));
  }
  updateSourceBlock(documentId: string, blockId: string, text: string) {
    const source = this.docs.get(documentId);
    const target = source?.blocks.find((candidate) => candidate.id === blockId);
    if (!target) throw new Error("源块不存在");
    target.content = { ...target.content, text, html: text };
    target.revision += 1;
    this.refreshReferenceSnapshots();
    const event: HostEvent = { protocolVersion: 1, kind: "documentChanged", payload: { documentId } };
    for (const listener of this.listeners) listener(event);
  }
  send(message: HostRequest | HostEvent) {
    if (!("requestId" in message)) return;
    const request = message as HostRequest;
    this.lastRequest = request;
    queueMicrotask(() => {
      try {
        if (request.protocolVersion !== 1) throw new Error("不支持的协议版本");
        switch (request.kind) {
          case "ready": this.respond(request, null); break;
          case "loadDocument":
          case "reloadDocument": this.respond(request, { state: this.state(request.sourceDocumentId ?? this.current) }); break;
          case "saveDocument": {
            if (this.failNextSave) { this.failNextSave = false; this.respond(request, undefined, false, "Mock 保存失败"); break; }
            const payload = request.payload as Extract<RequestMap["saveDocument"], { documentId: string }>;
            if (request.sourceDocumentId !== payload.documentId) throw new Error("保存文档与请求归属不一致");
            const version = this.saves.save(payload);
            this.setDocumentTitle(payload.documentId, this.docs.get(payload.documentId)!.note.title);
            this.respond(request, { documentId: payload.documentId, mutationId: payload.mutationId, clientVersion: version });
            break;
          }
          case "openDocument": {
            const payload = request.payload as RequestMap["openDocument"];
            if (!this.docs.has(payload.documentId)) throw new Error("目标文档已不存在");
            this.current = payload.documentId; this.history.splice(this.index + 1); this.history.push(this.current); this.index = this.history.length - 1; this.respond(request, null); this.emitLoaded();
            if (payload.blockId) {
              const event: HostEvent = { protocolVersion: 1, kind: "focusBlock", payload: { blockId: payload.blockId } };
              for (const listener of this.listeners) listener(event);
            }
            break;
          }
          case "navigateBack": if (this.index > 0) this.index--; this.current = this.history[this.index]; this.respond(request, null); this.emitLoaded(); break;
          case "navigateForward": if (this.index + 1 < this.history.length) this.index++; this.current = this.history[this.index]; this.respond(request, null); this.emitLoaded(); break;
          case "executeCommand": {
            const payload = request.payload as { operation?: string; referenceInstanceId?: string; mode?: string; hostBlockId?: string; targetDocumentId?: string; targetBlockId?: string; content?: BlockContent; properties?: BlockProperties };
            const current = this.docs.get(request.sourceDocumentId ?? this.current)!;
            const supported = new Set(["create-reference", "set-reference-mode", "save-override", "reset-override", "reset-reference", "save-instance-block", "move-reference-block", "delete-instance-block", "hide-reference-block", "remove-reference", "restore-snapshot"]);
            if (!current || !supported.has(payload.operation ?? "")) throw new Error("未知操作或文档不存在");
            if (payload.operation === "restore-snapshot") {
              const snapshot = (payload as { state?: EditorState }).state;
              if (!snapshot || snapshot.note?.id !== current.note.id) throw new Error("历史版本归属不一致");
              current.note.title = snapshot.note.title;
              current.blocks = structuredClone(snapshot.blocks);
              current.references = structuredClone(snapshot.references);
              this.respond(request, { state: this.state(current.note.id) });
              break;
            }
            if (payload.operation !== "create-reference" && !current.references.some(r => r.id === payload.referenceInstanceId))
              throw new Error("引用不属于当前文档");
            if (payload.operation === "set-reference-mode" && !["inline", "collapsed", "link", "sidebar"].includes(payload.mode ?? ""))
              throw new Error("无效引用模式");
            if (payload.operation === "create-reference" && (!payload.hostBlockId || !payload.targetDocumentId ||
                !current.blocks.some(b => b.id === payload.hostBlockId) || !this.docs.has(payload.targetDocumentId)))
              throw new Error("引用宿主或目标不存在");
            if (payload.operation === "create-reference" && payload.hostBlockId && payload.targetDocumentId) {
              const target = this.docs.get(payload.targetDocumentId);
              const documentInfo = current.documents.find((item) => item.id === payload.targetDocumentId);
              if (target) current.references.push({
                id: `ref-${payload.hostBlockId}`,
                hostBlockId: payload.hostBlockId,
                targetDocumentId: payload.targetDocumentId,
                targetBlockId: payload.targetBlockId,
                targetTitle: documentInfo?.title ?? "目标文档",
                mode: "inline",
                blocks: structuredClone(payload.targetBlockId ? this.subtree(target.blocks, payload.targetBlockId) : target.blocks),
                overrides: [],
                hiddenBlockIds: []
              });
            }
            if (payload.operation === "set-reference-mode" && payload.referenceInstanceId && (payload.mode === "inline" || payload.mode === "collapsed" || payload.mode === "sidebar" || payload.mode === "link")) {
              const reference = current.references.find((item) => item.id === payload.referenceInstanceId);
              if (reference) reference.mode = payload.mode;
            }
            const reference = current.references.find(item => item.id === payload.referenceInstanceId);
            if (reference && payload.operation === "save-override" && payload.targetBlockId && payload.content && payload.properties) {
              const source = this.docs.get(reference.targetDocumentId)?.blocks.find(block => block.id === payload.targetBlockId);
              if (!source) throw new Error("源块不存在");
              const previous = reference.overrides.find(item => item.targetBlockId === payload.targetBlockId);
              reference.overrides = reference.overrides.filter(item => item.targetBlockId !== payload.targetBlockId);
              reference.overrides.push({ targetBlockId: payload.targetBlockId, baseRevision: previous?.baseRevision ?? source.revision, patch: structuredClone({ content: payload.content, properties: payload.properties }) });
            }
            if (reference && payload.operation === "reset-override") {
              this.moves.get(reference.id)?.delete(payload.targetBlockId!);
              reference.overrides = reference.overrides.filter(item => item.targetBlockId !== payload.targetBlockId);
              reference.hiddenBlockIds = reference.hiddenBlockIds.filter(id => id !== payload.targetBlockId);
            }
            if (reference && payload.operation === "reset-reference") {
              this.moves.delete(reference.id);
              reference.overrides = []; reference.hiddenBlockIds = [];
              reference.blocks = reference.blocks.filter(block => block.scopeType !== "reference_instance");
            }
            if (reference && payload.operation === "save-instance-block" && (payload as { block?: { id: string; parentId: string | null; position: string; type: string; content: BlockContent; properties?: BlockProperties; scopeType?: string } }).block) {
              const block = (payload as { block: { id: string; parentId: string | null; position: string; type: BlockType; content: BlockContent; properties: BlockProperties; scopeType?: string } }).block;
              const existing = reference.blocks.findIndex(b => b.id === block.id);
              const stored: Block = {
                id: block.id,
                parentId: block.parentId,
                position: block.position,
                type: block.type,
                content: block.content,
                properties: block.properties ?? {},
                scopeType: "reference_instance",
                revision: existing >= 0 ? (reference.blocks[existing].revision + 1) : 1
              };
              if (existing >= 0) reference.blocks[existing] = stored;
              else reference.blocks.push(stored);
            }
            if (reference && payload.operation === "move-reference-block" && payload.targetBlockId) {
              const movePayload = payload as { targetBlockId: string; parentBlockId: string | null; position: string };
              const b = reference.blocks.find(x => x.id === movePayload.targetBlockId);
              if (!b) throw new Error("引用块不存在");
              {
                const moves = this.moves.get(reference.id) ?? new Map();
                moves.set(b.id, { parentId: movePayload.parentBlockId, position: movePayload.position });
                this.moves.set(reference.id, moves);
                b.parentId = movePayload.parentBlockId;
                b.position = movePayload.position;
              }
            }
            if (reference && payload.operation === "delete-instance-block") {
              const blockId = (payload as { blockId?: string }).blockId;
              if (blockId) reference.blocks = reference.blocks.filter(b => b.id !== blockId);
            }
            if (reference && payload.operation === "hide-reference-block" && payload.targetBlockId) {
              if (!reference.hiddenBlockIds.includes(payload.targetBlockId)) reference.hiddenBlockIds.push(payload.targetBlockId);
            }
            if (reference && payload.operation === "remove-reference") {
              const hostBlockId = reference.hostBlockId;
              current.references = current.references.filter(r => r.id !== reference.id);
              current.blocks = current.blocks.filter(b => b.id !== hostBlockId);
            }
            this.respond(request, { state: this.state(current.note.id) });
            break;
          }
          case "showNotification": this.respond(request, null); break;
          default: throw new Error("未知宿主能力：" + request.kind);
        }
      } catch (error) { this.respond(request, undefined, false, error instanceof Error ? error.message : String(error)); }
    });
  }
  private emitLoaded() {
    const event: HostEvent = { protocolVersion: 1, kind: "documentLoaded", payload: { state: this.state() } };
    for (const listener of this.listeners) listener(event);
  }
}
