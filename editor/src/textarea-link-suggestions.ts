import type { EditorState } from "../../protocol/types";
import { queryLinkSuggestions, suggestionWikiTarget, type LinkSuggestion } from "./link-suggestions";

/** Textarea adapter for the same notebook/document/block catalog as the editor. */
export function textareaLinkSuggestions(getState: () => EditorState | null) {
  let popup: HTMLElement | null = null;
  const close = () => { popup?.remove(); popup = null; };
  function bind(input: HTMLTextAreaElement, changed: () => void, typing = changed) {
    let composing = false;
    let index = 0;
    let items: LinkSuggestion[] = [];
    const query = () => {
      const end = input.selectionStart;
      const before = input.value.slice(0, end);
      const start = before.lastIndexOf("[[");
      return input.selectionEnd === end && start >= 0 && !/\]\]|\n/.test(before.slice(start))
        ? { start, end, text: before.slice(start + 2) } : null;
    };
    const choose = (item: LinkSuggestion) => {
      const match = query(); if (!match) return;
      const target = suggestionWikiTarget(item, { alias: true });
      input.setRangeText("[[" + target.text, match.start, match.end, "end");
      input.focus();
      if (target.complete) { changed(); close(); }
      else { typing(); show(); }
    };
    const show = () => {
      close();
      const match = query(); const state = getState();
      if (composing || !match || !state) return;
      items = queryLinkSuggestions(match.text, state, () => "").items;
      if (!match.text.includes("/") && !match.text.includes("#")) {
        state.documents.filter(doc => doc.title.toLocaleLowerCase().includes(match.text.toLocaleLowerCase())).forEach(doc =>
          items.push({ kind: "target", id: doc.id, title: doc.title, label: doc.title, meta: doc.notebookName ?? "", notebookName: doc.notebookName, documentTitle: doc.title }));
      }
      index = 0;
      popup = document.createElement("div"); popup.className = "reading-link-suggestions";
      popup.setAttribute("role", "listbox"); popup.setAttribute("aria-label", "插入引用");
      if (!items.length) popup.textContent = "没有匹配内容";
      items.forEach((item, i) => {
        const button = document.createElement("button"); button.type = "button";
        button.className = "reading-link-suggestion"; button.textContent = item.title;
        button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(i === index));
        if ("blockId" in item && item.blockId) button.dataset.blockId = item.blockId;
        button.onmousedown = event => event.preventDefault();
        button.onclick = () => choose(item); popup!.append(button);
      });
      document.body.append(popup);
      const rect = input.getBoundingClientRect();
      popup.style.left = Math.max(8, Math.min(innerWidth - 308, rect.left)) + "px";
      popup.style.top = Math.max(8, Math.min(innerHeight - popup.offsetHeight - 8, rect.bottom + 4)) + "px";
    };
    input.addEventListener("input", () => { if (!composing) { typing(); show(); } });
    input.addEventListener("compositionstart", () => { composing = true; close(); });
    input.addEventListener("compositionend", () => { composing = false; typing(); show(); });
    input.addEventListener("click", show);
    input.addEventListener("blur", close);
    input.addEventListener("keydown", event => {
      if (composing || event.isComposing || !popup) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (items.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault(); index = (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        popup.querySelectorAll("button").forEach((button, i) => { button.setAttribute("aria-selected", String(i === index)); if (i === index) button.scrollIntoView({ block: "nearest" }); });
      } else if (items.length && (event.key === "Enter" || event.key === "Tab")) { event.preventDefault(); choose(items[index]); }
    });
  }
  return { bind, close };
}
