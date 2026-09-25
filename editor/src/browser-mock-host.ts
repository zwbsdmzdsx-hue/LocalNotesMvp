import { headingSection } from "./link-suggestions";
import { EditorHistory } from "./history";
import { orderBlockTree } from "./block-tree";
import { normalizeCanvasNodes } from "./workspace-api";
import { createBlock, createDocumentState } from "./document-model";
import type { Notebook, Bookmark, WorkspaceDocument, WorkspaceSnapshot, SearchHit, CalendarTodo, CanvasDocument, CanvasNode, CanvasViewport, WorkspaceItemKind } from "./workspace-api";
import type { HostTransport } from "./editor-host-api";
import { MockSaveStore } from "./mock-save-store";
import type { HostRequest, HostResponse, HostEvent, EditorState, RequestMap, BlockContent, BlockProperties, Backlink, OverrideNotice, BlockType, Block, StyleSheet, StyleScope, MediaKind, DatabaseSource, DatabaseField, DatabaseRecord, GeoLocation, HistoryModel } from "../../protocol/types";
import { parseDql, executeDql } from "./database-query";

const block = (blockId: string, text: string) => ({ id: blockId, parentId: null, position: "00001000", type: "paragraph" as const, content: { text, html: text }, properties: {}, revision: 1 });

