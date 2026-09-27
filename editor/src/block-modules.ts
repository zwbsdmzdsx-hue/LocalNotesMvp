import type { Block, BlockType, EditorState } from "../../protocol/types";
import { createBlock as createCanonicalBlock, todayIsoDate } from "./document-model";
import { markdownFromContent, plainTextFromContent, renderMarkdown } from "./markdown";
import { createBlockRegistry, type BlockCapability, type BlockDefinition, type DatabaseBlockRole, type ReadingBlockRole } from "./module-registry";
import { previewLocation, previewMedia, previewReadingAnnotation, renderDatabaseTablePreview } from "./block-preview";
import { readStaticBlockSnapshot } from "./block-snapshot";
import type { BlockSnapshotReader } from "./block-snapshot";
import { readTextBlockSnapshot } from "./text-block-editor";
import { headingBodyText, headingCanvasDecorate, headingCanvasTextBehavior, headingSourcePrefix, readHeadingBlockSnapshot } from "./heading-block-editor";
import { attachCanvasTodoControls, readTodoBlockSnapshot, todoBodyMarkdown, todoSourcePrefix } from "./todo-block-editor";
import { readLocationBlockSnapshot } from "./location-block-editor";
import { renderCanvasDocumentMedia, renderCanvasLocation, renderCanvasMedia } from "./canvas-block-preview";
import { renderDatabaseReferenceRow, renderLocationReferenceRow, renderReadingAnnotationReferenceRow } from "./reference-row-content";
import { textBlockEditor, headingBlockEditor, todoBlockEditor, mediaBlockEditor, locationBlockEditor, databaseBlockEditor, referenceBlockEditor } from "./block-editor";
import type { BlockEditorAdapter } from "./block-editor";

export const blockModules = createBlockRegistry();

type BlockSpec = {
  id: BlockType;
  label?: (block: Block) => string;
  typeLabel?: string;
  icon?: string | ((block: Block) => string);
  commentSummary?: BlockDefinition["commentSummary"];
  canvasPreview?: BlockDefinition["canvasPreview"];
  canvasDocumentPreview?: BlockDefinition["canvasDocumentPreview"];
  canvasDecorate?: BlockDefinition["canvasDecorate"];
  canvasTextBehavior?: BlockDefinition["canvasTextBehavior"];
  canvasTextValue?: BlockDefinition["canvasTextValue"];
  canvasReferenceEditable?: boolean;
  canvasNodeDefaults?: BlockDefinition["canvasNodeDefaults"];
  readingRole?: ReadingBlockRole;
  readingAnnotationLabel?: BlockDefinition["readingAnnotationLabel"];
  databaseRole?: DatabaseBlockRole;
  referenceInstanceHost?: boolean;
  dashboardRole?: BlockDefinition["dashboardRole"];
  canvasHeadingCard?: boolean;
  headingRole?: boolean;
  projectionPrefix?: BlockDefinition["projectionPrefix"];
  bodyText?: (block: Block) => string;
  sourcePrefix?: (block: Block) => string;
  configure?: (block: Block) => void;
  preview?: (block: Block, state: EditorState) => HTMLElement;
  referenceRow?: BlockDefinition["referenceRow"];
  referenceRowClass?: BlockDefinition["referenceRowClass"];
  suggestion?: BlockDefinition["suggestion"];
  readSnapshot?: BlockSnapshotReader;
  editor?: BlockEditorAdapter;
  capabilities?: readonly BlockCapability[];
  extract?: BlockDefinition["extract"];
};

function readingLabel(block: Block, kind: string) {
  const text = (block.content.text ?? "").trim();
  return text || `第 ${block.properties.readingAnchor?.page ?? 1} 页${kind}`;
}

function fallbackLabel(block: Block) {
  const text = plainTextFromContent(block.content).trim();
  if (text) return text;
  return "未命名块";
}

function escapeLabel(value: string) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

