import type { Block } from "../../protocol/types";
import { headingLevelFromMarkdown } from "./heading-block-editor";
import { blockModules } from "./block-modules";

/** Apply the canonical layout rules shared by document, Canvas and reading surfaces. */
export function normalizeLoadedBlocks(blocks: Block[]) {
  const normalized = migrateLegacyColumns(blocks).map(normalizeCanonicalBlockProperties);
  normalized.forEach(block => {
    if (block.properties.columnGroup) {
      block.parentId = null;
      return;
    }
    if (!block.parentId || blockModules.require(block.type).editor.ordinaryReferenceHost === false) return;
    block.parentId = null;
    const { column: _column, columnGroup: _group, columnWidths: _widths, ...properties } = block.properties;
    block.properties = properties;
  });
  return normalized;
}

/** Return the nesting depth used by the shared block surface renderer. */
export function blockDepth(block: Block, all: Block[]) {
  let depth = 0;
  let parentId = block.parentId;
  const visited = new Set<string>();
  while (parentId && depth < 8 && !visited.has(parentId)) {
    visited.add(parentId);
    parentId = all.find(candidate => candidate.id === parentId)?.parentId ?? null;
    depth++;
  }
  return depth;
}

export function columnIndex(block: Block, fallback = 0) {
  const value = block.properties.column;
  return Number.isInteger(value) && value! >= 0 ? value! : fallback;
}

/** Remove the shared column placement metadata while keeping block styling. */
export function clearColumnPlacement(block: Block) {
  const { columnGroup: _group, column: _column, columnWidths: _widths, ...properties } = block.properties;
  block.properties = properties;
  block.parentId = null;
}

/** Put a block in a canonical column group without changing its document order. */
export function setColumnMember(block: Block, groupId: string, column: number, widths = [1, 1]) {
  block.parentId = null;
  block.properties = { ...block.properties, columnGroup: groupId, column, columnWidths: widths };
}

/** Convert the legacy hidden column-layout block into ordinary column members. */
export function migrateLegacyColumns(blocks: Block[]) {
  const layouts = blocks.filter(block => block.properties.layout === "columns");
  if (!layouts.length) return blocks;
  const replacements = new Map<string, { group: string; parentId: string | null }>();
  for (const layout of layouts) {
    const group = `columns-${layout.id}`;
    for (const block of blocks) {
      if (block.id === layout.id) continue;
      let parent = block.parentId;
      const visited = new Set<string>();
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        if (parent === layout.id) {
          replacements.set(block.id, { group, parentId: layout.parentId });
          break;
        }
        parent = blocks.find(candidate => candidate.id === parent)?.parentId ?? null;
      }
    }
  }
  return blocks.filter(block => block.properties.layout !== "columns").map(block => {
    const replacement = replacements.get(block.id);
    if (!replacement) return block;
    const { column, columnCount: _count, columnGap: _gap, ...properties } = block.properties;
    return {
      ...block,
      parentId: replacement.parentId,
      properties: { ...properties, columnGroup: replacement.group, column: column ?? 0 }
    };
  });
}

/** Fill canonical properties after loading older snapshots. */
export function normalizeCanonicalBlockProperties(block: Block) {
  if (blockModules.require(block.type).headingRole) {
    const parsedLevel = headingLevelFromMarkdown(block.content);
    if (!block.properties.headingLevel) block.properties.headingLevel = parsedLevel ?? 1;
  }
  if (block.properties.columnGroup) {
    const { layout: _layout, columnCount: _count, columnGap: _gap, ...properties } = block.properties;
    block.properties = properties;
  }
  if (block.properties.databaseViewId) {
    const { databaseViewId: _view, ...properties } = block.properties;
    block.properties = properties;
  }
  return block;
}
