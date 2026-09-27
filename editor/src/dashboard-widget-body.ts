import type { Block, BlockProperties, EditorState } from "../../protocol/types";
import type { DashboardExternalWidget } from "./dashboard-extension";
import type { DataViewKind } from "./dashboard-views";
import type { DashboardWidgetRenderer } from "./dashboard-renderers";

type DashboardConfig = NonNullable<BlockProperties["dashboardWidget"]>;

export type DashboardWidgetBodyContext = {
  block: Block;
  config: DashboardConfig;
  state: EditorState;
  renderers: ReadonlyMap<string, DashboardWidgetRenderer>;
  dataViews: Readonly<Record<string, { label: string; icon: string }>>;
  externalWidgets: ReadonlyMap<string, DashboardExternalWidget>;
  renderDocumentFilter(block: Block, config: DashboardConfig): HTMLElement;
  renderQuery(config: DashboardConfig, kind: DataViewKind): { element: HTMLElement; dispose(): void };
  renderExternal(block: Block, definition: DashboardExternalWidget): HTMLElement;
  registerDispose(dispose: () => void): void;
};

/** Resolve a Dashboard body through registered providers, keeping the manager lifecycle-only. */
export function renderDashboardWidgetBody(context: DashboardWidgetBodyContext) {
  const { block, config } = context;
  const summary = context.renderers.get(config.kind);
  const dataView = context.dataViews[config.kind];
  const external = context.externalWidgets.get(config.kind);
  if (config.kind === "documentFilter") return context.renderDocumentFilter(block, config);
  if (dataView) {
    const view = context.renderQuery(config, config.kind as DataViewKind);
    context.registerDispose(view.dispose);
    return view.element;
  }
  if (external) return context.renderExternal(block, external);
  if (summary) return summary.render(context.state, block);
  const hint = document.createElement("p");
  hint.className = "dashboard-empty";
  hint.textContent = "组件尚未注册，配置和位置仍会保留。";
  return hint;
}
