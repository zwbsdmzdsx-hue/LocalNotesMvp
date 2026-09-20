export type HistoryEntry = { id: string; timestamp: number; label: string; kind: string; title: string; preview: string };
export type HistoryModel = { documentId: string; entries: HistoryEntry[]; currentId: string; canUndo: boolean; canRedo: boolean };
export type MediaKind = "image" | "video" | "audio" | "pdf" | "file";
export type MediaAsset = { id: string; kind: MediaKind; name: string; mimeType: string; size: number; url: string };
export type BlockType = "paragraph" | "heading" | "todo" | "reference" | "media" | "database_table" | "data_view";
export type ReferenceTargetScope = "block" | "heading";
export type LinkToken = { targetDocumentId?: string; targetBlockId?: string; targetScope?: ReferenceTargetScope; targetText: string; alias?: string; start: number; end: number };
export type BlockContent = { text: string; html: string; markdown?: string; checked?: boolean; targetDocumentId?: string; links?: LinkToken[]; media?: MediaAsset; caption?: string };
export type BlockCommentHistory = { id: string; action: "created" | "edited" | "deleted"; content: string; timestamp: string };
export type BlockComment = { id: string; content: string; createdAt: string; updatedAt: string; deletedAt?: string; history: BlockCommentHistory[] };
export type BlockProperties = {
  background?: string;
  textColor?: string;
  textAlign?: "left" | "center" | "right";
  /** Relative width of a media preview, expressed as a percentage of its block. */
  mediaWidth?: number;
  /** A paragraph block with this layout owns a set of visual columns. */
  layout?: "columns";
  /** Zero-based column index for blocks whose nearest columns ancestor owns them. */
  column?: number;
  /** Number of columns rendered by a columns layout block. */
  columnCount?: number;
  columnGap?: string;
  /** Shared visual row identity for Notion-like columns. */
  columnGroup?: string;
  /** Persisted widths as CSS grid fractions for this column row. */
  columnWidths?: number[];
  databaseId?: string;
  databaseViewId?: string;
  databaseSource?: "gfm" | "database";
  dataQuery?: string;
  /** Comments are part of the owning block snapshot, so normal save/history semantics apply. */
  comments?: BlockComment[];
};
export type Block = { id: string; parentId: string | null; position: string; type: BlockType; content: BlockContent; properties: BlockProperties; revision: number; scopeType?: "canonical" | "reference_instance" };
export type Note = { id: string; title: string; isSticky: boolean; clientVersion: number };
export type StyleScope = "system" | "document" | "notebook";
export type StyleSheet = { id: string; title: string; description: string; css: string; enabled: boolean; position: string; scope: StyleScope; };
export type Backlink = { sourceDocumentId: string; sourceTitle: string; sourceBlockId: string; excerpt: string };
export type OverrideNotice = { referenceInstanceId: string; targetBlockId: string; sourceUpdated: boolean; hostTitle: string; hostDocumentId: string; excerpt: string; kind: "content_style" | "hide" | "move" | "insert" };
export type ReferenceOverride = { targetBlockId: string; patch: { content: BlockContent; properties: BlockProperties }; baseRevision: number };
export type ReferenceMode = "inline" | "collapsed" | "sidebar" | "link";
export type ReferenceInstance = { id: string; hostBlockId: string; targetDocumentId: string; targetBlockId?: string; targetScope?: ReferenceTargetScope; targetTitle: string; mode: ReferenceMode; broken?: boolean; blocks: Block[]; overrides: ReferenceOverride[]; hiddenBlockIds: string[] };
export type LinkCatalogDocument = {
  id: string;
  title: string;
  path?: string;
  notebookId?: string;
  notebookName?: string;
  blocks?: Block[];
};
export type DatabaseFieldType = "text" | "number" | "url" | "media" | "formula" | "rule" | "document_relation" | "record_relation" | "rollup";
export type RollupFunction = "count" | "sum" | "avg" | "min" | "max" | "unique";
export type DatabaseField = { id: string; databaseId: string; key: string; title: string; type: DatabaseFieldType; position: string; formula?: string; relationDatabaseId?: string; relationScope?: "document" | "record"; rollup?: RollupFunction; rollupFieldKey?: string; };
export type DatabaseSource = { id: string; notebookId?: string; title: string; createdAt?: string; updatedAt?: string; fields: DatabaseField[]; recordCount: number; };
export type DatabaseValue = string | number | boolean | string[] | MediaAsset | null;
export type DatabaseRecord = { id: string; databaseId: string; position: string; sourceDocumentId?: string; sourceBlockId?: string; values: Record<string, DatabaseValue>; };
export type DatabaseView = { id: string; databaseId: string; name: string; type: "table"; settings: { fieldKeys?: string[]; widths?: number[]; sort?: { key: string; direction: "asc" | "desc" }[]; filters?: Array<{ key: string; operator: "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains"; value: DatabaseValue }>; groupBy?: string; }; };
export type DataQuery = { table?: string[]; from: "current" | { notebookId: string }; where?: string; sort?: Array<{ key: string; direction: "asc" | "desc" }>; groupBy?: string; limit?: number; };
export type FormulaError = { code: "syntax" | "type" | "unknown_property" | "cycle" | "runtime"; message: string; };
export type DataQueryResult = { columns: Array<{ key: string; title: string; type: DatabaseFieldType }>; rows: Array<{ recordId: string; sourceDocumentId?: string; sourceBlockId?: string; values: Record<string, DatabaseValue | FormulaError>; grouped?: boolean; readonlyKeys?: string[]; }>; errors: FormulaError[]; };
export type EditorState = { history?: HistoryModel; note: Note & { workspaceId?: string }; blocks: Block[]; documents: LinkCatalogDocument[]; backlinks: Backlink[]; overrideNotices: OverrideNotice[]; references: ReferenceInstance[]; databases?: DatabaseSource[]; databaseRecords?: Record<string, DatabaseRecord[]>; databaseViews?: DatabaseView[]; systemStyles?: StyleSheet[]; documentStyles?: StyleSheet[]; notebookStyles?: StyleSheet[] };
export type SaveDocumentPayload = { title: string; blocks: Block[] };
export type SaveMutation = SaveDocumentPayload & { documentId: string; mutationId: string; historyGroup?: string; clientVersion: number };


