import type { DatabaseField, DatabaseRecord, DatabaseSource, DatabaseValue, EditorState, LinkToken, MediaAsset } from "../../protocol/types";
import { formulaDisplay } from "./database-presentation";

export function databaseCellLinks(source: string, documents: EditorState["documents"]): LinkToken[] {
  const links: LinkToken[] = [];
  const pattern = /\[\[([^\]|#]+)(?:#\^([^\]|]+)|#@([^\.\]|]+)(?:\.([^\]|]+))?|#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
  for (const match of source.matchAll(pattern)) {
    const title = match[1].trim(); const blockId = match[2]?.trim(); const recordId = match[3]?.trim();
    const fieldKey = match[4]?.trim(); const heading = match[5]?.trim();
    const leaf = title.split("/").pop() ?? title;
    const doc = documents.find(item => item.title === title || item.title === leaf || item.path === title || item.path?.endsWith(`/${title}`));
    links.push({ targetDocumentId: doc?.id, targetBlockId: blockId, targetRecordId: recordId,
      targetFieldKey: fieldKey, targetScope: recordId ? (fieldKey ? "cell" : "record") : heading ? "heading" : "block",
      targetText: title, alias: match[6]?.trim(), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return links;
}

export type DatabaseCellActions = {
  documents: EditorState["documents"];
  markdownHtml(source: string, links: LinkToken[]): string;
  bindSuggestions(input: HTMLTextAreaElement, commit: () => void): void;
  saveRecord(record: DatabaseRecord): void | Promise<unknown>;
};

export type DatabaseFieldCellActions = Omit<DatabaseCellActions, "saveRecord"> & {
  state: EditorState;
  mode: "rich" | "source" | "preview";
  database: DatabaseSource;
  saveRecord(record: DatabaseRecord, kind?: "database-record" | "database-media"): void | Promise<unknown>;
  saveFields(fields: DatabaseField[]): void;
  storeMedia(file: File): Promise<MediaAsset>;
  onError(error: unknown): void;
};

export function renderDatabaseFieldCell(
  td: HTMLTableCellElement, field: DatabaseField, record: DatabaseRecord,
  computedValue: unknown, actions: DatabaseFieldCellActions
) {
  if ((field.type === "document_relation" || field.type === "record_relation") && actions.mode !== "preview") {
    td.append(relationEditor(field, record, actions));
    return;
  }
  if (field.type === "media") {
    renderMediaCell(td, field, record, actions);
    return;
  }
  if (field.type === "url" && actions.mode === "preview") {
    const href = String(record.values[field.key] ?? "");
    const link = document.createElement("a"); link.href = href; link.textContent = href || "—";
    link.target = "_blank"; link.rel = "noreferrer"; td.append(link);
    return;
  }
  if (field.type === "formula" || field.type === "rule") {
    const result = document.createElement(actions.mode === "preview" ? "span" : "button");
    result.className = "database-computed-cell";
    result.textContent = computedCellText(field, computedValue);
    if (result instanceof HTMLButtonElement) {
      result.type = "button"; result.title = "点击编辑公式源码";
      result.onclick = () => editComputedField(td, field, computedValue, actions);
    }
    td.append(result);
    return;
  }
  if (field.type === "rollup") {
    const result = document.createElement("span"); result.className = "database-computed-cell";
    result.textContent = formulaDisplay(computedValue); td.append(result);
    return;
  }
  if (actions.mode === "preview") {
    const raw = formulaDisplay(computedValue);
    if ((field.type === "text" || field.type === "url") && raw.includes("[["))
      td.innerHTML = actions.markdownHtml(raw, record.cellLinks?.[field.key] ?? []);
    else td.append(document.createTextNode(raw));
    return;
  }
  renderDatabaseCell(td, field, record, computedValue, actions);
}

function relationEditor(field: DatabaseField, record: DatabaseRecord, actions: DatabaseFieldCellActions) {
  const { state, database } = actions;
  const select = document.createElement("select"); select.className = "database-cell database-relation"; select.multiple = true;
  const selected = new Set(Array.isArray(record.values[field.key]) ? record.values[field.key] as string[]
    : typeof record.values[field.key] === "string" ? [record.values[field.key] as string] : []);
  if (field.type === "document_relation") {
    state.documents.forEach(documentInfo => {
      const option = document.createElement("option"); option.value = documentInfo.id;
      option.textContent = documentInfo.path || documentInfo.title;
      option.selected = selected.has(option.value); select.append(option);
    });
  } else {
    const targetId = field.relationDatabaseId ?? database.id;
    const target = state.databases?.find(item => item.id === targetId);
    (state.databaseRecords?.[targetId] ?? []).forEach(item => {
      const option = document.createElement("option"); option.value = item.id;
      const labelField = target?.fields.find(candidate => candidate.type === "text");
      option.textContent = String(item.values[labelField?.key ?? ""] ?? item.id);
      option.selected = selected.has(option.value); select.append(option);
    });
  }
  select.onchange = () => {
    const next = { ...record, values: { ...record.values, [field.key]: [...select.selectedOptions].map(option => option.value) } };
    actions.saveRecord(next);
  };
  return select;
}

function computedCellText(field: DatabaseField, value: unknown) {
  if (field.type === "rule" && typeof value === "boolean") return value ? "✓ 符合" : "— 不符合";
  return formulaDisplay(value);
}

function editComputedField(td: HTMLElement, field: DatabaseField, value: unknown, actions: DatabaseFieldCellActions) {
  td.replaceChildren();
  const editor = document.createElement("input"); editor.className = "database-cell database-formula-source";
  editor.value = field.formula ?? ""; editor.placeholder = 'prop("字段") * 2';
  const commit = () => {
    const formula = editor.value.trim();
    if (formula === (field.formula ?? "")) { td.textContent = computedCellText(field, value); return; }
    actions.saveFields(actions.database.fields.map(item => item.id === field.id ? { ...item, formula } : item));
  };
  editor.onblur = commit;
  editor.onkeydown = event => {
    if (event.key === "Enter") { event.preventDefault(); editor.blur(); }
    else if (event.key === "Escape") { editor.onblur = null; td.textContent = computedCellText(field, value); }
  };
  td.append(editor); editor.focus(); editor.select();
}

function isDatabaseMedia(value: DatabaseValue | undefined): value is MediaAsset {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "url" in value && "kind" in value;
}

function renderMediaCell(td: HTMLElement, field: DatabaseField, record: DatabaseRecord, actions: DatabaseFieldCellActions) {
  const asset = record.values[field.key];
  if (isDatabaseMedia(asset)) {
    const preview = document.createElement(asset.kind === "image" ? "img" : asset.kind === "video" ? "video" : asset.kind === "audio" ? "audio" : "a");
    preview.className = "database-media-preview";
    if (preview instanceof HTMLImageElement) { preview.src = asset.url; preview.alt = asset.name; }
    else if (preview instanceof HTMLVideoElement || preview instanceof HTMLAudioElement) { preview.src = asset.url; preview.controls = true; }
    else { preview.href = asset.url; preview.textContent = asset.name; preview.target = "_blank"; }
    td.append(preview);
  } else {
    const empty = document.createElement("span"); empty.className = "database-cell-empty";
    empty.textContent = "无文件"; td.append(empty);
  }
  if (actions.mode === "preview") return;
  const choose = document.createElement("button"); choose.className = "database-media-choose";
  choose.textContent = asset ? "替换" : "+ 文件";
  const file = document.createElement("input"); file.type = "file"; file.hidden = true;
  choose.onclick = () => file.click();
  file.onchange = async () => {
    const selected = file.files?.[0]; if (!selected) return;
    try {
      const media = await actions.storeMedia(selected);
      await actions.saveRecord({ ...record, values: { ...record.values, [field.key]: media } }, "database-media");
    } catch (error) { actions.onError(error); }
  };
  td.append(choose, file);
}

export function renderDatabaseCell(
  td: HTMLTableCellElement, field: DatabaseField, record: DatabaseRecord,
  value: unknown, actions: DatabaseCellActions
) {
  const input = field.type === "text" ? document.createElement("textarea") : document.createElement("input");
  input.className = "database-cell";
  input.value = formulaDisplay(value);
  if (input instanceof HTMLInputElement) input.type = field.type === "number" ? "number" : field.type === "url" ? "url" : "text";
  input.dataset.fieldKey = field.key;
  let display: HTMLElement | null = null;
  const showCellPreview = () => {
    if (!display) return;
    const links = databaseCellLinks(input.value, actions.documents);
    if (!links.length) { display.hidden = true; input.hidden = false; return; }
    display.querySelector<HTMLElement>(".database-cell-display-content")!.innerHTML = actions.markdownHtml(input.value, links);
    display.hidden = false; input.hidden = true;
  };
  if (field.type === "text") {
    display = document.createElement("div"); display.className = "database-cell-display";
    const content = document.createElement("span"); content.className = "database-cell-display-content";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "database-cell-edit";
    edit.textContent = "编辑"; edit.title = "编辑单元格原文";
    edit.onclick = () => {
      display!.hidden = true; input.hidden = false; input.focus();
      (input as HTMLTextAreaElement).setSelectionRange(input.value.length, input.value.length);
    };
    display.append(content, edit); td.append(display);
    input.addEventListener("blur", showCellPreview);
    showCellPreview();
  }
  let lastSaved = input.value;
  input.addEventListener("change", () => {
    const raw = input.value;
    if (raw === lastSaved) return;
    lastSaved = raw;
    const next: DatabaseRecord = {
      ...record,
      values: { ...record.values, [field.key]: field.type === "number" ? Number(raw) : raw },
      cellLinks: { ...(record.cellLinks ?? {}),
        ...(field.type === "text" || field.type === "url" ? { [field.key]: databaseCellLinks(raw, actions.documents) } : {}) }
    };
    actions.saveRecord(next);
  });
  if (input instanceof HTMLTextAreaElement) {
    actions.bindSuggestions(input, () => { input.dispatchEvent(new Event("change")); input.blur(); });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.defaultPrevented) return;
      event.preventDefault(); input.blur();
    });
  }
  td.append(input);
}
