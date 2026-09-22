import type { Block } from "../../protocol/types";

export type Notebook = { id: string; name: string };
export type Bookmark = { id: string; notebookId: string; name: string; color: string };
export type WorkspaceDocument = { id: string; title: string; bookmarkId: string; parentId: string | null; position: number };
export type WorkspaceSnapshot = {
  notebooks: Notebook[]; bookmarks: Bookmark[]; openNotebookIds: string[];
  activeNotebookId: string; activeBookmarkId: string; documentIds: string[]; documents: WorkspaceDocument[];
};
export type SearchHit = {
  kind: "title" | "block"; documentId: string; documentTitle: string; blockId: string | null; excerpt: string;
};
export type CalendarTodo = { documentId: string; blockId: string; createdAt?: string; dueAt?: string };
export type WorkspaceCommand =
  | { type: "selectNotebook" | "openNotebook" | "closeNotebook" | "removeNotebook" | "selectBookmark" | "removeBookmark" | "removeDocument"; id: string }
  | { type: "renameNotebook" | "renameBookmark" | "renameDocument"; id: string; name: string }
  | { type: "createNotebook"; notebook: Notebook }
  | { type: "createBookmark"; bookmark: Bookmark }
  | { type: "createDocument"; document: { id: string; title: string }; bookmarkId: string; parentId?: string | null }
  | { type: "moveDocument"; id: string; bookmarkId: string; parentId: string | null; index: number }
  | { type: "moveBookmark"; id: string; index: number }
  | { type: "recolorBookmark"; id: string; color: string };

/** Read models and acknowledged commands; no transport or editor DOM exposed to the shell. */
export interface WorkspaceApi {
  snapshot(): WorkspaceSnapshot;
  documentTitle(id: string): string;
  outline(): Block[];
  search(query: string, limit?: number): SearchHit[];
  todoDates(): CalendarTodo[];
  execute(command: WorkspaceCommand): Promise<void>;
}
