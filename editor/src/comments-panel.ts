import type { PanelHandle } from "./module-registry";
import type { PanelContext } from "./panel-context";
import { annotatedBlocks, panelDataState } from "./panel-context";
import { appendCommentComposer, appendCommentThread, blockCommentSummary, type CommentActions } from "./block-comments";

export type CommentsPanelHandle = PanelHandle & { setSelectedBlockId(blockId: string | null): void };

export function mountCommentsPanel(slot: HTMLElement, actions: CommentActions, onFocusBlock: (blockId: string) => void): CommentsPanelHandle {
  let context: PanelContext | null = null;
  let selectedBlockId: string | null = null;
  function renderComments() {
    const state = context ? panelDataState(context) : null;
    if (!state) { slot.replaceChildren(); return; }
    slot.replaceChildren();
    const intro = document.createElement("p");
    intro.className = "comment-panel-intro";
    intro.textContent = "注释随块保存，并进入文档的撤销、重做和版本历史。";
    slot.append(intro);

    const activeId = selectedBlockId;
    const current = activeId ? state.blocks.find(block => block.id === activeId) : undefined;
    if (current) {
      const currentCard = document.createElement("section");
      currentCard.className = "comment-current-card";
      const title = document.createElement("strong");
      title.textContent = `给当前块添加注释 · ${blockCommentSummary(current, state)}`;
      currentCard.append(title);
      appendCommentComposer(currentCard, current, actions, state);
      slot.append(currentCard);
    } else {
      const hint = document.createElement("p");
      hint.className = "comment-empty";
      hint.textContent = "先在正文中点击一个块，即可从这里添加注释。";
      slot.append(hint);
    }

    const annotated = annotatedBlocks(state);
    if (!annotated.length) {
      const empty = document.createElement("p");
      empty.className = "comment-empty";
      empty.textContent = "当前文档还没有注释。也可以从块的六点菜单添加。";
      slot.append(empty);
      return;
    }
    const heading = document.createElement("h3");
    heading.className = "comment-panel-heading";
    heading.textContent = `全部注释块 · ${annotated.length}`;
    slot.append(heading);
    for (const block of annotated) {
      const card = document.createElement("section");
      card.className = "comment-block-card";
      card.dataset.blockId = block.id;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "comment-block-link";
      open.textContent = blockCommentSummary(block, state);
      open.title = "定位到正文块";
      open.onclick = () => onFocusBlock(block.id);
      card.append(open);
      appendCommentThread(card, block, true, actions, state);
      slot.append(card);
    }
  }

  return {
    update(next) {
      if (context?.state.note.id !== next?.state.note.id) selectedBlockId = null;
      context = next;
      renderComments();
    },
    setSelectedBlockId(blockId) { selectedBlockId = blockId; renderComments(); },
    dispose() { slot.replaceChildren(); }
  };
}
