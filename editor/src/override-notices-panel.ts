import type { OverrideNotice } from "../../protocol/types";
import type { PanelHandle } from "./module-registry";
import { panelDataState } from "./panel-context";

export type OverrideNoticeAction =
  | { kind: "open"; documentId: string }
  | { kind: "reset"; referenceInstanceId: string; blockId: string }
  | { kind: "delete"; referenceInstanceId: string; blockId: string };

const labels: Record<OverrideNotice["kind"], string> = {
  content_style: "修改了内容或样式",
  hide: "隐藏了此块",
  move: "调整了层级或顺序",
  insert: "增加了专属块"
};

const badges: Record<OverrideNotice["kind"], string> = {
  content_style: "改", hide: "隐", move: "移", insert: "增"
};

export function mountOverrideNoticesPanel(slot: HTMLElement, onAction: (action: OverrideNoticeAction) => void): PanelHandle {
  return {
    update(context) {
      const notices = context ? panelDataState(context).overrideNotices : [];
      const fragment = document.createDocumentFragment();
      if (!notices.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "暂无外部覆写通知。当其他文档修改、重排或隐藏了本块的引用副本时，会在此列出。";
        fragment.append(empty);
      } else {
        const intro = document.createElement("div");
        intro.className = "panel-intro";
        intro.textContent = `${notices.length} 条来自其他引用的覆写通知`;
        fragment.append(intro);
        notices.forEach(notice => {
          const card = document.createElement("div");
          card.className = "notice-card" + (notice.sourceUpdated ? " warning" : "");
          const head = document.createElement("div");
          head.className = "notice-head";
          const badge = document.createElement("span");
          badge.className = `notice-badge kind-${notice.kind}`;
          badge.textContent = badges[notice.kind];
          const title = document.createElement("span");
          title.className = "notice-title";
          title.textContent = notice.hostTitle;
          head.append(badge, title);
          const desc = document.createElement("div");
          desc.className = "notice-desc";
          if (notice.sourceUpdated) {
            const warning = document.createElement("strong");
            warning.textContent = "源内容已更新";
            desc.append(warning, " · ");
          }
          const excerpt = document.createElement("em");
          excerpt.textContent = notice.excerpt || "此块";
          desc.append(`${notice.hostTitle} ${labels[notice.kind]}了 `, excerpt);
          const actions = document.createElement("div");
          actions.className = "notice-actions";
          const open = document.createElement("button");
          open.type = "button";
          open.textContent = "打开";
          open.onclick = () => onAction({ kind: "open", documentId: notice.hostDocumentId });
          actions.append(open);
          const reset = document.createElement("button");
          reset.type = "button";
          reset.textContent = notice.kind === "hide" ? "取消隐藏" : notice.kind === "content_style" ? "恢复继承"
            : notice.kind === "insert" ? "删除专属块" : "恢复位置";
          reset.onclick = () => onAction({ kind: notice.kind === "insert" ? "delete" : "reset",
            referenceInstanceId: notice.referenceInstanceId, blockId: notice.targetBlockId });
          actions.append(reset);
          card.append(head, desc, actions);
          fragment.append(card);
        });
      }
      slot.replaceChildren(fragment);
    },
    dispose() { slot.replaceChildren(); }
  };
}
