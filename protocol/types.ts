export type HistoryEntry = { id: string; timestamp: number; label: string; kind: string; title: string; preview: string };
export type HistoryModel = { documentId: string; entries: HistoryEntry[]; currentId: string; canUndo: boolean; canRedo: boolean };
export type MediaKind = "image" | "video" | "audio";
export type MediaAsset = { id: string; kind: MediaKind; name: string; mimeType: string; size: number; url: string };
export type BlockType = "paragraph" | "heading" | "todo" | "reference" | "media";
export type LinkToken = { targetDocumentId?: string; targetBlockId?: string; targetText: string; alias?: string; start: number; end: number };
export type BlockContent = { text: string; html: string; markdown?: string; checked?: boolean; targetDocumentId?: string; links?: LinkToken[]; media?: MediaAsset };
export type BlockProperties = {
  background?: string;
  textColor?: string;
  textAlign?: "left" | "center" | "right";
  /** A paragraph block with this layout owns a set of visual columns. */
  layout?: "columns";
  /** Zero-based column index for blocks whose nearest columns ancestor owns them. */
  column?: number;
  /** Number of columns rendered by a columns layout block. */
  columnCount?: number;
  columnGap?: string;
};
export type Block = { id: string; parentId: string | null; position: string; type: BlockType; content: BlockContent; properties: BlockProperties; revision: number; scopeType?: "canonical" | "reference_instance" };
export type Note = { id: string; title: string; isSticky: boolean; clientVersion: number };
export type StyleSheet = { id: string; title: string; description: string; css: string; enabled: boolean; position: string; scope: "document" | "notebook"; };
export type Backlink = { sourceDocumentId: string; sourceTitle: string; sourceBlockId: string; excerpt: string };
export type OverrideNotice = { referenceInstanceId: string; targetBlockId: string; sourceUpdated: boolean; hostTitle: string; hostDocumentId: string; excerpt: string; kind: "content_style" | "hide" | "move" | "insert" };
export type ReferenceOverride = { targetBlockId: string; patch: { content: BlockContent; properties: BlockProperties }; baseRevision: number };
export type ReferenceMode = "inline" | "collapsed" | "sidebar" | "link";
export type ReferenceInstance = { id: string; hostBlockId: string; targetDocumentId: string; targetBlockId?: string; targetTitle: string; mode: ReferenceMode; broken?: boolean; blocks: Block[]; overrides: ReferenceOverride[]; hiddenBlockIds: string[] };
export type EditorState = { history?: HistoryModel; note: Note & { workspaceId?: string }; blocks: Block[]; documents: Array<{ id: string; title: string; path?: string; blocks?: Block[] }>; backlinks: Backlink[]; overrideNotices: OverrideNotice[]; references: ReferenceInstance[]; documentStyles?: StyleSheet[]; notebookStyles?: StyleSheet[] };
export type SaveDocumentPayload = { title: string; blocks: Block[] };
export type SaveMutation = SaveDocumentPayload & { documentId: string; mutationId: string; historyGroup?: string; clientVersion: number };


export const PROTOCOL_VERSION = 1 as const;
export type ReferenceCommandMap = {
  createReference: { hostBlockId: string; targetDocumentId: string; targetBlockId?: string };
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
  executeCommand: { state: EditorState };
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
