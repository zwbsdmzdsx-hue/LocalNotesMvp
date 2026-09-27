import type { Block, DatabaseField, DatabaseRecord, DatabaseSource, DatabaseView, EditorState } from "../../protocol/types";
import { executeDql } from "./database-query";
import { databaseViewRows } from "./database-views";
import { databaseFieldMeta } from "./database-presentation";

export type DatabaseTableMode = "rich" | "source" | "preview";
export type DatabaseTableActions = {
  activeViews: Map<string, string>;
  renderViewControls(block: Block, database: DatabaseSource, view: DatabaseView, views: DatabaseView[]): HTMLElement;
  renderCards(database: DatabaseSource, records: DatabaseRecord[], values: Map<string, { values: Record<string, unknown> }>, view: DatabaseView): HTMLElement;
  showFieldMenu(anchor: HTMLElement, database: DatabaseSource, field?: DatabaseField): void;
  saveWidths(database: DatabaseSource, view: DatabaseView, widths: number[]): Promise<unknown>;
  deleteRecord(database: DatabaseSource, recordId: string): void;
  reorderRecord(database: DatabaseSource, record: DatabaseRecord, position: string): Promise<unknown>;
  renderFieldCell(td: HTMLTableCellElement, field: DatabaseField, record: DatabaseRecord, value: unknown, database: DatabaseSource): void;
  addRecord(database: DatabaseSource): void;
  onError(error: unknown): void;
};

