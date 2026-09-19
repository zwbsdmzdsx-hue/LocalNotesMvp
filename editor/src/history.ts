import type { EditorState, HistoryModel } from "../../protocol/types";
export type { HistoryModel } from "../../protocol/types";
type Snapshot = { state: EditorState; moves: Array<[string, Array<[string, { parentId: string | null; position: string }]>]> };
type Entry = { id: string; timestamp: number; label: string; kind: string; group?: string; snapshot: Snapshot };
// Browser fixtures and their history share the same in-memory lifetime.
export class EditorHistory {
  private entries: Entry[] = [];
  private stack: string[] = [];
  private cursor = -1;
  private signature(snapshot: Snapshot) {
    const copy = structuredClone(snapshot);
    delete copy.state.history;
    copy.state.documents = []; copy.state.backlinks = []; copy.state.overrideNotices = [];
    copy.state.note.clientVersion = 0;
    for (const block of copy.state.blocks) block.revision = 0;
    for (const ref of copy.state.references) { ref.blocks = ref.blocks.filter(b => b.scopeType === "reference_instance"); ref.targetTitle = ""; delete ref.broken; }
    return JSON.stringify(copy);
  }
  record(snapshot: Snapshot, label: string, group?: string) {
    const current = this.entries.find(e => e.id === this.stack[this.cursor]);
    if (current && this.signature(current.snapshot) === this.signature(snapshot)) return;
    const now = Date.now();
    if (group && current?.kind === "edit" && current.group === group && this.cursor === this.stack.length - 1 && now - current.timestamp <= 900) {
      current.snapshot = structuredClone(snapshot); current.timestamp = now;
    } else this.append({ id: crypto.randomUUID(), timestamp: now, label, kind: !current ? "initial" : group ? "edit" : "command", group, snapshot: structuredClone(snapshot) });
  }
  private append(entry: Entry) {
    this.stack.splice(this.cursor + 1); this.entries.push(entry); this.stack.push(entry.id); this.cursor = this.stack.length - 1;
    while (this.entries.length > 80) {
      const removed = this.entries.shift()!; const index = this.stack.indexOf(removed.id);
      if (index >= 0) { this.stack.splice(index, 1); if (this.cursor >= index) this.cursor--; }
    }
  }
  move(operation: string, id?: string) {
    const target = operation === "history-undo" ? this.cursor - 1 : this.cursor + 1;
    const entry = this.entries.find(e => e.id === (operation === "history-restore" ? id : this.stack[target]));
    if (!entry) throw new Error("没有可恢复的历史版本");
    const snapshot = structuredClone(entry.snapshot);
    if (operation === "history-restore") this.append({ id: crypto.randomUUID(), timestamp: Date.now(), label: "恢复历史版本", kind: "restore", snapshot });
    else { this.cursor = target; entry.group = undefined; }
    return structuredClone(snapshot);
  }
  model(documentId: string): HistoryModel {
    return { documentId, currentId: this.stack[this.cursor] ?? "", canUndo: this.cursor > 0, canRedo: this.cursor >= 0 && this.cursor < this.stack.length - 1,
      entries: this.entries.map(e => ({ id: e.id, timestamp: e.timestamp, label: e.label, kind: e.kind, title: e.snapshot.state.note.title,
        preview: e.snapshot.state.blocks.map(b => b.content.text).join("\n").slice(0, 12000) })) };
  }
}
