import type { Block, DatabaseRecord, EditorState, ReferenceTargetScope } from "../../protocol/types";
import { markdownFromContent, plainTextFromContent } from "./markdown";
import { orderBlockTree } from "./block-tree";
import { blockReferenceLabel } from "./block-references";
import { blockModules } from "./block-modules";

export type LinkSuggestion =
  | { kind: "notebook"; notebookId: string; title: string; meta: string; preview?: string }
  | { kind: "document"; id: string; notebookId: string; notebookName: string; title: string; meta: string; preview?: string }
  | { kind: "target" | "heading"; id: string; blockId?: string; scope?: ReferenceTargetScope; title: string; meta: string; label: string; notebookName?: string; documentTitle?: string; preview?: string }
  | { kind: "record" | "cell"; id: string; recordId: string; fieldKey?: string; scope: "record" | "cell"; title: string; meta: string; label: string; notebookName?: string; documentTitle?: string; preview?: string };

export function suggestionWikiTarget(item: LinkSuggestion, options: { alias?: boolean; headingByTitle?: boolean } = {}) {
  if (item.kind === "notebook") return { text: `${item.title}/`, complete: false };
  if (item.kind === "document") return { text: `${item.notebookName}/${item.title}/`, complete: false };
  const documentTitle = item.documentTitle ?? item.label;
  const prefix = item.notebookName ? `${item.notebookName}/` : "";
  const suffix = item.kind === "record" || item.kind === "cell"
    ? `#@${item.recordId}${item.fieldKey ? `.${item.fieldKey}` : ""}`
    : item.kind === "heading" && options.headingByTitle ? `#${item.label}`
    : (item.kind === "target" || item.kind === "heading") && item.blockId ? `#^${item.blockId}` : "";
  const label = options.alias && suffix ? item.label.replace(/[\]\|\r\n]/g, " ").trim().slice(0, 80) : "";
  return { text: `${prefix}${documentTitle}${suffix}${label ? `|${label}` : ""}]]`, complete: true };
}

export function blockWikiLink(notebook: string, title: string, blockId: string) {
  return `[[${notebook}/${title}#^${blockId}]]`;
}