export const PROTOCOL_VERSION = 1 as const;
export type ReferenceCommandMap = {
  createReference: { hostBlockId: string; targetDocumentId: string; targetBlockId?: string; targetScope?: ReferenceTargetScope };
  setReferenceMode: { referenceInstanceId: string; mode: ReferenceMode };
  saveOverride: { historyGroup?: string; referenceInstanceId: string; targetBlockId: string; content: BlockContent; properties: BlockProperties };
  saveInstanceBlock: { historyGroup?: string; referenceInstanceId: string; block: Block };
  moveReferenceBlock: { referenceInstanceId: string; targetBlockId: string; parentBlockId: string | null; position: string };
  deleteInstanceBlock: { referenceInstanceId: string; blockId: string };
  hideReferenceBlock: { referenceInstanceId: string; targetBlockId: string };
  resetOverride: { referenceInstanceId: string; targetBlockId: string };
  resetReference: { referenceInstanceId: string };
  removeReference: { referenceInstanceId: string };
};
export type RequestMap = ReferenceCommandMap & {
  ready: {};
  loadDocument: { documentId: string };
  reloadDocument: {};
  saveDocument: SaveMutation;
  storeMedia: { name: string; mimeType: string; size: number; data: string };
  openDocument: { documentId: string; blockId?: string };
  navigateBack: {};
  navigateForward: {};
  showNotification: { message: string; level: "info" | "error" };
  executeCommand: { operation: string; [key: string]: unknown };
};
export type ResultMap = { [K in keyof ReferenceCommandMap]: { state: EditorState } } & {
  ready: null; loadDocument: { state: EditorState }; reloadDocument: { state: EditorState };
  saveDocument: { documentId: string; mutationId: string; historyGroup?: string; clientVersion: number; history?: HistoryModel };
  storeMedia: { media: MediaAsset };
  openDocument: null; navigateBack: null; navigateForward: null; showNotification: null;
  executeCommand: { state: EditorState; result?: DataQueryResult; content?: string; mimeType?: string; fileName?: string };
};
export type HostRequest<K extends keyof RequestMap = keyof RequestMap> = {
  protocolVersion: 1; requestId: string; kind: K; sourceDocumentId?: string; payload: RequestMap[K];
};
export type HostResponse = {
  protocolVersion: 1; requestId: string; kind: keyof RequestMap; ok: boolean;
  payload?: ResultMap[keyof ResultMap]; error?: { code: string; message: string };
};
export type HostEvent =
  | { protocolVersion: 1; kind: "documentChanged"; payload: { documentId: string } }
  | { protocolVersion: 1; kind: "documentLoaded"; payload: { state: EditorState } }
  | { protocolVersion: 1; kind: "focusBlock"; payload: { blockId: string } }
  | { protocolVersion: 1; kind: "flush"; payload: { requestId: string } }
  | { protocolVersion: 1; kind: "flushResult"; payload: { requestId: string; ok: boolean; error?: string } }
  | { protocolVersion: 1; kind: "notification"; payload: { message: string; level: "info" | "error" } };
export type EditorCommand = { operation: string; [key: string]: unknown };