const specs: BlockSpec[] = [
  { id: "paragraph", typeLabel: "正文块", icon: "≡", canvasReferenceEditable: true },
  { id: "heading", typeLabel: "标题块", icon: "H", referenceRowClass: () => "heading", canvasHeadingCard: true, headingRole: true, projectionPrefix: headingSourcePrefix, bodyText: headingBodyText, sourcePrefix: headingSourcePrefix,
    canvasTextValue: block => `${"#".repeat(Math.max(1, (block.properties.headingLevel ?? 2) - 1))} ${headingBodyText(block)}`,
    canvasReferenceEditable: true, canvasTextBehavior: headingCanvasTextBehavior, canvasDecorate: headingCanvasDecorate,
    canvasNodeDefaults: { width: 300, height: 125, properties: { headingLevel: 1 } },
    configure: block => { block.properties.headingLevel = 1; }, readSnapshot: readHeadingBlockSnapshot, editor: headingBlockEditor },
  { id: "todo", typeLabel: "待办块", icon: "☑", configure: block => {
      if (block.content.checked === undefined) block.content.checked = false;
      if (!block.properties.todoCreatedAt) block.properties.todoCreatedAt = todayIsoDate();
    }, bodyText: block => todoBodyMarkdown(block.content), sourcePrefix: todoSourcePrefix,
    canvasReferenceEditable: true, canvasDecorate: attachCanvasTodoControls, readSnapshot: readTodoBlockSnapshot, editor: todoBlockEditor, capabilities: ["date"], extract: { date: (block: Block, state: EditorState) => {
    const { todoCreatedAt: createdAt, todoDueAt: dueAt, todoCompletedAt: completedAt } = block.properties;
    if (!createdAt && !dueAt && !completedAt) return [];
    return [{ documentId: state.note.id, blockId: block.id, createdAt, dueAt, completedAt,
      checked: block.content.checked === true,
      text: (block.content.text || block.content.markdown || "").replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, "").trim() }];
  } } },
  { id: "reference", typeLabel: "引用块", icon: "↗", referenceInstanceHost: true, readSnapshot: readStaticBlockSnapshot, editor: referenceBlockEditor },
  { id: "media", typeLabel: "媒体块", icon: "▧", label: block => block.content.media?.name || "媒体", commentSummary: block => block.content.media?.name || "媒体块", canvasPreview: renderCanvasMedia, canvasDocumentPreview: renderCanvasDocumentMedia, preview: previewMedia, readSnapshot: readStaticBlockSnapshot, editor: mediaBlockEditor },
  { id: "location", typeLabel: "位置块", icon: "⌖", label: () => "位置", preview: previewLocation, referenceRow: renderLocationReferenceRow, readingRole: "attachment", readSnapshot: readLocationBlockSnapshot, editor: locationBlockEditor,
    commentSummary: (block, state) => state?.locations?.find(location => location.id === block.properties.locationId)?.name || "位置块",
    canvasPreview: renderCanvasLocation,
    capabilities: ["location"], extract: { location: (block: Block, state: EditorState) => block.properties.locationId
      ? [{ documentId: state.note.id, blockId: block.id, locationId: block.properties.locationId,
        label: block.properties.locationLabelOverride || "位置" }] : [] } },
  { id: "database_table", typeLabel: "数据表块", icon: "▦", databaseRole: "table", label: () => "数据库表", commentSummary: () => "数据库表", referenceRow: services => renderDatabaseReferenceRow(services, services.databaseDeclaration(services.source)), preview: (block, state) => renderDatabaseTablePreview(block, {}, state), suggestion: (block, state, renderText, resolveLinks) => {
    const preview = renderDatabaseTablePreview(block, {}, state); resolveLinks(preview, block.content.links ?? []); return preview.outerHTML;
  }, readSnapshot: readStaticBlockSnapshot, editor: databaseBlockEditor },
  { id: "data_view", typeLabel: "查询块", icon: "⌕", databaseRole: "query", label: () => "查询视图", commentSummary: () => "DQL 查询", referenceRow: services => renderDatabaseReferenceRow(services, services.source.properties.dataQuery ?? "FROM current"), preview: (block, state) => renderDatabaseTablePreview(block, {}, state), suggestion: (block, state, renderText, resolveLinks) => {
    const preview = renderDatabaseTablePreview(block, {}, state); resolveLinks(preview, block.content.links ?? []); return preview.outerHTML;
  }, readSnapshot: readStaticBlockSnapshot, editor: databaseBlockEditor },
  { id: "dashboard_widget", typeLabel: "Dashboard 组件", icon: "▦", label: block => block.properties.dashboardWidget?.title || "Dashboard 组件", dashboardRole: "widget", commentSummary: block => block.properties.dashboardWidget?.title || "Dashboard 组件", suggestion: block => escapeLabel(block.properties.dashboardWidget?.title || "Dashboard 组件") },
  { id: "reading_book", typeLabel: "读物块", icon: "▧", label: block => block.content.text || block.content.media?.name || "PDF", readingRole: "book", commentSummary: block => block.content.media?.name || "读物", preview: previewMedia },
  { id: "reading_bookmark", typeLabel: "书签块", icon: "⚑", label: block => readingLabel(block, "书签"), readingRole: "bookmark", readingAnnotationLabel: "书签", referenceRow: renderReadingAnnotationReferenceRow },
  { id: "reading_highlight", typeLabel: "高亮块", icon: "▰", label: block => readingLabel(block, "高亮"), readingRole: "highlight", readingAnnotationLabel: "高亮", referenceRow: renderReadingAnnotationReferenceRow },
  { id: "reading_note", typeLabel: "阅读笔记块", icon: "✎", label: block => readingLabel(block, "阅读笔记"), readingRole: "note", readingAnnotationLabel: "注释", referenceRow: renderReadingAnnotationReferenceRow }
];

