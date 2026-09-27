import type { Block, BlockContent, EditorState, ReferenceInstance } from "../../protocol/types";
import { blockModules } from "./block-modules";

function isReferenceHost(block: Pick<Block, "type">) {
  return blockModules.require(block.type).editor.ordinaryReferenceHost === false;
}

export function isEmbeddedReferenceBlock(block: Block, blocks: Block[], surface: HTMLElement) {
  if (!isReferenceHost(block) || !block.parentId) return false;
  const parent = blocks.find(candidate => candidate.id === block.parentId);
  if (!parent) return false;
  return !!surface.querySelector(`[data-reference-host-id="${CSS.escape(block.id)}"]`) ||
    parent.content.html?.includes(`data-reference-host-id="${block.id}"`) ||
    parent.content.markdown?.includes(`#^${block.id}`) || false;
}

export function referenceParentId(shell: HTMLElement) {
  const parentId = shell.dataset.parentId || null;
  const type = shell.dataset.type as Block["type"] | undefined;
  return type && isReferenceHost({ type }) ? parentId : null;
}

export function retainedReferenceHosts(blocks: Block[], references: ReferenceInstance[]) {
  const byId = new Map(blocks.map(block => [block.id, block]));
  const removedReferenceIds = new Set<string>();
  const retained = blocks.filter(block => {
    if (!isReferenceHost(block) || !block.parentId) return true;
    const parent = byId.get(block.parentId);
    const retainedByOwner = parent?.content.html.includes(`data-reference-host-id="${block.id}"`) ?? false;
    if (!retainedByOwner) {
      const reference = references.find(item => item.hostBlockId === block.id);
      if (reference) removedReferenceIds.add(reference.id);
    }
    return retainedByOwner;
  });
  return { retained, removedReferenceIds };
}

export function removeReferencesForBlock(shell: HTMLElement, state: EditorState | null, surface: HTMLElement) {
  const removedReferenceIds = new Set<string>();
  shell.querySelectorAll<HTMLElement>("[data-own-block][data-type]").forEach(referenceShell => {
    const type = referenceShell.dataset.type as Block["type"] | undefined;
    if (!type || !isReferenceHost({ type })) return;
    const reference = state?.references.find(item => item.hostBlockId === referenceShell.dataset.id);
    if (reference) removedReferenceIds.add(reference.id);
  });
  state?.references.filter(item => item.hostBlockId === shell.dataset.id)
    .forEach(reference => removedReferenceIds.add(reference.id));
  state?.blocks.filter(block => isReferenceHost(block) && block.parentId === shell.dataset.id).forEach(block => {
    const reference = state?.references.find(item => item.hostBlockId === block.id);
    if (reference) removedReferenceIds.add(reference.id);
    surface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(block.id)}"]`)?.remove();
  });
  return removedReferenceIds;
}

export function blockFromReferenceRow(
  row: HTMLElement, fallback: Block, mode: "rich" | "source" | "preview",
  readSource: (editable: HTMLElement) => string,
  fromMarkdown: (source: string, fallback: BlockContent) => BlockContent,
  fromRich: (editable: HTMLElement, fallback: BlockContent) => BlockContent
): Block {
  const editable = row.querySelector<HTMLElement>(".block-text")!;
  const content = mode === "source" ? fromMarkdown(readSource(editable), fallback.content)
    : mode === "preview" ? fallback.content : fromRich(editable, fallback.content);
  return {
    ...fallback,
    parentId: row.dataset.parentId || null,
    position: row.dataset.position || fallback.position,
    content,
    properties: mode === "rich"
      ? { ...fallback.properties, background: editable.style.backgroundColor || undefined,
        textColor: editable.style.color || undefined }
      : fallback.properties
  };
}

export function positionInstanceBlock(
  block: Block, reference: ReferenceInstance, parentId: string | null, afterId?: string
): Block {
  block.scopeType = "reference_instance";
  const siblings = reference.blocks.filter(item => (item.parentId ?? null) === parentId);
  const after = afterId ? siblings.find(item => item.id === afterId) : undefined;
  const used = new Set(siblings.map(item => Number(item.position)).filter(Number.isFinite));
  let position = after ? Number(after.position) + 1 : Math.max(0, ...used) + 1000;
  while (used.has(position)) position += 1;
  block.position = String(position).padStart(8, "0");
  return block;
}

export function detachedReferenceBlocks(
  reference: ReferenceInstance, hostBlock: Block, createId: () => string, createParagraph: () => Block
): Block[] {
  const hidden = new Set(reference.hiddenBlockIds);
  const overrideMap = new Map(reference.overrides.map(item => [item.targetBlockId, item]));
  const blocks: Block[] = reference.blocks
    .filter(block => block.scopeType !== "reference_instance" && !hidden.has(block.id))
    .map(source => {
      const override = overrideMap.get(source.id);
      const content = override?.patch.content ?? source.content;
      const properties = override?.patch.properties ?? source.properties;
      return {
        id: createId(), parentId: hostBlock.parentId, position: source.position, type: source.type,
        content: { text: content.text ?? "", html: content.html ?? "", links: content.links },
        properties: { ...(properties ?? {}) }, revision: 1
      };
    });
  if (!blocks.length) blocks.push({ ...createParagraph(), position: hostBlock.position });
  return blocks;
}
