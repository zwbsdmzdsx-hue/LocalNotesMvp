import type { Block, DatabaseField, DatabaseSource } from "../../protocol/types";
import { databaseFieldMeta } from "./database-presentation";
import { databaseBlockRole } from "./block-modules";

export type DatabaseDeclaration = { id: string; title?: string; fields: DatabaseField[] };

export type DatabaseSourceEdit =
  | { kind: "query" }
  | { kind: "error"; message: string }
  | { kind: "schema"; declaration: DatabaseDeclaration; title: string };

export function applyDatabaseSourceEdit(
  block: Block, source: string, existing: DatabaseSource | undefined,
  databases: DatabaseSource[] | undefined, createId: () => string
): DatabaseSourceEdit {
  if (databaseBlockRole(block) === "query") {
    block.properties = { ...block.properties, dataQuery: source };
    return { kind: "query" };
  }
  const parsed = parseDatabaseDeclaration(source, existing, createId);
  if ("error" in parsed) return { kind: "error", message: parsed.error };
  block.properties = { ...block.properties, databaseId: parsed.id, databaseSource: "database" };
  const index = databases?.findIndex(database => database.id === parsed.id) ?? -1;
  if (index >= 0 && databases)
    databases[index] = { ...databases[index], fields: parsed.fields };
  return { kind: "schema", declaration: parsed, title: parsed.title ?? existing?.title ?? "新数据库" };
}

export function databaseDeclaration(block: Block, database?: DatabaseSource) {
  if (!database) return `\`\`\`localnotes-database\nid: ${block.properties.databaseId ?? ""}\nview: table\n\`\`\``;
  const fields = database.fields.map(field => `  - key: ${field.key}\n    title: ${field.title}\n    type: ${field.type}${field.formula ? `\n    formula: ${field.formula}` : ""}`).join("\n");
  return `\`\`\`localnotes-database\nid: ${database.id}\nname: ${database.title}\nview: table\nfields:\n${fields}\nquery:\n  from: current\n\`\`\``;
}

// This constrained declaration format is produced by the editor; unknown syntax must not mutate stored data.
export function parseDatabaseDeclaration(
  source: string, existing: DatabaseSource | undefined, createId: () => string
): DatabaseDeclaration | { error: string } {
  const lines = source.replace(/^```localnotes-database\s*/i, "").replace(/```\s*$/i, "").split(/\r?\n/);
  const id = lines.find(line => /^\s*id\s*:/i.test(line))?.replace(/^\s*id\s*:\s*/i, "").trim();
  if (!id) return { error: "声明缺少数据库 id" };
  if (existing && existing.id.trim() !== id.trim()) return { error: `不能在声明中更换数据库 id（${existing.id} → ${id}）` };
  const fields: DatabaseField[] = [];
  let current: Partial<DatabaseField> | null = null;
  const finish = () => {
    if (!current) return;
    const key = String(current.key ?? "").trim();
    const title = String(current.title ?? "").trim();
    const type = current.type;
    if (!key || !title || !type || !(type in databaseFieldMeta)) throw new Error("字段声明缺少 key、title 或有效 type");
    const old = existing?.fields.find(field => field.key === key);
    fields.push({
      id: old?.id ?? String(current.id ?? createId()), databaseId: id, key, title,
      type: type as DatabaseField["type"],
      position: old?.position ?? String((fields.length + 1) * 1000).padStart(8, "0"),
      formula: current.formula
    });
    current = null;
  };
  try {
    for (const line of lines) {
      const field = line.match(/^\s*-\s*key\s*:\s*(\S+)\s*$/i);
      if (field) { finish(); current = { key: field[1] }; continue; }
      const value = line.match(/^\s*(title|type|formula)\s*:\s*(.*)$/i);
      if (value && current) {
        const name = value[1].toLowerCase();
        if (name === "title") current.title = value[2].trim();
        else if (name === "type") current.type = value[2].trim() as DatabaseField["type"];
        else current.formula = value[2].trim();
      }
    }
    finish();
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  if (!fields.length) return { error: "声明至少需要一个字段" };
  const title = lines.find(line => /^name\s*:/i.test(line))?.replace(/^name\s*:\s*/i, "").trim();
  return { id, title, fields };
}
