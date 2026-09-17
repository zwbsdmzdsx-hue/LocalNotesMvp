import type { Block, EditorState, SaveMutation } from "../../protocol/types";

/** In-memory implementation of the SQLite snapshot contract, including retained ID ownership. */
export class MockSaveStore {
  private receipts = new Map<string, Map<string, number>>();
  private owners = new Map<string, { documentId: string; scope: string }>();

  constructor(private documents: Map<string, EditorState>) { this.rememberOwners(); }

  private rememberOwners() {
    for (const [documentId, state] of this.documents) {
      for (const block of state.blocks) this.owners.set(block.id, { documentId, scope: "canonical" });
      for (const reference of state.references) for (const block of reference.blocks) {
        if (block.scopeType === "reference_instance")
          this.owners.set(block.id, { documentId, scope: reference.id });
      }
    }
  }

  save(mutation: SaveMutation) {
    const state = this.documents.get(mutation.documentId);
    if (!state || !mutation.mutationId?.trim()) throw new Error("保存需要有效文档和 mutationId");
    const previousVersion = this.receipts.get(mutation.documentId)?.get(mutation.mutationId);
    if (previousVersion !== undefined) return previousVersion;
    if (!Number.isSafeInteger(mutation.clientVersion) || mutation.clientVersion <= state.note.clientVersion)
      throw new Error("过期保存版本");
    this.rememberOwners();
    this.validate(mutation.documentId, mutation.blocks);
    const previous = new Map(state.blocks.map(block => [block.id, block]));
    const blocks = structuredClone(mutation.blocks);
    for (const block of blocks) {
      block.properties ??= {};
      const old = previous.get(block.id);
      const changed = !old || old.parentId !== block.parentId || old.position !== block.position || old.type !== block.type ||
        JSON.stringify(old.content) !== JSON.stringify(block.content) || JSON.stringify(old.properties) !== JSON.stringify(block.properties);
      block.revision = old ? old.revision + Number(changed) : 1;
    }
    state.blocks = blocks;
    state.note.title = mutation.title?.trim() || "未命名笔记";
    const version = ++state.note.clientVersion;
    const receipts = this.receipts.get(mutation.documentId) ?? new Map<string, number>();
    receipts.set(mutation.mutationId, version);
    this.receipts.set(mutation.documentId, receipts);
    this.rememberOwners();
    return version;
  }

  private validate(documentId: string, blocks: Block[]) {
    if (!Array.isArray(blocks)) throw new Error("blocks 必须是数组");
    const incoming = new Map<string, Block>();
    for (const block of blocks) {
      if (!block?.id?.trim() || incoming.has(block.id)) throw new Error("块 ID 不能为空或重复");
      const owner = this.owners.get(block.id);
      if (owner && (owner.documentId !== documentId || owner.scope !== "canonical"))
        throw new Error("块属于其他文档或引用实例");
      if (block.content === undefined) throw new Error("块内容不能为空");
      for (const value of [block.content, block.properties]) {
        if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value)))
          throw new Error("块内容和属性必须是对象");
      }
      incoming.set(block.id, block);
    }
    for (const block of blocks) {
      const seen = new Set([block.id]);
      let parent = block.parentId;
      while (parent != null) {
        const ancestor = incoming.get(parent);
        if (!ancestor) throw new Error("父块必须在当前文档快照内");
        if (seen.has(parent)) throw new Error("块树不能成环");
        seen.add(parent);
        parent = ancestor.parentId;
      }
    }
  }
}
