import type { WorkspaceItemKind } from "./workspace-api";

export const workspaceItemMeta: Record<WorkspaceItemKind, {
  icon: string;
  iconClass: string;
  createPrompt: string;
  defaultTitle: string;
  idPrefix: string;
}> = {
  document: { icon: "&#128196;", iconClass: "", createPrompt: "文档名称：", defaultTitle: "未命名文档", idPrefix: "doc" },
  canvas: { icon: "◇", iconClass: " canvas-item-icon", createPrompt: "Canvas 名称：", defaultTitle: "未命名 Canvas", idPrefix: "canvas" },
  dashboard: { icon: "▦", iconClass: " dashboard-item-icon", createPrompt: "Dashboard 名称：", defaultTitle: "工作台 Dashboard", idPrefix: "dashboard" }
};