export function headingInfo(block: Block) {
  const source = markdownFromContent(block.content);
  const line = source.split(/\r?\n/).find(value => value.trim()) ?? "";
  const match = line.match(/^\s*(#{1,6})[ \u3000]+(.+?)\s*$/);
  const title = plainTextFromContent(block.content).trim();
  const headingRole = blockModules.require(block.type).headingRole;
  if (headingRole && block.properties.headingLevel && title) {
    return { level: block.properties.headingLevel, title };
  }
  if (match) return { level: match[1].length as 1 | 2 | 3 | 4 | 5 | 6, title: match[2].trim() };
  return headingRole && title ? { level: 1, title } : null;
}


export function headingSection(blocks: Block[], headingId: string) {
  const ordered = orderBlockTree(blocks);
  const start = ordered.findIndex(block => block.id === headingId);
  if (start < 0) return [];
  const root = headingInfo(ordered[start]);
  if (!root) return [ordered[start]];
  const included: Block[] = [];
  for (let index = start; index < ordered.length; index++) {
    const info = headingInfo(ordered[index]);
    if (index > start && info && info.level <= root.level) break;
    included.push(ordered[index]);
  }
  return included;
}

function normalizedSearch(value: string) { return value.trim().toLocaleLowerCase(); }

function linkCatalogNotebooks(state: Pick<EditorState, "documents" | "note">) {
  if (!state) return [];
  const notebooks = new Map<string, { id: string; name: string; documents: typeof state.documents }>();
  state.documents.forEach(document => {
    const id = document.notebookId ?? (document.id === state?.note.id ? state.note.workspaceId : undefined) ?? "notebook-default";
    const name = document.notebookName ?? document.path?.split("/")[0]?.trim() ?? "当前笔记本";
    const notebook = notebooks.get(id) ?? { id, name, documents: [] };
    notebook.documents.push(document);
    notebooks.set(id, notebook);
  });
  return [...notebooks.values()];
}

function exactOrOnly<T>(items: T[], label: string, getLabel: (item: T) => string) {
  const normalized = normalizedSearch(label);
  return items.find(item => normalizedSearch(getLabel(item)) === normalized) ??
    (items.filter(item => normalizedSearch(getLabel(item)).includes(normalized)).length === 1
      ? items.filter(item => normalizedSearch(getLabel(item)).includes(normalized))[0]
      : undefined);
}

function headingFilter(value: string) {
  const hash = value.indexOf("#");
  if (hash < 0) return null;
  const suffix = value.slice(hash + 1);
  const extraHashes = suffix.match(/^#{0,5}/)?.[0].length ?? 0;
  const level = 1 + extraHashes;
  const needle = normalizedSearch(suffix.slice(extraHashes));
  return { hash, level, needle };
}

export function queryLinkSuggestions(query: string, state: Pick<EditorState, "documents" | "note" | "databases" | "databaseRecords">, suggestionPreview: (blocks: Block[]) => string) {
  let linkMenuStage: "notebook" | "document" | "block" = "notebook";
  let linkMenuTrail: string[] = [];
  function collect(): LinkSuggestion[] {
    const parts = query.split("/");
    const notebooks = linkCatalogNotebooks(state);
    if (parts.length === 1) {
      linkMenuStage = "notebook";
      linkMenuTrail = [];
      const needle = normalizedSearch(parts[0]);
      return notebooks
        .filter(notebook => !needle || normalizedSearch(notebook.name).includes(needle))
        .map(notebook => ({ kind: "notebook", notebookId: notebook.id, title: notebook.name, meta: `${notebook.documents.length} 篇文档` }));
    }
  
    const notebook = exactOrOnly(notebooks, parts[0], item => item.name);
    linkMenuStage = parts.length === 2 ? "document" : "block";
    linkMenuTrail = notebook ? [notebook.name] : [parts[0].trim()].filter(Boolean);
    if (!notebook) return [];
    const documentPart = parts[1] ?? "";
    const documentHeading = headingFilter(documentPart);
    const documentNeedle = normalizedSearch(documentHeading ? documentPart.slice(0, documentHeading.hash) : documentPart);
    if (parts.length === 2) {
      const documentMatches = notebook.documents
        .filter(document => !documentNeedle || normalizedSearch(document.title).includes(documentNeedle))
        .slice(0, 12);
      if (documentHeading) {
        const document = exactOrOnly(documentMatches, documentNeedle, item => item.title);
        if (!document) return [];
        linkMenuStage = "block";
        linkMenuTrail = [notebook.name, document.title];
        return (document.blocks ?? []).flatMap(block => {
          const heading = headingInfo(block);
          if (!heading || heading.level !== documentHeading.level ||
            (documentHeading.needle && !normalizedSearch(heading.title).includes(documentHeading.needle))) return [];
          const section = headingSection(document.blocks ?? [], block.id);
          return [{ kind: "heading" as const, id: document.id, blockId: block.id, scope: "heading" as const,
            title: heading.title, label: heading.title, notebookName: notebook.name, documentTitle: document.title,
            meta: `${document.title} · H${heading.level} · ${section.length} 个块`, preview: suggestionPreview(section) }];
        }).slice(0, 12);
      }
      return documentMatches.map(document => ({
          kind: "document", id: document.id, notebookId: notebook.id, notebookName: notebook.name,
          title: document.title, meta: document.path || notebook.name, preview: suggestionPreview(document.blocks ?? [])
        }));
    }
  
    const document = exactOrOnly(notebook.documents, documentNeedle || parts[1], item => item.title);
    if (!document) return [];
    linkMenuTrail = [notebook.name, document.title];
    const blockQuery = parts.slice(2).join("/");
    const databases = document.databases?.length ? document.databases : document.database ? [document.database] : [];
    if (databases.length) {
      const normalized = normalizedSearch(blockQuery.replace(/^#@?/, ""));
      const databaseFor = (record: DatabaseRecord) => databases.find(item => item.databaseId === record.databaseId)!;
      const makeRecord = (record: DatabaseRecord): LinkSuggestion => {
        const database = databaseFor(record);
        const labelField = database.fields.find(field => field.type === "text") ?? database.fields[0];
        const title = String(record.values[labelField?.key ?? ""] ?? record.id);
        const label = database.fields.map(field => `${field.title}: ${safeLinkLabel(formulaValue(record.values[field.key]))}`).join(" · ");
        return { kind: "record", id: document.id, recordId: record.id, scope: "record", title, label, notebookName: notebook.name, documentTitle: document.title, meta: `${document.title} · 整行`, preview: label };
      };
      const makeCell = (record: DatabaseRecord, fieldKey: string): LinkSuggestion => {
        const database = databaseFor(record);
        const field = database.fields.find(item => item.key === fieldKey)!;
        const label = safeLinkLabel(formulaValue(record.values[fieldKey]));
        return { kind: "cell", id: document.id, recordId: record.id, fieldKey, scope: "cell", title: `${label || "空值"}`, label: `${label || "空值"}`, notebookName: notebook.name, documentTitle: document.title, meta: `${field.title} · 单元格`, preview: `${field.title}: ${label || "空值"}` };
      };
      const explicit = blockQuery.match(/^#?@([^\.\s/]+)(?:\.([^\s/]+))?/);
      if (explicit) {
        const record = databases.flatMap(item => item.records).find(item => item.id === explicit[1]);
        if (!record) return [];
        const database = databaseFor(record);
        if (explicit[2]) {
          const field = database.fields.find(item => item.key === explicit[2]);
          return field ? [makeCell(record, field.key)] : [];
        }
        return [makeRecord(record), ...database.fields.map(field => makeCell(record, field.key))];
      }
      const records = databases.flatMap(item => item.records).filter(record => !normalized || normalizedSearch(makeRecord(record).title).includes(normalized));
      if (records.length || !blockQuery) {
        const items = records.flatMap(record => [makeRecord(record), ...databaseFor(record).fields.map(field => makeCell(record, field.key))]);
        if (items.length) return items.slice(0, 24);
      }
    }
    const blockHeading = headingFilter(blockQuery);
    const blockNeedle = normalizedSearch(blockHeading ? blockQuery.slice(blockHeading.hash + 1 + (blockQuery.slice(blockHeading.hash + 1).match(/^#{0,5}/)?.[0].length ?? 0)) : blockQuery);
    const items: LinkSuggestion[] = [];
    if (!blockHeading && (!blockNeedle || "整篇文档".includes(blockNeedle))) {
      items.push({ kind: "target", id: document.id, title: "整篇文档", meta: `${document.title} · 文档`, label: document.title,
        notebookName: notebook.name, documentTitle: document.title });
    }
    (document.blocks ?? []).forEach(block => {
      const heading = headingInfo(block);
      if (blockHeading) {
        if (heading && heading.level === blockHeading.level &&
          (!blockHeading.needle || normalizedSearch(heading.title).includes(blockHeading.needle))) {
          const section = headingSection(document.blocks ?? [], block.id);
          items.push({ kind: "heading", id: document.id, blockId: block.id, scope: "heading", title: heading.title, label: heading.title,
            notebookName: notebook.name, documentTitle: document.title, meta: `${document.title} · H${heading.level} · ${section.length} 个块`, preview: suggestionPreview(section) });
        }
        return;
      }
      const text = blockReferenceLabel(block);
      if (!text || (blockNeedle && !normalizedSearch(text).includes(blockNeedle))) return;
      const label = text.slice(0, 56);
      items.push({ kind: "target", id: document.id, blockId: block.id, title: label, meta: `${document.title} · 正文块`, label,
        notebookName: notebook.name, documentTitle: document.title, preview: suggestionPreview([block]) });
    });
    return items.slice(0, 12);
  }


  const items = collect();
  return { items, stage: linkMenuStage as "notebook" | "document" | "block", trail: linkMenuTrail };
}

function formulaValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object" && "message" in value) return String((value as { message?: unknown }).message ?? "计算失败");
  return String(value ?? "");
}

function safeLinkLabel(value: string) {
  return value.replace(/\[\[([^\]]+)\]\]/g, (_match, link: string) => link.split("|").pop() ?? link)
    .replace(/[\[\]|\r\n]/g, " ");
}
