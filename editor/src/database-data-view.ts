import type { Block, DatabaseRecord, EditorState } from "../../protocol/types";
import { executeDql, parseDql } from "./database-query";
import { formulaDisplay } from "./database-presentation";

export type DatabaseDataViewActions = {
  saveRecord(databaseId: string, record: DatabaseRecord): void;
  openSource(documentId: string, blockId?: string): void;
};

export function renderDataView(
  block: Block, state: EditorState, mode: "rich" | "source" | "preview", actions: DatabaseDataViewActions
) {
  const wrapper = document.createElement("div"); wrapper.className = "database-table data-view";
  const database = state.databases?.find(item => item.id === block.properties.databaseId);
  if (!database) { wrapper.textContent = "数据库不存在"; return wrapper; }
  const parsed = parseDql(block.properties.dataQuery ?? "FROM current");
  if ("code" in parsed) { wrapper.textContent = parsed.message; wrapper.classList.add("database-query-error"); return wrapper; }
  const result = executeDql(parsed, database, state.databaseRecords?.[database.id] ?? [], {
    sources: state.databases ?? [], records: state.databaseRecords ?? {}
  });
  const table = document.createElement("table");
  const head = document.createElement("thead"); const headRow = document.createElement("tr");
  result.columns.forEach(column => { const th = document.createElement("th"); th.textContent = column.title; headRow.append(th); });
  head.append(headRow); table.append(head);
  const body = document.createElement("tbody");
  result.rows.forEach(resultRow => {
    const tr = document.createElement("tr"); if (resultRow.grouped) tr.className = "database-group-row";
    result.columns.forEach(column => {
      const td = document.createElement("td");
      const readonly = mode === "preview" || resultRow.grouped || resultRow.readonlyKeys?.includes(column.key);
      if (readonly) td.textContent = formulaDisplay(resultRow.values[column.key]);
      else {
        const input = document.createElement("input"); input.className = "database-cell";
        input.value = formulaDisplay(resultRow.values[column.key]);
        input.onchange = () => {
          const record = state.databaseRecords?.[database.id]?.find(item => item.id === resultRow.recordId);
          if (!record) return;
          const field = database.fields.find(item => item.key === column.key);
          const next = { ...record, values: {
            ...record.values, [column.key]: field?.type === "number" ? Number(input.value) : input.value
          } };
          actions.saveRecord(database.id, next);
        };
        td.append(input);
      }
      tr.append(td);
    });
    if (resultRow.sourceDocumentId) {
      const td = document.createElement("td"); const open = document.createElement("button");
      open.textContent = "打开来源";
      open.onclick = () => actions.openSource(resultRow.sourceDocumentId!, resultRow.sourceBlockId);
      td.append(open); tr.append(td);
    }
    body.append(tr);
  });
  table.append(body); wrapper.append(table);
  return wrapper;
}
