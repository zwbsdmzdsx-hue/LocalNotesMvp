import type { BlockContent, EditorState, LinkToken, ReferenceTargetScope } from "../../protocol/types";
import { editableContent, sanitizeHtml } from "./block-content";
import { markdownFromHtml, renderMarkdown } from "./markdown";

export type LinkRendering = {
  renderLinkedHtml(html: string, alreadySanitized?: boolean): string;
  resolveWikiTargets(root: ParentNode, fallbackLinks?: readonly LinkToken[]): void;
  markdownHtml(source: string, fallbackLinks?: readonly LinkToken[]): string;
  contentFromMarkdown(source: string, fallback: BlockContent): BlockContent;
  contentFromRichEditable(editable: HTMLElement, fallback: BlockContent): BlockContent;
};

/** Shared DOM/Markdown bridge for wiki links. The state getter avoids a second document cache. */
export function createLinkRendering(getState: () => EditorState | null): LinkRendering {
  function renderLinkedHtml(html: string, alreadySanitized = false) {
    const template = document.createElement("template");
    template.innerHTML = alreadySanitized ? html : sanitizeHtml(html);
    template.content.querySelectorAll<HTMLElement>("[data-target-id]").forEach(link => { link.className = "wiki-link"; link.contentEditable = "false"; });
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.parentElement?.closest(".wiki-link, style, script")) textNodes.push(node);
    }
    textNodes.forEach(node => {
      const value = node.nodeValue ?? "";
      const matches = [...value.matchAll(/\[\[([^\]|#]+)(?:#\^([^\]|]+)|#@([^\.\]|]+)(?:\.([^\]|]+))?|#([^\]|]+))?(?:\|([^\]]+))?\]\]/g)];
      if (!matches.length) return;
      const fragment = document.createDocumentFragment();
      let offset = 0;
      matches.forEach(match => {
        fragment.append(value.slice(offset, match.index));
        const link = document.createElement("span");
        link.className = "wiki-link";
        link.contentEditable = "false";
        const title = match[1].trim();
        const blockId = match[2]?.trim();
        const recordId = match[3]?.trim();
        const fieldKey = match[4]?.trim();
        const heading = match[5]?.trim();
        link.dataset.title = title;
        if (blockId) link.dataset.targetBlockId = blockId;
        if (recordId) {
          link.dataset.targetRecordId = recordId;
          link.dataset.targetScope = fieldKey ? "cell" : "record";
          if (fieldKey) link.dataset.targetFieldKey = fieldKey;
        }
        if (heading) {
          link.dataset.targetHeading = heading;
          link.dataset.targetScope = "heading";
        }
        link.textContent = (match[6] ?? (heading || (recordId ? (fieldKey ? `${recordId}.${fieldKey}` : recordId) : title))).trim();
        fragment.append(link);
        offset = (match.index ?? 0) + match[0].length;
      });
      fragment.append(value.slice(offset));
      node.replaceWith(fragment);
    });
    return template.innerHTML;
  }

  function resolveWikiTargets(root: ParentNode, fallbackLinks: readonly LinkToken[] = []) {
    const state = getState();
    root.querySelectorAll<HTMLElement>(".wiki-link[data-target-title], .wiki-link[data-title]").forEach(link => {
      if (link.dataset.targetId) return;
      const title = (link.dataset.targetTitle ?? link.dataset.title ?? "").trim();
      const blockId = link.dataset.targetBlockId;
      const recordId = link.dataset.targetRecordId;
      const fieldKey = link.dataset.targetFieldKey;
      const targetScope = link.dataset.targetScope as ReferenceTargetScope | undefined;
      const retained = fallbackLinks.find(candidate =>
        (!blockId || candidate.targetBlockId === blockId) &&
        (!recordId || candidate.targetRecordId === recordId) &&
        (!fieldKey || candidate.targetFieldKey === fieldKey) &&
        (!targetScope || candidate.targetScope === targetScope) &&
        (candidate.targetText === title || state?.documents.find(document => document.id === candidate.targetDocumentId)?.title === title));
      const leafTitle = title.split("/").map(part => part.trim()).filter(Boolean).pop() ?? title;
      const document = state?.documents.find(candidate =>
        candidate.title === title || candidate.title === leafTitle || candidate.path === title || candidate.path?.endsWith(`/${title}`));
      const documentId = retained?.targetDocumentId ?? document?.id;
      if (documentId) link.dataset.targetId = documentId;
      if (retained?.targetBlockId) link.dataset.targetBlockId = retained.targetBlockId;
      if (retained?.targetRecordId) link.dataset.targetRecordId = retained.targetRecordId;
      if (retained?.targetFieldKey) link.dataset.targetFieldKey = retained.targetFieldKey;
      if (!link.dataset.targetTitle) link.dataset.targetTitle = title;
    });
  }

  function markdownHtml(source: string, fallbackLinks: readonly LinkToken[] = []) {
    const template = document.createElement("template");
    template.innerHTML = renderMarkdown(source);
    resolveWikiTargets(template.content, fallbackLinks);
    return renderLinkedHtml(template.innerHTML, true);
  }

  function contentFromMarkdown(source: string, fallback: BlockContent): BlockContent {
    const container = document.createElement("div");
    container.innerHTML = markdownHtml(source, fallback.links);
    resolveWikiTargets(container, fallback.links);
    return { ...editableContent(container, fallback), markdown: source.replace(/\r\n?/g, "\n") };
  }

  function contentFromRichEditable(editable: HTMLElement, fallback: BlockContent): BlockContent {
    if (editable.dataset.originalHtml === editable.innerHTML) return fallback;
    resolveWikiTargets(editable, fallback.links);
    const content = editableContent(editable, fallback);
    return { ...content, markdown: markdownFromHtml(content.html) };
  }

  return { renderLinkedHtml, resolveWikiTargets, markdownHtml, contentFromMarkdown, contentFromRichEditable };
}
