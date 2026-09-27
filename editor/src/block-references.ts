import type { Backlink, Block, EditorState } from "../../protocol/types";
import { blockModules } from "./block-modules";
export { isReadingAnnotation, readingAnnotationKind, readingAnnotationMeta } from "./reading-annotation";

export function blockReferenceLabel(block: Block) {
  return blockModules.require(block.type).label(block);
}

export function documentBacklinks(targetDocumentId: string, documents: Iterable<EditorState>): Backlink[] {
  const states = [...documents];
  const target = states.find(state => state.note.id === targetDocumentId);
  if (!target) return [];
  const targetBlocks = new Map(target.blocks.map(block => [block.id, block]));
  const targetRecords = new Map<string, { databaseId: string; values: Record<string, unknown> }>();
  Object.entries(target.databaseRecords ?? {}).forEach(([databaseId, records]) => records.forEach(record => targetRecords.set(record.id, { databaseId, values: record.values })));
  const found: Backlink[] = [];
  const seen = new Set<string>();
  for (const source of states) {
    if (source.note.id === targetDocumentId) continue;
    const sourceBlocks = new Map(source.blocks.map(block => [block.id, block]));
    const add = (sourceBlockId: string, targetBlockId?: string, targetRecordId?: string, targetFieldKey?: string, targetScope?: Backlink["targetScope"]) => {
      const block = sourceBlocks.get(sourceBlockId);
      if (!block || targetBlockId && !targetBlocks.has(targetBlockId) || targetRecordId && !targetRecords.has(targetRecordId)) return;
      const key = `${source.note.id}:${sourceBlockId}:${targetBlockId ?? ""}:${targetRecordId ?? ""}:${targetFieldKey ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      const record = targetRecordId ? targetRecords.get(targetRecordId) : undefined;
      const recordLabel = targetRecordId && record ? String(record.values[targetFieldKey ?? (target.databases?.find(database => database.id === record.databaseId)?.fields.find(field => field.type === "text")?.key ?? "")] ?? targetRecordId) : targetRecordId;
      found.push({ sourceDocumentId: source.note.id, sourceTitle: source.note.title, sourceBlockId,
        targetBlockId, targetRecordId, targetFieldKey, targetScope, targetTitle: targetBlockId ? blockReferenceLabel(targetBlocks.get(targetBlockId)!) : targetRecordId ? `${targetScope === "cell" ? "单元格" : "整行"} · ${recordLabel}${targetFieldKey ? " · " + targetFieldKey : ""}` : target.note.title,
        excerpt: blockReferenceLabel(block).slice(0, 80) });
    };
    source.references.forEach(reference => {
      if (reference.targetDocumentId === targetDocumentId) add(reference.hostBlockId, reference.targetBlockId, reference.targetRecordId, reference.targetFieldKey, reference.targetScope);
    });
    source.blocks.forEach(block => {
      const links = block.content.links ?? [];
      links.forEach(link => { if (link.targetDocumentId === targetDocumentId) add(block.id, link.targetBlockId, link.targetRecordId, link.targetFieldKey, link.targetScope); });
      if (links.some(link => link.targetDocumentId === targetDocumentId)) return;
      const legacy = block.content.html || block.content.markdown || "";
      if (legacy.includes(`[[${target.note.title}]]`) || legacy.includes(`[[${target.note.title}|`)) add(block.id);
    });
    Object.values(source.databaseRecords ?? {}).flat().forEach(record => {
      Object.entries(record.cellLinks ?? {}).forEach(([fieldKey, links]) => {
        links.forEach(link => { if (link.targetDocumentId === targetDocumentId) add(record.sourceBlockId ?? record.id, link.targetBlockId, link.targetRecordId, link.targetFieldKey, link.targetScope ?? "block"); });
      });
    });
  }
  return found;
}
