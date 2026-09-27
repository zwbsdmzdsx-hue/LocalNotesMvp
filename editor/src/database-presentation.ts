import type { Block, DatabaseField, EditorState } from "../../protocol/types";
import { executeDql, parseDql } from "./database-query";

export const databaseFieldMeta: Record<DatabaseField["type"], { icon: string; label: string }> = {
  text: { icon: "T", label: "文本" }, number: { icon: "#", label: "数值" }, url: { icon: "↗", label: "网页链接" },
  media: { icon: "▧", label: "多媒体" }, formula: { icon: "ƒ", label: "公式" }, rule: { icon: "⌁", label: "规则" },
  document_relation: { icon: "@", label: "文档关系" }, record_relation: { icon: "⇄", label: "记录关系" }, rollup: { icon: "Σ", label: "汇总" }
};

export function formulaDisplay(value: unknown) {
  if (typeof value === "object" && value !== null && "code" in value) return `#ERROR ${String((value as { message?: unknown }).message ?? "计算失败")}`;
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

export function renderDatabaseTablePreview(block: Block, limits: { rows?: number; columns?: number } = {}, context?: EditorState | null) {
  const wrapper = document.createElement("div");
  wrapper.className = "database-table database-table-preview";
  wrapper.dataset.databaseId = block.properties.databaseId ?? "";
  const database = context?.databases?.find(item => item.id === block.properties.databaseId);
  if (!database) { wrapper.textContent = "数据库不存在"; return wrapper; }
  const records = context?.databaseRecords?.[database.id] ?? [];
  let result: ReturnType<typeof executeDql>;
  if (block.type === "data_view") {
    const parsed = parseDql(block.properties.dataQuery ?? "FROM current");
    if ("code" in parsed) { wrapper.textContent = parsed.message; wrapper.classList.add("database-query-error"); return wrapper; }
    result = executeDql(parsed, database, records, { sources: context?.databases ?? [], records: context?.databaseRecords ?? {} });
  } else {
    result = executeDql({ from: "current" }, database, records, { sources: context?.databases ?? [], records: context?.databaseRecords ?? {} });
  }
  const columns = result.columns.slice(0, limits.columns ?? 5);
  const rows = result.rows.slice(0, limits.rows ?? 5);
  if (!columns.length || !rows.length) {
    const empty = document.createElement("div"); empty.className = "database-preview-empty"; empty.textContent = "暂无数据"; wrapper.append(empty); return wrapper;
  }
  const table = document.createElement("table");
  const head = document.createElement("thead"); const headRow = document.createElement("tr");
  columns.forEach(column => { const th = document.createElement("th"); th.textContent = `${databaseFieldMeta[column.type]?.icon ?? ""} ${column.title}`.trim(); headRow.append(th); });
  head.append(headRow); table.append(head);
  const body = document.createElement("tbody");
  rows.forEach(resultRow => {
    const tr = document.createElement("tr"); if (resultRow.grouped) tr.className = "database-group-row";
    columns.forEach(column => { const td = document.createElement("td"); td.textContent = formulaDisplay(resultRow.values[column.key]); td.title = td.textContent; tr.append(td); });
    body.append(tr);
  });
  table.append(body); wrapper.append(table);
  if (result.rows.length > rows.length) { const more = document.createElement("div"); more.className = "database-preview-empty"; more.textContent = `还有 ${result.rows.length - rows.length} 行`; wrapper.append(more); }
  return wrapper;
}
