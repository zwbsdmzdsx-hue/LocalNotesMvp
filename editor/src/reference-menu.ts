import type { ReferenceInstance, ReferenceMode } from "../../protocol/types";
import type { OrdinaryLinkSidebarEntry } from "./reference-sidebar-panel";

export type ReferenceMenuAction = { label: string; run(): void; danger?: boolean };

const displayModes: Array<{ label: string; mode: ReferenceMode }> = [
  { label: "仅标题链接", mode: "link" },
  { label: "正文直显", mode: "inline" },
  { label: "折叠卡片", mode: "collapsed" },
  { label: "右侧分栏", mode: "sidebar" }
];

export function ordinaryReferenceMenuActions(
  link: OrdinaryLinkSidebarEntry,
  existing: ReferenceInstance | undefined,
  actions: {
    setMode(reference: ReferenceInstance, mode: ReferenceMode): void;
    createMode(link: OrdinaryLinkSidebarEntry, mode: ReferenceMode): void;
    refresh(): void;
  }
): ReferenceMenuAction[] {
  return displayModes.map(({ label, mode }) => ({
    label,
    run: () => existing ? actions.setMode(existing, mode) : mode === "link" ? actions.refresh() : actions.createMode(link, mode)
  }));
}

export function referenceMenuActions(
  reference: ReferenceInstance,
  actions: {
    setMode(reference: ReferenceInstance, mode: ReferenceMode): void;
    openSource(documentId: string): void;
    remove(reference: ReferenceInstance): void;
    detach(reference: ReferenceInstance): void;
    reset(reference: ReferenceInstance): void;
  }
): ReferenceMenuAction[] {
  return [
    ...displayModes.map(({ label, mode }) => ({ label, run: () => actions.setMode(reference, mode) })),
    { label: "打开源文档", run: () => actions.openSource(reference.targetDocumentId) },
    { label: "删除引用", danger: true, run: () => actions.remove(reference) },
    { label: "断开引用（保留为正文）", run: () => actions.detach(reference) },
    { label: "恢复全部继承内容", run: () => actions.reset(reference) }
  ];
}
