import type { EditorState } from "../../protocol/types";
import type { mountEditor } from "./core";
import type { BrowserMockHost } from "./browser-mock-host";
import type { CanvasManager } from "./canvas-manager";
import type { DashboardManager } from "./dashboard-manager";
import type { ReadingManager } from "./reading-manager";
import type { DocumentModule, ModuleRegistry } from "./module-registry";
import type { PanelContext, SurfaceKind } from "./panel-context";
import { workspaceItemMeta } from "./workspace-item-meta";

type Dependencies = {
  editor(): ReturnType<typeof mountEditor>;
  canvas(): CanvasManager;
  dashboard(): DashboardManager;
  reading(): ReadingManager;
  publishContext(state: EditorState, surface: SurfaceKind, source?: EditorState | null): void;
};

export function registerBuiltinDocumentModules(modules: ModuleRegistry<DocumentModule>, store: BrowserMockHost, deps: Dependencies) {
  const flushEditor = () => deps.editor().flush();
  const ordinaryRuntime = {
    open: (state: EditorState) => deps.editor().load(state),
    update: (state: EditorState) => deps.editor().load(state),
    close: () => {},
    flush: flushEditor,
    focusBlock: (id: string) => deps.editor().focusBlock(id),
    restoreHistory: (id: string) => deps.editor().restoreHistory(id)
  };
  const ordinaryLiveContext = {
    tracksSource: true,
    create: (state: EditorState, _source: EditorState | null, surface: SurfaceKind): PanelContext =>
      ({ surface, state: structuredClone(state) })
  };
  modules.register({ id: "document", order: 0, createLabel: "新建文档", createIcon: "▤", presentation: workspaceItemMeta.document, dashboardSource: { countsAsDocument: true },
    create: ({ id, title, bookmarkId, parentId }) => store.createDocument(title, id, bookmarkId, parentId), liveContext: ordinaryLiveContext, runtime: ordinaryRuntime });
  modules.register({ id: "database", order: 4, createLabel: "新建数据表", createIcon: "▤", presentation: workspaceItemMeta.database, dashboardSource: { countsAsDocument: false },
    create: ({ id, title, bookmarkId, parentId }) => store.createDatabase(title, id, bookmarkId, parentId), liveContext: ordinaryLiveContext, runtime: ordinaryRuntime });
  modules.register({ id: "canvas", order: 1, createLabel: "新建 Canvas", createIcon: "◇", presentation: workspaceItemMeta.canvas, dashboardSource: { countsAsDocument: false },
    canvasLink: { nodeKind: "canvas", width: 300, height: 210 },
    create: ({ id, title, bookmarkId, parentId }) => store.createCanvas(title, id, bookmarkId, parentId),
    liveContext: ordinaryLiveContext,
    runtime: {
      open(state) { deps.editor().loadCanvas(state); deps.canvas().open(state.note.id); },
      update: state => deps.editor().loadCanvas(state),
      close: () => deps.canvas().close(),
      flush: async () => { await deps.canvas().flush(); await flushEditor(); },
      focusBlock: id => deps.canvas().focusBlock(id),
      restoreHistory: id => deps.canvas().restoreHistory(id)
    } });
  modules.register({ id: "dashboard", order: 2, createLabel: "新建 Dashboard", createIcon: "▦", presentation: workspaceItemMeta.dashboard,
    create: ({ id, title, bookmarkId, parentId }) => store.createDashboard(title, id, bookmarkId, parentId),
    liveContext: { tracksSource: false, create: (state, source) => ({ surface: "dashboard", state: structuredClone(state), sourceState: source ? structuredClone(source) : undefined }) },
    runtime: {
      open(state, source) { if (source) deps.editor().load(source); else deps.editor().clear(); deps.dashboard().open(state, source); deps.publishContext(state, "dashboard", source); },
      update: state => deps.dashboard().applyState(state),
      close: () => deps.dashboard().close(),
      flush: async () => { await deps.dashboard().flush(); await flushEditor(); },
      focusBlock: id => deps.dashboard().focusBlock(id),
      restoreHistory: id => deps.dashboard().restoreHistory(id)
    } });
  modules.register({ id: "reading", order: 3, createLabel: "新建读书笔记", createIcon: "▧", presentation: workspaceItemMeta.reading, dashboardSource: { countsAsDocument: false },
    create: ({ id, title, bookmarkId, parentId }) => store.createReading(title, id, bookmarkId, parentId),
    liveContext: { ...ordinaryLiveContext, changed: state => { if (!deps.reading().isOpen()) deps.reading().applyState(state); } },
    runtime: {
      open(state) { deps.reading().open(state); deps.editor().loadReading(state); },
      update: state => deps.reading().applyState(state),
      close: () => deps.reading().close(),
      flush: async () => { await deps.reading().flush(); await flushEditor(); },
      focusBlock: id => deps.reading().focusBlock(id),
      restoreHistory: id => deps.reading().restoreHistory(id)
    } });
}
