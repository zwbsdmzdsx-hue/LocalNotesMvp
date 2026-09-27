import type { Block, BlockContent, EditorState, ReferenceInstance, ReferenceTargetScope } from "../../protocol/types";
import { headingSection } from "./link-suggestions";
import { blockModules } from "./block-modules";
import { visibleReferenceBlocks } from "./reference-card";
import type { OrdinaryLinkSidebarEntry } from "./reference-sidebar-panel";

export type LinkDestination = {
  documentId: string;
  blockId?: string;
  recordId?: string;
  fieldKey?: string;
  targetScope?: ReferenceTargetScope;
  referenceId?: string;
  anchor: HTMLElement;
};

export function linkDestination(element: EventTarget | null, state: EditorState | null): LinkDestination | null {
  const anchor = (element as HTMLElement | null)?.closest<HTMLElement>(".wiki-link, .reference-title");
  if (!anchor || !state) return null;
  const rawTitle = (anchor.dataset.targetTitle ?? anchor.dataset.title ?? "").trim();
  const leafTitle = rawTitle.split("/").map(part => part.trim()).filter(Boolean).pop() ?? rawTitle;
  const documentId = anchor.dataset.targetId ?? state.documents.find(item =>
    item.title === rawTitle || item.title === leafTitle || item.path === rawTitle || item.path?.endsWith(`/${rawTitle}`))?.id;
  return documentId ? {
    documentId,
    blockId: anchor.dataset.targetBlockId,
    recordId: anchor.dataset.targetRecordId,
    fieldKey: anchor.dataset.targetFieldKey,
    targetScope: anchor.dataset.targetScope as ReferenceTargetScope | undefined,
    referenceId: anchor.dataset.referenceId,
    anchor
  } : null;
}

export function ordinaryLinkFromDestination(target: LinkDestination, state: EditorState): OrdinaryLinkSidebarEntry | null {
  const sourceBlockId = target.anchor.dataset.sourceBlockId
    ?? target.anchor.closest<HTMLElement>("[data-own-block]")?.dataset.id;
  if (!sourceBlockId) return null;
  const source = state.blocks.find(block => block.id === sourceBlockId);
  return {
    key: `${sourceBlockId}:${target.documentId}:${target.blockId ?? ""}:${target.recordId ?? ""}:${target.fieldKey ?? ""}`,
    sourceBlockId,
    documentId: target.documentId,
    blockId: target.blockId,
    targetRecordId: target.recordId,
    targetFieldKey: target.fieldKey,
    targetScope: target.targetScope,
    label: target.anchor.textContent?.trim() || state.documents.find(document => document.id === target.documentId)?.title || target.documentId,
    excerpt: source?.content.text ?? ""
  };
}

export async function projectLinkTarget(
  target: LinkDestination,
  state: EditorState,
  loadDocument: (documentId: string) => Promise<EditorState>
): Promise<ReferenceInstance> {
  const instance = state.references.find(item => item.id === target.referenceId);
  if (instance) return instance;
  const source = await loadDocument(target.documentId);
  if (target.recordId && (target.targetScope === "record" || target.targetScope === "cell")) {
    const database = source.databases?.find(item => source.databaseRecords?.[item.id]?.some(record => record.id === target.recordId));
    const record = database ? source.databaseRecords?.[database.id]?.find(item => item.id === target.recordId) : undefined;
    const fields = (database?.fields ?? []).filter(field => !target.fieldKey || field.key === target.fieldKey);
    const markdown = record ? fields.map(field => `**${field.title}:** ${String(record.values[field.key] ?? "")}`).join("\n\n") : "";
    const projected = record ? [{ id: `record-reference-${record.id}`, parentId: null, position: "00001000", type: "paragraph" as const,
      content: { text: fields.map(field => `${field.title}: ${String(record.values[field.key] ?? "")}`).join("\n"), html: "", markdown }, properties: {}, revision: 1 }] : [];
    return {
      id: "link-preview", hostBlockId: "", targetDocumentId: target.documentId,
      targetRecordId: target.recordId, targetFieldKey: target.fieldKey, targetScope: target.targetScope,
      targetTitle: source.note.title, mode: "link", blocks: projected, overrides: [], hiddenBlockIds: [], broken: !record
    };
  }
  let blocks = source.blocks;
  if (target.blockId && target.targetScope === "heading") {
    blocks = headingSection(blocks, target.blockId);
  } else if (target.blockId) {
    const ids = new Set([target.blockId]);
    for (let count = -1; count !== ids.size;) {
      count = ids.size;
      blocks.forEach(block => { if (block.parentId && ids.has(block.parentId)) ids.add(block.id); });
    }
    blocks = blocks.filter(block => ids.has(block.id));
  }
  return {
    id: "link-preview", hostBlockId: "", targetDocumentId: target.documentId,
    targetBlockId: target.blockId, targetScope: target.targetScope, targetTitle: source.note.title,
    mode: "link", blocks, overrides: [], hiddenBlockIds: [], broken: !!target.blockId && blocks.length === 0
  };
}

export type ReadOnlyProjectionServices = {
  renderText(block: Block): HTMLElement;
  resolveWikiTargets(root: ParentNode, links: readonly NonNullable<BlockContent["links"]>[number][]): void;
};

export function readOnlyProjection(reference: ReferenceInstance, context: EditorState, services: ReadOnlyProjectionServices) {
  const container = document.createElement("div");
  container.className = "link-preview-content";
  visibleReferenceBlocks(reference).forEach(block => {
    const override = reference.overrides.find(item => item.targetBlockId === block.id);
    const content = override?.patch.content ?? block.content;
    const paragraph = document.createElement("div");
    paragraph.className = "preview-block";
    paragraph.dataset.blockId = block.id;
    const preview = blockModules.require(block.type).preview({ ...block, content }, context, services.renderText);
    services.resolveWikiTargets(preview, content.links ?? []);
    paragraph.append(preview);
    container.append(paragraph);
  });
  if (!container.childElementCount) container.textContent = reference.broken ? "引用目标不存在" : "暂无内容";
  return container;
}
