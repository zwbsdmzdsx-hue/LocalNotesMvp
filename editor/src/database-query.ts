import type { DataQuery, DatabaseField, DatabaseRecord, DatabaseSource, DatabaseValue, DataQueryResult, FormulaError } from "../../protocol/types";
import { evaluateFormula } from "./database-expression";

const queryError = (message: string): FormulaError => ({ code: "syntax", message });
const isError = (value: unknown): value is FormulaError => typeof value === "object" && value !== null && "code" in value;

export function parseDql(source: string): DataQuery | FormulaError {
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const query: DataQuery = { from: "current" };
  for (const line of lines) {
    const table = line.match(/^TABLE\s+(.+)$/i);
    if (table) { query.table = table[1].split(",").map(value => value.trim()).filter(Boolean); continue; }
    const from = line.match(/^FROM\s+(.+)$/i);
    if (from) {
      if (/^current$/i.test(from[1])) query.from = "current";
      else { const match = from[1].match(/^notebook\(["']([^"']+)["']\)$/i); if (!match) return queryError("FROM 只支持 current 或 notebook(\"id\")"); query.from = { notebookId: match[1] }; }
      continue;
    }
    const where = line.match(/^WHERE\s+(.+)$/i); if (where) { query.where = where[1]; continue; }
    const sort = line.match(/^SORT\s+([A-Za-z_][\w-]*)(?:\s+(ASC|DESC))?$/i); if (sort) { query.sort = [{ key: sort[1], direction: sort[2]?.toLowerCase() === "desc" ? "desc" : "asc" }]; continue; }
    const group = line.match(/^GROUP\s+BY\s+([A-Za-z_][\w-]*)$/i); if (group) { query.groupBy = group[1]; continue; }
    const limit = line.match(/^LIMIT\s+(\d+)$/i); if (limit) { query.limit = Math.min(1000, Number(limit[1])); continue; }
    return queryError("无法解析 DQL：" + line);
  }
  return query;
}

