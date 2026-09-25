import type { MediaAsset } from "../../protocol/types";

export function mediaFromUrl(raw: string): MediaAsset {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("媒体地址必须使用 http 或 https");
  const path = parsed.pathname.toLocaleLowerCase();
  const kind: MediaAsset["kind"] = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(path) ? "image"
    : /\.(mp4|webm|mov|m4v|ogv)$/.test(path) ? "video"
    : /\.(mp3|wav|ogg|m4a|aac|flac)$/.test(path) ? "audio"
    : /\.pdf$/.test(path) ? "pdf" : "file";
  let name = parsed.pathname.split("/").pop() || "远程媒体";
  try { name = decodeURIComponent(name); } catch { /* Keep the original URL segment. */ }
  return { id: `remote-media-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`, kind, name,
    mimeType: "application/octet-stream", size: 0, url: parsed.href };
}

export function mediaUrlFromTransfer(transfer: DataTransfer | null): string | null {
  if (!transfer) return null;
  const uri = transfer.getData("text/uri-list").split(/\r?\n/).find(line => line.trim() && !line.startsWith("#"));
  if (uri?.trim()) return uri.trim();
  const html = transfer.getData("text/html");
  if (html) {
    const fragment = new DOMParser().parseFromString(html, "text/html");
    const media = fragment.querySelector("img[src], video[src], audio[src], source[src], embed[src]");
    const source = media?.getAttribute("src") ?? media?.getAttribute("href");
    if (source && /^https?:\/\//i.test(source)) return source;
  }
  const plain = transfer.getData("text/plain").trim();
  return /^https?:\/\/\S+$/i.test(plain) ? plain : null;
}

export function mediaFromTransfer(transfer: DataTransfer | null): MediaAsset | null {
  const url = mediaUrlFromTransfer(transfer);
  if (!url) return null;
  let asset: MediaAsset;
  try { asset = mediaFromUrl(url); } catch { return null; }
  const html = transfer?.getData("text/html");
  if (!html) return asset;
  const fragment = new DOMParser().parseFromString(html, "text/html");
  const media = fragment.querySelector("img[src], video[src], audio[src], source[src], embed[src]");
  if (media?.getAttribute("src") !== url) return asset;
  const element = media.tagName.toLowerCase() === "source" ? media.parentElement?.tagName.toLowerCase() : media.tagName.toLowerCase();
  if (element === "img") asset.kind = "image";
  else if (element === "video") asset.kind = "video";
  else if (element === "audio") asset.kind = "audio";
  else if (element === "embed" && media.getAttribute("type") === "application/pdf") asset.kind = "pdf";
  return asset;
}

export function hasMediaTransfer(transfer: DataTransfer | null): boolean {
  return Boolean(transfer?.types.includes("Files") || transfer?.types.includes("text/uri-list") || transfer?.types.includes("text/html"));
}
