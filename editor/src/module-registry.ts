import type { Block, BlockContent, BlockProperties, EditorState } from "../../protocol/types";
import type { PanelContext, SurfaceKind } from "./panel-context";
import type { CalendarTodo } from "./workspace-api";
import type { BlockSnapshotReader } from "./block-snapshot";
import type { BlockEditorAdapter } from "./block-editor";

export type ModuleRegistry<T extends { id: string }> = {
  register(definition: T): void;
  get(id: string): T | undefined;
  require(id: string): T;
  entries(): T[];
};

export function createModuleRegistry<T extends { id: string }>(name: string, validate?: (definition: T) => void): ModuleRegistry<T> {
  const definitions = new Map<string, T>();
  return {
    register(definition) {
      if (!definition.id.trim()) throw new Error(`${name} ID 不能为空`);
      if (definitions.has(definition.id)) throw new Error(`${name} 已注册：${definition.id}`);
      validate?.(definition);
      definitions.set(definition.id, definition);
    },
    get: id => definitions.get(id),
    require(id) {
      const definition = definitions.get(id);
      if (!definition) throw new Error(`${name} 未注册：${id}`);
      return definition;
    },
    entries: () => [...definitions.values()]
  };
}

export type DocumentRuntime = {
  open(state: EditorState, previousSource?: EditorState | null): void;
  update(state: EditorState): void;
  close(): void;
  flush(): Promise<void>;
  focusBlock(blockId: string): void;
  restoreHistory(entryId: string): Promise<void>;
};

export type DocumentModule = {
  id: string;
  order: number;
  createLabel: string;
  createIcon: string;
  presentation: { icon: string; iconClass: string; createPrompt: string; defaultTitle: string; idPrefix: string };
  /** Eligible for Dashboard workspace aggregation; document counts use the narrower flag. */
  dashboardSource?: { countsAsDocument: boolean };
  /** Optional Canvas node presentation; other document kinds use the ordinary preview node. */
  canvasLink?: { nodeKind: "document" | "canvas"; width: number; height: number };
  liveContext: {
    tracksSource: boolean;
    changed?(state: EditorState): void;
    create(state: EditorState, source: EditorState | null, surface: SurfaceKind): PanelContext;
  };
  create(input: { id: string; title: string; bookmarkId: string; parentId: string | null }): void;
  runtime: DocumentRuntime;
};

export function createDocumentRegistry() {
  return createModuleRegistry<DocumentModule>("文档模块", definition => {
    const runtime = definition.runtime;
    if (!definition.createLabel.trim() || !definition.create || !definition.liveContext?.create ||
        typeof definition.liveContext.tracksSource !== "boolean" || !runtime?.open || !runtime.update ||
        !runtime.close || !runtime.flush || !runtime.focusBlock || !runtime.restoreHistory)
      throw new Error(`文档模块 ${definition.id} 缺少创建或运行时接口`);
    if (definition.canvasLink && (definition.canvasLink.nodeKind !== "document" && definition.canvasLink.nodeKind !== "canvas" ||
        !Number.isFinite(definition.canvasLink.width) || !Number.isFinite(definition.canvasLink.height) ||
        definition.canvasLink.width <= 0 || definition.canvasLink.height <= 0))
      throw new Error(`文档模块 ${definition.id} 的 Canvas 节点尺寸无效`);
  });
}