export function renderDatabaseTable(block: Block, state: EditorState, mode: DatabaseTableMode, actions: DatabaseTableActions) {
  const wrapper = document.createElement("div"); wrapper.className = "database-table"; wrapper.dataset.databaseId = block.properties.databaseId ?? "";
  const database = state.databases?.find(item => item.id === block.properties.databaseId);
  if (!database) { wrapper.textContent = "数据库不存在"; return wrapper; }
  const records = state.databaseRecords?.[database.id] ?? [];
  const computed = executeDql({ from: "current" }, database, records, { sources: state.databases ?? [], records: state.databaseRecords ?? {} });
  const computedById = new Map(computed.rows.filter(row => !row.grouped).map(row => [row.recordId, row]));
  const views = state.databaseViews?.filter(item => item.databaseId === database.id) ?? [];
  const view = views.find(item => item.id === (actions.activeViews.get(database.id) ?? block.properties.databaseActiveViewId)) ?? views[0];
  if (view) actions.activeViews.set(database.id, view.id);
  const settings = view?.settings ?? {};
  const orderedRecords = databaseViewRows(records, computed, database.fields, settings);
  const fields = settings.fieldKeys?.length ? database.fields.filter(field => settings.fieldKeys?.includes(field.key)) : database.fields;
  if (mode !== "preview" && view) wrapper.append(actions.renderViewControls(block, database, view, views));
  if (view?.type === "board" || view?.type === "gallery") {
    wrapper.append(actions.renderCards(database, orderedRecords, computedById, view));
    return wrapper;
  }
  const table = document.createElement("table");
  const widths = database.fields.map((_, index) => Math.max(120, Math.min(640, settings.widths?.[index] ?? 180)));
  const widthFor = (field: DatabaseField) => widths[database.fields.findIndex(item => item.key === field.key)];
  const columns = document.createElement("colgroup");
  const rowColumn = document.createElement("col"); rowColumn.style.width = "52px"; columns.append(rowColumn);
  const fieldColumns = new Map<string, HTMLTableColElement>();
  fields.forEach(field => { const column = document.createElement("col"); column.style.width = `${widthFor(field)}px`; fieldColumns.set(field.key, column); columns.append(column); });
  table.append(columns);
  const tableWidth = () => { table.style.width = `${52 + fields.reduce((sum, field) => sum + widthFor(field), 0)}px`; };
  tableWidth();
  const head = document.createElement("thead"); const headRow = document.createElement("tr");
  const rowHead = document.createElement("th"); rowHead.className = "database-row-header"; rowHead.setAttribute("aria-label", "行操作"); headRow.append(rowHead);
  fields.forEach((field, fieldIndex) => {
    const th = document.createElement("th"); th.dataset.fieldKey = field.key;
    th.style.width = `${widthFor(field)}px`;
    const header = document.createElement(mode === "preview" ? "span" : "button"); header.className = "database-field-header";
    const icon = document.createElement("span"); icon.className = "database-field-icon"; icon.textContent = databaseFieldMeta[field.type].icon; icon.title = databaseFieldMeta[field.type].label;
    const title = document.createElement("span"); title.textContent = field.title; header.append(icon, title);
    if (header instanceof HTMLButtonElement) { header.type = "button"; header.title = "字段设置"; header.onclick = () => actions.showFieldMenu(header, database, field); }
    th.append(header);
    if (mode !== "preview" && view && fieldIndex < fields.length - 1) {
      const grip = document.createElement("span"); grip.className = "database-column-resize"; grip.setAttribute("role", "separator");
      grip.setAttribute("aria-label", `调整${field.title}列宽`); grip.title = `拖动调整${field.title}列宽`;
      const fullIndex = database.fields.findIndex(item => item.key === field.key);
      let startX = 0; let startWidth = 0; let dragging = false;
      grip.addEventListener("pointerdown", event => { event.preventDefault(); event.stopPropagation(); dragging = true; startX = event.clientX; startWidth = widths[fullIndex]; grip.setPointerCapture(event.pointerId); });
      grip.addEventListener("pointermove", event => {
        if (!dragging) return;
        widths[fullIndex] = Math.max(120, Math.min(640, startWidth + event.clientX - startX));
        th.style.width = `${widths[fullIndex]}px`; fieldColumns.get(field.key)!.style.width = `${widths[fullIndex]}px`; tableWidth();
      });
      grip.addEventListener("pointerup", event => {
        if (!dragging) return;
        dragging = false; grip.releasePointerCapture(event.pointerId);
        void actions.saveWidths(database, view, [...widths]).catch(actions.onError);
      });
      grip.addEventListener("pointercancel", () => { dragging = false; widths[fullIndex] = startWidth; th.style.width = `${startWidth}px`; fieldColumns.get(field.key)!.style.width = `${startWidth}px`; tableWidth(); });
      th.append(grip);
    }
    headRow.append(th);
  });
  head.append(headRow); table.append(head);
  const body = document.createElement("tbody");
  orderedRecords.forEach(record => {
    const tr = document.createElement("tr"); tr.dataset.recordId = record.id;
    const controls = document.createElement("td"); controls.className = "database-row-controls";
    if (mode !== "preview") {
      const handle = document.createElement("button"); handle.type = "button"; handle.className = "database-row-handle"; handle.textContent = "⠿";
      handle.draggable = !settings.sort?.length && !settings.filters?.length && !settings.search;
      handle.title = handle.draggable ? "拖动调整行顺序" : "清除排序和筛选后可调整行顺序";
      handle.setAttribute("aria-label", handle.title);
      handle.addEventListener("dragstart", event => {
        event.stopPropagation(); event.dataTransfer?.setData("text/x-database-record-id", record.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        tr.classList.add("database-row-dragging");
      });
      handle.addEventListener("dragend", () => { tr.classList.remove("database-row-dragging"); body.querySelectorAll(".database-row-drop-before, .database-row-drop-after").forEach(row => row.classList.remove("database-row-drop-before", "database-row-drop-after")); });
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "database-delete-row"; remove.textContent = "×"; remove.title = "删除行";
      remove.onclick = () => actions.deleteRecord(database, record.id);
      controls.append(handle, remove);
      tr.addEventListener("dragover", event => {
        if (!event.dataTransfer?.types.includes("text/x-database-record-id")) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
        body.querySelectorAll(".database-row-drop-before, .database-row-drop-after").forEach(row => row.classList.remove("database-row-drop-before", "database-row-drop-after"));
        tr.classList.add(event.clientY < tr.getBoundingClientRect().top + tr.getBoundingClientRect().height / 2 ? "database-row-drop-before" : "database-row-drop-after");
      });
      tr.addEventListener("drop", event => {
        const sourceId = event.dataTransfer?.getData("text/x-database-record-id");
        if (!sourceId || sourceId === record.id) return;
        event.preventDefault(); event.stopPropagation();
        const moved = [...orderedRecords]; const sourceIndex = moved.findIndex(item => item.id === sourceId); const targetIndex = moved.findIndex(item => item.id === record.id);
        if (sourceIndex < 0 || targetIndex < 0) return;
        const after = event.clientY >= tr.getBoundingClientRect().top + tr.getBoundingClientRect().height / 2;
        const [sourceRecord] = moved.splice(sourceIndex, 1);
        const nextTargetIndex = moved.findIndex(item => item.id === record.id);
        moved.splice(nextTargetIndex + (after ? 1 : 0), 0, sourceRecord);
        void moved.reduce<Promise<unknown>>((tail, item, index) => {
          const position = String((index + 1) * 1000).padStart(8, "0");
          return tail.then(() => item.position === position ? undefined : actions.reorderRecord(database, item, position));
        }, Promise.resolve()).catch(actions.onError);
      });
    }
    tr.append(controls);
    fields.forEach(field => {
      const td = document.createElement("td"); td.dataset.fieldKey = field.key;
      const computedValue = computedById.get(record.id)?.values[field.key];
      actions.renderFieldCell(td, field, record, computedValue, database);
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(body); wrapper.append(table);
  if (mode !== "preview") {
    const add = document.createElement("button"); add.className = "database-add-row"; add.textContent = "+ 添加记录";
    add.onclick = () => actions.addRecord(database);
    const addColumn = document.createElement("button"); addColumn.className = "database-add-column"; addColumn.textContent = "+ 添加列"; addColumn.onclick = () => actions.showFieldMenu(addColumn, database);
    wrapper.append(add, addColumn);
  }
  return wrapper;
}
