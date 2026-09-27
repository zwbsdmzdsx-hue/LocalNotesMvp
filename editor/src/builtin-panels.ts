import { createPanelRegistry, type PanelHandle } from "./module-registry";
import type { PanelContext } from "./panel-context";
import { mountHistoryPanel, type HistoryPanelHandle } from "./history-panel";
import { mountOverrideNoticesPanel, type OverrideNoticeAction } from "./override-notices-panel";
import { mountBacklinksPanel, type BacklinksPanelHandle } from "./backlinks-panel";
import { mountCalendarPanel, type CalendarPanelCallbacks } from "./calendar-panel";
import { mountCommentsPanel, type CommentsPanelHandle } from "./comments-panel";
import type { CommentActions } from "./block-comments";
import type { WorkspaceApi } from "./workspace-api";
import { mountStylesPanel, type StylePanelActions, type StylesPanelHandle, type StyleScope } from "./styles-panel";
import { mountDatabasePanel, type DatabasePanelActions, type DatabasePanelHandle } from "./database-panel";
import { mountLocationsPanel, type LocationPanelActions } from "./locations-panel";
import { mountDashboardConfigPanel, type DashboardConfigPanelHandle, type DashboardConfigPanelModel } from "./dashboard-config-panel";
import { mountCanvasConfigPanel, type CanvasConfigPanelHandle, type CanvasConfigPanelModel } from "./canvas-config-panel";
import { mountReferencePanel, type ReferencePanelActions, type ReferencePanelHandle, type OrdinaryLinkSidebarEntry } from "./reference-sidebar-panel";
import type { EditorState, ReferenceInstance } from "../../protocol/types";
import type { HistoryModel } from "./history";

type PanelActions = {
  restoreHistory(entryId: string): void;
  overrideNotice(action: OverrideNoticeAction): void;
  openBacklink(documentId: string, blockId?: string): void;
  calendar: { workspace: WorkspaceApi; callbacks: CalendarPanelCallbacks };
  comments: { actions: CommentActions; focusBlock(blockId: string): void };
  styles: StylePanelActions;
  databases: DatabasePanelActions;
  locations: LocationPanelActions;
  references: ReferencePanelActions;
};

type BuiltinPanel = {
  id: string;
  label: string;
  icon: string;
  initialTab?: boolean;
  fallbackTab?: boolean;
  slotId?: string;
  selectionCapability?: string;
  restorePreviousTab?: boolean;
  available?: (context: PanelContext | null) => boolean;
  mount: (slot: HTMLElement, actions: Partial<PanelActions>) => PanelHandle;
};

function requirePanelAction<K extends keyof PanelActions>(actions: Partial<PanelActions>, key: K, panelId: string): PanelActions[K] {
  const action = actions[key];
  if (!action) throw new Error(`右栏面板 ${panelId} 缺少 ${String(key)} 能力`);
  return action;
}

const panels: BuiltinPanel[] = [
  { id: "reference-sidebar", label: "实时引用", icon: "📎", fallbackTab: true, mount: (slot, actions) =>
    mountReferencePanel(slot, requirePanelAction(actions, "references", "reference-sidebar")) },
  { id: "backlinks", label: "反向链接", icon: "🔗", mount: (slot, actions) =>
    mountBacklinksPanel(slot, requirePanelAction(actions, "openBacklink", "backlinks")) },
  { id: "overrides", label: "外部覆写", icon: "✎", initialTab: true, slotId: "override-notices", mount: (slot, actions) =>
    mountOverrideNoticesPanel(slot, requirePanelAction(actions, "overrideNotice", "overrides")) },
  { id: "comments", label: "注释管理", icon: "💬", mount: (slot, actions) => {
    const comments = requirePanelAction(actions, "comments", "comments");
    return mountCommentsPanel(slot, comments.actions, comments.focusBlock);
  } },
  { id: "history", label: "历史记录", icon: "🕘", slotId: "history-list", mount: (slot, actions) =>
    mountHistoryPanel(slot, requirePanelAction(actions, "restoreHistory", "history")) },
  { id: "calendar", label: "日历", icon: "📅", mount: (slot, actions) => {
    const { workspace, callbacks } = requirePanelAction(actions, "calendar", "calendar");
    const calendar = mountCalendarPanel(slot, workspace, callbacks);
    return { ...calendar, activate: () => calendar.open() };
  } },
  { id: "locations", label: "地图管理", icon: "📍", mount: (slot, actions) =>
    mountLocationsPanel(slot, requirePanelAction(actions, "locations", "locations")) },
  { id: "styles", label: "CSS 管理", icon: "🎨", mount: (slot, actions) =>
    mountStylesPanel(slot, requirePanelAction(actions, "styles", "styles")) },
  { id: "databases", label: "数据表属性", icon: "▦", selectionCapability: "database", restorePreviousTab: true, mount: (slot, actions) =>
    mountDatabasePanel(slot, requirePanelAction(actions, "databases", "databases")) },
  { id: "canvas-config", label: "对象设置", icon: "⚙", selectionCapability: "canvasObject", mount: slot => mountCanvasConfigPanel(slot) },
  { id: "dashboard-config", label: "组件设置", icon: "⚙", selectionCapability: "dashboardWidget", mount: slot => mountDashboardConfigPanel(slot) }
];

