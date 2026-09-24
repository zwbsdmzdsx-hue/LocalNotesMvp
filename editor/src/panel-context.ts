import type { Block, EditorState } from "../../protocol/types";
import type { CalendarTodo } from "./workspace-api";

export type SurfaceKind = "document" | "canvas" | "dashboard";

/** State contract shared by the document editor, Canvas, Dashboard, and right-side panels. */
export type PanelContext = {
  surface: SurfaceKind;
  state: EditorState;
  /** Source state used by a Dashboard widget or by a Dashboard-hosted right panel. */
  sourceState?: EditorState;
};

export function panelDataState(context: PanelContext): EditorState {
  return context.surface === "dashboard" ? context.sourceState ?? context.state : context.state;
}

export function calendarTodosFromState(state: EditorState): CalendarTodo[] {
  const todos: CalendarTodo[] = [];
  for (const block of state.blocks) {
    if (block.type !== "todo") continue;
    const { todoCreatedAt: createdAt, todoDueAt: dueAt, todoCompletedAt: completedAt } = block.properties;
    if (!createdAt && !dueAt && !completedAt) continue;
    todos.push({
      documentId: state.note.id,
      blockId: block.id,
      createdAt,
      dueAt,
      completedAt,
      checked: block.content.checked === true,
      text: todoText(block)
    });
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
