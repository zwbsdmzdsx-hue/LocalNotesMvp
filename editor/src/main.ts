import { mountEditor } from "./core";
import { EditorHostApi } from "./editor-host-api";
import { BrowserMockHost } from "./browser-mock-host";
import { mountShell } from "./shell";
import { createBrowserWorkspace } from "./browser-workspace";
import { mountCanvasManager, type CanvasManager } from "./canvas-manager";
import { mountDashboardManager, type DashboardManager } from "./dashboard-manager";
import { mountReadingManager, type ReadingManager } from "./reading-manager";
import type { DashboardExternalWidget } from "./dashboard-extension";
import { fileToBase64 } from "./media-source";
import { createDocumentRegistry } from "./module-registry";
import { registerBuiltinDocumentModules } from "./builtin-document-modules";
import { createDocumentRouter } from "./document-router";
import { createSurfaceContextController } from "./surface-context-controller";
import { createBuiltinPanelPorts, createBuiltinPanelRegistry } from "./builtin-panels";
import "./style.css";

const transport = new BrowserMockHost();
const host = new EditorHostApi(transport);
let canvasManager: CanvasManager;
let dashboardManager: DashboardManager;
let readingManager: ReadingManager;
let editor: ReturnType<typeof mountEditor>;
let shell: ReturnType<typeof mountShell>;
let panelPorts: ReturnType<typeof createBuiltinPanelPorts>;
const documentModules = createDocumentRegistry();
const documentRouter = createDocumentRouter(documentModules);
const surfaceContext = createSurfaceContextController({
  module: id => documentModules.require(workspaceKind(id) ?? "document"),
  load: id => host.loadDocument(id),
  publish: context => shell.setPanelContext(context),
  readingId: () => readingManager?.activeId() ?? null,
  flushReading: () => readingManager.flush(),
  refreshReading: state => readingManager.refreshContext(state),
  refreshCanvas: () => canvasManager.refreshReferences(),
  refreshDashboard: id => dashboardManager.refreshSources(id),
  dashboardOpen: () => dashboardManager?.isOpen() ?? false,
  dashboardState: () => dashboardManager?.currentState() ?? null,
  applyEditor: state => editor.load(state),
  setDashboardSource: state => dashboardManager?.setSourceState(state),
  error: error => editor.showError(error)
});
registerBuiltinDocumentModules(documentModules, transport, {
  editor: () => editor,
  canvas: () => canvasManager,
  dashboard: () => dashboardManager,
  reading: () => readingManager,
  publishContext: (state, surface, source) => surfaceContext.changed(state, surface, source)
});

function workspaceKind(id: string) {
  return workspace.snapshot().documents.find(item => item.id === id)?.kind;
}

async function flushSurfaces() {
  if (documentRouter.kind()) await documentRouter.flush();
  else await editor.flush();
}

function navigate(action: () => Promise<unknown>) {
  void flushSurfaces().then(action).catch(editor.showError);
}

