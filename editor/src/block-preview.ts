import type { Block, EditorState } from "../../protocol/types";
import { renderLocationMap } from "./location-manager";
import { renderDatabaseTablePreview } from "./database-presentation";
import { markdownFromContent, renderMarkdown } from "./markdown";
import { renderMediaAsset } from "./media-editor";

export function previewReadingAnnotation(block: Block, kind: string) {
  const wrapper = document.createElement("div"); wrapper.className = "reading-reference-preview";
  const meta = document.createElement("div"); meta.className = "reading-reference-meta";
  meta.textContent = `${kind} · 第 ${block.properties.readingAnchor?.page ?? 1} 页`;
  const body = document.createElement("div"); body.className = "reading-reference-body";
  const source = markdownFromContent(block.content);
  body.innerHTML = source ? renderMarkdown(source) : "";
  if (!source) body.textContent = block.content.text || "";
  wrapper.append(meta, body); return wrapper;
}

export function previewLocation(block: Block, state: EditorState) {
  const location = state.locations?.find(item => item.id === block.properties.locationId);
  const card = document.createElement("figure");
  card.className = `location-card-body${location?.deletedAt ? " is-deleted" : ""}`;
  card.setAttribute("aria-label", location ? `位置：${location.name}` : "位置已删除");
  const head = document.createElement("div"); head.className = "location-body-head";
  const icon = document.createElement("span"); icon.className = "location-pin-icon"; icon.textContent = "📍";
  const title = document.createElement("strong"); title.textContent = block.properties.locationLabelOverride || location?.name || "位置已删除";
  head.append(icon, title); card.append(head);
  if (!location || location.deletedAt) {
    const missing = document.createElement("p"); missing.className = "location-missing";
    missing.textContent = location ? "此位置已删除，可在地图管理中恢复" : `找不到位置 ${block.properties.locationId ?? ""}`;
    card.append(missing); return card;
  }
  const address = document.createElement("p"); address.className = "location-body-address"; address.textContent = location.address || "未填写地址";
  const coords = document.createElement("p"); coords.className = "location-body-coordinates"; coords.textContent = `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
  const map = document.createElement("div"); map.className = "location-body-map";
  card.append(address, coords, map); renderLocationMap(map, location);
  return card;
}

export function previewMedia(block: Block) {
  const asset = block.content.media;
  const figure = document.createElement("figure"); figure.className = "media-preview";
  if (!asset) { figure.textContent = "媒体不存在"; return figure; }
  figure.dataset.mediaKind = asset.kind;
  const stage = document.createElement("div"); stage.className = "media-stage";
  stage.dataset.mediaAlign = block.properties.textAlign ?? "left";
  if (block.properties.mediaWidth !== undefined) stage.style.width = `${Math.max(20, Math.min(100, block.properties.mediaWidth))}%`;
  const media = renderMediaAsset(asset);
  stage.append(media); figure.append(stage);
  if (block.content.caption) { const caption = document.createElement("figcaption"); caption.className = "media-caption"; caption.textContent = block.content.caption; figure.append(caption); }
  return figure;
}

export { renderDatabaseTablePreview };
