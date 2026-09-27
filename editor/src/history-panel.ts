import type { HistoryModel } from "./history";
import type { PanelHandle } from "./module-registry";

export type HistoryPanelHandle = PanelHandle & { setModel(model: HistoryModel): void };

export function mountHistoryPanel(slot: HTMLElement, onRestore: (entryId: string) => void): HistoryPanelHandle {
  let model: HistoryModel = { documentId: "", entries: [], currentId: "", canUndo: false, canRedo: false };
  let selectedId = "";

  function render() {
    slot.replaceChildren();
    const intro = document.createElement("p");
    intro.className = "history-intro";
    intro.textContent = "最近 80 个版本 · 点击预览，恢复后可撤销";
    slot.append(intro);
    if (!model.entries.length) {
      const empty = document.createElement("p");
      empty.textContent = "编辑后自动记录版本";
      slot.append(empty);
      return;
    }
    for (const entry of [...model.entries].reverse()) {
      const button = document.createElement("button");
      button.className = "history-entry" + (entry.id === model.currentId ? " current" : "");
      button.textContent = `${entry.label} · ${new Date(entry.timestamp).toLocaleString()}${entry.id === model.currentId ? " · 当前" : ""}`;
      button.onclick = () => { selectedId = entry.id; render(); };
      slot.append(button);
    }
    const selected = model.entries.find(entry => entry.id === selectedId)
      ?? model.entries.find(entry => entry.id === model.currentId)!;
    const preview = document.createElement("section");
    preview.className = "history-preview";
    const title = document.createElement("strong");
    title.textContent = selected.title;
    const content = document.createElement("pre");
    content.textContent = selected.preview || "（空白正文）";
    const restore = document.createElement("button");
    restore.textContent = "恢复此版本";
    restore.disabled = selected.id === model.currentId;
    restore.onclick = () => onRestore(selected.id);
    preview.append(title, content, restore);
    slot.append(preview);
  }

  return {
    update() {},
    setModel(next) {
      if (next.documentId !== model.documentId) selectedId = "";
      model = next;
      render();
    },
    dispose() { slot.replaceChildren(); }
  };
}
