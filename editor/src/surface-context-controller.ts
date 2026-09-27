import type { EditorState } from "../../protocol/types";
import type { SurfaceKind, PanelContext } from "./panel-context";
import type { DocumentModule } from "./module-registry";

type Dependencies = {
  module(documentId: string): DocumentModule;
  load(documentId: string): Promise<EditorState>;
  publish(context: PanelContext): void;
  readingId(): string | null;
  flushReading(): Promise<void>;
  refreshReading(state: EditorState): void;
  refreshCanvas(): void;
  refreshDashboard(documentId: string): void;
  dashboardOpen(): boolean;
  dashboardState(): EditorState | null;
  applyEditor(state: EditorState): void;
  setDashboardSource(state: EditorState): void;
  error(error: unknown): void;
};

export function createSurfaceContextController(deps: Dependencies) {
  let source: EditorState | null = null;
  return {
    source: () => source,
    changed(state: EditorState, surface: SurfaceKind, sourceOverride?: EditorState | null) {
      const context = deps.module(state.note.id).liveContext;
      context.changed?.(state);
      if (context.tracksSource) {
        source = structuredClone(state);
      }
      deps.publish(context.create(state, sourceOverride === undefined ? source : sourceOverride, surface));
      if (context.tracksSource) deps.setDashboardSource(state);
    },
    documentChanged(documentId: string) {
      deps.refreshCanvas();
      deps.refreshDashboard(documentId);
      const readingId = deps.readingId();
      if (readingId) void deps.flushReading().then(() => deps.load(readingId)).then(deps.refreshReading).catch(deps.error);
      if (source?.note.id !== documentId) return;
      void deps.load(documentId).then(next => {
        source = structuredClone(next);
        const dashboard = deps.dashboardOpen() ? deps.dashboardState() : null;
        if (dashboard) {
          deps.applyEditor(next);
          deps.setDashboardSource(next);
          deps.publish(deps.module(dashboard.note.id).liveContext.create(dashboard, next, "dashboard"));
        }
      }).catch(deps.error);
    }
  };
}
