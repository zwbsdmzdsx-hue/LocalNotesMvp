import type { EditorState } from "../../protocol/types";
import type { PanelHandle } from "./module-registry";
import { backlinkEntries, panelDataState, type PanelContext } from "./panel-context";

export type BacklinksPanelHandle = PanelHandle & { setTarget(blockId: string | null, state?: EditorState): void };

export function mountBacklinksPanel(slot: HTMLElement, onOpen: (documentId: string, blockId?: string) => void): BacklinksPanelHandle {
  let context: PanelContext | null = null;
  let targetBlockId: string | null = null;
  let targetState: EditorState | null = null;

  function render() {
    const state = targetState ?? (context ? panelDataState(context) : null);
    const fragment = document.createDocumentFragment();
    if (!state) { slot.replaceChildren(); return; }
    const links = backlinkEntries(state, targetBlockId);
    if (!links.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "暂无反向链接。在其他文档中链接或嵌入引用此处时会自动出现。";
      fragment.append(empty);
    } else {
      const intro = document.createElement("div");
      intro.className = "panel-intro";
      intro.textContent = `${links.length} 处引用了${targetBlockId ? "此块" : "此文档"}`;
      fragment.append(intro);
      links.forEach(link => {
        const card = document.createElement("div");
        card.className = "backlink-card";
        card.dataset.sourceId = `${link.sourceDocumentId}:${link.sourceBlockId ?? ""}:${link.targetBlockId ?? ""}`;
        const head = document.createElement("div");
        head.className = "backlink-head";
        const icon = document.createElement("span");
        icon.className = "backlink-icon";
        icon.textContent = "🔗";
        const title = document.createElement("span");
        title.className = "backlink-title";
        title.textContent = link.sourceTitle;
        const open = document.createElement("button");
        open.type = "button";
        open.className = "backlink-open";
        open.textContent = "打开";
        open.title = "打开源文档";
        open.onclick = () => onOpen(link.sourceDocumentId, link.sourceBlockId);
        head.append(icon, title, open);
        const excerpt = document.createElement("div");
        excerpt.className = "backlink-excerpt";
        excerpt.textContent = link.excerpt || "(无文本)";
        const target = document.createElement("div");
        target.className = "backlink-target";
        target.textContent = `指向：${link.targetTitle ?? state.note.title}`;
        card.append(head, target, excerpt);
        card.onclick = event => { if (!(event.target as HTMLElement).closest(".backlink-open")) open.click(); };
        fragment.append(card);
      });
    }
    slot.replaceChildren(fragment);
  }

  return {
    update(next) { context = next; render(); },
    setTarget(blockId, state) {
      targetBlockId = blockId;
      targetState = state ? structuredClone(state) : null;
      render();
    },
    dispose() { slot.replaceChildren(); }
  };
}
