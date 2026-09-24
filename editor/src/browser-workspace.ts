import type { BrowserMockHost } from "./browser-mock-host";
import type { WorkspaceApi, WorkspaceCommand } from "./workspace-api";

/** Browser adapter only. A native workspace adapter must implement the same interface. */
export function createBrowserWorkspace(store: BrowserMockHost, session: {
  flush(): Promise<void>;
  reloadCurrent(): Promise<void>;
}): WorkspaceApi {
  let tail = Promise.resolve();
  function apply(command: WorkspaceCommand) {
    switch (command.type) {
      case "selectNotebook": store.setActiveNotebook(command.id); break;
      case "openNotebook": store.openNotebook(command.id); break;
      case "closeNotebook": store.closeNotebook(command.id); break;
      case "removeNotebook": store.removeNotebook(command.id); break;
      case "selectBookmark": store.setActiveBookmark(command.id); break;
      case "removeBookmark": store.removeBookmark(command.id); break;
      case "removeDocument": store.removeDocument(command.id); break;
      case "renameNotebook": store.renameNotebook(command.id, command.name); break;
      case "renameBookmark": store.renameBookmark(command.id, command.name); break;
      case "renameDocument": store.renameDocument(command.id, command.name); break;
      case "createNotebook": store.notebooksPush(command.notebook); store.openNotebook(command.notebook.id); break;
      case "createBookmark": store.bookmarksPush(command.bookmark); break;
      case "createDocument": store.createDocument(command.document.title, command.document.id, command.bookmarkId, command.parentId ?? null); break;
      case "createCanvas": store.createCanvas(command.canvas.title, command.canvas.id, command.bookmarkId, command.parentId ?? null); break;
      case "createDashboard": store.createDashboard(command.dashboard.title, command.dashboard.id, command.bookmarkId, command.parentId ?? null); break;
      case "moveDocument": store.moveDocument(command.id, command.bookmarkId, command.parentId, command.index); break;
      case "transferBlock": store.transferBlock(command.sourceDocumentId, command.targetDocumentId, command.blockId, command.mode); break;
      case "moveBookmark": store.moveBookmark(command.id, command.index); break;
      case "recolorBookmark": store.recolorBookmark(command.id, command.color); break;
      case "saveCanvas": store.saveCanvas(command.canvasId, command.nodes, command.viewport, command.mutationId, command.expectedVersion); break;
      case "undoCanvas": store.moveCanvasHistory(command.canvasId, "undo", command.expectedVersion); break;
      case "redoCanvas": store.moveCanvasHistory(command.canvasId, "redo", command.expectedVersion); break;
      case "restoreCanvas": store.restoreCanvasHistory(command.canvasId, command.entryId, command.expectedVersion); break;
    }
  }
  return {
    snapshot: () => structuredClone(store.shellSnapshot()),
    documentTitle: id => store.getDocumentTitle(id),
    outline: () => structuredClone(store.docs.get(store.current)?.blocks ?? []),
    search: (query, limit) => store.searchDocuments(query, limit),
    todoDates: () => store.todoDates(),
    canvas: id => store.canvas(id),
    canLinkCanvas: (sourceCanvasId, targetCanvasId) => store.canLinkCanvas(sourceCanvasId, targetCanvasId),
    execute(command) {
      const task = tail.catch(() => undefined).then(async () => {
        await session.flush();
        apply(command);
        if (command.type === "renameDocument" || command.type === "removeDocument" || command.type === "transferBlock") await session.reloadCurrent();
      });
      tail = task;
      return task;
    }
  };
}
