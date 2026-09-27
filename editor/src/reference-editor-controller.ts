import type { Block, BlockContent, BlockProperties, EditorState, ReferenceInstance } from "../../protocol/types";
import { blockFromReferenceRow as readReferenceRowBlock, detachedReferenceBlocks, positionInstanceBlock } from "./reference-instance-editor";

export type ReferenceEditorMode = "rich" | "source" | "preview";
type Command = { type: string; [key: string]: unknown };

export type ReferenceEditorControllerDeps = {
  state(): EditorState | null;
  mode(): ReferenceEditorMode;
  newId(): string;
  createBlock(type: "paragraph", parentId: string | null): Block;
  sourceText(editable: HTMLElement): string;
  contentFromMarkdown(source: string, fallback: BlockContent): BlockContent;
  contentFromRichEditable(editable: HTMLElement, fallback: BlockContent): BlockContent;
  post(command: Command, documentId?: string): Promise<void>;
  postAfterFlush(command: Command): void;
  runAfterSaveDrain(action: () => void): void;
  renderOwnBlockShell(block: Block): HTMLElement;
  removeReferencesFromLocalState(referenceIds: ReadonlySet<string>): void;
  enqueueDocumentSave(): void;
  flushSave(): Promise<void>;
  setEditGroup(): string;
  setStatus(message: string): void;
  surface: HTMLElement;
};

export function createReferenceEditorController(deps: ReferenceEditorControllerDeps) {
  function blockFromReferenceRow(row: HTMLElement, fallback: Block): Block {
    const mode = deps.mode();
    return readReferenceRowBlock(row, fallback, mode, deps.sourceText, deps.contentFromMarkdown, deps.contentFromRichEditable);
  }

  function handleRowKeydown(event: KeyboardEvent, row: HTMLElement, reference: ReferenceInstance, source: Block) {
    if ((event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text") !== event.currentTarget || event.defaultPrevented) return;
    if (event.key !== "Enter" || event.shiftKey || deps.mode() === "preview") return;
    event.preventDefault();
    addInstanceBlock(reference, source.parentId ?? null, row);
  }

  function scheduleInstanceBlock(row: HTMLElement, source: Block) {
    const state = deps.state();
    if (!state) return;
    const referenceInstanceId = row.dataset.referenceInstanceId;
    if (!referenceInstanceId) return;
    const block = blockFromReferenceRow(row, source);
    deps.setStatus("正在保存引用专属块...");
    void deps.post({ type: "saveInstanceBlock", referenceInstanceId, block, historyGroup: deps.setEditGroup() }, state.note.id);
  }

  function addInstanceBlock(reference: ReferenceInstance, parentId: string | null, afterRow?: HTMLElement) {
    const state = deps.state();
    if (!state) return;
    const block = positionInstanceBlock(
      deps.createBlock("paragraph", parentId),
      reference,
      parentId,
      afterRow?.dataset.targetBlockId
    );
    deps.runAfterSaveDrain(() => void deps.post({ type: "saveInstanceBlock", referenceInstanceId: reference.id, block }, state.note.id).then(() => {
      const row = document.querySelector<HTMLElement>(
        `.reference-row[data-reference-instance-id="${CSS.escape(reference.id)}"][data-target-block-id="${CSS.escape(block.id)}"]`
      );
      row?.querySelector<HTMLElement>(".block-text")?.focus();
    }));
  }

  function scheduleOverride(row: HTMLElement, source: Block, originalProperties: BlockProperties, historyGroup: string) {
    const state = deps.state();
    if (!state) return;
    const referenceInstanceId = row.dataset.referenceInstanceId;
    const targetBlockId = row.dataset.targetBlockId;
    const editable = row.querySelector<HTMLElement>(".block-text");
    if (!referenceInstanceId || !targetBlockId || !editable) return;
    const content = deps.mode() === "source"
      ? deps.contentFromMarkdown(deps.sourceText(editable), source.content)
      : deps.mode() === "preview" ? source.content : deps.contentFromRichEditable(editable, source.content);
    const properties = deps.mode() === "rich"
      ? { ...originalProperties, background: editable.style.backgroundColor || undefined, textColor: editable.style.color || undefined }
      : originalProperties;
    deps.setStatus("正在保存局部覆写...");
    void deps.post({ type: "saveOverride", referenceInstanceId, targetBlockId, content, properties, historyGroup }, state.note.id);
  }

  function detachReferenceAsPlainText(reference: ReferenceInstance) {
    const state = deps.state();
    if (!state) return;
    const hostShell = deps.surface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(reference.hostBlockId)}"]`);
    if (!hostShell) {
      deps.postAfterFlush({ type: "removeReference", referenceInstanceId: reference.id });
      return;
    }
    const hostBlock = state.blocks.find(block => block.id === reference.hostBlockId);
    if (!hostBlock) return;
    const newBlocks = detachedReferenceBlocks(reference, hostBlock, deps.newId,
      () => deps.createBlock("paragraph", hostBlock.parentId));
    const index = state.blocks.findIndex(block => block.id === reference.hostBlockId);
    if (index < 0) return;
    state.blocks.splice(index, 1, ...newBlocks);
    const fragment = document.createDocumentFragment();
    const shells = newBlocks.map(deps.renderOwnBlockShell);
    fragment.append(...shells);
    hostShell.replaceWith(fragment);
    shells[0]?.querySelector<HTMLElement>(".block-text")?.focus();
    deps.removeReferencesFromLocalState(new Set([reference.id]));
    deps.enqueueDocumentSave();
    void deps.flushSave();
    deps.setStatus("引用已断开，内容保留为正文");
  }

  return {
    blockFromReferenceRow,
    handleRowKeydown,
    scheduleInstanceBlock,
    addInstanceBlock,
    scheduleOverride,
    detachReferenceAsPlainText
  };
}
