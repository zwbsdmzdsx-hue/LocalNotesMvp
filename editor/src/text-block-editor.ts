import type { Block, BlockContent, BlockProperties, LinkToken } from "../../protocol/types";
import { markdownFromContent } from "./markdown";
import type { BlockSnapshotReader } from "./block-snapshot";

export type TextBlockRowActions = {
  markdownHtml(source: string, links?: readonly LinkToken[]): string;
  renderLinkedHtml(html: string): string;
  toggleHeading(block: Block, button: HTMLButtonElement): void;
  saveTodo(): void;
  focus(editable: HTMLElement): void;
  input(editable: HTMLElement): void;
  keydown(event: KeyboardEvent): void;
  remove(row: HTMLElement): void;
};

export type TextBlockVariant = {
  className?: string;
  source(block: Block): string;
  preview(block: Block): string | undefined;
  rich(block: Block): { html?: string; markdown?: string; text: string };
  mount?(row: HTMLElement, block: Block, mode: "rich" | "source" | "preview", onChange: () => void): void;
  decorate?(row: HTMLElement, block: Block, actions: TextBlockRowActions): void;
};

export const plainTextVariant: TextBlockVariant = {
  source: block => markdownFromContent(block.content),
  preview: block => block.content.markdown,
  rich: block => ({ html: block.content.html, markdown: block.content.markdown, text: block.content.text })
};

export type TextSnapshotVariant = {
  content(shell: HTMLElement, previous: Block | undefined, context: Parameters<BlockSnapshotReader>[2]): BlockContent;
  enrich(shell: HTMLElement, previous: Block | undefined, content: BlockContent, properties: BlockProperties,
    context: Parameters<BlockSnapshotReader>[2]): { content: BlockContent; properties: BlockProperties };
};

const plainSnapshotVariant: TextSnapshotVariant = {
  content: (shell, previous, context) => {
    const editable = shell.querySelector<HTMLElement>(":scope > .block-row > .block-text");
    if (!editable || context.mode === "preview") return previous?.content ?? { text: "", html: "", markdown: "" };
    return context.mode === "source"
      ? context.contentFromMarkdown(context.sourceText(editable), previous?.content ?? { text: "", html: "" })
      : context.contentFromRichEditable(editable, previous?.content ?? { text: "", html: "" });
  },
  enrich: (_shell, previous, content, properties) => ({
    content,
    properties: { ...(previous?.properties ?? {}), ...properties }
  })
};

export function readTextBlockSnapshotWithVariant(
  shell: HTMLElement, previous: Block | undefined, context: Parameters<BlockSnapshotReader>[2],
  variant: TextSnapshotVariant = plainSnapshotVariant
) {
  const editable = shell.querySelector<HTMLElement>(":scope > .block-row > .block-text");
  if (!editable) return {
    content: previous?.content ?? { text: "", html: "" },
    properties: previous?.properties ?? {}
  };
  const { mode } = context;
  const columnPlacement = context.columnGroup
    ? { columnGroup: context.columnGroup, column: context.column }
    : shell.dataset.column === "" ? {} : { column: Number(shell.dataset.column) };
  const properties: BlockProperties = mode === "rich" ? {
    ...(previous?.properties ?? {}),
    background: editable.style.backgroundColor || undefined,
    textColor: editable.style.color || undefined,
    textAlign: editable.style.textAlign === "left" || editable.style.textAlign === "center" || editable.style.textAlign === "right"
      ? editable.style.textAlign : undefined,
    ...columnPlacement
  } : {
    ...(previous?.properties ?? {}),
    ...(previous?.properties.textAlign ? { textAlign: previous.properties.textAlign } : {}),
    ...columnPlacement
  };
  const content = variant.content(shell, previous, context);
  return variant.enrich(shell, previous, content, properties, context);
}

export const readTextBlockSnapshot: BlockSnapshotReader = (shell, previous, context) =>
  readTextBlockSnapshotWithVariant(shell, previous, context);

function escapeText(value: string) {
  const span = document.createElement("span"); span.textContent = value;
  return span.innerHTML;
}

export function renderTextBlockRow(
  block: Block, mode: "rich" | "source" | "preview", actions: TextBlockRowActions,
  variant: TextBlockVariant = plainTextVariant
) {
  const row = document.createElement("div"); row.className = "block-row";
  row.innerHTML = `<button type="button" class="grip" aria-label="块菜单" draggable="${mode !== "preview"}">⠿</button><div class="block-text ${variant.className ?? ""}"></div><button class="delete-block" title="删除块">×</button>`;
  variant.decorate?.(row, block, actions);
  const editable = row.querySelector<HTMLElement>(".block-text")!;
  variant.mount?.(row, block, mode, actions.saveTodo);
  if (mode === "source") {
    editable.classList.add("markdown-source");
    editable.contentEditable = "plaintext-only";
    editable.spellcheck = false;
    editable.textContent = variant.source(block);
  } else if (mode === "preview") {
    editable.classList.add("markdown-preview");
    const source = variant.preview(block);
    editable.innerHTML = source !== undefined
      ? actions.markdownHtml(source, block.content.links)
      : actions.renderLinkedHtml(block.content.html || escapeText(block.content.text));
  } else {
    editable.classList.add("rich-editor");
    editable.contentEditable = "true";
    const rich = variant.rich(block);
    const source = variant.preview(block);
    editable.innerHTML = rich.html
      ? actions.renderLinkedHtml(rich.html)
      : source !== undefined
        ? actions.markdownHtml(source, block.content.links)
        : escapeText(rich.text);
    editable.dataset.originalHtml = editable.innerHTML;
  }
  editable.style.backgroundColor = block.properties.background ?? "";
  editable.style.color = block.properties.textColor ?? "";
  editable.style.textAlign = block.properties.textAlign ?? "";
  if (mode !== "preview") {
    editable.addEventListener("focus", () => actions.focus(editable));
    editable.addEventListener("input", event => {
      if (event.target === editable) actions.input(editable);
    });
    editable.addEventListener("keydown", actions.keydown);
  }
  const remove = row.querySelector<HTMLButtonElement>(".delete-block")!;
  remove.addEventListener("click", () => actions.remove(row));
  remove.disabled = mode === "preview";
  return row;
}
