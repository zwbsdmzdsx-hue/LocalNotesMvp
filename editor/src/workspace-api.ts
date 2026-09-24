import type { Block, ReferenceInstance, HistoryModel, MediaAsset } from "../../protocol/types";

export type Notebook = { id: string; name: string };
export type Bookmark = { id: string; notebookId: string; name: string; color: string };
export type WorkspaceItemKind = "document" | "canvas" | "dashboard";
export type WorkspaceDocument = { id: string; title: string; bookmarkId: string; parentId: string | null; position: number; kind: WorkspaceItemKind };
/**
 * Canvas uses the same Block model as a document for free-form content.
 * `text` remains a read-only compatibility value for canvases created by
 * older builds and is normalized at the workspace boundary.
 */
export type CanvasNodeKind = "block" | "document" | "canvas" | "text" | "draw" | "curve" | "media";
export type CanvasPoint = { x: number; y: number };
export type CanvasStroke = { points: CanvasPoint[]; color: string; width: number };
export type CanvasCurveEndpoint = { nodeId: string; side: "top" | "right" | "bottom" | "left" };
export type CanvasCurve = {
  start: CanvasCurveEndpoint;
  end: CanvasCurveEndpoint;
  control1: CanvasPoint;
  control2: CanvasPoint;
  color: string;
  width: number;
  dash: "solid" | "dashed" | "dotted";
  /** Arrowhead placement for the main path. Older curves default to none. */
  arrow?: "none" | "end" | "both";
  /** Additional points inserted between the legacy cubic handles. */
  controlPoints?: CanvasPoint[];
  /** Extra endpoints that branch from the same start node. */
  branches?: CanvasCurveEndpoint[];
  label?: string;
};
export type CanvasDisplayMode = "preview" | "icon";
export type CanvasReferenceDisplay = "preview" | "icon";
export type CanvasNode = {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  /** Canonical content for a free-form Canvas node. */
  block?: Block;
  /** @deprecated Legacy Canvas payload. Read only; never written by new code. */
  content?: string;
  targetId?: string;
  displayMode?: CanvasDisplayMode;
  /** Display preference for a Block-backed node that contains wiki links. */
  referenceDisplay?: CanvasReferenceDisplay;
  /** User supplied glyph shown when a reference node is in icon mode. */
  referenceIcon?: string;
  /** Canvas-only font size for the node body. */
  fontSize?: number;
  strokes?: CanvasStroke[];
  curve?: CanvasCurve;
  media?: MediaAsset;
  caption?: string;
};

export function normalizeCanvasNode(node: CanvasNode, index = 0): CanvasNode {
  if (node.kind !== "text" && node.kind !== "block") return structuredClone(node);
  const legacyText = node.content ?? node.block?.content.text ?? "";
  const block = node.block ?? {
    id: node.id,
    parentId: null,
    position: String((index + 1) * 1000).padStart(8, "0"),
    type: "paragraph" as const,
    content: { text: legacyText, html: legacyText, markdown: legacyText },
    properties: {},
    revision: 1
  };
  const { content: _legacyContent, ...layout } = structuredClone(node);
  return { ...layout, kind: "block", block };
}

export function normalizeCanvasNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((node, index) => normalizeCanvasNode(node, index));
}
export type CanvasViewport = { x: number; y: number; zoom: number };
export type CanvasDocument = {
  id: string;
  title: string;
  nodes: CanvasNode[];
  references: ReferenceInstance[];
  viewport: CanvasViewport;
  version: number;
  canUndo: boolean;
  canRedo: boolean;
  history?: HistoryModel;
};
export type WorkspaceSnapshot = {
  notebooks: Notebook[]; bookmarks: Bookmark[]; openNotebookIds: string[];
  activeNotebookId: string; activeBookmarkId: string; documentIds: string[]; documents: WorkspaceDocument[];
};
export type SearchHit = {
  kind: "title" | "block"; documentId: string; documentTitle: string; blockId: string | null; excerpt: string;
};
export type CalendarTodo = {
  documentId: string;
  blockId: string;
  createdAt?: string;
  dueAt?: string;
  completedAt?: string;
  checked: boolean;
  text: string;
};
export type WorkspaceCommand =
  | { type: "selectNotebook" | "openNotebook" | "closeNotebook" | "removeNotebook" | "selectBookmark" | "removeBookmark" | "removeDocument"; id: string }
  | { type: "renameNotebook" | "renameBookmark" | "renameDocument"; id: string; name: string }
  | { type: "createNotebook"; notebook: Notebook }
  | { type: "createBookmark"; bookmark: Bookmark }
  | { type: "createDocument"; document: { id: string; title: string }; bookmarkId: string; parentId?: string | null }
  | { type: "createCanvas"; canvas: { id: string; title: string }; bookmarkId: string; parentId?: string | null }
  | { type: "createDashboard"; dashboard: { id: string; title: string }; bookmarkId: string; parentId?: string | null }
  | { type: "moveDocument"; id: string; bookmarkId: string; parentId: string | null; index: number }
  | { type: "transferBlock"; sourceDocumentId: string; targetDocumentId: string; blockId: string; mode: "reference" | "copy" }
  | { type: "moveBookmark"; id: string; index: number }
  | { type: "recolorBookmark"; id: string; color: string }
  | { type: "saveCanvas"; canvasId: string; nodes: CanvasNode[]; viewport: CanvasViewport; mutationId: string; expectedVersion: number }
  | { type: "undoCanvas" | "redoCanvas"; canvasId: string; expectedVersion: number }
  | { type: "restoreCanvas"; canvasId: string; entryId: string; expectedVersion: number };

/** Read models and acknowledged commands; no transport or editor DOM exposed to the shell. */
export interface WorkspaceApi {
  snapshot(): WorkspaceSnapshot;
  documentTitle(id: string): string;
  outline(): Block[];
  search(query: string, limit?: number): SearchHit[];
  todoDates(): CalendarTodo[];
  canvas(id: string): CanvasDocument | undefined;
  canLinkCanvas(sourceCanvasId: string, targetCanvasId: string): boolean;
  execute(command: WorkspaceCommand): Promise<void>;
}
