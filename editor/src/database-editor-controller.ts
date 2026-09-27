import type { Block, BlockType, DatabaseField, DatabaseRecord, DatabaseSource, DatabaseView, EditorState } from "../../protocol/types";
import type { EditorHostApi } from "./editor-host-api";
import { orderBlockTree } from "./block-tree";
import { executeDql } from "./database-query";
import { databaseViewRows, createDatabaseView } from "./database-views";
import { renderDatabaseViewControls, renderDatabaseCards } from "./database-view-ui";
import { showDatabaseFieldMenu } from "./database-field-menu";
import { renderDatabaseFieldCell } from "./database-cell-editor";
import { renderDatabaseTable, type DatabaseTableMode } from "./database-table-editor";
import { databaseDeclaration as serializeDatabaseDeclaration, applyDatabaseSourceEdit } from "./database-declaration";
import { renderSheetTabs } from "./database-sheet-tabs";
import { renderDataView } from "./database-data-view";
import { renderDatabaseBlockRow } from "./database-block-row";
import { createDatabaseRecord } from "./database-records";
import { databaseFromGfm, applyGfmConversion, applyMarkdownConversion } from "./database-conversion";
import { databaseBlockRole } from "./block-modules";

type CommandResult = { state: EditorState; content?: string; fileName?: string; mimeType?: string };
type CellSuggestions = { bind(input: HTMLTextAreaElement, commit: () => void, typing?: () => void): void };

export type DatabaseEditorControllerDeps = {
  state(): EditorState | null;
  mode(): DatabaseTableMode;
  host: EditorHostApi;
  blockSurface: HTMLElement;
  setActiveSheet(databaseId: string | null): void;
  clearActiveBlock(): void;
  activeViews: Map<string, string>;
  newId(): string;
  fileToBase64(file: File): Promise<string>;
  downloadText(content: string, fileName: string, mimeType: string): void;
  executeCommand(command: { operation: string; [key: string]: unknown }, sourceType: string): Promise<CommandResult>;
  renderAll(): void;
  scheduleSave(structural?: number): void;
  showError(error: unknown): void;
  setStatus(message: string): void;
  sourceText(editable: HTMLElement): string;
  createBlock(type: BlockType): Block;
  activateBlock(block: Block): void;
  showBlockMenu(anchor: HTMLElement, block: Block): void;
  removeBlock(row: HTMLElement | null): void;
  cellSuggestions: CellSuggestions;
  markdownHtml(source: string, links?: readonly import("../../protocol/types").LinkToken[]): string;
};

