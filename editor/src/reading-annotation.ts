import type { Block, BlockType, EditorState, ReadingAnchor } from "../../protocol/types";
import { blockModules } from "./block-modules";

export type ReadingAnnotationType = "reading_bookmark" | "reading_highlight" | "reading_note";

export function isReadingAnnotationType(type: BlockType | string): type is ReadingAnnotationType {
  const role = blockModules.get(type)?.readingRole;
  return role === "bookmark" || role === "highlight" || role === "note";
}

export function isReadingAnnotation(block: Pick<Block, "type">): boolean {
  return isReadingAnnotationType(block.type);
}

export function readingAnnotationKind(type: ReadingAnnotationType | Block): "书签" | "高亮" | "注释" {
  const value = typeof type === "string" ? type : type.type;
  const label = blockModules.require(value).readingAnnotationLabel;
  if (!label) throw new Error(`块类型 ${value} 缺少阅读标注名称`);
  return label;
}

export function readingAnnotationMeta(block: Pick<Block, "type" | "properties">) {
  return `${readingAnnotationKind(block as Block)} · 第 ${block.properties.readingAnchor?.page ?? 1} 页`;
}

export function readingInspectorTab(type: ReadingAnnotationType): "bookmark" | "highlight" | "note" {
  const role = blockModules.require(type).readingRole;
  if (role === "bookmark" || role === "highlight" || role === "note") return role;
  throw new Error(`块类型 ${type} 不是阅读标注`);
}

export function hasReadingMark(type: BlockType | string, anchor?: ReadingAnchor): boolean {
  const role = blockModules.get(type)?.readingRole;
  return role === "highlight" || (role === "note" && Boolean(anchor?.rects?.length));
}

export function isReadingNote(type: BlockType | string): boolean {
  return blockModules.get(type)?.readingRole === "note";
}

export function readingInspectorMatches(block: Block, tab: "bookmark" | "highlight" | "note") {
  const role = blockModules.require(block.type).readingRole;
  return role === tab || tab === "note" && role === "attachment";
}

export function readingInspectorField(block: Block, state?: EditorState) {
  const role = blockModules.require(block.type).readingRole;
  if (role === "attachment") {
    return {
      element: "p" as const,
      text: "📍 " + (state?.locations?.find(item => item.id === block.properties.locationId)?.name ?? block.content.text),
      editable: false,
      ariaLabel: "位置内容",
      showPreview: false
    };
  }
  const editable = role === "note" || role === "bookmark";
  return {
    element: editable ? "textarea" as const : "p" as const,
    text: block.content.text,
    editable,
    ariaLabel: role === "note" ? "注释内容" : "书签标题",
    showPreview: role === "note"
  };
}
