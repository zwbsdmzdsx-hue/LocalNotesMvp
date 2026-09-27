import type { Block, EditorState, LinkToken } from "../../protocol/types";
import { blockReferenceLabel } from "./block-references";

function syncReferenceContent(block: Block) {
  const body = block.content.text ?? "";
  let markdown = body;
  block.content.links = (block.content.links ?? []).map(link => {
    const target = `${link.targetText}${link.targetBlockId ? `#^${link.targetBlockId}` : ""}`;
    const source = `[[${target}${link.alias ? `|${link.alias}` : ""}]]`;
    if (markdown) markdown += "\n";
    const start = markdown.length;
    markdown += source;
    return { ...link, start, end: markdown.length };
  });
  block.content.markdown = markdown;
}

export function setBlockReferenceText(block: Block, text: string) {
  block.content.text = text;
  syncReferenceContent(block);
}

export function createBlockReferenceControls(
  state: EditorState, block: Block, onChange: () => void,
  onOpen: (documentId: string, blockId?: string) => void
) {
  const controls = document.createElement("div"); controls.className = "block-reference-controls";
  const references = document.createElement("div"); references.className = "block-reference-links";
  const picker = document.createElement("div"); picker.className = "block-reference-picker";
  const documentSelect = document.createElement("select"); documentSelect.setAttribute("aria-label", "引用目标文档");
  const blockSelect = document.createElement("select"); blockSelect.setAttribute("aria-label", "引用目标块");
  const add = document.createElement("button"); add.type = "button"; add.textContent = "+"; add.title = "引用选中的块"; add.setAttribute("aria-label", "引用选中的块");
  const documents = state.documents.filter(item => item.id !== state.note.id && item.blocks?.length);
  documents.forEach(item => {
    const option = document.createElement("option"); option.value = item.id; option.textContent = item.title; documentSelect.append(option);
  });
  const updateBlocks = () => {
    blockSelect.replaceChildren();
    const target = documents.find(item => item.id === documentSelect.value);
    target?.blocks?.forEach(candidate => {
      const option = document.createElement("option"); option.value = candidate.id;
      option.textContent = blockReferenceLabel(candidate).slice(0, 70);
      blockSelect.append(option);
    });
    add.disabled = !blockSelect.options.length;
  };
  documentSelect.onchange = updateBlocks;
  updateBlocks();
  const renderLinks = () => {
    references.replaceChildren();
    (block.content.links ?? []).forEach((link, index) => {
      if (!link.targetDocumentId) return;
      const target = state.documents.find(item => item.id === link.targetDocumentId);
      const chip = document.createElement("span"); chip.className = "block-reference-chip";
      const open = document.createElement("button"); open.type = "button"; open.textContent = `${target?.title ?? link.targetText} / ${link.alias ?? link.targetBlockId ?? "文档"}`;
      open.title = "打开引用目标"; open.onclick = () => onOpen(link.targetDocumentId!, link.targetBlockId);
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
      remove.title = "移除引用"; remove.setAttribute("aria-label", `移除引用：${open.textContent}`);
      remove.onclick = () => { block.content.links?.splice(index, 1); syncReferenceContent(block); block.revision += 1; onChange(); renderLinks(); };
      chip.append(open, remove); references.append(chip);
    });
  };
  add.onclick = () => {
    const target = documents.find(item => item.id === documentSelect.value);
    const targetBlock = target?.blocks?.find(item => item.id === blockSelect.value);
    if (!target || !targetBlock || block.content.links?.some(link => link.targetDocumentId === target.id && link.targetBlockId === targetBlock.id)) return;
    const targetText = `${target.notebookName ? `${target.notebookName}/` : ""}${target.title}`;
    const link: LinkToken = { targetDocumentId: target.id, targetBlockId: targetBlock.id, targetText,
      alias: blockReferenceLabel(targetBlock).slice(0, 56), start: 0, end: 0 };
    block.content.links = [...(block.content.links ?? []), link];
    syncReferenceContent(block); block.revision += 1; onChange(); renderLinks();
  };
  picker.append(documentSelect, blockSelect, add);
  controls.append(references, picker);
  renderLinks();
  return controls;
}
