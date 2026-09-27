import type { Block } from "../../protocol/types";
import { blockModules } from "./block-modules";

/** Stable, type-aware text used by the browser's native drag ghost. */
export function blockSummaryForDrag(block: Block) {
  return blockModules.require(block.type).label(block).trim() || "空白块";
}

/** Whether targetId is inside sourceId's block subtree. */
export function isBlockDescendant(blocks: readonly Block[], sourceId: string, targetId: string) {
  const parentOf = new Map<string, string | null>();
  for (const block of blocks) parentOf.set(block.id, block.parentId);
  let current: string | null = targetId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current === sourceId) return true;
    current = parentOf.get(current) ?? null;
  }
  return false;
}
