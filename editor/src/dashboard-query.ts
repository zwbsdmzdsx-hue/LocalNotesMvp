import type { DatabaseValue, EditorState } from "../../protocol/types";
import { evaluateFormula } from "./database-expression";

export type DashboardSource = "documents" | "blocks" | "todos" | "locations" | "databaseRecords" | "keywords";
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
export type DashboardRow = Record<string, DatabaseValue>;
export type DashboardResult = { total: number; value: number; groups: Array<{ key: string; count: number; value: number }>; rows: DashboardRow[]; error?: string };

const text = (value: DatabaseValue | undefined) => value === null || value === undefined ? "" : Array.isArray(value) ? value.join(", ") : typeof value === "object" ? value.name : String(value);
const isError = (value: unknown): value is { code: string; message: string } => !!value && typeof value === "object" && "code" in value;

export function normalizeDashboardQuery(value: Record<string, unknown> | undefined): DashboardQuery {
  const source = value?.source;
  return {
    source: source === "documents" || source === "blocks" || source === "todos" || source === "locations" || source === "databaseRecords" || source === "keywords" ? source : "documents",
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
      if (query.source === "todos" && block.type !== "todo") return [];
      const content = block.content.text || block.content.markdown || "";
      const common: DashboardRow = { documentId: state.note.id, documentTitle: state.note.title, notebookId: state.note.workspaceId ?? "", blockId: block.id, type: block.type, text: content, checked: !!block.content.checked, dueAt: block.properties.todoDueAt ?? "", completedAt: block.properties.todoCompletedAt ?? "" };
      if (query.source !== "keywords") return [common];
      if (!keyword) return [];
      const haystack = content.toLocaleLowerCase();
      const matches = haystack.split(keyword).length - 1;
      return Array.from({ length: matches }, (_, index) => ({ ...common, occurrence: index + 1, keyword: query.keyword ?? "" }));
    }));
  }
  if (query.source === "locations") {
    const locations = new Map(documents.flatMap(state => (state.locations ?? []).filter(location => !location.deletedAt).map(location => [location.id, location] as const)));
    return [...locations.values()].map(location => ({ locationId: location.id, name: location.name, address: location.address, scope: location.scope, latitude: location.latitude, longitude: location.longitude }));
  }
  const records = new Map<string, DashboardRow>();
  documents.forEach(state => Object.entries(state.databaseRecords ?? {}).forEach(([databaseId, rows]) => {
    if (query.databaseId && query.databaseId !== databaseId) return;
    rows.forEach(record => records.set(`${databaseId}:${record.id}`, { databaseId, recordId: record.id, documentId: record.sourceDocumentId ?? "", ...record.values }));
  }));
  return [...records.values()];
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
  function aggregate(items: DashboardRow[]): number | { error: string } {
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
  const value = aggregate(filtered);
  if (typeof value !== "number") return { total: 0, value: 0, groups: [], rows: [], error: value.error };
  const resultGroups: DashboardResult["groups"] = [];
  for (const [key, items] of groups) {
    const groupValue = aggregate(items);
    if (typeof groupValue !== "number") return { total: 0, value: 0, groups: [], rows: [], error: groupValue.error };
    resultGroups.push({ key, count: items.length, value: groupValue });
  }
  return { total: filtered.length, value, groups: resultGroups, rows: filtered };
}
