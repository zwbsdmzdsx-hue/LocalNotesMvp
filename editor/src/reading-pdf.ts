import * as pdfjs from "pdfjs-dist";
import type { MediaAsset, ReadingAnchor, ReadingRect } from "../../protocol/types";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../web/node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;

const documents = new Map<string, Promise<pdfjs.PDFDocumentProxy>>();

export function loadReadingPdf(asset: MediaAsset) {
  const cached = documents.get(asset.id);
  if (cached) return cached;
  const source = asset.url.startsWith("data:")
    ? { data: Uint8Array.from(atob(asset.url.slice(asset.url.indexOf(",") + 1)), character => character.charCodeAt(0)) }
    : { url: asset.url };
  const pending = pdfjs.getDocument(source).promise.catch(error => { documents.delete(asset.id); throw error; });
  documents.set(asset.id, pending);
  return pending;
}

export async function renderReadingCover(asset: MediaAsset, canvas: HTMLCanvasElement) {
  const pdf = await loadReadingPdf(asset);
  const page = await pdf.getPage(1);
  const original = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(1, 150 / original.width) });
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.ceil(viewport.width * ratio);
  canvas.height = Math.ceil(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const context = canvas.getContext("2d")!;
  await page.render({ canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
}

export async function renderReadingPage(pdf: pdfjs.PDFDocumentProxy, pageNumber: number, width: number, zoom: number, container: HTMLElement) {
  const page = await pdf.getPage(pageNumber);
  const original = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.max(.25, Math.min(4, (width / original.width) * zoom)) });
  const sheet = document.createElement("div"); sheet.className = "reading-pdf-sheet";
  sheet.style.width = `${viewport.width}px`; sheet.style.height = `${viewport.height}px`;
  const canvas = document.createElement("canvas"); canvas.className = "reading-pdf-canvas";
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
  const context = canvas.getContext("2d")!;
  const marks = document.createElement("div"); marks.className = "reading-pdf-marks";
  const textLayer = document.createElement("div"); textLayer.className = "reading-text-layer";
  textLayer.style.setProperty("--total-scale-factor", String(viewport.scale));
  sheet.append(canvas, marks, textLayer);
  container.replaceChildren(sheet);
  await page.render({ canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
  const layer = new pdfjs.TextLayer({ textContentSource: await page.getTextContent(), container: textLayer, viewport });
  await layer.render();
  return { sheet, marks, textLayer };
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function pointOnReadingPage(sheet: HTMLElement, clientX: number, clientY: number) {
  const bounds = sheet.getBoundingClientRect();
  return { x: clamp((clientX - bounds.left) / bounds.width), y: clamp((clientY - bounds.top) / bounds.height) };
}

export function selectedReadingAnchor(textLayer: HTMLElement, sheet: HTMLElement, bookId: string, page: number): ReadingAnchor | null {
  const selection = document.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return null;
  if (!textLayer.contains(selection.anchorNode) || !textLayer.contains(selection.focusNode)) return null;
  const quote = selection.toString().trim();
  if (!quote) return null;
  const bounds = sheet.getBoundingClientRect();
  const rects: ReadingRect[] = [...selection.getRangeAt(0).getClientRects()].filter(rect => rect.width > 1 && rect.height > 1).map(rect => ({
    x: clamp((rect.left - bounds.left) / bounds.width), y: clamp((rect.top - bounds.top) / bounds.height),
    width: clamp(rect.width / bounds.width), height: clamp(rect.height / bounds.height)
  })).filter(rect => rect.x < 1 && rect.y < 1);
  if (!rects.length) return null;
  return { bookId, page, x: rects[0].x, y: rects[0].y, rects, quote };
}
