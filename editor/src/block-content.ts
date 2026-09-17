import type { BlockContent, LinkToken } from "../../protocol/types";

/** Persist only the owner's content; reference projections are presentation, never source data. */
export function sanitizeHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("[data-reference-host-id]").forEach(anchor => anchor.replaceChildren());
  const allowed = new Set(["B", "STRONG", "I", "EM", "MARK", "BR", "SPAN"]);
  [...template.content.querySelectorAll("*")].forEach((element) => {
    if (!allowed.has(element.tagName)) element.replaceWith(...element.childNodes);
    else [...element.attributes].forEach((attribute) => {
      const allowedLinkAttribute = ["data-target-id", "data-target-block-id", "data-target-title", "data-reference-host-id"].includes(attribute.name);
      if (attribute.name !== "style" && !allowedLinkAttribute || attribute.name === "style" && !/^(background-color|color):/i.test(attribute.value)) element.removeAttribute(attribute.name);
    });
  });
  return template.innerHTML;
}

export function editableContent(editable: HTMLElement, fallback: BlockContent = { text: "", html: "" }): BlockContent {
  const clean = editable.cloneNode(true) as HTMLElement;
  clean.querySelectorAll("[data-reference-host-id]").forEach(anchor => anchor.replaceChildren());
  const textOnly = clean.cloneNode(true) as HTMLElement;
  textOnly.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
  const text = textOnly.textContent ?? "";
  const links: LinkToken[] = [];
  clean.querySelectorAll<HTMLElement>(".wiki-link").forEach((link) => {
    const targetText = link.textContent ?? "";
    const start = text.indexOf(targetText);
    links.push({ targetDocumentId: link.dataset.targetId, targetBlockId: link.dataset.targetBlockId, targetText, start: Math.max(0, start), end: Math.max(0, start) + targetText.length });
  });
  return { ...fallback, text, html: sanitizeHtml(clean.innerHTML), links };
}