function demoBlock(id: string, type: BlockType, markdown: string, position: string, properties: BlockProperties = {}, checked = false): Block {
  const text = markdown.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, "").replace(/[*_`]/g, "");
  return {
    id,
    parentId: null,
    position,
    type,
    content: { text, html: "", markdown, checked: type === "todo" ? checked : undefined },
    properties,
    revision: 1
  };
}

const demoImageUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360' viewBox='0 0 640 360'%3E%3Crect width='640' height='360' fill='%23eef4ff'/%3E%3Cpath d='M0 285 150 145 240 220 375 75 640 285V360H0Z' fill='%2398b9ff'/%3E%3Ccircle cx='505' cy='92' r='38' fill='%23f7c873'/%3E%3Ctext x='32' y='48' font-family='sans-serif' font-size='24' fill='%23172b4d'%3ELocalNotes demo%3C/text%3E%3C/svg%3E";

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
  private locations = new Map<string, GeoLocation>();
  private locationVersion = 0;
  private locationMutations = new Set<string>();
  private itemKinds = new Map<string, WorkspaceItemKind>();
  private canvases = new Map<string, Omit<CanvasDocument, "canUndo" | "canRedo" | "references">>();
  private canvasMutations = new Set<string>();
  private canvasHistories = new Map<string, { entries: Array<{ id: string; timestamp: number; label: string; title: string; nodes: CanvasNode[]; viewport: CanvasViewport; references: EditorState["references"] }>; cursor: number }>();
  private canvasTextGroups = new Map<string, { blockId: string; baselineLength: number; lastTimestamp: number }>();
  private canvasHistoryModel(id: string): HistoryModel {
    const history = this.canvasHistories.get(id);
    if (!history) return { documentId: id, entries: [], currentId: "", canUndo: false, canRedo: false };
    return {
      documentId: id,
      entries: history.entries.map((entry, index) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        label: entry.label,
        kind: "canvas",
        title: entry.title,
        preview: `${entry.nodes.length} 个画布元素${index === history.cursor ? " · 当前" : ""}`
      })),
      currentId: history.entries[history.cursor]?.id ?? "",
      canUndo: history.cursor > 0,
      canRedo: history.cursor < history.entries.length - 1
    };
  }
  private historySnapshot(id: string) {
    const state = structuredClone(this.docs.get(id)!);
    const workspaceId = state.note.workspaceId;
    state.locations = [...this.locations.values()].filter(location => location.scope === "global" || location.notebookId === workspaceId);
    state.locationVersion = this.locationVersion;
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
    { id: "nb-life",      name: "生活" },
    { id: "nb-diary",     name: "日记" }
  ];

  bookmarks: Bookmark[] = [
    { id: "bk-inbox",    notebookId: "nb-default",  name: "收集",     color: "#3B82F6" },
    { id: "bk-daily",    notebookId: "nb-default",  name: "日记",     color: "#16A34A" },
    { id: "bk-projects", notebookId: "nb-default",  name: "项目",     color: "#7C3AED" },
    { id: "bk-sources",  notebookId: "nb-research", name: "参考资料", color: "#EA580C" },
    { id: "bk-notes",    notebookId: "nb-research", name: "笔记",     color: "#0891B2" },
    { id: "bk-life",     notebookId: "nb-life",     name: "日常",     color: "#DB2777" },
    { id: "bk-diary",    notebookId: "nb-diary",    name: "日记",     color: "#64748B" }
  ];

  documentByBookmark = new Map<string, string[]>([
    ["bk-inbox",    ["alpha", "beta"]],
    ["bk-daily",    ["gamma", "delta"]],
    ["bk-projects", ["epsilon", "showcase"]],
    ["bk-sources",  ["zeta"]],
    ["bk-notes",    ["eta"]],
    ["bk-life",     ["theta"]],
    ["bk-diary",    []]
  ]);

  /** 哪些笔记本当前处于打开状态（tab 栏中可见） */
  openNotebookIds: string[] = ["nb-default"];

  private activeNotebookId = "nb-default";
  private activeBookmarkId = "bk-inbox";
  private parentByDocument = new Map<string, string | null>();
  titleByDocument = new Map<string, string>([
    ["alpha", "Alpha"], ["beta", "Beta"], ["gamma", "Gamma"], ["delta", "Delta"],
    ["epsilon", "Epsilon"], ["showcase", "演示中心"], ["zeta", "Zeta"], ["eta", "Eta"], ["theta", "Theta"]
  ]);
  constructor() {
    const all: Array<{ id: string; title: string; blocks: Array<{ id: string; text: string }> }> = [
      { id: "alpha",   title: "Alpha",   blocks: [{ id: "a1", text: "工作台总览" }] },
      { id: "beta",    title: "Beta",    blocks: [{ id: "b1", text: "产品研究" }, { id: "b2", text: "用户访谈摘要" }] },
      { id: "gamma",   title: "Gamma",   blocks: [{ id: "g1", text: "2026-09-24 日记" }, { id: "g2", text: "今日复盘" }] },
      { id: "delta",   title: "Delta",   blocks: [{ id: "d1", text: "灵感收集" }] },
      { id: "epsilon", title: "Epsilon", blocks: [{ id: "e1", text: "产品发布计划" }] },
      { id: "showcase", title: "演示中心", blocks: [{ id: "s1", text: "LocalNotes 能力演示" }] },
      { id: "zeta",    title: "Zeta",    blocks: [{ id: "z1", text: "参考资料" }] },
      { id: "eta",     title: "Eta",     blocks: [{ id: "h1", text: "研究笔记" }] },
      { id: "theta",   title: "Theta",   blocks: [{ id: "t1", text: "日常记录" }] }
    ];
    for (const d of all) {
      this.itemKinds.set(d.id, "document");
      this.parentByDocument.set(d.id, null);
       const state: EditorState = {
        note: { id: d.id, title: d.title, isSticky: false, clientVersion: 0, workspaceId: d.id === "zeta" || d.id === "eta" ? "nb-research" : d.id === "theta" ? "nb-life" : "nb-default" },
        blocks: d.blocks.map((b, index) => demoBlock(b.id, "paragraph", b.text, String((index + 1) * 1000).padStart(8, "0"))),
        documents: [],
        backlinks: [],
        overrideNotices: [],
        references: [], locations: [], locationVersion: 0, databases: [], databaseRecords: {}, systemStyles: [], documentStyles: [], notebookStyles: []
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
    const now = new Date().toISOString();
    this.locations.set("loc-global-guangzhou", {
      id: "loc-global-guangzhou", scope: "global", name: "广州越秀区", address: "广东省广州市越秀区",
      latitude: 23.1291, longitude: 113.2644, source: "manual", precision: "district", createdAt: now, updatedAt: now
    });
    this.locations.set("loc-default-office", {
      id: "loc-default-office", scope: "notebook", notebookId: "nb-default", name: "默认办公点", address: "默认笔记本示例位置",
      latitude: 23.1291, longitude: 113.2644, source: "map", precision: "unknown", createdAt: now, updatedAt: now
    });
    this.seedDemoDocuments();
    this.saves = new MockSaveStore(this.docs);
  }

  /** Replace the tiny smoke-test fixtures with a usable showcase workspace.
   * IDs remain stable because links and contract tests use them as anchors. */
  private seedDemoDocuments() {
    const setBlocks = (documentId: string, blocks: Block[]) => {
      const document = this.docs.get(documentId);
      if (!document) return;
      document.blocks = blocks;
    };
    const heading = (id: string, level: 1 | 2 | 3, title: string, position: string, collapsed = false) =>
      demoBlock(id, "heading", `${"#".repeat(level)} ${title}`, position, { headingLevel: level, headingCollapsed: collapsed });
    const paragraph = (id: string, markdown: string, position: string, properties: BlockProperties = {}) =>
      demoBlock(id, "paragraph", markdown, position, properties);
    const todo = (id: string, markdown: string, position: string, createdAt: string, dueAt: string, checked = false, completedAt?: string) =>
      demoBlock(id, "todo", markdown, position, { todoCreatedAt: createdAt, todoDueAt: dueAt, todoCompletedAt: completedAt }, checked);

    const roadmapDatabaseId = "db-demo-roadmap";
    const roadmapFields: DatabaseField[] = [
      { id: "demo-field-name", databaseId: roadmapDatabaseId, key: "name", title: "事项", type: "text", position: "00001000" },
      { id: "demo-field-status", databaseId: roadmapDatabaseId, key: "status", title: "状态", type: "text", position: "00002000" },
      { id: "demo-field-effort", databaseId: roadmapDatabaseId, key: "effort", title: "工时", type: "number", position: "00003000" },
      { id: "demo-field-score", databaseId: roadmapDatabaseId, key: "score", title: "优先级分", type: "formula", formula: 'prop("effort") * 2', position: "00004000" },
      { id: "demo-field-url", databaseId: roadmapDatabaseId, key: "url", title: "资料链接", type: "url", position: "00005000" }
    ];
    this.databases.set(roadmapDatabaseId, {
      source: { id: roadmapDatabaseId, title: "发布路线图", notebookId: "nb-default", fields: roadmapFields, recordCount: 3 },
      records: [
        { id: "demo-record-1", databaseId: roadmapDatabaseId, position: "00001000", sourceDocumentId: "showcase", values: { name: "引用体验", status: "进行中", effort: 3, url: "https://example.com/references" } },
        { id: "demo-record-2", databaseId: roadmapDatabaseId, position: "00002000", sourceDocumentId: "epsilon", values: { name: "Canvas 白板", status: "规划中", effort: 5, url: "https://example.com/canvas" } },
        { id: "demo-record-3", databaseId: roadmapDatabaseId, position: "00003000", sourceDocumentId: "beta", values: { name: "智能表格", status: "已完成", effort: 2, url: "https://example.com/database" } }
      ]
    });

    setBlocks("alpha", [
      // Keep Alpha as the minimal long-lived editing anchor. Rich examples
      // are grouped in 演示中心 so ordinary editor workflows stay stable.
      { ...block("a1", "浏览器编辑器核心"), position: "00001000" },
      { ...block("ar1", ""), position: "00002000", type: "reference" }
    ]);

    const showcase = this.docs.get("showcase")!;
    const showcaseComments = [{ id: "demo-comment-1", content: "这里演示块级注释与历史记录。", createdAt: "2026-09-20T09:00:00.000Z", updatedAt: "2026-09-20T09:00:00.000Z", history: [{ id: "demo-comment-history-1", action: "created" as const, content: "这里演示块级注释与历史记录。", timestamp: "2026-09-20T09:00:00.000Z" }] }];
    setBlocks("showcase", [
      heading("s1", 1, "LocalNotes 能力演示", "00001000"),
      paragraph("s2", "这是一个可编辑的项目首页：[[默认笔记本/Beta#^b1]] 记录研究结论，[[默认笔记本/Epsilon#^e1]] 负责发布计划。", "00002000", { comments: showcaseComments }),
      heading("s3", 2, "本周重点", "00003000"),
      todo("s4", "完成实时引用的交互验收", "00004000", "2026-09-20", "2026-09-27"),
      todo("s5", "整理数据库字段与 DQL 示例", "00005000", "2026-09-19", "2026-09-25", true, "2026-09-24"),
      demoBlock("s6", "database_table", "", "00006000", { databaseId: roadmapDatabaseId, databaseSource: "database" }),
      demoBlock("s7", "location", "", "00007000", { locationId: "loc-default-office" }),
      { id: "s8", parentId: null, position: "00008000", type: "media", content: { text: "", html: "", caption: "项目首页视觉卡片", media: { id: "demo-asset-cover", kind: "image", name: "项目首页视觉卡片.svg", mimeType: "image/svg+xml", size: demoImageUrl.length, url: demoImageUrl } }, properties: {}, revision: 1 },
      heading("s9", 2, "访谈洞察", "00009000"),
      paragraph("s10", "用户反复提到：信息应该能够被引用、预览，并在原文更新时同步。", "00010000"),
      todo("s11", "把三条洞察转成产品假设", "00011000", "2026-09-18", "2026-09-26")
    ]);

    setBlocks("beta", [
      { ...block("b1", "Beta 的内容"), position: "00001000" },
      { ...block("b2", "Beta 文档中的其他块"), position: "00002000" }
    ]);
    setBlocks("gamma", [
      heading("g0", 1, "2026-09-24", "00001000"),
      paragraph("g1", "Gamma 日记", "00002000"),
      paragraph("g2", "今日复盘：把零散的灵感整理成可追踪的行动。", "00003000"),
      heading("g3", 2, "明日计划", "00004000"),
      todo("g4", "完成一小时深度阅读", "00005000", "2026-09-24", "2026-09-25")
    ]);
    setBlocks("delta", [
      heading("d0", 1, "灵感收集", "00001000"),
      paragraph("d1", "Delta 灵感收集", "00002000"),
      paragraph("d2", "> 一个好工具应该让内容之间自然发生关系。\n\n- 先记录\n- 再连接\n- 最后回看", "00003000")
    ]);
    setBlocks("epsilon", [
      heading("e0", 1, "产品发布计划", "00001000"),
      paragraph("e1", "Epsilon 项目计划", "00002000"),
      heading("e2", 2, "里程碑", "00003000"),
      paragraph("e3", "第一阶段：编辑器基础；第二阶段：引用与数据库；第三阶段：Canvas 工作流。", "00004000"),
      todo("e4", "发布体验验收", "00005000", "2026-09-15", "2026-10-01")
    ]);
    const zetaHeading = this.docs.get("zeta")!.blocks.find(block => block.id === "z2") ?? demoBlock("z2", "paragraph", "# 目标标题", "00003000");
    setBlocks("zeta", [
      heading("z0", 1, "参考资料", "00001000"),
      paragraph("z1", "Zeta 参考资料", "00002000"),
      { ...zetaHeading, position: "00003000" },
      heading("z3", 2, "阅读摘录", "00004000"),
      paragraph("z4", "<style>.reference-note { color: #175cd3; }</style>\n\n**可搜索正文** 与网页链接字段都可以被查询。", "00005000")
    ]);
    setBlocks("eta", [
      heading("eta0", 1, "研究笔记", "00001000"),
      paragraph("h1", "Eta 研究笔记", "00002000"),
      paragraph("h2", "将来源文档、块引用和 DQL 查询放在同一条工作流里。", "00003000"),
      todo("h3", "补充研究结论", "00004000", "2026-09-21", "2026-09-30")
    ]);
    setBlocks("theta", [
      heading("t0", 1, "日常记录", "00001000"),
      paragraph("t1", "Theta 日常", "00002000"),
      paragraph("t2", "今天适合把日历、待办和位置记录串起来。", "00003000")
    ]);
    showcase.documentStyles = [{ id: "demo-showcase-style", title: "首页提示", description: "给项目首页的提示段落加一条蓝色边线。", css: ".demo-callout { border-left: 3px solid #175cd3; padding-left: 12px; color: #344054; }", enabled: true, position: "00001000", scope: "document" }];
    showcase.notebookStyles = [{ id: "demo-notebook-style", title: "演示笔记本强调色", description: "为演示笔记本提供克制的链接颜色。", css: ".wiki-link { text-decoration-thickness: 1px; }", enabled: true, position: "00001000", scope: "notebook" }];

    const now = new Date().toISOString();
    this.locations.set("loc-demo-studio", { id: "loc-demo-studio", scope: "notebook", notebookId: "nb-research", name: "演示工作室", address: "广东省广州市越秀区示例路 18 号", latitude: 23.1295, longitude: 113.2648, source: "map", precision: "street", createdAt: now, updatedAt: now });

    const makeCanvas = (id: string, title: string, bookmarkId: string, nodes: CanvasNode[]) => {
      this.createCanvas(title, id, bookmarkId);
      const canvas = this.canvases.get(id)!;
      canvas.nodes = normalizeCanvasNodes(nodes);
      const document = this.docs.get(id)!;
      document.blocks = canvas.nodes.flatMap(node => node.block ? [node.block] : []);
      this.recordCanvasHistory(id);
    };
    const roadmapBlock = demoBlock("canvas-roadmap-note", "paragraph", "把研究结论、发布计划和实时引用放在一起。", "00001000");
    const roadmapHeading = demoBlock("canvas-roadmap-heading", "heading", "# 项目路线图", "00002000", { headingLevel: 1 });
    makeCanvas("canvas-roadmap", "项目路线图", "bk-projects", [
      { id: roadmapHeading.id, kind: "block", x: 120, y: 90, width: 300, height: 150, zIndex: 2, block: roadmapHeading },
      { id: roadmapBlock.id, kind: "block", x: 150, y: 310, width: 320, height: 170, zIndex: 3, block: roadmapBlock },
      { id: "canvas-roadmap-beta", kind: "document", x: 560, y: 100, width: 340, height: 260, zIndex: 2, targetId: "beta", displayMode: "preview" },
      { id: "canvas-roadmap-epsilon", kind: "document", x: 980, y: 100, width: 112, height: 112, zIndex: 3, targetId: "epsilon", displayMode: "icon" },
      { id: "canvas-roadmap-cover", kind: "media", x: 560, y: 430, width: 360, height: 230, zIndex: 2, caption: "路线图视觉卡片", media: { id: "demo-asset-canvas", kind: "image", name: "路线图视觉卡片.svg", mimeType: "image/svg+xml", size: demoImageUrl.length, url: demoImageUrl } },
      { id: "canvas-roadmap-curve", kind: "curve", x: 0, y: 0, width: 1, height: 1, zIndex: 1, curve: { start: { nodeId: roadmapHeading.id, side: "right" }, end: { nodeId: "canvas-roadmap-beta", side: "left" }, control1: { x: 500, y: 150 }, control2: { x: 500, y: 250 }, color: "#175cd3", width: 2, dash: "dashed", label: "研究 → 交付" } }
    ]);
    const researchHeading = demoBlock("canvas-research-heading", "heading", "# 研究白板", "00001000", { headingLevel: 1 });
    makeCanvas("canvas-research", "研究白板", "bk-sources", [
      { id: researchHeading.id, kind: "block", x: 120, y: 120, width: 300, height: 150, zIndex: 2, block: researchHeading },
      { id: "canvas-research-zeta", kind: "document", x: 520, y: 100, width: 112, height: 112, zIndex: 2, targetId: "zeta", displayMode: "icon" },
      { id: "canvas-research-eta", kind: "document", x: 760, y: 100, width: 320, height: 220, zIndex: 2, targetId: "eta", displayMode: "preview" },
      { id: "canvas-research-roadmap", kind: "canvas", x: 520, y: 390, width: 112, height: 112, zIndex: 2, targetId: "canvas-roadmap", displayMode: "icon" },
      { id: "canvas-research-curve", kind: "curve", x: 0, y: 0, width: 1, height: 1, zIndex: 1, curve: { start: { nodeId: researchHeading.id, side: "right" }, end: { nodeId: "canvas-research-zeta", side: "left" }, control1: { x: 470, y: 170 }, control2: { x: 470, y: 170 }, color: "#ea580c", width: 3, dash: "solid", label: "来源" } }
    ]);
  }
  private allDocuments() {
    return [...this.titleByDocument.entries()].filter(([id]) => this.itemKinds.get(id) !== "canvas").map(([id, title]) => ({ id, title }));
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
      ids.forEach((id, position) => documents.push({ id, title: this.getDocumentTitle(id), bookmarkId, parentId: this.parentByDocument.get(id) ?? null, position, kind: this.itemKinds.get(id) ?? "document" }));
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
    const canvas = this.canvases.get(id);
    if (canvas) { canvas.title = title; this.recordCanvasHistory(id); }
  }
  removeDocument(id: string) {
    const oldParent = this.parentByDocument.get(id) ?? null;
    this.titleByDocument.delete(id); this.docs.delete(id); this.canvases.delete(id); this.canvasHistories.delete(id); this.itemKinds.delete(id); this.parentByDocument.delete(id);
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
    this.itemKinds.set(id, "document");
    this.titleByDocument.set(id, title);
    const bookmark = this.bookmarks.find(item => item.id === bookmarkId);
    this.docs.set(id, createDocumentState(id, title, bookmark?.notebookId, this.globalSystemStyles));
    this.parentByDocument.set(id, parentId);
    const list = this.documentByBookmark.get(bookmarkId) ?? [];
    list.push(id);
    this.documentByBookmark.set(bookmarkId, list);
    return id;
  }

  createCanvas(title: string, requestedId: string, bookmarkId = this.activeBookmarkId, parentId: string | null = null) {
    if (this.titleByDocument.has(requestedId)) throw new Error("工作区项目 ID 已存在");
    this.createDocument(title, requestedId, bookmarkId, parentId);
    const canvas = { id: requestedId, title, nodes: [] as CanvasNode[], viewport: { x: 0, y: 0, zoom: 1 }, version: 0 };
    this.itemKinds.set(requestedId, "canvas");
    this.titleByDocument.set(requestedId, title);
    this.canvases.set(requestedId, canvas);
    this.canvasHistories.set(requestedId, { entries: [{ id: `canvas-history-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`, timestamp: Date.now(), label: "创建 Canvas", title, nodes: [], viewport: structuredClone(canvas.viewport), references: [] }], cursor: 0 });
    this.parentByDocument.set(requestedId, parentId);
    const list = this.documentByBookmark.get(bookmarkId) ?? [];
    if (!list.includes(requestedId)) list.push(requestedId);
    this.documentByBookmark.set(bookmarkId, list);
  }

  createDashboard(title: string, requestedId: string, bookmarkId = this.activeBookmarkId, parentId: string | null = null) {
    if (this.titleByDocument.has(requestedId)) throw new Error("工作区项目 ID 已存在");
    this.createDocument(title, requestedId, bookmarkId, parentId);
    this.itemKinds.set(requestedId, "dashboard");
    const state = this.docs.get(requestedId)!;
    const widget = (id: string, kind: string, titleText: string, x: number, y: number, position: number, width = 320, height = 220): Block =>
      createBlock({ id, type: "dashboard_widget", position: String(position * 1000).padStart(8, "0"),
        properties: { dashboardWidget: { kind, title: titleText, scope: "activeDocument", layout: { x, y, width, height } } } });
    state.blocks = [
      widget(`${requestedId}-widget-references`, "references", "实时引用", 32, 32, 1),
      widget(`${requestedId}-widget-backlinks`, "backlinks", "反向链接", 376, 32, 2),
      widget(`${requestedId}-widget-calendar`, "calendar", "日历", 32, 276, 3, 320, 190)
    ];
  }

  canvas(id: string): CanvasDocument | undefined {
    this.refreshReferenceSnapshots();
    const canvas = this.canvases.get(id);
    const history = this.canvasHistories.get(id);
    if (!canvas || !history) return undefined;
    const normalized = normalizeCanvasNodes(canvas.nodes);
    // Migrate legacy `text/content` nodes as they cross the workspace API.
    // The returned object is detached, so this does not mutate the host until
    // the next acknowledged save.
    return structuredClone({ ...canvas, nodes: normalized, references: this.docs.get(id)?.references ?? [], canUndo: history.cursor > 0, canRedo: history.cursor < history.entries.length - 1, history: this.canvasHistoryModel(id) });
  }

  canLinkCanvas(sourceCanvasId: string, targetCanvasId: string, proposedNodes?: CanvasNode[]) {
    if (sourceCanvasId === targetCanvasId || !this.canvases.has(sourceCanvasId) || !this.canvases.has(targetCanvasId)) return false;
    const pending = [targetCanvasId];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === sourceCanvasId) return false;
      if (visited.has(current)) continue;
      visited.add(current);
      const nodes = current === sourceCanvasId && proposedNodes ? proposedNodes : this.canvases.get(current)?.nodes ?? [];
      for (const node of normalizeCanvasNodes(nodes)) if (node.kind === "canvas" && node.targetId) pending.push(node.targetId);
    }
    return true;
  }

  saveCanvas(canvasId: string, nodes: CanvasNode[], viewport: CanvasViewport, mutationId: string, expectedVersion: number) {
    const canvas = this.canvases.get(canvasId);
    if (!canvas) throw new Error("Canvas 不存在");
    if (this.failNextSave) { this.failNextSave = false; throw new Error("Mock 保存失败"); }
    const mutationKey = `${canvasId}:${mutationId}`;
    if (this.canvasMutations.has(mutationKey)) return;
    if (expectedVersion !== canvas.version) throw new Error("Canvas 已更新，请重新载入后再保存");
    const canonicalNodes = normalizeCanvasNodes(nodes);
    const ids = new Set<string>();
    for (const node of canonicalNodes) {
      if (!node.id || ids.has(node.id)) throw new Error("Canvas 节点 ID 重复");
      ids.add(node.id);
      if (![node.x, node.y, node.width, node.height, node.zIndex].every(Number.isFinite)) throw new Error("Canvas 节点位置无效");
      // Curves keep their bounds as a lightweight geometry envelope; legacy
      // canvases may store a 1×1 envelope even though the rendered path is
      // fully defined by its endpoints and control points. Enforce the card
      // minimum only for nodes whose frame is user-visible.
      if (node.kind !== "curve" && (node.width < 80 || node.height < 64)) throw new Error("Canvas 节点尺寸无效");
      if (node.kind === "block" && (!node.block || node.block.id !== node.id)) throw new Error("Canvas 正文块无效");
      if ((node.kind === "document" || node.kind === "canvas") && (!node.targetId || !this.titleByDocument.has(node.targetId))) throw new Error("Canvas 引用目标不存在");
      if (node.kind === "draw" && (!node.strokes?.length || node.strokes.some(stroke => stroke.points.length < 2))) throw new Error("Canvas 手绘内容无效");
      if (node.kind === "curve" && (!node.curve || !node.curve.start?.nodeId || !node.curve.end?.nodeId)) throw new Error("Canvas 曲线端点无效");
      if (node.kind === "curve" && node.curve && (!(["none", "end", "both", undefined] as unknown[]).includes(node.curve.arrow) || node.curve.controlPoints?.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)))) throw new Error("Canvas 曲线控制点无效");
      if (node.kind === "media" && (node.block?.id !== node.id || node.block.type !== "media" || !node.block.content.media?.url)) throw new Error("Canvas 媒体块无效");
      if (node.kind === "curve" && node.curve && (!canonicalNodes.some(item => item.id === node.curve!.start.nodeId && item.kind !== "curve" && item.kind !== "draw") || !canonicalNodes.some(item => item.id === node.curve!.end.nodeId && item.kind !== "curve" && item.kind !== "draw"))) throw new Error("Canvas 曲线必须连接到块");
      if (node.kind === "curve" && node.curve?.branches?.some(branch => !canonicalNodes.some(item => item.id === branch.nodeId && item.kind !== "curve" && item.kind !== "draw"))) throw new Error("Canvas 曲线分支端点无效");
      if (node.kind === "canvas" && node.targetId && !this.canLinkCanvas(canvasId, node.targetId, nodes)) throw new Error("Canvas 不能形成直接或间接循环引用");
    }
    canvas.nodes = structuredClone(canonicalNodes);
    const document = this.docs.get(canvasId)!;
    // Layout owns the Block objects; the document index exposes those same objects
    // to the existing reference commands and catalog, never another content copy.
    document.blocks = canvas.nodes.flatMap(node => node.block ? [node.block] : []);
    document.references = document.references.filter(ref => {
      const block = document.blocks.find(block => block.id === ref.hostBlockId);
      return block && (block.type === "reference" || block.content.links?.some(link =>
        link.targetDocumentId === ref.targetDocumentId && link.targetBlockId === ref.targetBlockId && link.targetScope === ref.targetScope));
    });
    canvas.viewport = { x: Number(viewport.x) || 0, y: Number(viewport.y) || 0, zoom: Math.max(.25, Math.min(2.5, Number(viewport.zoom) || 1)) };
    canvas.version += 1;
    this.canvasMutations.add(mutationKey);
    this.recordCanvasHistory(canvasId);
  }

  private recordCanvasHistory(canvasId: string) {
    const canvas = this.canvases.get(canvasId)!;
    const history = this.canvasHistories.get(canvasId)!;
    const references = structuredClone(this.docs.get(canvasId)?.references ?? []);
    // Source projections are refreshed on read. Only instance state belongs to history.
    references.forEach(ref => { ref.blocks = ref.blocks.filter(block => block.scopeType === "reference_instance"); });
    const snapshot = { id: `canvas-history-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`, timestamp: Date.now(), label: "编辑 Canvas", title: canvas.title, nodes: structuredClone(canvas.nodes), viewport: structuredClone(canvas.viewport), references };
    const current = history.entries[history.cursor];
    const same = current && JSON.stringify({ title: current.title, nodes: current.nodes, viewport: current.viewport, references: current.references }) === JSON.stringify({ title: snapshot.title, nodes: snapshot.nodes, viewport: snapshot.viewport, references: snapshot.references });
    if (!same && current) {
      const withoutTextRevision = (node: CanvasNode) => {
        const copy = structuredClone(node);
        if (copy.block) {
          const { content: _content, revision: _revision, ...blockLayout } = copy.block;
          copy.block = blockLayout as CanvasNode["block"];
        }
        return copy;
      };
      const previousNodes = current.nodes.map(withoutTextRevision);
      const nextNodes = snapshot.nodes.map(withoutTextRevision);
      const changedTextNodes = snapshot.nodes.filter((node, index) => JSON.stringify(node.block?.content) !== JSON.stringify(current.nodes[index]?.block?.content));
      const textOnly = snapshot.title === current.title
        && JSON.stringify(previousNodes) === JSON.stringify(nextNodes)
        && snapshot.viewport.x === current.viewport.x && snapshot.viewport.y === current.viewport.y && snapshot.viewport.zoom === current.viewport.zoom
        && snapshot.references.length === current.references.length
        && changedTextNodes.length === 1;
      // Canvas text is saved after a short debounce. Keep a continuous edit of
      // one block as one history entry while still recording layout/media/curve
      // changes immediately.
      if (textOnly) {
        const changed = changedTextNodes[0];
        const blockId = changed.block?.id ?? "";
        const previousBlock = current.nodes.find(node => node.block?.id === blockId)?.block;
        const nextLength = changed.block?.content.text?.length ?? changed.block?.content.markdown?.length ?? 0;
        const previousLength = previousBlock?.content.text?.length ?? previousBlock?.content.markdown?.length ?? 0;
        const beforeCreation = history.entries[history.cursor - 1];
        if (beforeCreation && !beforeCreation.nodes.some(node => node.block?.id === blockId)
          && previousLength === 0 && snapshot.timestamp - current.timestamp < 5000) {
          history.entries[history.cursor] = snapshot;
          return;
        }
        const group = this.canvasTextGroups.get(canvasId);
        const withinGroup = group && group.blockId === blockId && snapshot.timestamp - group.lastTimestamp < 5000 && Math.abs(nextLength - group.baselineLength) < 50;
        if (withinGroup) {
          history.entries[history.cursor] = snapshot;
          group.lastTimestamp = snapshot.timestamp;
          return;
        }
        this.canvasTextGroups.set(canvasId, { blockId, baselineLength: previousLength, lastTimestamp: snapshot.timestamp });
      } else {
        this.canvasTextGroups.delete(canvasId);
      }
    }
    if (!same) {
      history.entries.splice(history.cursor + 1);
      history.entries.push(snapshot);
      history.cursor = history.entries.length - 1;
      if (history.entries.length > 80) { history.entries.shift(); history.cursor -= 1; }
    }
  }

  moveCanvasHistory(canvasId: string, direction: "undo" | "redo", expectedVersion: number) {
    const canvas = this.canvases.get(canvasId);
    const history = this.canvasHistories.get(canvasId);
    if (!canvas || !history) throw new Error("Canvas 不存在");
    if (expectedVersion !== canvas.version) throw new Error("Canvas 已更新，请重新载入后再恢复历史");
    const target = history.cursor + (direction === "undo" ? -1 : 1);
    const snapshot = history.entries[target];
    if (!snapshot) return;
    history.cursor = target;
    canvas.nodes = structuredClone(snapshot.nodes);
    canvas.title = snapshot.title;
    this.setDocumentTitle(canvasId, canvas.title);
    const document = this.docs.get(canvasId)!;
    document.blocks = canvas.nodes.flatMap(node => node.block ? [node.block] : []);
    document.references = structuredClone(snapshot.references);
    canvas.viewport = structuredClone(snapshot.viewport);
    canvas.version += 1;
  }

  restoreCanvasHistory(canvasId: string, entryId: string, expectedVersion: number) {
    const canvas = this.canvases.get(canvasId);
    const history = this.canvasHistories.get(canvasId);
    if (!canvas || !history) throw new Error("Canvas 不存在");
    if (expectedVersion !== canvas.version) throw new Error("Canvas 已更新，请重新载入后再恢复历史");
    const target = history.entries.findIndex(entry => entry.id === entryId);
    if (target < 0) throw new Error("Canvas 历史版本不存在");
    history.cursor = target;
    const snapshot = history.entries[target];
    canvas.nodes = structuredClone(snapshot.nodes);
    canvas.title = snapshot.title;
    this.setDocumentTitle(canvasId, canvas.title);
    canvas.viewport = structuredClone(snapshot.viewport);
    const document = this.docs.get(canvasId)!;
    document.blocks = canvas.nodes.flatMap(node => node.block ? [node.block] : []);
    document.references = structuredClone(snapshot.references);
    canvas.version += 1;
  }

  todoDates(): CalendarTodo[] {
    const todos: CalendarTodo[] = [];
    for (const [documentId, state] of this.docs) {
      state.blocks.forEach(block => {
        if (block.type !== "todo") return;
        const createdAt = block.properties.todoCreatedAt;
        const dueAt = block.properties.todoDueAt;
        const completedAt = block.properties.todoCompletedAt;
        if (createdAt || dueAt || completedAt) {
          todos.push({
            documentId,
            blockId: block.id,
            createdAt,
            dueAt,
            completedAt,
            checked: block.content.checked === true,
            text: (block.content.text || block.content.markdown || "").replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, "").trim()
          });
        }
      });
    }
    return todos;
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

  transferBlock(sourceDocumentId: string, targetDocumentId: string, blockId: string, mode: "reference" | "copy", beforeBlockId?: string, insertAfter = false) {
    if (sourceDocumentId === targetDocumentId) throw new Error("不能把块导入到同一文档");
    const source = this.docs.get(sourceDocumentId);
    const target = this.docs.get(targetDocumentId);
    if (!source || !target) throw new Error("源文档或目标文档不存在");
    const original = source.blocks.find(block => block.id === blockId);
    if (!original) throw new Error("源块不存在");
    const sourceHistory = this.documentHistory(sourceDocumentId);
    const targetHistory = this.documentHistory(targetDocumentId);
    const ordered = [...target.blocks].sort((a, b) => a.position.localeCompare(b.position));
    const targetIndex = beforeBlockId ? ordered.findIndex(block => block.id === beforeBlockId) : -1;
    const insertionIndex = targetIndex >= 0 ? targetIndex + (insertAfter ? 1 : 0) : ordered.length;
    const position = String((insertionIndex + 1) * 1000).padStart(8, "0");
    if (mode === "copy") {
      const copied: Block = structuredClone(original);
      copied.id = `block-${Math.random().toString(36).slice(2, 10)}`;
      copied.parentId = null;
      copied.position = position;
      copied.scopeType = "canonical";
      copied.revision = 1;
      target.blocks.push(copied);
    } else {
      const hostBlockId = `reference-${Math.random().toString(36).slice(2, 10)}`;
      const targetTitle = this.getDocumentTitle(sourceDocumentId);
      target.blocks.push({ id: hostBlockId, parentId: null, position, type: "reference", content: { text: "", html: "" }, properties: {}, revision: 1 });
      target.references.push({
        id: `ref-${hostBlockId}`,
        hostBlockId,
        targetDocumentId: sourceDocumentId,
        targetBlockId: original.id,
        targetScope: "block",
        targetTitle,
        mode: "inline",
        blocks: [structuredClone(original)],
        overrides: [],
        hiddenBlockIds: []
      });
    }
    target.blocks = orderBlockTree(target.blocks.map((block, index) => ({ ...block, position: String((index + 1) * 1000).padStart(8, "0") })));
    sourceHistory.record(this.historySnapshot(sourceDocumentId), "跨文档拖拽");
    targetHistory.record(this.historySnapshot(targetDocumentId), mode === "reference" ? "插入块引用" : "复制块");
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
    result.history = this.canvases.has(documentId) ? this.canvasHistoryModel(documentId) : this.documentHistory(documentId).model(documentId);
    result.backlinks = this.computeBacklinks(documentId);
    result.overrideNotices = this.computeOverrideNotices(documentId);
    const workspaceId = result.note.workspaceId;
    result.locations = [...this.locations.values()].filter(location => location.scope === "global" || location.notebookId === workspaceId);
    result.locationVersion = this.locationVersion;
    const visible = [...this.databases.values()].filter(item => !item.source.notebookId || item.source.notebookId === workspaceId);
    result.databases = visible.map(item => structuredClone(item.source));
    result.databaseRecords = Object.fromEntries(visible.map(item => [item.source.id, structuredClone(item.records)]));
    return result;
  }
  private restoreVisibleLocations(workspaceId: string | undefined, snapshot: GeoLocation[]) {
    for (const [id, location] of this.locations) {
      if (location.scope === "global" || location.notebookId === workspaceId) this.locations.delete(id);
    }
    snapshot.forEach(location => this.locations.set(location.id, structuredClone(location)));
    this.locationVersion += 1;
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
  private headingSection = headingSection;
  updateSourceBlock(documentId: string, blockId: string, text: string) {
    const source = this.docs.get(documentId);
    const target = source?.blocks.find((candidate) => candidate.id === blockId);
    if (!target) throw new Error("源块不存在");
    // Keep all serialized representations in sync. Demo fixtures use Markdown
    // for source review, and projections prefer that field when it exists.
    target.content = { ...target.content, text, html: text, markdown: text };
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
            const payload = request.payload as { operation?: string; referenceInstanceId?: string; mode?: string; hostBlockId?: string; targetDocumentId?: string; targetBlockId?: string; targetScope?: "block" | "heading"; content?: BlockContent; properties?: BlockProperties; style?: StyleSheet; styleId?: string; scope?: StyleScope; databaseId?: string; database?: DatabaseSource; fields?: DatabaseField[]; record?: DatabaseRecord; query?: string; location?: GeoLocation; locationId?: string; locationsScope?: "global" | "notebook"; mutationId?: string; expectedLocationVersion?: number };
            const current = this.docs.get(request.sourceDocumentId ?? this.current)!;
            if (!current) throw new Error("文档不存在");
            const databaseWrites = new Set(["create-database", "save-database-schema", "upsert-database-record", "delete-database-record"]);
            const locationWrites = new Set(["create-location", "update-location", "delete-location"]);
            const mutationId = typeof (payload as Record<string, unknown>).mutationId === "string" ? String((payload as Record<string, unknown>).mutationId) : "";
            const requestedVersion = Number((payload as Record<string, unknown>).clientVersion);
            const mutationKey = `${current.note.id}:${mutationId}`;
            if (databaseWrites.has(payload.operation ?? "")) {
              if (!mutationId || !Number.isInteger(requestedVersion)) throw new Error("数据库写入缺少 mutationId 或 clientVersion");
              if (this.databaseMutations.has(mutationKey)) { this.respond(request, { state: this.state(current.note.id) }); break; }
              if (requestedVersion <= current.note.clientVersion) throw new Error("数据库写入版本已过期，请重新载入");
            }
            const finishDatabaseMutation = () => { current.note.clientVersion += 1; this.databaseMutations.add(mutationKey); };
            const finishLocationMutation = () => { this.locationVersion += 1; this.locationMutations.add(mutationKey); };
            if (payload.operation === "list-locations") {
              const workspaceId = current.note.workspaceId;
              const locations = [...this.locations.values()].filter(location => location.scope === "global" || location.notebookId === workspaceId);
              this.respond(request, { state: this.state(current.note.id), result: { locations, locationVersion: this.locationVersion } });
              break;
            }
            if (locationWrites.has(payload.operation ?? "")) {
              if (!mutationId || !Number.isInteger(Number(payload.expectedLocationVersion))) throw new Error("位置写入缺少 mutationId 或版本");
              if (this.locationMutations.has(mutationKey)) { this.respond(request, { state: this.state(current.note.id), result: { locations: [...this.locations.values()], locationVersion: this.locationVersion } }); break; }
              if (Number(payload.expectedLocationVersion) !== this.locationVersion) throw new Error("位置目录已更新，请重新载入");
              if (payload.operation === "create-location") {
                const location = structuredClone(payload.location);
                if (!location?.id || !location.name || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) throw new Error("位置缺少名称或有效坐标");
                if (location.scope === "notebook") location.notebookId = current.note.workspaceId;
                else delete location.notebookId;
                this.locations.set(location.id, { ...location, createdAt: location.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: undefined });
              } else if (payload.operation === "update-location") {
                const previous = payload.locationId ? this.locations.get(payload.locationId) : undefined;
                if (!previous) throw new Error("位置不存在");
                const next = structuredClone(payload.location);
                if (!next || next.id !== previous.id) throw new Error("位置 ID 不匹配");
                if (next.scope === "notebook") next.notebookId = current.note.workspaceId;
                else delete next.notebookId;
                this.locations.set(next.id, { ...previous, ...next, updatedAt: new Date().toISOString() });
              } else if (payload.operation === "delete-location") {
                const previous = payload.locationId ? this.locations.get(payload.locationId) : undefined;
                if (!previous) throw new Error("位置不存在");
                this.locations.set(previous.id, { ...previous, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
              }
              finishLocationMutation();
              this.documentHistory(current.note.id).record(this.historySnapshot(current.note.id), "更新位置");
              this.respond(request, { state: this.state(current.note.id), result: { locations: [...this.locations.values()], locationVersion: this.locationVersion } });
              break;
            }
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
              this.restoreVisibleLocations(current.note.workspaceId, snapshot.state.locations ?? []);
              this.setDocumentTitle(current.note.id, current.note.title);
              this.respond(request, { state: this.state(current.note.id) });
              break;
            }
            if (payload.operation === "transfer-block") {
              const sourceDocumentId = String((payload as { sourceDocumentId?: string }).sourceDocumentId ?? "");
              const targetDocumentId = String(payload.targetDocumentId ?? current.note.id);
              const blockId = String((payload as { blockId?: string }).blockId ?? "");
              const mode = payload.mode === "copy" ? "copy" : payload.mode === "reference" ? "reference" : null;
              if (!mode) throw new Error("无效的块导入方式");
              const transfer = payload as { beforeBlockId?: string; insertAfter?: boolean };
              this.transferBlock(sourceDocumentId, targetDocumentId, blockId, mode, transfer.beforeBlockId, transfer.insertAfter === true);
              this.respond(request, { state: this.state(targetDocumentId) });
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
              if (target && !current.references.some(ref => ref.hostBlockId === payload.hostBlockId &&
                  ref.targetDocumentId === payload.targetDocumentId && ref.targetBlockId === payload.targetBlockId && ref.targetScope === payload.targetScope)) current.references.push({
                id: current.references.some(ref => ref.id === `ref-${payload.hostBlockId}`) ? `ref-${crypto.randomUUID()}` : `ref-${payload.hostBlockId}`,
                hostBlockId: payload.hostBlockId,
                targetDocumentId: payload.targetDocumentId,
                targetBlockId: payload.targetBlockId,
                targetScope: payload.targetScope as "block" | "heading" | undefined,
                targetTitle: documentInfo?.title ?? target.note.title,
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
            if (this.canvases.has(current.note.id)) {
              this.canvases.get(current.note.id)!.version += 1;
              this.recordCanvasHistory(current.note.id);
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