const workspace = createBrowserWorkspace(transport, {
  flush: async () => { await readingManager?.flush(); await editor.flush(); },
  reloadCurrent: async () => {
    if (transport.current) {
      const state = await host.loadDocument(transport.current);
      if (documentRouter.kind()) documentRouter.update(state);
      else editor.load(state);
    }
    else editor.clear();
  }
}, documentModules);
const openDocument = (id: string, blockId?: string) => {
  navigate(() => host.openDocument(id, blockId));
};
const panelRegistry = createBuiltinPanelRegistry({
  restoreHistory: entryId => void documentRouter.restoreHistory(entryId).catch(editor.showError),
  overrideNotice: action => editor.handleOverrideNoticeAction(action),
  openBacklink: openDocument,
  calendar: { workspace, callbacks: {
    onLoadDocumentPreview: documentId => host.loadDocument(documentId),
    onCreateDiary: (documentId, heading) => editor.createDiaryDocument(documentId, heading),
    onInsertDiaryLink: (documentId, blockId, scope, label) => editor.insertCalendarLink(documentId, blockId, scope, label),
    onOpenDocument: openDocument,
    onCreated: id => shell.highlightActiveDocument(id),
    onError: error => editor.showError(error)
  } },
  comments: {
    actions: {
      add: (blockId, content) => editor.addBlockComment(blockId, content),
      edit: (blockId, commentId, content) => editor.editBlockComment(blockId, commentId, content),
      delete: (blockId, commentId) => editor.deleteBlockComment(blockId, commentId)
    },
    focusBlock: blockId => editor.focusBlock(blockId)
  },
  styles: {
    apply: style => editor.applyStyleToSelection(style),
    save: (style, documentId) => editor.saveManagedStyle(style, documentId),
    delete: (styleId, scope, documentId) => editor.deleteManagedStyle(styleId, scope, documentId)
  },
  databases: {
    saveQuery: (blockId, query, documentId) => editor.saveDatabaseQuery(blockId, query, documentId),
    saveSchema: (databaseId, fields, title, documentId) => editor.saveDatabaseSchema(databaseId, fields, title, documentId),
    export: (databaseId, csv, documentId) => editor.exportDatabaseById(databaseId, csv, documentId)
  },
  locations: {
    execute: (command, label) => editor.executeLocationCommand(command, label),
    insert: locationId => editor.insertLocationBlock(locationId),
    onError: error => editor.showError(error)
  },
  references: {
    rowSignature: reference => editor.rowSignature(reference),
    renderReference: (reference, inSidebar) => editor.renderReference(reference, inSidebar),
    readOnlyProjection: reference => editor.readOnlyProjection(reference),
    showOrdinaryLinkModeMenu: (anchor, link) => editor.showSidebarOrdinaryModeMenu(anchor, link),
    onClosePreview: () => editor.closeSidebarPreview()
  }
});
shell = mountShell(workspace, {
  onFocusBlock: id => editor.focusBlock(id),
  onError: error => editor.showError(error),
  onOpenDocument: openDocument,
  onNavigateBack: () => {
    navigate(() => host.navigateBack());
  },
  onNavigateForward: () => {
    navigate(() => host.navigateForward());
  },
  onOpenSticky: () => {
    alert("便签窗口：浏览器模式下是占位提示。桌面端请从主窗口新建便签。");
  },
}, documentModules, panelRegistry);
panelPorts = createBuiltinPanelPorts(shell);

