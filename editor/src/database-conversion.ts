import type { Block, DatabaseField, DatabaseRecord, DatabaseSource } from "../../protocol/types";
import { markdownFromContent } from "./markdown";

export function parseGfmTable(source: string) {
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2 || !/^\|?\s*:?-{3,}/.test(lines[1])) return null;
  const cells = (line: string) => line.replace(/^\||\|$/g, "").split("|").map(value => value.trim());
  const headers = cells(lines[0]);
  const rows = lines.slice(2).map(cells).filter(row => row.some(Boolean));
  return headers.length ? { headers, rows } : null;
}

export function databaseFromGfm(block: Block, documentId: string, newId: () => string) {
  const parsed = parseGfmTable(markdownFromContent(block.content));
  if (!parsed) return null;
  const databaseId = `db-${newId()}`;
  const usedKeys = new Set<string>();
  const fields: DatabaseField[] = parsed.headers.map((title, index) => {
    const base = title.toLowerCase().replace(/[^a-z0-9_]+/g, "_") || `field_${index + 1}`;
    let key = base; let suffix = 2;
    while (usedKeys.has(key)) key = `${base}_${suffix++}`;
    usedKeys.add(key);
    return { id: `field-${newId()}`, databaseId, key, title, type: "text", position: String((index + 1) * 1000).padStart(8, "0") };
  });
  const records: DatabaseRecord[] = parsed.rows.map((values, index) => ({
    id: `record-${newId()}`, databaseId, position: String((index + 1) * 1000).padStart(8, "0"),
    sourceDocumentId: documentId, sourceBlockId: block.id,
    values: Object.fromEntries(fields.map((field, fieldIndex) => [field.key, values[fieldIndex] ?? ""]))
  }));
  return { databaseId, title: block.content.text || "数据表", fields, records };
}

export function applyGfmConversion(block: Block, databaseId: string) {
  block.type = "database_table";
  block.properties = { ...block.properties, databaseId, databaseSource: "gfm" };
  block.content = { text: "", html: "" };
}

export function applyMarkdownConversion(block: Block, database: DatabaseSource, records: DatabaseRecord[]) {
  const header = `| ${database.fields.map(field => field.title).join(" | ")} |`;
  const divider = `| ${database.fields.map(() => "---").join(" | ")} |`;
  const rows = records.map(record => `| ${database.fields.map(field => String(record.values[field.key] ?? "")).join(" | ")} |`);
  const markdown = [header, divider, ...rows].join("\n");
  block.type = "paragraph";
  block.properties = { ...block.properties, databaseId: undefined };
  block.content = { text: markdown, html: "", markdown };
}
