import type { EditorState } from "../../protocol/types";

export type HistoryKind = "initial" | "edit" | "command" | "restore";

export type HistoryEntry = {
  id: string;
  documentId: string;
  timestamp: number;
  label: string;
  kind: HistoryKind;
  state: EditorState;
};

export type HistoryModel = {
  documentId: string;
  entries: Array<Pick<HistoryEntry, "id" | "timestamp" | "label" | "kind">>;
  currentId: string;
  canUndo: boolean;
  canRedo: boolean;
};

export type HistoryMove = {
  from: number;
  to: number;
  entry: HistoryEntry;
};

const STORAGE_PREFIX = "lnm-editor-history-v1:";
const MAX_ENTRIES = 80;
const COALESCE_WINDOW_MS = 900;

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function entryId() {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `history-${random}` : `history-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Browser history for one editor document. Snapshots are persisted locally so the
 * history panel remains useful after a browser refresh, while the actual document
 * restore still goes through the host save queue in core.ts. */
export class EditorHistory {
  private entries: HistoryEntry[] = [];
  private cursor = -1;
  private documentId = "";

  load(documentId: string, state: EditorState) {
    this.documentId = documentId;
    this.entries = this.read(documentId);
    this.cursor = this.entries.length - 1;
    const latest = this.entries[this.cursor];
    if (!latest || JSON.stringify(latest.state) !== JSON.stringify(state)) {
      this.entries.push({ id: entryId(), documentId, timestamp: Date.now(), label: "重新载入", kind: "initial", state: clone(state) });
      this.cursor = this.entries.length - 1;
      this.trimAndWrite();
    }
  }

  record(state: EditorState, label: string, kind: HistoryKind = "edit") {
    if (!this.documentId || state.note.id !== this.documentId) return;
    const now = Date.now();
    const current = this.entries[this.cursor];
    // A run of keystrokes is one user action for undo purposes, like Notion.
    if (current && current.kind === "edit" && kind === "edit" && now - current.timestamp <= COALESCE_WINDOW_MS) {
      current.timestamp = now;
      current.label = label;
      current.state = clone(state);
      this.trimAndWrite();
      return;
    }
    if (this.cursor < this.entries.length - 1) this.entries.splice(this.cursor + 1);
    this.entries.push({ id: entryId(), documentId: this.documentId, timestamp: now, label, kind, state: clone(state) });
    this.cursor = this.entries.length - 1;
    this.trimAndWrite();
  }

  beginUndo(): HistoryMove | null {
    return this.beginMove(this.cursor - 1);
  }

  beginRedo(): HistoryMove | null {
    return this.beginMove(this.cursor + 1);
  }

  beginRestore(id: string): HistoryMove | null {
    const target = this.entries.findIndex(entry => entry.id === id);
    return target < 0 ? null : this.beginMove(target);
  }

  commit(move: HistoryMove) {
    if (this.cursor === move.from) {
      this.cursor = move.to;
      this.trimAndWrite();
    }
  }

  rollback(move: HistoryMove) {
    if (this.cursor === move.from) return;
    this.cursor = move.from;
  }

  model(): HistoryModel {
    return {
      documentId: this.documentId,
      entries: this.entries.map(({ id, timestamp, label, kind }) => ({ id, timestamp, label, kind })),
      currentId: this.entries[this.cursor]?.id ?? "",
      canUndo: this.cursor > 0,
      canRedo: this.cursor >= 0 && this.cursor < this.entries.length - 1
    };
  }

  stateFor(move: HistoryMove): EditorState {
    return clone(move.entry.state);
  }

  private beginMove(target: number): HistoryMove | null {
    if (target < 0 || target >= this.entries.length || target === this.cursor) return null;
    const from = this.cursor;
    const entry = this.entries[target];
    return { from, to: target, entry: clone(entry) };
  }

  private read(documentId: string): HistoryEntry[] {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + documentId);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as HistoryEntry[];
      return Array.isArray(parsed) ? parsed.filter(item => item?.documentId === documentId && item?.state?.note?.id === documentId).slice(-MAX_ENTRIES) : [];
    } catch {
      return [];
    }
  }

  private trimAndWrite() {
    if (this.entries.length > MAX_ENTRIES) {
      const remove = this.entries.length - MAX_ENTRIES;
      this.entries.splice(0, remove);
      this.cursor -= remove;
    }
    try { localStorage.setItem(STORAGE_PREFIX + this.documentId, JSON.stringify(this.entries)); } catch { /* storage is optional */ }
  }
}