export type BlockCapability = "reference" | "date" | "location" | "search";
export type ReadingBlockRole = "book" | "bookmark" | "highlight" | "note" | "attachment";
export type DatabaseBlockRole = "table" | "query";
export type LocationEntry = { documentId: string; blockId: string; locationId: string; label: string };
export type SearchEntry = { documentId: string; blockId: string; text: string };
export type ReferenceRowContentServices = {
  source: Block;
  content: BlockContent;
  properties: BlockProperties;
  state: EditorState;
  mode: "rich" | "source" | "preview";
  editable: HTMLElement;
  renderReadingAnnotation(block: Block, content: BlockContent): HTMLElement;
  databaseDeclaration(block: Block): string;
  markdownHtml(source: string, links?: readonly NonNullable<BlockContent["links"]>[number][]): string;
  renderLinkedHtml(html: string): string;
};
export type ReferenceRowRenderer = (services: ReferenceRowContentServices) => { projected: boolean };
export type BlockDefinition = {
  id: string;
  create(options: { id: string; parentId?: string | null; position?: string; content?: Partial<BlockContent>; properties?: BlockProperties }): Block;
  label(block: Block): string;
  typeLabel?: string;
  icon?: (block: Block) => string;
  /** Short label used by shared block affordances such as comments and history. */
  commentSummary?: (block: Block, state?: EditorState) => string;
  /** Optional compact preview used by the Canvas for non-text block types. */
  canvasPreview?: (block: Block, state: EditorState) => HTMLElement;
  /** Optional preview used when a linked document is shown inside a Canvas node. */
  canvasDocumentPreview?: (block: Block, state: EditorState) => HTMLElement;
  /** Optional block-specific controls added around the Canvas text editor. */
  canvasDecorate?: (body: HTMLElement, block: Block, services: {
    syncPreview(): void;
    scheduleSave(delay?: number): void;
    renderChildren?(): void;
  }) => void;
  /** Text editing behavior specific to a block type on the Canvas. */
  canvasTextBehavior?: (context: {
    block: Block;
    nodeId: string;
    parentId: string;
    textarea: HTMLTextAreaElement;
    commit(): void;
    splitLines(parentId: string, afterId: string, textarea: HTMLTextAreaElement, commit: () => void): boolean;
    splitAtCaret(parentId: string, afterId: string, textarea: HTMLTextAreaElement, commit: () => void): void;
  }) => { onChange(): boolean; onEnter(): void };
  /** Text value used when a block is edited inside a Canvas heading card. */
  canvasTextValue?: (block: Block) => string;
  /** Whether a read-only Canvas projection may be edited as a local override. */
  canvasReferenceEditable?: boolean;
  /** Initial geometry and properties for a newly created Canvas block node. */
  canvasNodeDefaults?: { width: number; height: number; properties?: BlockProperties };
  /** Optional role when this block is attached to a Reading Note document. */
  readingRole?: ReadingBlockRole;
  readingAnnotationLabel?: "书签" | "高亮" | "注释";
  /** Marks a block as a Dashboard widget host. */
  dashboardRole?: "widget";
  /** Identifies the database block presentation without exposing its type ID. */
  databaseRole?: DatabaseBlockRole;
  /** An independent block that owns a reference instance and is removed with it. */
  referenceInstanceHost?: boolean;
  /** Marks a block as the root of a Canvas heading card. */
  canvasHeadingCard?: boolean;
  /** Structural role consumed by shared block-tree normalization. */
  headingRole?: boolean;
  /** Optional prefix used when projecting a block without explicit Markdown markers. */
  projectionPrefix?: (block: Block) => string;
  bodyText?: (block: Block) => string;
  sourcePrefix?: (block: Block) => string;
  preview(block: Block, state: EditorState, renderText: (block: Block) => HTMLElement): HTMLElement;
  /** Optional renderer for a block's projected body inside a reference card. */
  referenceRow?: ReferenceRowRenderer;
  /** Optional extra class for a block's editable surface in a reference row. */
  referenceRowClass?: (block: Block) => string;
  suggestion(block: Block, state: EditorState, renderText: (block: Block) => string,
    resolveLinks: (root: ParentNode, links: readonly NonNullable<BlockContent["links"]>[number][]) => void): string;
  locate(block: Block, documentId: string): { documentId: string; blockId: string };
  readSnapshot: BlockSnapshotReader;
  editor: BlockEditorAdapter;
  capabilities: readonly BlockCapability[];
  extract?: {
    date?: (block: Block, state: EditorState) => CalendarTodo[];
    location?: (block: Block, state: EditorState) => LocationEntry[];
    search?: (block: Block, state: EditorState) => SearchEntry[];
  };
};

export function createBlockRegistry() {
  return createModuleRegistry<BlockDefinition>("块类型", definition => {
    if (!definition.create || !definition.label || !definition.preview || !definition.suggestion || !definition.locate ||
        !definition.readSnapshot || !definition.editor?.mount)
      throw new Error(`块类型 ${definition.id} 缺少基础引用或编辑能力`);
    for (const capability of definition.capabilities)
      if (capability !== "reference" && !definition.extract?.[capability])
        throw new Error(`块类型 ${definition.id} 声明 ${capability} 却没有提取器`);
    if ((definition.readingRole === "bookmark" || definition.readingRole === "highlight" || definition.readingRole === "note") &&
        !definition.readingAnnotationLabel)
      throw new Error(`块类型 ${definition.id} 缺少阅读标注名称`);
  });
}

export type PanelHandle = { update(context: PanelContext | null): void; activate?(): void; dispose(): void };
export type PanelDefinition = {
  id: string;
  label: string;
  icon: string;
  order: number;
  initialTab?: boolean;
  fallbackTab?: boolean;
  /** Optional DOM slot ID; defaults to the panel ID. */
  slotId?: string;
  /** Selection capability published by a document surface for contextual panels. */
  selectionCapability?: string;
  /** Restore the previously active tab when this contextual panel is deselected. */
  restorePreviousTab?: boolean;
  available(context: PanelContext | null): boolean;
  mount(slot: HTMLElement): PanelHandle;
};

export function createPanelRegistry() {
  const registry = createModuleRegistry<PanelDefinition>("右栏面板", definition => {
    if (!definition.label.trim() || !definition.mount || !definition.available)
      throw new Error(`右栏面板 ${definition.id} 缺少生命周期或名称`);
    if (definition.restorePreviousTab && !definition.selectionCapability)
      throw new Error(`右栏面板 ${definition.id} 缺少选中能力`);
    if (definition.fallbackTab && !definition.available(null))
      throw new Error(`右栏回退面板 ${definition.id} 必须在空上下文可用`);
  });
  return {
    ...registry,
    register(definition: PanelDefinition) {
      if (definition.initialTab && registry.entries().some(panel => panel.initialTab))
        throw new Error(`右栏初始面板已注册：${definition.id}`);
      if (definition.fallbackTab && registry.entries().some(panel => panel.fallbackTab))
        throw new Error(`右栏回退面板已注册：${definition.id}`);
      registry.register(definition);
    }
  };
}