function valueMatches(value: DatabaseValue, operator: string, expected: DatabaseValue) {
  if (operator === "contains") return String(value ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
  if (operator === "=") return JSON.stringify(value) === JSON.stringify(expected);
  if (operator === "!=") return JSON.stringify(value) !== JSON.stringify(expected);
  const a = Number(value); const b = Number(expected);
  return operator === ">" ? a > b : operator === ">=" ? a >= b : operator === "<" ? a < b : a <= b;
}

type DatabaseCatalog = { sources: DatabaseSource[]; records: Record<string, DatabaseRecord[]> };

function enrich(record: DatabaseRecord, fields: DatabaseField[], catalog?: DatabaseCatalog) {
  const values: Record<string, DatabaseValue | FormulaError> = { ...record.values };
  const readonlyKeys: string[] = [];
  const formulas = new Map(fields.filter(field => field.type === "formula" || field.type === "rule").map(field => [field.key, field]));
  const byName = new Map(fields.flatMap(field => [[field.key, field.key], [field.title, field.key]]));
  const visiting = new Set<string>();
  const resolve = (key: string): DatabaseValue | FormulaError => {
    if (key in values && !formulas.has(key)) return values[key];
    if (visiting.has(key)) return { code: "cycle", message: `公式循环引用：${key}` };
    const field = formulas.get(key); if (!field) return values[key] ?? null;
    visiting.add(key);
    const expressionValues: Record<string, DatabaseValue> = {};
    fields.forEach(candidate => {
      const value = formulas.has(candidate.key) ? resolve(candidate.key) : values[candidate.key] ?? null;
      (expressionValues as Record<string, DatabaseValue | FormulaError>)[candidate.key] = value;
      (expressionValues as Record<string, DatabaseValue | FormulaError>)[candidate.title] = value;
    });
    const result = evaluateFormula(field.formula ?? "", expressionValues);
    visiting.delete(key); values[key] = result; return result;
  };
  formulas.forEach((_, key) => { readonlyKeys.push(key); resolve(key); });
  for (const field of fields.filter(field => field.type === "rollup")) {
    readonlyKeys.push(field.key);
    const relation = fields.find(candidate => candidate.type === "record_relation" && (!field.relationDatabaseId || candidate.relationDatabaseId === field.relationDatabaseId));
    const ids = relation ? record.values[relation.key] : null;
    const relationIds = Array.isArray(ids) ? ids : typeof ids === "string" && ids ? [ids] : [];
    const targetId = field.relationDatabaseId ?? relation?.relationDatabaseId ?? record.databaseId;
    const targetSource = catalog?.sources.find(source => source.id === targetId);
    const targetFields = targetSource?.fields ?? fields;
    const targetRecords = (catalog?.records[targetId] ?? []).filter(candidate => relationIds.includes(candidate.id));
    const targetValues = targetRecords.map(candidate => enrich(candidate, targetFields).values[field.rollupFieldKey ?? ""]).filter(value => value !== null && !isError(value));
    const numeric = targetValues.map(Number).filter(Number.isFinite);
    values[field.key] = field.rollup === "count" ? targetRecords.length
      : field.rollup === "sum" ? numeric.reduce((sum, value) => sum + value, 0)
      : field.rollup === "avg" ? (numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null)
      : field.rollup === "min" ? (numeric.length ? Math.min(...numeric) : null)
      : field.rollup === "max" ? (numeric.length ? Math.max(...numeric) : null)
      : field.rollup === "unique" ? [...new Set(targetValues.map(value => String(value)))].join(", ")
      : { code: "runtime", message: `汇总字段 ${field.title} 缺少有效函数` };
  }
  for (const [name, key] of byName) if (!(name in values) && key in values) values[name] = values[key];
  return { values, readonlyKeys };
}

export function executeDql(query: DataQuery, source: DatabaseSource, records: DatabaseRecord[], catalog?: DatabaseCatalog): DataQueryResult {
  const fields = source.fields.slice().sort((a, b) => a.position.localeCompare(b.position));
  const requested = query.table?.length ? fields.filter(field => query.table!.includes(field.key) || query.table!.includes(field.title)) : fields;
  let rows = records.map(record => ({ record, ...enrich(record, fields, catalog) }));
  if (query.where) {
    const match = query.where.match(/^([A-Za-z_][\w-]*)\s*(=|!=|>=|<=|>|<|contains)\s*(?:"([^"]*)"|'([^']*)'|(\d+(?:\.\d+)?))$/i);
    if (match) {
      const expected: DatabaseValue = match[3] ?? match[4] ?? (match[5] === undefined ? null : Number(match[5]));
      rows = rows.filter(row => !isError(row.values[match[1]]) && valueMatches(row.values[match[1]] as DatabaseValue, match[2], expected));
    }
  }
  if (query.sort?.length) {
    const sort = query.sort[0];
    rows.sort((a, b) => String(a.values[sort.key] ?? "").localeCompare(String(b.values[sort.key] ?? ""), undefined, { numeric: true }) * (sort.direction === "desc" ? -1 : 1));
  }
  if (query.groupBy) {
    const key = query.groupBy;
    rows.sort((a, b) => String(a.values[key] ?? "").localeCompare(String(b.values[key] ?? ""), undefined, { numeric: true }));
  }
  if (query.limit !== undefined) rows = rows.slice(0, query.limit);
  let previousGroup: string | undefined;
  const resultRows: DataQueryResult["rows"] = [];
  rows.forEach(row => {
    if (query.groupBy) {
      const group = String(row.values[query.groupBy] ?? "");
      if (group !== previousGroup) {
        resultRows.push({ recordId: `group:${group}`, values: { [query.groupBy]: group }, grouped: true, readonlyKeys: requested.map(field => field.key) });
        previousGroup = group;
      }
    }
    resultRows.push({
      recordId: row.record.id,
      sourceDocumentId: row.record.sourceDocumentId,
      sourceBlockId: row.record.sourceBlockId,
      values: Object.fromEntries(requested.map(field => [field.key, row.values[field.key] ?? null])),
      readonlyKeys: row.readonlyKeys
    });
  });
  return {
    columns: requested.map(field => ({ key: field.key, title: field.title, type: field.type })),
    rows: resultRows,
    errors: rows.flatMap(row => Object.values(row.values).filter((value): value is FormulaError => typeof value === "object" && value !== null && "code" in value))
  };
}
