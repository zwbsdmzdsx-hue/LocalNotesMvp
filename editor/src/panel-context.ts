import type { Backlink, Block, EditorState } from "../../protocol/types";
import type { CalendarTodo } from "./workspace-api";
import { blockModules } from "./block-modules";

export type SurfaceKind = "document" | "canvas" | "dashboard";

/** State contract shared by the document editor, Canvas, Dashboard, and right-side panels. */
export type PanelContext = {
  surface: SurfaceKind;
  state: EditorState;
  /** Source state used by a Dashboard widget or by a Dashboard-hosted right panel. */
  sourceState?: EditorState;
  /** Selection capabilities published by a surface. Panels decide whether they need them. */
  capabilities?: Readonly<Record<string, boolean>>;
};

export function panelDataState(context: PanelContext): EditorState {
  return context.surface === "dashboard" ? context.sourceState ?? context.state : context.state;
}

export function calendarTodosFromState(state: EditorState): CalendarTodo[] {
  const todos: CalendarTodo[] = [];
  for (const block of state.blocks) {
    todos.push(...(blockModules.require(block.type).extract?.date?.(block, state) ?? []));
  }
  return todos;
}

export function todoText(block: Block): string {
  return (block.content.text || block.content.markdown || "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, "")
    .trim();
}

export function mergeSurfaceTodos(workspaceTodos: CalendarTodo[], context?: PanelContext): CalendarTodo[] {
  if (!context) return workspaceTodos;
  const source = calendarTodosFromState(panelDataState(context));
  const byKey = new Map(workspaceTodos.map(todo => [`${todo.documentId}:${todo.blockId}`, todo]));
  source.forEach(todo => byKey.set(`${todo.documentId}:${todo.blockId}`, todo));
  return [...byKey.values()];
}

export function ordinaryReferenceEntries(state: EditorState) {
  const liveKeys = new Set(state.references.filter(reference => reference.mode !== "link")
    .map(reference => `${reference.hostBlockId}:${reference.targetDocumentId}:${reference.targetBlockId ?? ""}:${reference.targetRecordId ?? ""}:${reference.targetFieldKey ?? ""}`));
  return state.blocks.flatMap(block => (block.content.links ?? [])
    .filter(link => !!link.targetDocumentId)
    .map((link, index) => ({
      key: `${block.id}:${link.targetDocumentId}:${link.targetBlockId ?? ""}:${link.start}:${index}`,
      sourceBlockId: block.id,
      documentId: link.targetDocumentId!,
      blockId: link.targetBlockId,
      targetRecordId: link.targetRecordId,
      targetFieldKey: link.targetFieldKey,
      targetScope: link.targetScope,
      label: state.documents.find(document => document.id === link.targetDocumentId)?.title ?? link.targetText,
      excerpt: block.content.text
    })))
    .filter(link => !liveKeys.has(`${link.sourceBlockId}:${link.documentId}:${link.blockId ?? ""}:${link.targetRecordId ?? ""}:${link.targetFieldKey ?? ""}`));
}

export function backlinkEntries(state: EditorState, targetBlockId?: string | null): Backlink[] {
  return targetBlockId ? state.backlinks.filter(link => link.targetBlockId === targetBlockId) : state.backlinks;
}

export function annotatedBlocks(state: EditorState): Block[] {
  return state.blocks.filter(block => !!block.properties.comments?.length);
}
