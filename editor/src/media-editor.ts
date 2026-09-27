import type { Block, MediaAsset } from "../../protocol/types";

export type MediaRenderVariant = "standard" | "canvas";

/** Create the element for one media asset; containers own layout and captions. */
export function renderMediaAsset(asset: MediaAsset, options: { variant?: MediaRenderVariant; alt?: string } = {}): HTMLElement {
  const variant = options.variant ?? "standard";
  let media: HTMLElement;
  if (asset.kind === "image") {
    const image = document.createElement("img"); image.src = asset.url; image.alt = options.alt || asset.name; image.loading = "lazy"; media = image;
  } else if (asset.kind === "video") {
    const video = document.createElement("video"); video.src = asset.url; video.controls = true; video.preload = "metadata"; video.playsInline = true; media = video;
  } else if (asset.kind === "audio") {
    const audio = document.createElement("audio"); audio.src = asset.url; audio.controls = true; audio.preload = "metadata"; media = audio;
  } else if (asset.kind === "pdf") {
    const frame = document.createElement("iframe"); frame.src = asset.url; frame.title = asset.name; frame.loading = "lazy"; media = frame;
  } else {
    const link = document.createElement("a"); link.href = asset.url; link.download = asset.name; link.textContent = `下载 ${asset.name}`; media = link;
  }
  if (variant === "canvas") {
    media.classList.add(asset.kind === "pdf" ? "canvas-media-pdf" : asset.kind === "file" ? "canvas-media-file" : "canvas-media-preview");
  } else {
    media.classList.add("media-player");
    if (asset.kind === "file") media.classList.add("media-file-link");
  }
  return media;
}

export type MediaEditorActions = {
  mode(): "rich" | "source" | "preview";
  canEdit(): boolean;
  select(figure: HTMLElement, editable?: HTMLElement): void;
  changeCaption(block: Block, value: string): void;
  resize(blockId: string, width: number): void;
  finishResize(): void;
};

function boundedMediaWidth(value: number | undefined) {
  return Math.max(10, Math.min(100, Number.isFinite(value) ? value! : 100));
}

export function mountMediaEditor(surface: HTMLElement, actions: MediaEditorActions) {
  let resize: { blockId: string; startX: number; startWidth: number; containerWidth: number } | null = null;

  function beginResize(event: PointerEvent, block: Block, stage: HTMLElement) {
    if (actions.mode() === "preview" || !actions.canEdit()) return;
    const container = stage.closest<HTMLElement>(".block-row") ?? stage;
    const rect = container.getBoundingClientRect();
    const current = stage.getBoundingClientRect();
    resize = {
      blockId: block.id, startX: event.clientX,
      startWidth: current.width / Math.max(1, rect.width) * 100,
      containerWidth: rect.width
    };
    stage.classList.add("is-resizing");
    try { (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId); }
    catch { /* Synthetic pointer events may not have an active pointer. */ }
    event.preventDefault(); event.stopPropagation();
  }

  function updateResize(event: PointerEvent) {
    if (!resize || !actions.canEdit()) return;
    const stage = surface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(resize.blockId)}"] .media-stage`);
    if (!stage) return;
    const width = boundedMediaWidth(resize.startWidth +
      (event.clientX - resize.startX) / Math.max(1, resize.containerWidth) * 100);
    actions.resize(resize.blockId, width);
    stage.style.width = `${width}%`;
  }

  function finishResize() {
    if (!resize || !actions.canEdit()) return;
    surface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(resize.blockId)}"] .media-stage`)
      ?.classList.remove("is-resizing");
    resize = null;
    actions.finishResize();
  }

  document.addEventListener("pointermove", updateResize);
  document.addEventListener("pointerup", finishResize);

  function renderPreview(block: Block, readonly = false): HTMLElement {
    const asset = block.content.media!;
    const figure = document.createElement("figure");
    figure.className = "media-preview";
    figure.dataset.mediaKind = asset.kind;
    const stage = document.createElement("div"); stage.className = "media-stage";
    stage.dataset.mediaAlign = block.properties.textAlign ?? "left";
    if (block.properties.mediaWidth !== undefined)
      stage.style.width = `${boundedMediaWidth(block.properties.mediaWidth)}%`;
    const media = renderMediaAsset(asset); stage.append(media);
    if (asset.kind === "image" && actions.mode() !== "preview" && !readonly) {
      const handle = document.createElement("button"); handle.type = "button";
      handle.className = "media-resize-handle"; handle.title = "拖拽调整图片尺寸";
      handle.setAttribute("aria-label", "拖拽调整图片尺寸");
      handle.addEventListener("pointerdown", event => beginResize(event, block, stage));
      stage.append(handle);
    }
    figure.append(stage);
    const caption = document.createElement("figcaption"); caption.className = "media-caption";
    const name = document.createElement("span"); name.className = "media-name";
    name.contentEditable = actions.mode() === "rich" && !readonly ? "true" : "false";
    name.dataset.placeholder = `添加 caption（${asset.name}）`;
    name.textContent = block.content.caption ?? "";
    name.addEventListener("focus", () => actions.select(figure, name));
    name.addEventListener("input", () => actions.changeCaption(block, name.textContent?.trim() ?? ""));
    if (block.content.caption || actions.mode() === "rich") caption.append(name);
    figure.addEventListener("pointerdown", () => actions.select(figure));
    figure.append(caption);
    return figure;
  }

  function renderBlockRow(block: Block, onRemove: (row: HTMLElement) => void): HTMLElement {
    const row = document.createElement("div"); row.className = "block-row media-row";
    const grip = document.createElement("button"); grip.type = "button"; grip.className = "grip";
    grip.setAttribute("aria-label", "媒体块菜单"); grip.title = "媒体块菜单";
    grip.draggable = actions.mode() !== "preview"; grip.textContent = "⠿";
    const asset = block.content.media;
    if (asset) row.append(grip, renderPreview(block));
    else {
      const missing = document.createElement("div");
      missing.className = "media-preview media-missing";
      missing.textContent = "媒体文件不可用";
      row.append(grip, missing);
    }
    const remove = document.createElement("button"); remove.type = "button";
    remove.className = "delete-block"; remove.title = "删除媒体块";
    remove.textContent = "×"; remove.disabled = actions.mode() === "preview";
    remove.addEventListener("click", () => onRemove(row));
    row.append(remove);
    return row;
  }

  return {
    renderBlockRow,
    dispose() {
      document.removeEventListener("pointermove", updateResize);
      document.removeEventListener("pointerup", finishResize);
      resize = null;
    }
  };
}
