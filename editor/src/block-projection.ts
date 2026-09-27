import type { Block, BlockContent, LinkToken } from "../../protocol/types";
import { markdownFromContent, renderMarkdown } from "./markdown";
import { previewReadingAnnotation } from "./block-preview";
import { blockModules } from "./block-modules";

export type BlockProjectionServices = {
  markdownHtml(source: string, links?: readonly LinkToken[]): string;
  renderLinkedHtml(html: string): string;
  resolveWikiTargets(root: ParentNode, links: readonly LinkToken[]): void;
};

function escapeText(value: string) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

/** Create read-only block projections without coupling the link renderer to editor state. */
export function createBlockProjection(services: BlockProjectionServices) {
  function renderTextProjection(block: Block) {
    const paragraph = document.createElement("div");
    const content = block.content;
    const source = markdownFromContent(content);
    const definition = blockModules.require(block.type);
    paragraph.innerHTML = definition.projectionPrefix && !/^\s*#{1,6}\s/.test(source)
      ? renderMarkdown(definition.projectionPrefix(block) + (definition.bodyText?.(block) ?? source))
      : content.markdown !== undefined
        ? services.markdownHtml(content.markdown, content.links)
        : services.renderLinkedHtml(content.html || escapeText(content.text));
    return paragraph;
  }

  function renderReadingAnnotationPreview(block: Block, content: BlockContent = block.content) {
    const kind = blockModules.require(block.type).readingAnnotationLabel;
    if (!kind) throw new Error(`块类型 ${block.type} 缺少阅读标注名称`);
    const wrapper = previewReadingAnnotation({ ...block, content }, kind);
    services.resolveWikiTargets(wrapper, content.links ?? []);
    return wrapper;
  }

  return { renderTextProjection, renderReadingAnnotationPreview };
}
