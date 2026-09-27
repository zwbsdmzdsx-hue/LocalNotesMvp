import type { DatabaseField, DatabaseRecord, DatabaseSource, DatabaseValue, DatabaseView, DataQueryResult } from "../../protocol/types";

export function databaseViewLabel(type: DatabaseView["type"]) {
  return type === "table" ? "表格" : type === "board" ? "看板" : "画廊";
}

export function createDatabaseView(database: DatabaseSource, type: DatabaseView["type"], count: number, id: string): DatabaseView {
  return {
    id: `view-${id}`,
    databaseId: database.id,
    name: `${databaseViewLabel(type)} ${count + 1}`,
    type,
    settings: {
      fieldKeys: database.fields.map(field => field.key),
      groupBy: type === "board"
        ? (database.fields.find(field => field.key === "status" && field.type === "text")
          ?? database.fields.find(field => field.type === "text"))?.key : undefined
    }
  };
}

export function databaseViewRows(records: DatabaseRecord[], computed: DataQueryResult, fields: DatabaseField[], settings: DatabaseView["settings"]) {
  const values = new Map(computed.rows.filter(row => !row.grouped).map(row => [row.recordId, row.values]));
  const valueFor = (record: DatabaseRecord, key: string) => values.get(record.id)?.[key] ?? record.values[key];
  const normalized = (value: unknown) => Array.isArray(value) ? value.join(" ") : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
  const search = settings.search?.trim().toLocaleLowerCase();
  const filtered = records.filter(record => {
    if (search && !fields.some(field => normalized(valueFor(record, field.key)).toLocaleLowerCase().includes(search))) return false;
    return (settings.filters ?? []).every(filter => {
      const actual = valueFor(record, filter.key);
      const left = normalized(actual);
      const right = normalized(filter.value);
      if (filter.operator === "contains") return left.toLocaleLowerCase().includes(right.toLocaleLowerCase());
      if (filter.operator === "=") return left === right;
      if (filter.operator === "!=") return left !== right;
      const leftNumber = Number(actual);
      const rightNumber = Number(filter.value);
      const comparison = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
        ? leftNumber - rightNumber : left.localeCompare(right, undefined, { numeric: true });
      return filter.operator === ">" ? comparison > 0 : filter.operator === ">=" ? comparison >= 0
        : filter.operator === "<" ? comparison < 0 : comparison <= 0;
    });
  });
  const sort = settings.sort ?? [];
  return filtered.sort((a, b) => {
    for (const rule of sort) {
      const left = valueFor(a, rule.key) as DatabaseValue;
      const right = valueFor(b, rule.key) as DatabaseValue;
      const compared = typeof left === "number" && typeof right === "number"
        ? left - right : normalized(left).localeCompare(normalized(right), undefined, { numeric: true });
      if (compared) return compared * (rule.direction === "desc" ? -1 : 1);
    }
    return a.position.localeCompare(b.position);
  });
}
