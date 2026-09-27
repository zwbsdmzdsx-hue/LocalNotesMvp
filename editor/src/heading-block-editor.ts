import type { Block } from "../../protocol/types";
import type { BlockContent } from "../../protocol/types";
import { markdownFromContent } from "./markdown";
import type { BlockSnapshotReader } from "./block-snapshot";
import { readTextBlockSnapshotWithVariant, type TextBlockVariant, type TextSnapshotVariant } from "./text-block-editor";

export function headingLevelFromMarkdown(content: BlockContent) {
  const line = markdownFromContent(content).split(/\r?\n/).find(value => value.trim()) ?? "";
  const match = line.match(/^\s*(#{1,6})[ \u3000]+/);
  return match ? match[1].length as 1 | 2 | 3 | 4 | 5 | 6 : undefined;
}

export function headingLevel(block: Block) {
  return block.type === "heading"
    ? (block.properties.headingLevel ?? headingLevelFromMarkdown(block.content) ?? 1)
    : undefined;
}

export function isHeadingBlock(block: Pick<Block, "type">) {
  return block.type === "heading";
}

export function headingBodyText(block: Block) {
  return (block.content.markdown ?? block.content.text ?? "").replace(/^#{1,6}\s+/, "");
}

export function headingSourcePrefix(block: Block) {
  return `${"#".repeat(headingLevel(block) ?? 1)} `;
}

export function headingCanvasTextBehavior(context: Parameters<NonNullable<import("./module-registry").BlockDefinition["canvasTextBehavior"]>>[0]) {
  return {
    onChange() {
      if (context.splitLines(context.parentId, context.nodeId, context.textarea, context.commit)) return true;
      context.commit();
      return false;
    },
    onEnter() {
      context.splitAtCaret(context.parentId, context.nodeId, context.textarea, context.commit);
    }
  };
}

export function headingCanvasDecorate(
  _body: HTMLElement,
  _block: Block,
  services: { renderChildren?(): void }
) {
  services.renderChildren?.();
}

const headingSnapshotVariant: TextSnapshotVariant = {
  content: (shell, previous, context) => {
    const editable = shell.querySelector<HTMLElement>(":scope > .block-row > .block-text");
    if (!editable || context.mode === "preview") return previous?.content ?? { text: "", html: "", markdown: "" };
    return context.mode === "source"
      ? context.contentFromMarkdown(context.sourceText(editable), previous?.content ?? { text: "", html: "" })
      : context.contentFromRichEditable(editable, previous?.content ?? { text: "", html: "" });
  },
  enrich: (_shell, previous, content, properties, context) => ({
    content,
    properties: { ...properties, headingLevel: context.headingLevelFromMarkdown(content) ?? previous?.properties.headingLevel ?? 1 }
  })
};

export const readHeadingBlockSnapshot: BlockSnapshotReader = (shell, previous, context) =>
  readTextBlockSnapshotWithVariant(shell, previous, context, headingSnapshotVariant);

export const headingTextVariant: TextBlockVariant = {
  className: "heading",
  source: block => block.content.markdown ?? block.content.text,
  preview: block => block.content.markdown,
  rich: block => ({ html: block.content.html, markdown: block.content.markdown, text: block.content.text }),
  decorate: (row, block, actions) => attachHeadingToggle(row, block, button => actions.toggleHeading(block, button))
};

function updateHeadingToggle(toggle: HTMLButtonElement, collapsed: boolean) {
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.textContent = collapsed ? "▸" : "▾";
  toggle.title = collapsed ? "展开标题内容" : "折叠标题内容";
  toggle.setAttribute("aria-label", toggle.title);
}

export function applyHeadingCollapseVisibility(surface: HTMLElement, blocks: Block[]) {
  const byId = new Map(blocks.map(block => [block.id, block]));
  const containers: HTMLElement[] = [surface, ...surface.querySelectorAll<HTMLElement>(".column-track")];
  containers.forEach(container => {
    let collapsedLevel: number | null = null;
    [...container.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches("[data-own-block]"))
      .forEach(shell => {
        const block = byId.get(shell.dataset.id ?? "");
        if (!block) return;
        const level = headingLevel(block);
        if (level !== undefined && collapsedLevel !== null && level <= collapsedLevel) collapsedLevel = null;
        const hidden = collapsedLevel !== null;
        shell.hidden = hidden;
        shell.classList.toggle("heading-section-hidden", hidden);
        const toggle = shell.querySelector<HTMLButtonElement>(":scope > .block-row > .heading-collapse-toggle");
        if (toggle && level !== undefined) updateHeadingToggle(toggle, !!block.properties.headingCollapsed);
        if (level !== undefined && !hidden && block.properties.headingCollapsed) collapsedLevel = level;
      });
  });
}

export function toggleHeadingSection(block: Block, button: HTMLButtonElement, surface: HTMLElement, blocks: Block[]) {
  if (block.type !== "heading") return false;
  block.properties.headingCollapsed = !block.properties.headingCollapsed;
  updateHeadingToggle(button, !!block.properties.headingCollapsed);
  applyHeadingCollapseVisibility(surface, blocks);
  return true;
}

export function attachHeadingToggle(
  row: HTMLElement, block: Block, onToggle: (button: HTMLButtonElement) => void
) {
  const grip = row.querySelector<HTMLButtonElement>(".grip")!;
  const toggle = document.createElement("button"); toggle.type = "button";
  toggle.className = "heading-collapse-toggle";
  updateHeadingToggle(toggle, !!block.properties.headingCollapsed);
  toggle.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation(); onToggle(toggle);
  });
  grip.insertAdjacentElement("afterend", toggle);
}
