import type { EditorState } from "../../protocol/types";
import type { WorkspaceItemKind } from "./workspace-api";
import type { ModuleRegistry, DocumentModule } from "./module-registry";

export function createDocumentRouter(modules: ModuleRegistry<DocumentModule>) {
  let active: DocumentModule | null = null;
  let activeId: string | null = null;
  return {
    open(kind: WorkspaceItemKind, state: EditorState, source?: EditorState | null) {
      const next = modules.require(kind);
      if (active && (active !== next || activeId !== state.note.id)) active.runtime.close();
      active = next;
      activeId = state.note.id;
      next.runtime.open(state, source);
    },
    update(state: EditorState) { active?.runtime.update(state); },
    async flush() { await active?.runtime.flush(); },
    focusBlock(blockId: string) { active?.runtime.focusBlock(blockId); },
    async restoreHistory(entryId: string) { await active?.runtime.restoreHistory(entryId); },
    kind() { return active?.id ?? null; }
  };
}
