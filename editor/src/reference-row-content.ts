import { markdownFromContent } from "./markdown";
import { previewLocation, renderDatabaseTablePreview } from "./block-preview";
import type { ReferenceRowContentServices, ReferenceRowRenderer } from "./module-registry";

function escapeHtml(value: string) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

/** Render a regular text block inside a reference card. */
export function renderPlainReferenceRowContent(services: ReferenceRowContentServices): { projected: boolean } {
  const { content, mode, editable } = services;
  if (mode === "source") {
    editable.classList.add("markdown-source");
    editable.contentEditable = "plaintext-only";
    editable.spellcheck = false;
    editable.textContent = markdownFromContent(content);
  } else if (mode === "preview") {
    editable.classList.add("markdown-preview");
    editable.innerHTML = content.markdown !== undefined
      ? services.markdownHtml(content.markdown, content.links)
      : services.renderLinkedHtml(content.html || escapeHtml(content.text));
  } else {
    editable.classList.add("rich-editor");
    editable.contentEditable = "true";
    editable.innerHTML = content.html
      ? services.renderLinkedHtml(content.html)
      : content.markdown !== undefined
        ? services.markdownHtml(content.markdown, content.links)
        : escapeHtml(content.text);
    editable.dataset.originalHtml = editable.innerHTML;
  }
  return { projected: false };
}

/** Render a read-only reading-note annotation projection. */
export function renderReadingAnnotationReferenceRow(services: ReferenceRowContentServices): { projected: boolean } {
  const { source, content, properties, editable } = services;
  editable.classList.add("markdown-preview", "reading-reference-content");
  editable.contentEditable = "false";
  editable.replaceChildren(services.renderReadingAnnotation({ ...source, properties }, content));
  return { projected: true };
}

/** Render a read-only location projection. */
export function renderLocationReferenceRow(services: ReferenceRowContentServices): { projected: boolean } {
  const { source, content, properties, state, editable } = services;
  editable.replaceChildren(previewLocation({ ...source, content, properties }, state));
  return { projected: true };
}

/** Render a read-only database or query projection. */
export function renderDatabaseReferenceRow(services: ReferenceRowContentServices, declaration: string): { projected: boolean } {
  const { source, content, properties, state, mode, editable } = services;
  if (mode === "source") {
    editable.classList.add("markdown-source");
    editable.contentEditable = "plaintext-only";
    editable.spellcheck = false;
    editable.textContent = declaration;
  } else {
    editable.classList.add("markdown-preview");
    editable.replaceChildren(renderDatabaseTablePreview({ ...source, content, properties }, {}, state));
  }
  return { projected: true };
}

export function renderReferenceRowContent(services: ReferenceRowContentServices, renderer?: ReferenceRowRenderer): { projected: boolean } {
  return renderer?.(services) ?? renderPlainReferenceRowContent(services);
}
