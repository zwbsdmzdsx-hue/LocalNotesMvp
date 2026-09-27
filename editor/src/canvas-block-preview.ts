import type { Block, EditorState } from "../../protocol/types";
import { renderMediaAsset } from "./media-editor";
import { markdownFromContent, renderMarkdown } from "./markdown";
import { headingLevel } from "./heading-block-editor";

/** Compact Canvas previews for block types that are not text editors. */
export function renderCanvasMedia(block: Block) {
  const body = document.createElement("div");
  const media = block.content.media;
  if (!media) {
    body.className = "canvas-missing";
    body.textContent = "媒体不存在";
    return body;
  }
  body.append(renderMediaAsset(media, { variant: "canvas", alt: block.content.caption || media.name }));
  if (block.content.caption) {
    const caption = document.createElement("div");
    caption.className = "canvas-media-caption";
    caption.textContent = block.content.caption;
    body.append(caption);
  }
  return body;
}

export function renderCanvasDocumentMedia(block: Block) {
  const asset = block.content.media;
  if (!asset) return renderCanvasMedia(block);
  const wrapper = document.createElement("figure");
  wrapper.className = "canvas-media-preview canvas-document-media";
  const media = renderMediaAsset(asset, { variant: "canvas", alt: block.content.caption || asset.name });
  media.classList.add("canvas-media-player");
  wrapper.append(media);
  if (block.content.caption) {
    const caption = document.createElement("figcaption");
    caption.textContent = block.content.caption;
    wrapper.append(caption);
  }
  return wrapper;
}

export function renderCanvasLocation(block: Block, state: EditorState) {
  const location = state.locations?.find(candidate => candidate.id === block.properties.locationId);
  const card = document.createElement("div");
  card.className = "canvas-location-preview";
  const heading = document.createElement("strong");
  heading.textContent = location?.name ?? "位置已删除";
  card.append(heading);
  const address = document.createElement("p");
  address.textContent = location?.address || "未填写地址";
  card.append(address);
  if (location) {
    const coordinates = document.createElement("small");
    coordinates.textContent = `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
    card.append(coordinates);
  }
  return card;
}

export function renderCanvasDocumentLine(
  block: Block,
  state: EditorState,
  collapsed: Set<string>,
  specializedPreview?: HTMLElement,
  onToggleHeading?: (blockId: string) => void
) {
  const line = document.createElement("div");
  line.className = `canvas-document-line type-${block.type}`;
  line.dataset.blockId = block.id;
  const level = headingLevel(block);
  if (level !== undefined) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "canvas-heading-collapse-toggle";
    toggle.textContent = collapsed.has(block.id) ? "▸" : "▾";
    toggle.setAttribute("aria-expanded", String(!collapsed.has(block.id)));
    toggle.setAttribute("aria-label", collapsed.has(block.id) ? "展开标题内容" : "折叠标题内容");
    toggle.onclick = event => {
      event.stopPropagation();
      onToggleHeading?.(block.id);
    };
    line.append(toggle);
  }
  const content = document.createElement("span");
  if (specializedPreview) {
    content.className = "canvas-document-media-line";
    content.append(specializedPreview);
  } else {
    content.innerHTML = renderMarkdown(markdownFromContent(block.content));
  }
  line.append(content);
  return line;
}