export function createDatabaseEditorController(deps: DatabaseEditorControllerDeps) {
  function databaseForBlock(block: Block) {
    return deps.state()?.databases?.find(database => database.id === block.properties.databaseId);
  }

  function saveDatabaseFields(database: DatabaseSource, fields: DatabaseField[], title = database.title) {
    return deps.executeCommand({
      operation: "save-database-schema", databaseId: database.id,
      database: { ...database, title },
      fields: fields.map((field, index) => ({ ...field, position: String((index + 1) * 1000).padStart(8, "0") }))
    }, "database-schema");
  }

  function saveDatabaseQuery(blockId: string, query: string, documentId: string) {
    const state = deps.state();
    if (state?.note.id !== documentId) { deps.showError("文档已切换，请重新选择查询块"); return; }
    const block = state.blocks.find(item => item.id === blockId && databaseBlockRole(item) === "query");
    if (!block) return;
    block.properties = { ...block.properties, dataQuery: query };
    deps.renderAll();
    deps.scheduleSave(0);
  }

  function saveDatabaseSchema(databaseId: string, fields: DatabaseField[], title: string, documentId: string) {
    const state = deps.state();
    if (state?.note.id !== documentId) { deps.showError("文档已切换，请重新选择数据表"); return; }
    const database = state.databases?.find(item => item.id === databaseId);
    if (database) void saveDatabaseFields(database, fields, title).catch(deps.showError);
  }

  function exportDatabaseById(databaseId: string, csv: boolean, documentId: string) {
    const state = deps.state();
    if (state?.note.id !== documentId) { deps.showError("文档已切换，请重新选择数据表"); return; }
    const database = state.databases?.find(item => item.id === databaseId);
    if (!database) return;
    void deps.host.executeCommand({ operation: csv ? "export-database-csv" : "export-database-markdown", databaseId }, documentId)
      .then(result => {
        if (result.content) deps.downloadText(result.content, result.fileName ?? `${database.title}.${csv ? "csv" : "md"}`, result.mimeType ?? "text/plain");
      })
      .catch(deps.showError);
  }

  function showFieldMenu(anchor: HTMLElement, database: DatabaseSource, field?: DatabaseField) {
    showDatabaseFieldMenu(anchor, database, field, () => `field-${deps.newId()}`, fields => saveDatabaseFields(database, fields));
  }

  function declaration(block: Block) {
    return serializeDatabaseDeclaration(block, databaseForBlock(block));
  }

  function sourceInput(block: Block, body: HTMLElement) {
    const state = deps.state();
    const result = applyDatabaseSourceEdit(block, deps.sourceText(body), databaseForBlock(block), state?.databases, () => `field-${deps.newId()}`);
    if (result.kind === "error") {
      body.classList.add("database-source-error");
      deps.setStatus(result.message);
      return;
    }
    body.classList.remove("database-source-error");
    if (result.kind === "query") { deps.scheduleSave(); return; }
    const { declaration: next, title } = result;
    void deps.executeCommand({ operation: "save-database-schema", databaseId: next.id,
      database: { id: next.id, title }, fields: next.fields }, "database-schema");
  }

  function renderSheet(block: Block) {
    const state = deps.state();
    if (!state) return document.createElement("span");
    return renderSheetTabs(block, state, deps.mode(), {
      select: sheet => { deps.setActiveSheet(sheet.properties.databaseId ?? null); deps.clearActiveBlock(); deps.renderAll(); },
      reorder: (moved, original) => {
        const slots = original.flatMap(item => [
          state.blocks.find(candidate => candidate.id === item.properties.databaseSheetHeadingId)!.position,
          item.position
        ]).sort((a, b) => a.localeCompare(b));
        moved.forEach((item, index) => {
          state.blocks.find(candidate => candidate.id === item.properties.databaseSheetHeadingId)!.position = slots[index * 2];
          item.position = slots[index * 2 + 1];
        });
        state.blocks = orderBlockTree(state.blocks);
        deps.renderAll(); deps.scheduleSave(0);
      },
      rename: (heading, name) => { heading.content = { ...heading.content, text: name, markdown: `# ${name}`, html: "" }; deps.renderAll(); deps.scheduleSave(0); },
      add: name => {
        const documentId = state.note.id;
        const databaseId = `db-${deps.newId()}`;
        const fields: DatabaseField[] = [
          { id: `field-${deps.newId()}`, databaseId, key: "name", title: "名称", type: "text", position: "00001000" },
          { id: `field-${deps.newId()}`, databaseId, key: "status", title: "状态", type: "text", position: "00002000" }
        ];
        void deps.executeCommand({ operation: "create-database", databaseId,
          database: { id: databaseId, title: name, fields, recordCount: 0 }, fields }, "create-database").then(() => {
          const current = deps.state();
          if (!current || current.note.id !== documentId) return;
          const last = Math.max(0, ...current.blocks.map(item => Number(item.position) || 0));
          const heading = deps.createBlock("heading"); heading.position = String(last + 1000).padStart(8, "0"); heading.properties.headingLevel = 1;
          heading.content = { text: name, markdown: `# ${name}`, html: "" };
          const table = deps.createBlock("database_table"); table.position = String(last + 2000).padStart(8, "0");
          table.properties = { ...table.properties, databaseId, databaseSource: "database", databaseSheetHeadingId: heading.id };
          current.blocks.push(heading, table); deps.setActiveSheet(databaseId); deps.clearActiveBlock(); deps.renderAll(); deps.scheduleSave(0);
        }).catch(deps.showError);
      },
      remove: (sheet, fallbackDatabaseId) => {
        const current = deps.state(); if (!current) return;
        current.blocks = current.blocks.filter(item => item.id !== sheet.id && item.id !== sheet.properties.databaseSheetHeadingId);
        deps.setActiveSheet(fallbackDatabaseId); deps.clearActiveBlock(); deps.renderAll(); deps.scheduleSave(0);
      }
    });
  }

  function renderData(block: Block) {
    const state = deps.state();
    if (!state) return document.createElement("span");
    return renderDataView(block, state, deps.mode(), {
      saveRecord: (databaseId, record) => { void deps.executeCommand({ operation: "upsert-database-record", databaseId, record }, "database-record"); },
      openSource: (documentId, blockId) => { void deps.host.openDocument(documentId, blockId).catch(deps.showError); }
    });
  }

  function renderControls(block: Block, database: DatabaseSource, view: DatabaseView, views: DatabaseView[]) {
    return renderDatabaseViewControls(database, view, views, {
      saveView: next => void deps.executeCommand({ operation: "save-database-view", databaseId: database.id, view: next }, "database-view").catch(deps.showError),
      selectView: id => { deps.activeViews.set(database.id, id); block.properties.databaseActiveViewId = id; deps.renderAll(); deps.scheduleSave(0); },
      createView: (type, count) => {
        const next = createDatabaseView(database, type, count, deps.newId());
        deps.activeViews.set(database.id, next.id);
        void deps.executeCommand({ operation: "save-database-view", databaseId: database.id, view: next }, "database-view").then(() => {
          const current = deps.state()?.blocks.find(item => item.id === block.id);
          if (current) { current.properties.databaseActiveViewId = next.id; deps.scheduleSave(0); }
        }).catch(deps.showError);
      },
      deleteView: (selected, fallback) => {
        deps.activeViews.set(database.id, fallback.id);
        void deps.executeCommand({ operation: "delete-database-view", databaseId: database.id, viewId: selected.id }, "database-view").then(() => {
          const current = deps.state()?.blocks.find(item => item.id === block.id);
          if (current) { current.properties.databaseActiveViewId = fallback.id; deps.scheduleSave(0); }
        }).catch(deps.showError);
      },
      search: value => {
        const state = deps.state(); const records = state?.databaseRecords?.[database.id] ?? [];
        const computed = executeDql({ from: "current" }, database, records);
        return new Set(databaseViewRows(records, computed, database.fields, { ...view.settings, search: value }).map(record => record.id));
      },
      addRecord: () => addRecord(database),
      addField: anchor => showFieldMenu(anchor, database)
    });
  }

  function renderCards(database: DatabaseSource, records: DatabaseRecord[], computedById: Map<string, { values: Record<string, unknown> }>, view: DatabaseView) {
    return renderDatabaseCards(database, records, computedById, view, recordId => {
      const state = deps.state(); const table = state?.databaseViews?.find(item => item.databaseId === database.id && item.type === "table");
      if (!table) return;
      deps.activeViews.set(database.id, table.id); deps.renderAll();
      deps.blockSurface.querySelector<HTMLElement>(`[data-record-id="${CSS.escape(recordId)}"] .database-cell`)?.focus();
    });
  }

  function addRecord(database: DatabaseSource) {
    const records = deps.state()?.databaseRecords?.[database.id] ?? [];
    const record = createDatabaseRecord(database, records, deps.newId());
    void deps.executeCommand({ operation: "upsert-database-record", databaseId: database.id, record }, "database-record").catch(deps.showError);
  }

  function renderTable(block: Block) {
    const state = deps.state();
    if (!state) return document.createElement("span");
    return renderDatabaseTable(block, state, deps.mode(), {
      activeViews: deps.activeViews,
      renderViewControls: renderControls,
      renderCards,
      showFieldMenu,
      saveWidths: (database, view, widths) => deps.executeCommand({ operation: "save-database-view", databaseId: database.id, view: { ...view, settings: { ...view.settings, widths } } }, "database-view"),
      deleteRecord: (database, recordId) => { void deps.executeCommand({ operation: "delete-database-record", databaseId: database.id, record: { id: recordId } }, "database-record"); },
      reorderRecord: (database, record, position) => deps.executeCommand({ operation: "upsert-database-record", databaseId: database.id, record: { ...record, position } }, "database-record"),
      renderFieldCell: (td, field, record, computedValue, database) => renderDatabaseFieldCell(td, field, record, computedValue, {
        state, mode: deps.mode(), database, documents: state.documents,
        markdownHtml: (source, links) => deps.markdownHtml(source, links),
        bindSuggestions: (input, commit) => deps.cellSuggestions.bind(input, commit, () => {}),
        saveRecord: (next, kind) => deps.executeCommand({ operation: "upsert-database-record", databaseId: database.id, record: next }, kind ?? "database-record"),
        saveFields: fields => void saveDatabaseFields(database, fields),
        storeMedia: async file => (await deps.host.storeMedia({ name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, data: await deps.fileToBase64(file) })).media,
        onError: deps.showError
      }),
      addRecord,
      onError: deps.showError
    });
  }

  function renderRow(block: Block) {
    return renderDatabaseBlockRow(block, deps.mode(), {
      sheetTabs: renderSheet,
      showActions: (anchor, item) => deps.showBlockMenu(anchor, item),
      remove: row => deps.removeBlock(row.closest<HTMLElement>("[data-own-block]")),
      declaration,
      sourceInput,
      dataView: renderData,
      table: renderTable
    });
  }

  function addTable() {
    const state = deps.state();
    if (deps.mode() === "preview" || !state) return;
    const databaseId = `db-${deps.newId()}`;
    const fields: DatabaseField[] = [
      { id: `field-${deps.newId()}`, databaseId, key: "name", title: "名称", type: "text", position: "00001000" },
      { id: `field-${deps.newId()}`, databaseId, key: "amount", title: "金额", type: "number", position: "00002000" },
      { id: `field-${deps.newId()}`, databaseId, key: "total", title: "合计", type: "formula", formula: 'prop("amount") * 1', position: "00003000" }
    ];
    void deps.executeCommand({ operation: "create-database", databaseId,
      database: { id: databaseId, title: "新数据库", fields, recordCount: 0 }, fields }, "create-database").then(() => {
      const current = deps.state(); if (!current || current.note.id !== state.note.id) return;
      const block = deps.createBlock("database_table"); block.properties = { ...block.properties, databaseId, databaseSource: "database" };
      current.blocks.push(block); current.blocks = orderBlockTree(current.blocks); deps.renderAll(); deps.activateBlock(block); deps.scheduleSave(0);
    }).catch(deps.showError);
  }

  function addDataView() {
    const state = deps.state();
    if (deps.mode() === "preview" || !state) return;
    const database = state.databases?.[0];
    if (!database) { deps.setStatus("请先插入一个数据库表"); return; }
    const block = deps.createBlock("data_view"); block.properties = { ...block.properties, databaseId: database.id, dataQuery: `TABLE ${database.fields.map(field => field.key).join(", ")}\nFROM current\nLIMIT 50` };
    state.blocks.push(block); state.blocks = orderBlockTree(state.blocks); deps.renderAll(); deps.activateBlock(block); deps.scheduleSave(0);
  }

  function convertFromGfm(block: Block) {
    const state = deps.state(); if (!state) return;
    const conversion = databaseFromGfm(block, state.note.id, deps.newId);
    if (!conversion) { deps.setStatus("当前块不是可转换的 GFM 表格"); return; }
    const { databaseId, title, fields, records } = conversion;
    const chain = deps.executeCommand({ operation: "create-database", databaseId,
      database: { id: databaseId, title, fields, recordCount: 0 }, fields }, "create-database").then(() =>
      records.reduce((tail, record) => tail.then(() => deps.executeCommand({ operation: "upsert-database-record", databaseId, record }, "database-record").then(() => undefined)), Promise.resolve())
    ).then(() => {
      const current = deps.state()?.blocks.find(item => item.id === block.id); const latest = deps.state();
      if (!current || !latest) return;
      applyGfmConversion(current, databaseId); deps.renderAll(); deps.activateBlock(current); deps.scheduleSave(0);
    });
    void chain.catch(deps.showError);
  }

  function convertToMarkdown(block: Block) {
    const state = deps.state(); const database = databaseForBlock(block); if (!database || !state) return;
    applyMarkdownConversion(block, database, state.databaseRecords?.[database.id] ?? []);
    deps.renderAll(); deps.scheduleSave(0);
  }

  function exportBlock(block: Block, csv: boolean) {
    const state = deps.state(); const database = databaseForBlock(block); if (!database || !state) return;
    exportDatabaseById(database.id, csv, state.note.id);
  }

  return { databaseForBlock, saveDatabaseQuery, saveDatabaseSchema, exportDatabaseById, declaration, renderRow, renderTable,
    addTable, addDataView, convertFromGfm, convertToMarkdown, exportBlock };
}
