import type { BlockContent, LinkToken } from "../../protocol/types";

/** Persist only the owner's content; reference projections are presentation, never source data. */
export function sanitizeHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("[data-reference-host-id]").forEach(anchor => anchor.replaceChildren());
  const allowed = new Set([
    "A", "B", "BLOCKQUOTE", "BR", "CODE", "DEL", "DIV", "EM", "H1", "H2", "H3", "H4", "H5", "H6",
    "HR", "I", "IMG", "INPUT", "LI", "MARK", "OL", "P", "PRE", "S", "SPAN", "STRONG", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL"
  ]);
  [...template.content.querySelectorAll("*")].forEach((element) => {
    if (!allowed.has(element.tagName)) element.replaceWith(...element.childNodes);
    else [...element.attributes].forEach((attribute) => {
      const allowedClassAttribute = attribute.name === "class" &&
        [...element.classList].every(token => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(token));
      const allowedLinkAttribute = ["data-target-id", "data-target-block-id", "data-target-title", "data-reference-host-id"].includes(attribute.name) ||
        allowedClassAttribute;
      const allowedAnchorAttribute = element.tagName === "A" && ["href", "title"].includes(attribute.name) &&
        !/^\s*(?:javascript|data):/i.test(attribute.value);
      const allowedImageAttribute = element.tagName === "IMG" && ["src", "alt", "title"].includes(attribute.name) &&
        (attribute.name !== "src" || !/^\s*(?:javascript|data):/i.test(attribute.value));
      const allowedCheckboxAttribute = element.tagName === "INPUT" && ["type", "checked", "disabled"].includes(attribute.name);
      if (attribute.name !== "style" && !allowedLinkAttribute && !allowedAnchorAttribute && !allowedImageAttribute && !allowedCheckboxAttribute ||
          attribute.name === "style" && !/^(background-color|color):/i.test(attribute.value)) element.removeAttribute(attribute.name);
    });
  });
  template.content.querySelectorAll<HTMLInputElement>("input").forEach(input => {
    if (input.type !== "checkbox") input.remove();
    else input.disabled = true;
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
