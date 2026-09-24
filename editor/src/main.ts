import { mountEditor } from "./core";
import { EditorHostApi } from "./editor-host-api";
import { BrowserMockHost } from "./browser-mock-host";
import { mountShell } from "./shell";
import { createBrowserWorkspace } from "./browser-workspace";
import { mountCanvasManager, type CanvasManager } from "./canvas-manager";
import { mountDashboardManager, type DashboardManager } from "./dashboard-manager";
import "./style.css";

const transport = new BrowserMockHost();
const host = new EditorHostApi(transport);
let canvasManager: CanvasManager;
let dashboardManager: DashboardManager;
let lastSurfaceState: import("../../protocol/types").EditorState | null = null;

function workspaceKind(id: string) {
  return workspace.snapshot().documents.find(item => item.id === id)?.kind;
}

const workspace = createBrowserWorkspace(transport, {
  flush: () => editor.flush(),
  reloadCurrent: async () => {
    if (transport.current) {
      const state = await host.loadDocument(transport.current);
      if (dashboardManager?.isOpen()) dashboardManager.applyState(state);
      else if (canvasManager?.isOpen() && canvasManager.activeId() === transport.current) editor.loadCanvas(state);
      else editor.load(state);
    }
    else editor.clear();
  }
});
const shell = mountShell(workspace, {
  onFocusBlock: id => editor.focusBlock(id),
  onError: error => editor.showError(error),
  onRestoreHistory: entryId => void (canvasManager?.isOpen() ? canvasManager.restoreHistory(entryId) : editor.restoreHistory(entryId)),
  onOpenDocument: (id, blockId) => {
    void dashboardManager.flush().then(() => canvasManager.flush()).then(() => editor.flush()).then(() => host.openDocument(id, blockId)).catch(editor.showError);
  },
  onOpenCanvas: id => {
    void dashboardManager.flush().then(() => canvasManager.flush()).then(() => editor.flush()).then(() => host.openDocument(id)).catch(editor.showError);
  },
  onOpenDashboard: id => {
    void dashboardManager.flush().then(() => canvasManager.flush()).then(() => editor.flush()).then(() => host.openDocument(id)).catch(editor.showError);
  },
  onNavigateBack: () => {
    void dashboardManager.flush().then(() => canvasManager.flush()).then(() => editor.flush()).then(() => host.navigateBack()).catch(editor.showError);
  },
  onNavigateForward: () => {
    void dashboardManager.flush().then(() => canvasManager.flush()).then(() => editor.flush()).then(() => host.navigateForward()).catch(editor.showError);
  },
  onOpenSticky: () => {
    alert("便签窗口：浏览器模式下是占位提示。桌面端请从主窗口新建便签。");
  },
  onCreateNote: () => {
    void editor.flush().then(async () => {
      const id = transport.createDocument("新建笔记 " + new Date().toLocaleTimeString());
      await host.openDocument(id);
      shell.highlightActiveDocument(id);
    }).catch(editor.showError);
  },
  onLoadDocumentPreview: documentId => host.loadDocument(documentId),
  onCreateDiary: (documentId, heading) => editor.createDiaryDocument(documentId, heading),
  onInsertDiaryLink: (documentId, blockId, scope, label) => editor.insertCalendarLink(documentId, blockId, scope, label)
});

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