export function createBuiltinPanelRegistry(services: Partial<PanelActions> = {}) {
  const registry = createPanelRegistry();
  panels.forEach((panel, order) => registry.register({
    id: panel.id, label: panel.label, icon: panel.icon, slotId: panel.slotId, order,
    initialTab: panel.initialTab, fallbackTab: panel.fallbackTab,
    selectionCapability: panel.selectionCapability, restorePreviousTab: panel.restorePreviousTab,
    available: context => panel.available?.(context) ??
      (panel.selectionCapability ? !!context?.capabilities?.[panel.selectionCapability] : true),
    mount(slot) {
      const content = panel.mount(slot, services);
      return {
        ...content,
        update(context: PanelContext | null) {
          if (context) {
            slot.dataset.documentId = context.state.note.id;
            slot.dataset.surface = context.surface;
          } else {
            delete slot.dataset.documentId;
            delete slot.dataset.surface;
          }
          content.update(context);
        },
        dispose() { content.dispose(); }
      };
    }
  }));
  return registry;
}

/** Typed commands for built-in panels. The shell only owns their visibility. */
export function createBuiltinPanelPorts(host: {
  openPanel(id: string): void;
  panelHandle<T extends PanelHandle>(id: string): T;
}) {
  return {
    showReferences: () => host.openPanel("reference-sidebar"),
    showBacklinks: () => host.openPanel("backlinks"),
    showLocations: () => host.openPanel("locations"),
    showHistory: () => host.openPanel("history"),
    updateHistory: (model: HistoryModel) => host.panelHandle<HistoryPanelHandle>("history").setModel(model),
    setReferencePanelState: (state: EditorState, previewActive: boolean) =>
      host.panelHandle<ReferencePanelHandle>("reference-sidebar").setState(state, previewActive),
    showReferenceLoading: () => host.panelHandle<ReferencePanelHandle>("reference-sidebar").showLoading(),
    showReferencePreview: (reference: ReferenceInstance, referenceId?: string, ordinaryLink?: OrdinaryLinkSidebarEntry | null) =>
      host.panelHandle<ReferencePanelHandle>("reference-sidebar").showPreview(reference, referenceId, ordinaryLink),
    showReferenceError: (message: string) => host.panelHandle<ReferencePanelHandle>("reference-sidebar").showError(message),
    clearReferencePanel: () => host.panelHandle<ReferencePanelHandle>("reference-sidebar").clear(),
    setBacklinkTarget: (blockId: string | null, state?: EditorState) =>
      host.panelHandle<BacklinksPanelHandle>("backlinks").setTarget(blockId, state),
    setCommentSelection: (blockId: string | null) =>
      host.panelHandle<CommentsPanelHandle>("comments").setSelectedBlockId(blockId),
    showStyleScope: (scope: StyleScope) => {
      host.panelHandle<StylesPanelHandle>("styles").setScope(scope);
      host.openPanel("styles");
    },
    setDatabaseSelection: (blockId: string | null) =>
      host.panelHandle<DatabasePanelHandle>("databases").setSelectedBlockId(blockId),
    setDashboardConfig: (model: DashboardConfigPanelModel | null) =>
      host.panelHandle<DashboardConfigPanelHandle>("dashboard-config").setModel(model),
    setCanvasConfig: (model: CanvasConfigPanelModel | null) =>
      host.panelHandle<CanvasConfigPanelHandle>("canvas-config").setModel(model),
    dismissCanvasConfigCurve: () => host.panelHandle<CanvasConfigPanelHandle>("canvas-config").dismissCurve()
  };
}
