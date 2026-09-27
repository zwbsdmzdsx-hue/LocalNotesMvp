import type { DatabaseValue, EditorState } from "../../protocol/types";
import { evaluateFormula } from "./database-expression";
import { executeDql } from "./database-query";
import { blockModules } from "./block-modules";

export type DashboardSource = "documents" | "blocks" | "todos" | "locations" | "databaseRecords" | "keywords" | "documentLinks" | "recordRelations";
export type DashboardOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";
export type DashboardMeasure = "count" | "sum" | "avg" | "min" | "max" | "unique";
export type DashboardFilter = { field: string; operator: DashboardOperator; value: string };
export type DashboardQuery = {
  source: DashboardSource;
  keyword?: string;
  databaseId?: string;
  filters?: DashboardFilter[];
  condition?: string;
  groupBy?: string;
  measure?: DashboardMeasure;
  valueField?: string;
  formula?: string;
};

export const dashboardMetricPresets: Record<string, DashboardQuery> = {
  "文档数量": { source: "documents", measure: "count" },
  "关键字数量": { source: "keywords", measure: "count" },
  "未完成待办": { source: "todos", measure: "count", filters: [{ field: "checked", operator: "=", value: "false" }] },
  "已完成待办": { source: "todos", measure: "count", filters: [{ field: "checked", operator: "=", value: "true" }] },
  "位置汇总": { source: "locations", measure: "count" },
  "表格汇总": { source: "databaseRecords", measure: "count" }
};
export type DashboardRow = Record<string, DatabaseValue>;
export type DashboardResult = { total: number; value: number; groups: Array<{ key: string; count: number; value: number }>; rows: DashboardRow[]; error?: string };

const text = (value: DatabaseValue | undefined) => value === null || value === undefined ? "" : Array.isArray(value) ? value.join(", ") : typeof value === "object" ? value.name : String(value);
const isError = (value: unknown): value is { code: string; message: string } => !!value && typeof value === "object" && "code" in value;

export function normalizeDashboardQuery(value: Record<string, unknown> | undefined): DashboardQuery {
  const source = value?.source;
  return {
    source: source === "documents" || source === "blocks" || source === "todos" || source === "locations" || source === "databaseRecords" || source === "keywords" || source === "documentLinks" || source === "recordRelations" ? source : "documents",
    keyword: typeof value?.keyword === "string" ? value.keyword : undefined,
    databaseId: typeof value?.databaseId === "string" ? value.databaseId : undefined,
    filters: Array.isArray(value?.filters) ? value.filters.filter((entry): entry is DashboardFilter => !!entry && typeof entry === "object" && typeof entry.field === "string" && typeof entry.value === "string" && ["=", "!=", ">", ">=", "<", "<=", "contains"].includes(entry.operator)) : [],
    condition: typeof value?.condition === "string" ? value.condition : undefined,
    groupBy: typeof value?.groupBy === "string" ? value.groupBy : undefined,
    measure: ["count", "sum", "avg", "min", "max", "unique"].includes(String(value?.measure)) ? value!.measure as DashboardMeasure : "count",
    valueField: typeof value?.valueField === "string" ? value.valueField : undefined,
    formula: typeof value?.formula === "string" ? value.formula : undefined
  };
}