const editor = mountEditor(host, {
  showReferences: () => shell.showReferences(),
  showLocations: () => shell.showLocations(),
  showHistory: () => shell.showHistory(),
  setDatabaseContext: (visible, activate) => shell.setDatabaseContext(visible, activate),
  updateHistory: model => shell.updateHistory(model),
  canvasUndo: () => void canvasManager?.undo(),
  canvasRedo: () => void canvasManager?.redo(),
  canvasStateChanged: (state, persist) => canvasManager?.applyEditorState(state, persist),
  canvasInsertCalendarLink: (documentId, blockId, scope, label) => canvasManager?.insertCalendarLink(documentId, blockId, scope, label) ?? false,
  canvasInsertLocationBlock: locationId => canvasManager?.insertLocationBlock(locationId) ?? false,
  surfaceStateChanged: (state, surface) => {
    // core also listens to documentLoaded for desktop compatibility. In the
    // browser entrypoint the main router owns Dashboard/Canvas switching, so a
    // transient render of a Dashboard document must never replace the last
    // content source used by its widgets and right-side panels.
    const kind = workspaceKind(state.note.id);
    if (kind !== "dashboard") {
      lastSurfaceState = structuredClone(state);
      shell.setPanelContext({ surface, state: structuredClone(state) });
      dashboardManager?.setSourceState(state);
    } else {
      shell.setPanelContext({ surface: "dashboard", state: structuredClone(state), sourceState: lastSurfaceState ? structuredClone(lastSurfaceState) : undefined });
    }
  }
});
canvasManager = mountCanvasManager(workspace, {
  onOpenDocument: (id, blockId) => {
    void canvasManager.flush().then(() => editor.flush()).then(() => host.openDocument(id, blockId)).catch(editor.showError);
  },
  onOpenCanvas: id => { void canvasManager.flush().then(() => editor.flush()).then(() => host.openDocument(id)).catch(editor.showError); },
  onError: editor.showError,
  onWorkspaceChanged: () => shell.refresh(),
  onLoadDocumentPreview: documentId => host.loadDocument(documentId),
  executeCommand: (command, documentId) => host.executeCommand(command, documentId),
  renderProjection: (reference, context) => editor.readOnlyProjection(reference, context),
  contentFromMarkdown: (source, fallback) => editor.contentFromMarkdown(source, fallback),
  storeMedia: async file => host.storeMedia({ name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, data: await fileToBase64(file) }).then(result => result.media),
  onStateChanged: state => editor.loadCanvas(state),
  onHistoryChanged: model => shell.updateHistory(model),
  onActiveBlockChanged: block => editor.setCanvasActiveBlock(block)
});
dashboardManager = mountDashboardManager(host, workspace, {
  onOpenDocument: (id, blockId) => { void dashboardManager.flush().then(() => host.openDocument(id, blockId)).catch(editor.showError); },
  onError: editor.showError,
  onStateChanged: state => { if (dashboardManager.isOpen()) dashboardManager.applyState(state); }
});
host.onEvent(event => {
  if (event.kind === "documentChanged") {
    canvasManager.refreshReferences();
    dashboardManager?.refreshSources(event.payload.documentId);
    if (lastSurfaceState?.note.id === event.payload.documentId) {
      void host.loadDocument(event.payload.documentId).then(next => {
        lastSurfaceState = structuredClone(next);
        if (dashboardManager?.isOpen()) {
          editor.load(next);
          dashboardManager.setSourceState(next);
          shell.setPanelContext({ surface: "dashboard", state: structuredClone(next), sourceState: structuredClone(next) });
        }
      }).catch(editor.showError);
    }
  }
  if (event.kind === "documentLoaded") {
    const id = event.payload.state.note.id;
    if (workspaceKind(id) === "dashboard") {
      canvasManager.close();
      if (lastSurfaceState) editor.load(lastSurfaceState);
      else editor.clear();
      dashboardManager.open(event.payload.state, lastSurfaceState);
      if (lastSurfaceState) shell.setPanelContext({ surface: "dashboard", state: structuredClone(event.payload.state), sourceState: structuredClone(lastSurfaceState) });
    } else if (workspace.canvas(id)) {
      dashboardManager.close();
      editor.loadCanvas(event.payload.state);
      canvasManager.open(id);
    } else {
      dashboardManager.close();
      canvasManager.close();
      editor.load(event.payload.state);
    }
    shell.highlightActiveDocument(id);
  }
});
transport.subscribe(message => {
  if ("requestId" in message && message.ok && message.kind === "saveDocument") shell.refresh();
});

void host.loadDocument("alpha").then(state => editor.load(state)).then(() => {
  shell.highlightActiveDocument("alpha");
}).catch(editor.showError);

const bar = document.createElement("nav");
bar.className = "browser-devbar";
bar.innerHTML = '<strong>浏览器开发模式 · 仅内存数据，刷新即重置</strong><button id="dev-back" title="后退">←</button><button id="dev-forward" title="前进">→</button><button data-doc="alpha">Alpha</button><button data-doc="beta">Beta</button><button data-doc="gamma">Gamma</button><button id="dev-fail">模拟下次保存失败</button><button id="dev-retry">重试保存</button><button id="dev-reset-layout">重置布局</button>';
document.body.prepend(bar);
bar.querySelectorAll<HTMLButtonElement>("[data-doc]").forEach(b => b.onclick = () => void editor.flush().then(() => host.openDocument(b.dataset.doc!)).then(() => shell.highlightActiveDocument(b.dataset.doc!)).catch(editor.showError));
bar.querySelector<HTMLButtonElement>("#dev-back")!.onclick = () => void canvasManager.flush().then(() => editor.flush()).then(() => host.navigateBack()).catch(editor.showError);
bar.querySelector<HTMLButtonElement>("#dev-forward")!.onclick = () => void canvasManager.flush().then(() => editor.flush()).then(() => host.navigateForward()).catch(editor.showError);
bar.querySelector<HTMLButtonElement>("#dev-fail")!.onclick = () => transport.failNextSave = true;
bar.querySelector<HTMLButtonElement>("#dev-retry")!.onclick = () => editor.retry();
bar.querySelector<HTMLButtonElement>("#dev-reset-layout")!.onclick = () => { localStorage.removeItem("lnm-shell-layout-v1"); location.reload(); };
Object.assign(window, { mockHost: transport, shell, canvasManager });
