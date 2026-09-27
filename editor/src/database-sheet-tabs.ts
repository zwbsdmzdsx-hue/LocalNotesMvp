import type { Block, EditorState } from "../../protocol/types";
import { databaseBlockRole } from "./block-modules";

export type DatabaseSheetActions = {
  select(sheet: Block): void;
  reorder(moved: Block[], original: Block[]): void;
  rename(heading: Block, name: string): void;
  add(name: string): void;
  remove(block: Block, fallbackDatabaseId: string | null): void;
};

function documentSheets(blocks: Block[]) {
  return blocks.filter(block => databaseBlockRole(block) === "table" && block.properties.databaseSheetHeadingId);
}

export function visibleSheetBlocks(blocks: Block[], selectedDatabaseId: string | null, groupedIds: ReadonlySet<string>) {
  const sheets = documentSheets(blocks);
  const activeDatabaseId = sheets.length && !sheets.some(block => block.properties.databaseId === selectedDatabaseId)
    ? sheets[0].properties.databaseId ?? null : selectedDatabaseId;
  const activeSheet = sheets.find(sheet => sheet.properties.databaseId === activeDatabaseId);
  const headingIds = new Set(sheets.map(sheet => sheet.properties.databaseSheetHeadingId));
  const sheetIds = new Set(sheets.map(sheet => sheet.id));
  return {
    activeDatabaseId,
    visible: blocks.filter(block => !groupedIds.has(block.id) && (
      (!headingIds.has(block.id) && !sheetIds.has(block.id)) ||
      block.id === activeSheet?.id || block.id === activeSheet?.properties.databaseSheetHeadingId
    ))
  };
}

export function retainInactiveSheetBlocks(retained: Block[], canonical: Block[], activeDatabaseId: string | null) {
  const sheets = documentSheets(canonical);
  const sheetIds = new Set(sheets.flatMap(sheet => [sheet.id, sheet.properties.databaseSheetHeadingId!]));
  const present = new Set(retained.map(block => block.id));
  const positions = new Map(canonical.map(block => [block.id, block.position]));
  retained.forEach(block => {
    if (sheetIds.has(block.id)) block.position = positions.get(block.id) ?? block.position;
  });
  const inactive = canonical.filter(block => sheetIds.has(block.id) && !present.has(block.id) && (
    databaseBlockRole(block) === "table" ? block.properties.databaseId !== activeDatabaseId
      : sheets.some(sheet => sheet.properties.databaseSheetHeadingId === block.id && sheet.properties.databaseId !== activeDatabaseId)
  ));
  return [...retained, ...inactive];
}

export function renderSheetTabs(
  block: Block, state: EditorState, mode: "rich" | "source" | "preview", actions: DatabaseSheetActions
) {
  const tabs = document.createElement("nav");
  tabs.className = "database-sheet-tabs";
  tabs.setAttribute("aria-label", "数据表工作表");
  const sheets = documentSheets(state.blocks);
  sheets.forEach(sheet => {
    const heading = state.blocks.find(item => item.id === sheet.properties.databaseSheetHeadingId);
    const tab = document.createElement("button"); tab.type = "button"; tab.className = "database-sheet-tab";
    tab.textContent = heading?.content.text?.trim() || "未命名 Sheet";
    tab.dataset.databaseId = sheet.properties.databaseId ?? "";
    tab.setAttribute("aria-current", sheet.properties.databaseId === block.properties.databaseId ? "page" : "false");
    tab.title = "切换 Sheet；双击重命名";
    tab.onclick = () => actions.select(sheet);
    if (mode !== "preview") {
      tab.draggable = true;
      tab.addEventListener("dragstart", event => {
        event.dataTransfer?.setData("text/x-database-sheet-id", sheet.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      tab.addEventListener("dragover", event => {
        if (!event.dataTransfer?.types.includes("text/x-database-sheet-id")) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "move";
      });
      tab.addEventListener("drop", event => {
        const sourceId = event.dataTransfer?.getData("text/x-database-sheet-id");
        if (!sourceId || sourceId === sheet.id) return;
        event.preventDefault(); event.stopPropagation();
        const moved = [...sheets];
        const sourceIndex = moved.findIndex(item => item.id === sourceId);
        if (sourceIndex < 0) return;
        const [source] = moved.splice(sourceIndex, 1);
        const targetIndex = moved.findIndex(item => item.id === sheet.id);
        const after = event.clientX > tab.getBoundingClientRect().left + tab.getBoundingClientRect().width / 2;
        moved.splice(targetIndex + (after ? 1 : 0), 0, source);
        actions.reorder(moved, sheets);
      });
    }
    tab.ondblclick = () => {
      if (mode === "preview" || !heading) return;
      const name = prompt("Sheet 名称", heading.content.text ?? "");
      if (name?.trim()) actions.rename(heading, name.trim());
    };
    tabs.append(tab);
  });
  if (mode !== "preview") {
    const add = document.createElement("button"); add.type = "button"; add.className = "database-sheet-add";
    add.textContent = "+"; add.title = "新建 Sheet"; add.setAttribute("aria-label", "新建 Sheet");
    add.onclick = () => {
      const name = prompt("新 Sheet 名称", `Sheet ${sheets.length + 1}`)?.trim();
      if (name) actions.add(name);
    };
    tabs.append(add);
    if (sheets.length > 1) {
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "database-sheet-remove";
      remove.textContent = "×"; remove.title = "移除当前 Sheet，保留记录和引用";
      remove.setAttribute("aria-label", "移除当前 Sheet");
      remove.onclick = () => {
        if (!confirm("从文档移除这个 Sheet？记录与已有引用会保留，可通过历史恢复 Sheet。")) return;
        actions.remove(block, sheets.find(item => item.id !== block.id)?.properties.databaseId ?? null);
      };
      tabs.append(remove);
    }
  }
  return tabs;
}
