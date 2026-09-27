import mammoth from "mammoth";
// pptx-preview ships a declaration that does not match its browser ESM entry.
// Keep the adapter local so the rest of the reader only sees a small preview API.
// @ts-expect-error The package's ESM file has no published declaration.
import { init as initPptx } from "../../web/node_modules/pptx-preview/dist/pptx-preview.es.js";
import type { MediaAsset, ReadingFormat } from "../../protocol/types";
import { renderMarkdown } from "./markdown";

export type ReadingOutlineItem = { level: number; text: string };

const codeExtensions = /\.(asm|bat|c|cc|clj|cljs|cpp|cr|cs|css|cxx|dart|ex|exs|fs|fsx|gd|go|h|hpp|html?|ini|ipynb|java|jl|js|jsx|json|kt|less|lua|m|mm|pas|php|pl|ps1|py|r|rb|rs|sass|scala|scss|sh|sql|swift|toml|ts|tsx|vb|vbs|vue|wasm|xml|xsl|yaml|yml|zig)$/i;
const markdownExtensions = /\.(md|markdown|mdown)$/i;
const wordExtensions = /\.(docx|doc)$/i;
const presentationExtensions = /\.(pptx|ppt)$/i;

export function readingFormat(asset: Pick<MediaAsset, "name" | "mimeType">): ReadingFormat {
  const name = asset.name.toLocaleLowerCase();
  const mime = asset.mimeType.toLocaleLowerCase();
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (markdownExtensions.test(name) || mime === "text/markdown") return "markdown";
  if (wordExtensions.test(name) || mime.includes("wordprocessingml") || mime === "application/msword") return "word";
  if (presentationExtensions.test(name) || mime.includes("presentationml") || mime === "application/vnd.ms-powerpoint") return "presentation";
  if (codeExtensions.test(name) || mime.startsWith("text/")) return codeExtensions.test(name) ? "code" : "text";
  return "unsupported";
}

function dataToBytes(url: string) {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return null;
  const body = url.slice(comma + 1);
  if (/;base64/i.test(url.slice(0, comma))) {
    const binary = atob(body);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

export async function readAssetBytes(asset: MediaAsset) {
  const local = dataToBytes(asset.url);
  if (local) return local;
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`无法读取 ${asset.name}（${response.status}）`);
  return new Uint8Array(await response.arrayBuffer());
}

async function readText(asset: MediaAsset) {
  return new TextDecoder().decode(await readAssetBytes(asset));
}

function documentSheet(container: HTMLElement, format: ReadingFormat) {
  container.className = `reading-page-slot reading-document-slot reading-document-${format}`;
  container.replaceChildren();
  const sheet = document.createElement("article"); sheet.className = "reading-document-sheet";
  const content = document.createElement("div"); content.className = "reading-document-content";
  sheet.append(content); container.append(sheet);
  return { sheet, content };
}

function message(container: HTMLElement, text: string) {
  container.replaceChildren();
  const paragraph = document.createElement("p"); paragraph.className = "reading-document-message"; paragraph.textContent = text;
  container.append(paragraph);
}

/** Render non-PDF reading materials inside the reading window. */
export async function renderReadingDocument(asset: MediaAsset, container: HTMLElement) {
  const format = readingFormat(asset);
  const { sheet, content } = documentSheet(container, format);
  try {
    if (format === "markdown") {
      const source = await readText(asset);
      content.innerHTML = renderMarkdown(source);
      return { format, sheet, textLayer: undefined as HTMLElement | undefined, outline: [...source.matchAll(/^\s{0,3}(#{1,6})\s+(.+)$/gm)].map(match => ({ level: match[1].length, text: match[2].trim() })) };
    }
    if (format === "text" || format === "code") {
      const source = await readText(asset);
      const pre = document.createElement("pre"); pre.className = "reading-code-content";
      if (format === "code") pre.dataset.language = asset.name.split(".").pop()?.toLocaleLowerCase() ?? "text";
      pre.textContent = source; content.replaceChildren(pre);
      return { format, sheet, textLayer: pre, outline: source.split(/\r?\n/).filter(line => /^\s*(#{1,6})\s+/.test(line)).map(line => { const match = line.match(/^\s*(#{1,6})\s+(.+)/)!; return { level: match[1].length, text: match[2].trim() }; }) };
    }
    if (format === "word") {
      const result = await mammoth.convertToHtml({ arrayBuffer: (await readAssetBytes(asset)).buffer });
      content.innerHTML = result.value || `<p>${asset.name}</p>`;
      return { format, sheet, textLayer: content, outline: [...content.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].map(node => ({ level: Number(node.tagName.slice(1)), text: node.textContent?.trim() ?? "" })).filter(item => item.text) };
    }
    if (format === "presentation") {
      const bounds = sheet.getBoundingClientRect();
      const preview = initPptx(content, { width: Math.max(480, bounds.width - 24), height: Math.max(320, bounds.height - 24), mode: "list" });
      await preview.preview((await readAssetBytes(asset)).buffer);
      return { format, sheet, textLayer: undefined as HTMLElement | undefined };
    }
    message(content, `${asset.name} 暂不支持直接预览，请在浏览器中打开原文件。`);
    const link = document.createElement("a"); link.href = asset.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "打开原文件";
    content.append(link);
    return { format, sheet, textLayer: undefined as HTMLElement | undefined };
  } catch (error) {
    message(content, error instanceof Error ? error.message : `无法渲染 ${asset.name}`);
    const link = document.createElement("a"); link.href = asset.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "在浏览器打开原文件"; content.append(link);
    return { format, sheet, textLayer: undefined as HTMLElement | undefined };
  }
}

export function readingCoverLabel(asset: MediaAsset) {
  const format = readingFormat(asset);
  return format === "markdown" ? "MD" : format === "word" ? "DOCX" : format === "presentation" ? "PPTX" : format === "code" ? "CODE" : format === "text" ? "TXT" : format.toUpperCase();
}
