import type { EditorState, Block } from "../../protocol/types";
import { calendarTodosFromState } from "./panel-context";

export type DashboardWidgetRenderer = {
  kind: string;
  icon?: string;
  render(state: EditorState, widget: Block): HTMLElement;
};

export const widgetIcons: Record<string, string> = {
  metric: "∑", references: "↗", backlinks: "↙", overrides: "!", comments: "◌",
  history: "↶", calendar: "▦", locations: "⌖", styles: "◧", databases: "▤", documentFilter: "▤"
};

function list(values: string[], empty = "暂无内容") {
  const section = document.createElement("div");
  section.className = "dashboard-widget-list";
  if (!values.length) {
    const p = document.createElement("p"); p.className = "dashboard-empty"; p.textContent = empty; section.append(p); return section;
  }
  values.slice(0, 12).forEach(value => {
    const row = document.createElement("div"); row.className = "dashboard-list-row"; row.textContent = value; section.append(row);
  });
  if (values.length > 12) { const more = document.createElement("small"); more.textContent = `还有 ${values.length - 12} 项`; section.append(more); }
  return section;
}

function countCard(label: string, count: number) {
  const body = document.createElement("div"); body.className = "dashboard-count-card";
  const value = document.createElement("strong"); value.textContent = String(count);
  const caption = document.createElement("span"); caption.textContent = label;
  body.append(value, caption); return body;
}

export function defaultDashboardRenderers(): DashboardWidgetRenderer[] {
  return [
    { kind: "references", render: state => list(state.references.map(ref => `${ref.targetTitle} · ${ref.mode}`)) },
    { kind: "backlinks", render: state => list(state.backlinks.map(link => `${link.sourceTitle} · ${link.excerpt}`)) },
    { kind: "overrides", render: state => countCard("条外部覆写通知", state.overrideNotices.length) },
    { kind: "comments", render: state => countCard("条正文注释", state.blocks.reduce((total, block) => total + (block.properties.comments?.length ?? 0), 0)) },
    { kind: "history", render: state => list((state.history?.entries ?? []).map(entry => `${entry.label} · ${entry.preview}`)) },
    { kind: "calendar", render: state => list(calendarTodosFromState(state).map(todo => todo.text || "未命名待办"), "当前文档没有待办") },
    { kind: "locations", render: state => list((state.locations ?? []).filter(location => !location.deletedAt).map(location => `${location.name} · ${location.address}`)) },
    { kind: "styles", render: state => list([...(state.systemStyles ?? []), ...(state.notebookStyles ?? []), ...(state.documentStyles ?? [])].map(style => `${style.title}${style.enabled ? "" : " · 已停用"}`)) },
    { kind: "databases", render: state => list((state.databases ?? []).map(database => `${database.title} · ${database.recordCount} 条记录`)) }
  ];
}

export function dashboardWidgetConfig(block: Block) {
  return block.properties.dashboardWidget;
}
