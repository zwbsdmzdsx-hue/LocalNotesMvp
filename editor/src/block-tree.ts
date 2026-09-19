export type PositionedBlock = { id: string; parentId: string | null; position: string };

/**
 * Positions are relative to siblings. A flat ORDER BY position interleaves children
 * with unrelated roots, so always materialize the tree in stable preorder.
 */
export function orderBlockTree<T extends PositionedBlock>(blocks: readonly T[]): T[] {
  const ids = new Set(blocks.map(block => block.id));
  const inputIndex = new Map(blocks.map((block, index) => [block.id, index]));
  const children = new Map<string | null, T[]>();
  for (const block of blocks) {
    const parentId = block.parentId && ids.has(block.parentId) ? block.parentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(block);
    children.set(parentId, siblings);
  }
  const compare = (left: T, right: T) => left.position.localeCompare(right.position) ||
    (inputIndex.get(left.id)! - inputIndex.get(right.id)!) || left.id.localeCompare(right.id);
  children.forEach(siblings => siblings.sort(compare));

  const ordered: T[] = [];
  const visited = new Set<string>();
  const append = (block: T) => {
    if (visited.has(block.id)) return;
    visited.add(block.id);
    ordered.push(block);
    for (const child of children.get(block.id) ?? []) append(child);
  };
  for (const root of children.get(null) ?? []) append(root);
  for (const block of [...blocks].sort(compare)) append(block);
  return ordered;
}
