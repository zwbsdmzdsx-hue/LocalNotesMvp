import type { Block } from "../../protocol/types";
import { markdownFromContent } from "./markdown";
import { parseGfmTable } from "./database-conversion";
import { databaseBlockRole } from "./block-modules";

export type DatabaseMenuAction = { label: string; run(): void };

export function databaseBlockMenuActions(block: Block, handlers: {
  changed(): void;
  convertToDatabase(): void;
  convertToMarkdown(): void;
  export(csv: boolean): void;
  refresh(): void;
}): DatabaseMenuAction[] {
  const role = databaseBlockRole(block);
  if (role === "table") return [
    ...(block.properties.databaseSource === "gfm" ? [{ label: "升级为智能数据库表", run: () => {
      block.properties = { ...block.properties, databaseSource: "database" };
      handlers.changed();
    } }] : []),
    { label: "转换为 Markdown 表格", run: handlers.convertToMarkdown },
    { label: "导出 Markdown", run: () => handlers.export(false) },
    { label: "导出 CSV", run: () => handlers.export(true) }
  ];
  if (role === "query") return [{ label: "刷新 DQL 查询", run: handlers.refresh }];
  if (block.type === "paragraph" && parseGfmTable(markdownFromContent(block.content)))
    return [{ label: "转换为普通数据表", run: handlers.convertToDatabase }];
  return [];
}

export type DatabaseBlockRowActions = {
  sheetTabs(block: Block): HTMLElement;
  showActions(anchor: HTMLElement, block: Block): void;
  remove(row: HTMLElement): void;
  declaration(block: Block): string;
  sourceInput(block: Block, source: HTMLElement): void;
  dataView(block: Block): HTMLElement;
  table(block: Block): HTMLElement;
};

export function renderDatabaseBlockRow(
  block: Block, mode: "rich" | "source" | "preview", actions: DatabaseBlockRowActions
) {
  const role = databaseBlockRole(block);
  const row = document.createElement("div"); row.className = "block-row database-row";
  const body = document.createElement("div"); body.className = "database-block-body";
  if (role === "table" && block.properties.databaseSheetHeadingId)
    body.append(actions.sheetTabs(block));
  if (mode !== "preview") {
    const toolbar = document.createElement("div"); toolbar.className = "database-toolbar";
    const menu = document.createElement("button"); menu.type = "button";
    menu.className = "database-table-actions"; menu.textContent = "表格操作";
    menu.onclick = () => actions.showActions(menu, block);
    const remove = document.createElement("button"); remove.type = "button";
    remove.className = "database-table-remove"; remove.textContent = "删除表格";
    remove.onclick = () => actions.remove(row);
    toolbar.append(menu, remove); body.append(toolbar);
  }
  if (mode === "source") {
    const source = document.createElement("div");
    source.className = "markdown-source database-source";
    source.contentEditable = "plaintext-only";
    source.textContent = role === "query"
      ? (block.properties.dataQuery ?? "FROM current") : actions.declaration(block);
    source.addEventListener("input", () => actions.sourceInput(block, source));
    body.append(source);
  } else body.append(role === "query" ? actions.dataView(block) : actions.table(block));
  row.append(body);
  return row;
}
