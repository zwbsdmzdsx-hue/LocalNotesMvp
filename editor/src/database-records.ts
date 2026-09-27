import type { DatabaseField, DatabaseRecord, DatabaseSource } from "../../protocol/types";

export function initialDatabaseValues(fields: readonly DatabaseField[]): DatabaseRecord["values"] {
  const values: DatabaseRecord["values"] = {};
  fields.forEach(field => {
    if (field.type === "number") values[field.key] = 0;
    else if (field.type === "text" || field.type === "url") values[field.key] = "";
    else if (field.type === "document_relation" || field.type === "record_relation") values[field.key] = [];
  });
  return values;
}

export function createDatabaseRecord(database: DatabaseSource, records: readonly DatabaseRecord[], id: string): DatabaseRecord {
  return {
    id: `record-${id}`,
    databaseId: database.id,
    position: String((records.length + 1) * 1000).padStart(8, "0"),
    values: initialDatabaseValues(database.fields)
  };
}