editor = mountEditor(host, {
  showReferences: panelPorts.showReferences,
  showLocations: panelPorts.showLocations,
  showHistory: panelPorts.showHistory,
  showBacklinks: panelPorts.showBacklinks,
  setReferencePanelState: panelPorts.setReferencePanelState,
  showReferenceLoading: panelPorts.showReferenceLoading,
  showReferencePreview: panelPorts.showReferencePreview,
  showReferenceError: panelPorts.showReferenceError,
  clearReferencePanel: panelPorts.clearReferencePanel,
  setBacklinkTarget: panelPorts.setBacklinkTarget,
  setCommentSelection: panelPorts.setCommentSelection,
  showStyleScope: panelPorts.showStyleScope,
  setDatabaseSelection: panelPorts.setDatabaseSelection,
  setDatabaseContext: (visible, activate) => shell.setPanelCapability("databases", visible, activate),
  updateHistory: panelPorts.updateHistory,
  canvasUndo: () => void canvasManager?.undo(),
  canvasRedo: () => void canvasManager?.redo(),
  canvasStateChanged: (state, persist) => canvasManager?.applyEditorState(state, persist),
  canvasInsertCalendarLink: (documentId, blockId, scope, label) => canvasManager?.insertCalendarLink(documentId, blockId, scope, label) ?? false,
  canvasInsertLocationBlock: locationId => canvasManager?.insertLocationBlock(locationId) ?? false,
  readingFlush: () => readingManager.flush(),
  readingStateChanged: state => readingManager.applyState(state),
  readingInsertCalendarLink: (documentId, blockId, scope, label) => readingManager.insertCalendarLink(documentId, blockId, scope, label),
  readingInsertLocationBlock: locationId => readingManager.insertLocationBlock(locationId),
  beforeNavigation: flushSurfaces,
  routeDocumentLoaded: state => {
    documentRouter.open(workspaceKind(state.note.id) ?? "document", state, surfaceContext.source());
    shell.highlightActiveDocument(state.note.id);
  },
  routeFocusBlock: blockId => documentRouter.focusBlock(blockId),
  surfaceStateChanged: (state, surface) => surfaceContext.changed(state, surface),
  clearPanelContext: () => shell.setPanelContext(null)
});
canvasManager = mountCanvasManager(workspace, {
  onOpenDocument: (id, blockId) => {
    navigate(() => host.openDocument(id, blockId));
  },
  onError: editor.showError,
  onWorkspaceChanged: () => shell.refresh(),
  onLoadDocumentPreview: documentId => host.loadDocument(documentId),
  executeCommand: (command, documentId) => host.executeCommand(command, documentId),
  renderProjection: (reference, context) => editor.readOnlyProjection(reference, context),
  contentFromMarkdown: (source, fallback) => editor.contentFromMarkdown(source, fallback),
  storeMedia: async file => host.storeMedia({ name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, data: await fileToBase64(file) }).then(result => result.media),
  onStateChanged: state => editor.loadCanvas(state),
  onHistoryChanged: panelPorts.updateHistory,
  onActiveBlockChanged: block => editor.setCanvasActiveBlock(block),
  onObjectSelection: (selected, activate) => shell.setPanelCapability("canvas-config", selected, activate),
  onConfigSelection: panelPorts.setCanvasConfig,
  onConfigCurveDismiss: panelPorts.dismissCanvasConfigCurve,
  onShowBacklinks: blockId => { editor.showBacklinksFor(blockId); panelPorts.showBacklinks(); }
}, documentModules);
dashboardManager = mountDashboardManager(host, workspace, {
  onOpenDocument: (id, blockId) => navigate(() => host.openDocument(id, blockId)),
  onError: editor.showError,
  onStateChanged: state => surfaceContext.changed(state, "dashboard"),
  onHistoryChanged: panelPorts.updateHistory,
  onWidgetSelection: (selected, activate) => shell.setPanelCapability("dashboard-config", selected, activate),
  onWidgetConfig: panelPorts.setDashboardConfig,
  onShowBacklinks: (blockId, state) => { editor.showBacklinksFor(blockId, state); panelPorts.showBacklinks(); }
}, documentModules);
readingManager = mountReadingManager(host, {
  contentFromMarkdown: (source, fallback) => editor.contentFromMarkdown(source, fallback),
  renderProjection: (reference, context) => editor.readOnlyProjection(reference, context),
  onError: editor.showError,
  onHistoryChanged: state => editor.loadReading(state),
  onStateChanged: state => editor.loadReading(state),
});
export function registerDashboardExternalWidget(definition: DashboardExternalWidget) {
  return dashboardManager.registerExternal(definition);
}
host.onEvent(event => {
  if (event.kind === "documentChanged") {
    surfaceContext.documentChanged(event.payload.documentId);
  }
});
transport.subscribe(message => {
  if ("requestId" in message && message.ok && message.kind === "saveDocument") shell.refresh();
});

void host.loadDocument("alpha").then(state => documentRouter.open("document", state)).then(() => {
  shell.highlightActiveDocument("alpha");
}).catch(editor.showError);

const bar = document.createElement("nav");
bar.className = "browser-devbar";
bar.innerHTML = '<strong>浏览器开发模式 · 仅内存数据，刷新即重置</strong><button id="dev-back" title="后退">←</button><button id="dev-forward" title="前进">→</button><button data-doc="alpha">Alpha</button><button data-doc="beta">Beta</button><button data-doc="gamma">Gamma</button><button id="dev-fail">模拟下次保存失败</button><button id="dev-retry">重试保存</button><button id="dev-reset-layout">重置布局</button>';
document.body.prepend(bar);
bar.querySelectorAll<HTMLButtonElement>("[data-doc]").forEach(b => b.onclick = () => navigate(() => host.openDocument(b.dataset.doc!)));
bar.querySelector<HTMLButtonElement>("#dev-back")!.onclick = () => navigate(() => host.navigateBack());
bar.querySelector<HTMLButtonElement>("#dev-forward")!.onclick = () => navigate(() => host.navigateForward());
bar.querySelector<HTMLButtonElement>("#dev-fail")!.onclick = () => transport.failNextSave = true;
bar.querySelector<HTMLButtonElement>("#dev-retry")!.onclick = () => editor.retry();
bar.querySelector<HTMLButtonElement>("#dev-reset-layout")!.onclick = () => { localStorage.removeItem("lnm-shell-layout-v1"); location.reload(); };
Object.assign(window, { mockHost: transport, shell, canvasManager });