export function dashboardRows(states: EditorState[], query: DashboardQuery): DashboardRow[] {
  const documents = [...new Map(states.map(state => [state.note.id, state])).values()];
  if (query.source === "documents") return documents.map(state => ({ documentId: state.note.id, title: state.note.title, notebookId: state.note.workspaceId ?? "", blockCount: state.blocks.length }));
  if (query.source === "blocks" || query.source === "todos" || query.source === "keywords") {
    const keyword = query.keyword?.toLocaleLowerCase() ?? "";
    return documents.flatMap(state => state.blocks.flatMap(block => {
      const dates = blockModules.require(block.type).extract?.date?.(block, state) ?? [];
      if (query.source === "todos" && !dates.length) return [];
      const todo = dates[0];
      const content = todo?.text || block.content.text || block.content.markdown || "";
      const dueAt = todo?.dueAt ?? "";
      const checked = todo?.checked ?? false;
      const status = todo ? checked ? "已完成" : dueAt && dueAt < new Date().toISOString().slice(0, 10) ? "已逾期" : "未完成" : "";
      const common: DashboardRow = { documentId: state.note.id, documentTitle: state.note.title, notebookId: state.note.workspaceId ?? "", blockId: block.id, type: block.type, text: content, checked, status, createdAt: todo?.createdAt ?? "", dueAt, completedAt: todo?.completedAt ?? "" };
      if (query.source !== "keywords") return [common];
      if (!keyword) return [];
      const haystack = content.toLocaleLowerCase();
      const matches = haystack.split(keyword).length - 1;
      return Array.from({ length: matches }, (_, index) => ({ ...common, occurrence: index + 1, keyword: query.keyword ?? "" }));
    }));
  }
  if (query.source === "locations") {
    return documents.flatMap(state => {
      const locations = new Map((state.locations ?? []).filter(location => !location.deletedAt).map(location => [location.id, location]));
      return state.blocks.flatMap(block => {
        const location = locations.get(block.properties.locationId ?? "");
        return location ? [{ documentId: state.note.id, documentTitle: state.note.title, blockId: block.id, locationId: location.id, name: location.name, address: location.address, scope: location.scope, latitude: location.latitude, longitude: location.longitude }] : [];
      });
    });
  }
  if (query.source === "documentLinks") {
    const edges = new Map<string, DashboardRow>();
    documents.forEach(state => {
      state.references.forEach(reference => {
        const key = `${state.note.id}:${reference.hostBlockId}:${reference.targetDocumentId}:${reference.targetBlockId ?? ""}`;
        edges.set(key, { documentId: state.note.id, sourceId: state.note.id, sourceTitle: state.note.title, sourceBlockId: reference.hostBlockId, targetId: reference.targetDocumentId, targetTitle: reference.targetTitle, relation: "引用" });
      });
      state.blocks.forEach(block => block.content.links?.forEach(link => {
        if (!link.targetDocumentId) return;
        const key = `${state.note.id}:${block.id}:${link.targetDocumentId}:${link.targetBlockId ?? ""}`;
        if (!edges.has(key)) edges.set(key, { documentId: state.note.id, sourceId: state.note.id, sourceTitle: state.note.title, sourceBlockId: block.id, targetId: link.targetDocumentId, targetTitle: link.targetText, relation: "链接" });
      }));
    });
    return [...edges.values()];
  }
  const sources = new Map(documents.flatMap(state => (state.databases ?? []).map(database => [database.id, database] as const)));
  const allowedDocuments = new Set(documents.map(state => state.note.id));
  const records = new Map(documents.flatMap(state => Object.entries(state.databaseRecords ?? {}).flatMap(([databaseId, rows]) => rows.filter(record => !record.sourceDocumentId || allowedDocuments.has(record.sourceDocumentId)).map(record => [`${databaseId}:${record.id}`, record] as const))));
  if (query.source === "recordRelations") {
    const edges: DashboardRow[] = [];
    for (const record of records.values()) {
      const source = sources.get(record.databaseId);
      if (!source || query.databaseId && source.id !== query.databaseId) continue;
      for (const field of source.fields.filter(field => field.type === "record_relation")) {
        const raw = record.values[field.key];
        const ids = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
        ids.forEach(targetId => edges.push({ sourceId: record.id, sourceTitle: String(record.values.name ?? record.id), targetId, targetTitle: String(records.get(`${field.relationDatabaseId ?? source.id}:${targetId}`)?.values.name ?? targetId), relation: field.title, databaseId: source.id, documentId: record.sourceDocumentId ?? "" }));
      }
    }
    return edges;
  }
  const rows: DashboardRow[] = [];
  for (const source of sources.values()) {
    if (query.databaseId && query.databaseId !== source.id) continue;
    const sourceRecords = [...records.values()].filter(record => record.databaseId === source.id);
    const catalog = { sources: [...sources.values()], records: Object.fromEntries([...sources.keys()].map(id => [id, [...records.values()].filter(record => record.databaseId === id)])) };
    executeDql({ from: "current" }, source, sourceRecords, catalog).rows.forEach(row => {
      rows.push({ databaseId: source.id, recordId: row.recordId, documentId: row.sourceDocumentId ?? "", ...Object.fromEntries(Object.entries(row.values).filter(([, value]) => !isError(value))) });
    });
  }
  return rows;
}

function matches(row: DashboardRow, field: string, operator: DashboardOperator, expected: string) {
  const actual = row[field];
  if (operator === "contains") return text(actual).toLocaleLowerCase().includes(expected.toLocaleLowerCase());
  if (operator === "=" || operator === "!=") {
    const equal = text(actual) === expected;
    return operator === "=" ? equal : !equal;
  }
  const left = Number(actual); const right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return operator === ">" ? left > right : operator === ">=" ? left >= right : operator === "<" ? left < right : left <= right;
}

export function runDashboardQuery(states: EditorState[], query: DashboardQuery): DashboardResult {
  const rows = dashboardRows(states, query);
  const filtered: DashboardRow[] = [];
  for (const row of rows) {
    if (query.filters?.some(filter => !matches(row, filter.field, filter.operator, filter.value))) continue;
    if (query.condition?.trim()) {
      const condition = evaluateFormula(query.condition, row);
      if (isError(condition)) return { total: 0, value: 0, groups: [], rows: [], error: condition.message };
      if (!condition) continue;
    }
    filtered.push(row);
  }
  const groups = new Map<string, DashboardRow[]>();
  filtered.forEach(row => { const key = query.groupBy ? text(row[query.groupBy]) || "未分类" : "总计"; groups.set(key, [...(groups.get(key) ?? []), row]); });
  const value = aggregateDashboardRows(filtered, query);
  if (typeof value !== "number") return { total: 0, value: 0, groups: [], rows: [], error: value.error };
  const resultGroups: DashboardResult["groups"] = [];
  for (const [key, items] of groups) {
    const groupValue = aggregateDashboardRows(items, query);
    if (typeof groupValue !== "number") return { total: 0, value: 0, groups: [], rows: [], error: groupValue.error };
    resultGroups.push({ key, count: items.length, value: groupValue });
  }
  return { total: filtered.length, value, groups: resultGroups, rows: filtered };
}

export function aggregateDashboardRows(items: DashboardRow[], query: DashboardQuery): number | { error: string } {
  if (query.measure === "count" || !query.measure) return items.length;
  const distinct = new Set<string>();
  const values: number[] = [];
  for (const row of items) {
    const calculated = query.formula?.trim() ? evaluateFormula(query.formula, row) : row[query.valueField ?? ""];
    if (isError(calculated)) return { error: calculated.message };
    if (calculated === null || calculated === undefined || text(calculated) === "") continue;
    distinct.add(text(calculated));
    const number = Number(calculated);
    if (Number.isFinite(number)) values.push(number);
  }
  if (query.measure === "unique") return distinct.size;
  if (query.measure === "sum") return values.reduce((sum, number) => sum + number, 0);
  if (query.measure === "avg") return values.length ? values.reduce((sum, number) => sum + number, 0) / values.length : 0;
  if (query.measure === "min") return values.length ? Math.min(...values) : 0;
  return values.length ? Math.max(...values) : 0;
}