for (const spec of specs) {
  const type = spec.id;
  const iconValue = spec.icon as string | undefined;
  const icon: (block: Block) => string = typeof spec.icon === "function"
    ? spec.icon
    : (_block: Block) => iconValue ?? "≡";
  const capabilities: BlockCapability[] = ["reference", "search", ...(spec.capabilities ?? [])];
  blockModules.register({
    id: type,
    create: options => {
      const block = createCanonicalBlock({ ...options, type });
      spec.configure?.(block);
      return block;
    },
    label: spec.label ?? fallbackLabel,
    typeLabel: spec.typeLabel,
    icon,
    commentSummary: spec.commentSummary,
    canvasPreview: spec.canvasPreview,
    canvasDocumentPreview: spec.canvasDocumentPreview,
    canvasDecorate: spec.canvasDecorate,
    canvasTextBehavior: spec.canvasTextBehavior,
    canvasTextValue: spec.canvasTextValue,
    canvasReferenceEditable: spec.canvasReferenceEditable,
    canvasNodeDefaults: spec.canvasNodeDefaults,
    readingRole: spec.readingRole,
    readingAnnotationLabel: spec.readingAnnotationLabel,
    databaseRole: spec.databaseRole,
    referenceInstanceHost: spec.referenceInstanceHost,
    dashboardRole: spec.dashboardRole,
    canvasHeadingCard: spec.canvasHeadingCard,
    headingRole: spec.headingRole,
    projectionPrefix: spec.projectionPrefix,
    bodyText: spec.bodyText ?? (block => block.content.markdown ?? block.content.text ?? ""),
    sourcePrefix: spec.sourcePrefix ?? (() => ""),
    preview: (block, state, renderText) => spec.readingAnnotationLabel
      ? previewReadingAnnotation(block, spec.readingAnnotationLabel) : spec.preview?.(block, state) ?? renderText(block),
    referenceRow: spec.referenceRow,
    referenceRowClass: spec.referenceRowClass,
    suggestion: (block, state, renderText, resolveLinks) => {
      if (spec.readingAnnotationLabel) {
        const preview = previewReadingAnnotation(block, spec.readingAnnotationLabel);
        resolveLinks(preview, block.content.links ?? []);
        return preview.outerHTML;
      }
      if (spec.suggestion) return spec.suggestion(block, state, renderText, resolveLinks);
      return renderText(block);
    },
    locate: (block, documentId) => ({ documentId, blockId: block.id }),
    readSnapshot: spec.readSnapshot ?? readTextBlockSnapshot,
    editor: spec.editor ?? textBlockEditor,
    capabilities,
    extract: {
      search: (block, state) => [{ documentId: state.note.id, blockId: block.id, text: spec.label?.(block) ?? fallbackLabel(block) }],
      ...spec.extract
    }
  });
}

export function createRegisteredBlock(options: Parameters<typeof createCanonicalBlock>[0]) {
  return blockModules.require(options.type ?? "paragraph").create(options);
}

export function blockBodyText(block: Block) {
  return blockModules.require(block.type).bodyText?.(block) ?? block.content.markdown ?? block.content.text ?? "";
}

export function blockSourcePrefix(block: Block) {
  return blockModules.require(block.type).sourcePrefix?.(block) ?? "";
}

export function readingBlockRole(block: Pick<Block, "type">): ReadingBlockRole | undefined {
  return blockModules.require(block.type).readingRole;
}

export function isDashboardWidgetBlock(block: Pick<Block, "type">) {
  return blockModules.require(block.type).dashboardRole === "widget";
}

export function databaseBlockRole(block: Pick<Block, "type">): DatabaseBlockRole | undefined {
  return blockModules.require(block.type).databaseRole;
}

export function isReferenceInstanceHost(block: Pick<Block, "type">) {
  return blockModules.require(block.type).referenceInstanceHost === true;
}

/** Render the compact suggestion preview through the registered block definition. */
export function blockSuggestionPreview(block: Block, state: EditorState) {
  const definition = blockModules.require(block.type);
  return definition.suggestion(block, state,
    candidate => renderMarkdown(markdownFromContent(candidate.content)) || renderMarkdown(definition.label(candidate)),
    () => undefined);
}
