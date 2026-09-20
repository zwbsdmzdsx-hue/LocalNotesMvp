import { EditorHistory } from "./history";
import { orderBlockTree } from "./block-tree";
import type { Notebook, Bookmark, WorkspaceDocument, WorkspaceSnapshot, SearchHit } from "./workspace-api";
import type { HostTransport } from "./editor-host-api";
import { MockSaveStore } from "./mock-save-store";
import type { HostRequest, HostResponse, HostEvent, EditorState, RequestMap, BlockContent, BlockProperties, Backlink, OverrideNotice, BlockType, Block, StyleSheet, StyleScope, MediaKind, DatabaseSource, DatabaseField, DatabaseRecord } from "../../protocol/types";
import { parseDql, executeDql } from "./database-query";

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
  private globalSystemStyles: StyleSheet[] = [];
  private documentHistories = new Map<string, EditorHistory>();
  private databases = new Map<string, { source: DatabaseSource; records: DatabaseRecord[] }>();
  private databaseMutations = new Set<string>();
  private historySnapshot(id: string) {
    const state = structuredClone(this.docs.get(id)!);
    const moves = state.references.map(ref => [ref.id, [...(this.moves.get(ref.id) ?? new Map())]] as [string, Array<[string, { parentId: string | null; position: string }]>]);
    return { state, moves };
  }
  private documentHistory(id: string) {
    let history = this.documentHistories.get(id);
    if (!history) { history = new EditorHistory(); history.record(this.historySnapshot(id), "开始编辑"); this.documentHistories.set(id, history); }
    return history;
  }
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
  private parentByDocument = new Map<string, string | null>();
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
      this.parentByDocument.set(d.id, null);
       const state: EditorState = {
        note: { id: d.id, title: d.title, isSticky: false, clientVersion: 0, workspaceId: d.id === "zeta" || d.id === "eta" ? "nb-research" : d.id === "theta" ? "nb-life" : "nb-default" },
        blocks: d.blocks.map(b => block(b.id, b.text)),
        documents: [],
        backlinks: [],
        overrideNotices: [],
        references: [], databases: [], databaseRecords: {}, systemStyles: [], documentStyles: [], notebookStyles: []
      };
      if (d.id === "alpha") state.blocks.push({ ...block("ar1", ""), type: "reference" });
      this.docs.set(d.id, state);
    }
    this.docs.get("zeta")!.blocks.push({
      ...block("z2", "目标标题 可搜索正文"),
      content: {
        text: "# 目标标题 .secret { color: red; } **可搜索正文**",
        html: "<h1>目标标题</h1><style>.secret { color: red; }</style><strong>可搜索正文</strong>",
        markdown: "# 目标标题\n\n<style>.secret { color: red; }</style>\n\n**可搜索正文**"
      }
    });
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
  private documentLocation(id: string) {
    for (const [bookmarkId, ids] of this.documentByBookmark) {
      if (!ids.includes(id)) continue;
      const bookmark = this.bookmarks.find(item => item.id === bookmarkId);
      const notebook = bookmark ? this.notebooks.find(item => item.id === bookmark.notebookId) : undefined;
      return { bookmark, notebook };
    }
    return {};
  }
  private linkCatalog() {
    return this.allDocuments().map(({ id, title }) => {
      const { bookmark, notebook } = this.documentLocation(id);
      return {
        id, title,
        path: [notebook?.name, bookmark?.name].filter(Boolean).join(" / "),
        notebookId: notebook?.id,
        notebookName: notebook?.name,
        blocks: structuredClone(this.docs.get(id)?.blocks ?? [])
      };
    });
  }
  shellSnapshot(): WorkspaceSnapshot {
    const documents: WorkspaceDocument[] = [];
    for (const [bookmarkId, ids] of this.documentByBookmark) {
      ids.forEach((id, position) => documents.push({ id, title: this.getDocumentTitle(id), bookmarkId, parentId: this.parentByDocument.get(id) ?? null, position }));
    }
    return {
      notebooks: this.notebooks,
      bookmarks: this.bookmarks,
      openNotebookIds: this.openNotebookIds,
      activeNotebookId: this.activeNotebookId,
      activeBookmarkId: this.activeBookmarkId,
      documentIds: this.documentByBookmark.get(this.activeBookmarkId) ?? [],
      documents
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
    const oldParent = this.parentByDocument.get(id) ?? null;
    this.titleByDocument.delete(id); this.docs.delete(id); this.parentByDocument.delete(id);
    this.history = this.history.filter(documentId => documentId !== id);
    for (const [child, parent] of this.parentByDocument) if (parent === id) this.parentByDocument.set(child, oldParent);
    for (const list of this.documentByBookmark.values()) { const idx = list.indexOf(id); if (idx >= 0) list.splice(idx, 1); }
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
  createDocument(title: string, requestedId?: string, bookmarkId = this.activeBookmarkId, parentId: string | null = null) {
    const id = requestedId ?? ("doc-" + Math.random().toString(36).slice(2, 8));
    this.titleByDocument.set(id, title);
    const bookmark = this.bookmarks.find(item => item.id === bookmarkId);
    this.docs.set(id, {
      note: { id, title, isSticky: false, clientVersion: 0, workspaceId: bookmark?.notebookId },
      blocks: [],
      documents: [],
      backlinks: [],
      overrideNotices: [],
       references: [],
       databases: [], databaseRecords: {},
       systemStyles: structuredClone(this.globalSystemStyles),
      documentStyles: [],
      notebookStyles: []
    });
    this.parentByDocument.set(id, parentId);
    const list = this.documentByBookmark.get(bookmarkId) ?? [];
    list.push(id);
    this.documentByBookmark.set(bookmarkId, list);
    return id;
  }
  moveDocument(id: string, bookmarkId: string, parentId: string | null, index: number) {
    if (!this.titleByDocument.has(id) || !this.documentByBookmark.has(bookmarkId)) return;
    const descendants = new Set<string>(); const pending = [id];
    while (pending.length) { const current = pending.pop()!; for (const [child, parent] of this.parentByDocument) if (parent === current) { descendants.add(child); pending.push(child); } }
    if (parentId === id || (parentId && descendants.has(parentId))) return;
    let depth = 1; let cursor = parentId;
    while (cursor) { depth++; cursor = this.parentByDocument.get(cursor) ?? null; }
    const subtreeDepth = (node: string): number => { const children = [...this.parentByDocument].filter(([, p]) => p === node).map(([child]) => child); return children.length ? 1 + Math.max(...children.map(subtreeDepth)) : 1; };
    if (depth + subtreeDepth(id) - 1 > 3) return;
    const subtree = new Set([id, ...descendants]);
    const extracted: string[] = [];
    // Preserve the existing preorder of the moved subtree while removing every
    // descendant from its old bookmark as well.
    for (const [owner, list] of this.documentByBookmark.entries()) {
      const kept: string[] = [];
      for (const item of list) (subtree.has(item) ? extracted : kept).push(item);
      this.documentByBookmark.set(owner, kept);
    }
    this.parentByDocument.set(id, parentId);
    const target = this.documentByBookmark.get(bookmarkId)!;
    const siblings = this.documentByBookmark.get(bookmarkId)!
      .filter(candidate => (this.parentByDocument.get(candidate) ?? null) === parentId);
    const siblingIndex = Math.max(0, Math.min(index, siblings.length));
    let insertAt = target.length;
    if (siblingIndex < siblings.length) {
      insertAt = target.indexOf(siblings[siblingIndex]);
    } else if (siblings.length) {
      const last = siblings[siblings.length - 1];
      const lastIndex = target.indexOf(last);
      insertAt = lastIndex < 0 ? target.length : lastIndex + 1;
      while (insertAt < target.length && (this.parentByDocument.get(target[insertAt]) ?? null) !== parentId) insertAt++;
    }
    target.splice(Math.max(0, insertAt), 0, ...extracted);
    const notebookId = this.bookmarks.find(item => item.id === bookmarkId)?.notebookId;
    if (notebookId) {
      subtree.forEach(documentId => {
        const document = this.docs.get(documentId);
        if (document) document.note.workspaceId = notebookId;
      });
    }
  }
  moveBookmark(id: string, index: number) {
    const at = this.bookmarks.findIndex(bookmark => bookmark.id === id); if (at < 0) return;
    const bookmark = this.bookmarks[at];
    const sameNotebook = this.bookmarks.filter(item => item.notebookId === bookmark.notebookId);
    const target = sameNotebook[Math.max(0, Math.min(index, sameNotebook.length - 1))];
    this.bookmarks.splice(at, 1);
    const targetIndex = target ? this.bookmarks.findIndex(item => item.id === target.id) : this.bookmarks.length;
    this.bookmarks.splice(Math.max(0, targetIndex), 0, bookmark);
  }
  subscribe(listener: (message: HostResponse | HostEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private respond<K extends keyof RequestMap>(request: HostRequest<K>, payload: unknown, ok = true, error?: string) {
    const response: HostResponse = { protocolVersion: 1, requestId: request.requestId, kind: request.kind, ok, payload: payload as never, error: error ? { code: "mock_error", message: error } : undefined };
    for (const listener of this.listeners) listener(response);
  }
  private state(documentId = this.current) {
    this.refreshReferenceSnapshots();
    const result = structuredClone(this.docs.get(documentId)!);
    result.documents = this.linkCatalog();
    result.blocks = orderBlockTree(result.blocks);
    result.references.forEach(reference => reference.blocks = orderBlockTree(reference.blocks));
    result.history = this.documentHistory(documentId).model(documentId);
    result.backlinks = this.computeBacklinks(documentId);
    result.overrideNotices = this.computeOverrideNotices(documentId);
    const workspaceId = result.note.workspaceId;
    const visible = [...this.databases.values()].filter(item => !item.source.notebookId || item.source.notebookId === workspaceId);
    result.databases = visible.map(item => structuredClone(item.source));
    result.databaseRecords = Object.fromEntries(visible.map(item => [item.source.id, structuredClone(item.records)]));
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
          ? reference.targetScope === "heading"
            ? this.headingSection(source.blocks, reference.targetBlockId)
            : this.subtree(source.blocks, reference.targetBlockId)
          : source.blocks;
        reference.blocks = [...structuredClone(sourceBlocks), ...reference.blocks.filter(block => block.scopeType === "reference_instance")];
        for (const block of reference.blocks) {
          const move = this.moves.get(reference.id)?.get(block.id);
          if (move) Object.assign(block, move);
        }
        reference.blocks = orderBlockTree(reference.blocks);
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
  private headingInfo(block: Block) {
    const source = block.content.markdown ?? block.content.text ?? "";
    const line = source.split(/\r?\n/).find(value => value.trim()) ?? "";
    const match = line.match(/^\s*(#{1,6})[ \u3000]+(.+?)\s*$/);
    return match ? { level: match[1].length, title: match[2].trim() } : null;
  }
  private headingSection(blocks: EditorState["blocks"], headingId: string) {
    const ordered = orderBlockTree(blocks);
    const start = ordered.findIndex(block => block.id === headingId);
    if (start < 0) return [];
    const root = this.headingInfo(ordered[start]);
    if (!root) return [ordered[start]];
    const result: Block[] = [];
    for (let index = start; index < ordered.length; index++) {
      const info = this.headingInfo(ordered[index]);
      if (index > start && info && info.level <= root.level) break;
      result.push(ordered[index]);
    }
    return result;
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
            const history = this.documentHistory(payload.documentId);
            const version = this.saves.save(payload);
            history.record(this.historySnapshot(payload.documentId), "编辑正文", payload.historyGroup);
            this.setDocumentTitle(payload.documentId, this.docs.get(payload.documentId)!.note.title);
            this.respond(request, { documentId: payload.documentId, mutationId: payload.mutationId, clientVersion: version, history: history.model(payload.documentId) });
            break;
          }
          case "storeMedia": {
            const payload = request.payload as RequestMap["storeMedia"];
            const kind: MediaKind = payload.mimeType.startsWith("image/") ? "image" : payload.mimeType.startsWith("video/") ? "video" : payload.mimeType.startsWith("audio/") ? "audio" : payload.mimeType === "application/pdf" ? "pdf" : "file";
            const media = {
              id: `media-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
              kind,
              name: payload.name || "media",
              mimeType: payload.mimeType,
              size: payload.size,
              url: `data:${payload.mimeType};base64,${payload.data}`
            };
            this.respond(request, { media });
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
            const payload = request.payload as { operation?: string; referenceInstanceId?: string; mode?: string; hostBlockId?: string; targetDocumentId?: string; targetBlockId?: string; targetScope?: "block" | "heading"; content?: BlockContent; properties?: BlockProperties; style?: StyleSheet; styleId?: string; scope?: StyleScope; databaseId?: string; database?: DatabaseSource; fields?: DatabaseField[]; record?: DatabaseRecord; query?: string };
            const current = this.docs.get(request.sourceDocumentId ?? this.current)!;
            if (!current) throw new Error("文档不存在");
            const databaseWrites = new Set(["create-database", "save-database-schema", "upsert-database-record", "delete-database-record"]);
            const mutationId = typeof (payload as Record<string, unknown>).mutationId === "string" ? String((payload as Record<string, unknown>).mutationId) : "";
            const requestedVersion = Number((payload as Record<string, unknown>).clientVersion);
            const mutationKey = `${current.note.id}:${mutationId}`;
            if (databaseWrites.has(payload.operation ?? "")) {
              if (!mutationId || !Number.isInteger(requestedVersion)) throw new Error("数据库写入缺少 mutationId 或 clientVersion");
              if (this.databaseMutations.has(mutationKey)) { this.respond(request, { state: this.state(current.note.id) }); break; }
              if (requestedVersion <= current.note.clientVersion) throw new Error("数据库写入版本已过期，请重新载入");
            }
            const finishDatabaseMutation = () => { current.note.clientVersion += 1; this.databaseMutations.add(mutationKey); };
            if (payload.operation === "create-database") {
              const id = payload.database?.id ?? `db-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
              const source: DatabaseSource = { id, notebookId: current.note.workspaceId, title: payload.database?.title ?? "新数据库", fields: structuredClone(payload.fields ?? []), recordCount: 0 };
              source.fields = source.fields.map((field, index) => ({ ...field, id: field.id || `field-${id}-${index}`, databaseId: id, position: field.position || String((index + 1) * 1000).padStart(8, "0") }));
              this.databases.set(id, { source, records: [] });
              (current.databaseViews ??= []).push({ id: `view-${id}`, databaseId: id, name: source.title, type: "table", settings: { fieldKeys: source.fields.map(field => field.key) } });
              finishDatabaseMutation();
              this.respond(request, { state: this.state(current.note.id) });
              break;
            }
            if (payload.operation === "save-database-schema" && payload.databaseId) {
              const item = this.databases.get(payload.databaseId); if (!item) throw new Error("数据库不存在");
              item.source = { ...item.source, title: payload.database?.title ?? item.source.title, fields: structuredClone(payload.fields ?? item.source.fields) };
              item.source.fields = item.source.fields.map((field, index) => ({ ...field, databaseId: item.source.id, position: field.position || String((index + 1) * 1000).padStart(8, "0") }));
              finishDatabaseMutation();
              this.respond(request, { state: this.state(current.note.id) });
              break;
            }
            if (payload.operation === "upsert-database-record" && payload.databaseId && payload.record) {
              const item = this.databases.get(payload.databaseId); if (!item) throw new Error("数据库不存在");
              const next = structuredClone(payload.record); const index = item.records.findIndex(record => record.id === next.id);
              if (index >= 0) item.records[index] = next; else item.records.push(next);
              item.source.recordCount = item.records.length;
              finishDatabaseMutation();
              this.respond(request, { state: this.state(current.note.id) });
              break;
            }
            if (payload.operation === "delete-database-record" && payload.databaseId && payload.record?.id) {
              const item = this.databases.get(payload.databaseId); if (!item) throw new Error("数据库不存在");
              item.records = item.records.filter(record => record.id !== payload.record!.id); item.source.recordCount = item.records.length;
              finishDatabaseMutation();
              this.respond(request, { state: this.state(current.note.id) });
              break;
            }
            if (payload.operation === "execute-dql" && payload.databaseId) {
              const item = this.databases.get(payload.databaseId); if (!item) throw new Error("数据库不存在");
              const parsed = parseDql(payload.query ?? "FROM current"); if ("code" in parsed) throw new Error(parsed.message);
              const result = executeDql(parsed, item.source, item.records, { sources: [...this.databases.values()].map(value => value.source), records: Object.fromEntries([...this.databases.entries()].map(([id, value]) => [id, value.records])) });
              this.respond(request, { state: this.state(current.note.id), result });
              break;
            }
            if ((payload.operation === "export-database-markdown" || payload.operation === "export-database-csv") && payload.databaseId) {
              const item = this.databases.get(payload.databaseId); if (!item) throw new Error("数据库不存在");
              const csv = payload.operation === "export-database-csv";
              const computed = executeDql({ from: "current" }, item.source, item.records);
              const escape = (value: unknown) => csv ? `"${String(value ?? "").replace(/"/g, '""')}"` : String(value ?? "").replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
              const content = csv
                ? [computed.columns.map(column => escape(column.title)).join(","), ...computed.rows.filter(row => !row.grouped).map(row => computed.columns.map(column => escape(row.values[column.key])).join(","))].join("\n")
                : [`| ${computed.columns.map(column => escape(column.title)).join(" | ")} |`, `| ${computed.columns.map(() => "---").join(" | ")} |`, ...computed.rows.filter(row => !row.grouped).map(row => `| ${computed.columns.map(column => escape(row.values[column.key])).join(" | ")} |`)].join("\n");
              this.respond(request, { state: this.state(current.note.id), content, mimeType: csv ? "text/csv" : "text/markdown", fileName: `${item.source.title}.${csv ? "csv" : "md"}` });
              break;
            }
            if (payload.operation === "save-style") {
              const style = structuredClone(payload as unknown as StyleSheet); const list = style.scope === "system" ? (current.systemStyles ??= []) : style.scope === "notebook" ? (current.notebookStyles ??= []) : (current.documentStyles ??= []);
              const index = list.findIndex(item => item.id === style.id); if (index >= 0) list[index] = style; else list.push(style);
              this.docs.forEach((doc) => {
                if (style.scope === "system") {
                  this.globalSystemStyles = structuredClone(current.systemStyles ?? []);
                  doc.systemStyles = structuredClone(this.globalSystemStyles);
                }
                else if (style.scope === "notebook" && doc.note.workspaceId === current.note.workspaceId) doc.notebookStyles = structuredClone(current.notebookStyles);
              });
              this.respond(request, { state: this.state(current.note.id) });
              break;
            } else if (payload.operation === "delete-style" && payload.styleId) {
              const scope = payload.scope as StyleScope | undefined;
              if (scope === "system") {
                this.globalSystemStyles = this.globalSystemStyles.filter(item => item.id !== payload.styleId);
                this.docs.forEach(doc => { doc.systemStyles = structuredClone(this.globalSystemStyles); });
              }
              else if (scope === "notebook") this.docs.forEach(doc => { if (doc.note.workspaceId === current.note.workspaceId) doc.notebookStyles = (doc.notebookStyles ?? []).filter(item => item.id !== payload.styleId); });
              else current.documentStyles = (current.documentStyles ?? []).filter(item => item.id !== payload.styleId);
              this.respond(request, { state: this.state(current.note.id) });
              break;
            }
            const history = this.documentHistory(current.note.id);
            if (payload.operation?.startsWith("history-")) {
              const move = payload as { operation: string; expectedVersion: number; entryId?: string };
              if (move.expectedVersion !== current.note.clientVersion) throw new Error("文档已更新，请重新载入后再恢复历史");
              if (this.failNextSave) { this.failNextSave = false; throw new Error("Mock 保存失败"); }
              const snapshot = history.move(move.operation, move.entryId);
              const version = current.note.clientVersion + 1;
              for (const ref of current.references) this.moves.delete(ref.id);
              for (const [id, moves] of snapshot.moves) this.moves.set(id, new Map(moves));
              const previous = new Map(current.blocks.map(b => [b.id, b.revision]));
              current.note.title = snapshot.state.note.title;
              current.note.clientVersion = version;
              current.blocks = snapshot.state.blocks;
              current.blocks.forEach(b => b.revision = Math.max(b.revision, previous.get(b.id) ?? 0) + 1);
              current.references = snapshot.state.references;
              this.setDocumentTitle(current.note.id, current.note.title);
              this.respond(request, { state: this.state(current.note.id) });
              break;
            }
            const supported = new Set(["create-reference", "set-reference-mode", "save-override", "reset-override", "reset-reference", "save-instance-block", "move-reference-block", "delete-instance-block", "hide-reference-block", "remove-reference"]);
            if (!supported.has(payload.operation ?? "")) throw new Error("未知操作");
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
                targetScope: payload.targetScope as "block" | "heading" | undefined,
                targetTitle: documentInfo?.title ?? "目标文档",
                mode: "inline",
                blocks: structuredClone(payload.targetBlockId
                  ? payload.targetScope === "heading"
                    ? this.headingSection(target.blocks, payload.targetBlockId)
                    : this.subtree(target.blocks, payload.targetBlockId)
                  : target.blocks),
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
            history.record(this.historySnapshot(current.note.id), "更新引用", (payload as { historyGroup?: string }).historyGroup);
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
