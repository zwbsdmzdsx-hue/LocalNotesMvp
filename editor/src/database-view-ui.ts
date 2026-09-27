import type { DatabaseRecord, DatabaseSource, DatabaseView } from "../../protocol/types";
import { formulaDisplay } from "./database-presentation";
import { databaseViewLabel } from "./database-views";

export type DatabaseViewUiActions = {
  saveView(view: DatabaseView): void;
  selectView(viewId: string): void;
  createView(type: DatabaseView["type"], count: number): void;
  deleteView(view: DatabaseView, fallback: DatabaseView): void;
  search(value: string): Set<string>;
  addRecord(): void;
  addField(anchor: HTMLElement): void;
};

export function renderDatabaseViewControls(database: DatabaseSource, view: DatabaseView, views: DatabaseView[], actions: DatabaseViewUiActions) {
  const controls = document.createElement("div"); controls.className = "database-view-controls";
  const save = (next: DatabaseView) => actions.saveView(next);
  const update = (settings: DatabaseView["settings"]) => save({ ...view, settings });
  const picker = document.createElement("select"); picker.className = "database-view-picker"; picker.setAttribute("aria-label", "选择视图");
  views.forEach(item => { const option = document.createElement("option"); option.value = item.id; option.textContent = `${databaseViewLabel(item.type)} · ${item.name}`; picker.append(option); });
  picker.value = view.id;
  picker.onchange = () => actions.selectView(picker.value);
  const add = document.createElement("select"); add.className = "database-view-add"; add.setAttribute("aria-label", "新增视图");
  [["", "+ 视图"], ["table", "表格视图"], ["board", "看板视图"], ["gallery", "画廊视图"]].forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; add.append(option); });
  add.onchange = () => { if (add.value) actions.createView(add.value as DatabaseView["type"], views.length); };
  const rename = document.createElement("button"); rename.type = "button"; rename.textContent = "重命名"; rename.title = "重命名当前视图";
  rename.onclick = () => { const name = prompt("视图名称", view.name)?.trim(); if (name) save({ ...view, name }); };
  const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "删除视图"; remove.disabled = views.length <= 1;
  remove.onclick = () => { if (!confirm(`删除视图“${view.name}”？记录不会删除。`)) return; actions.deleteView(view, views.find(item => item.id !== view.id)!); };
  controls.append(picker, add, rename, remove);

  const search = document.createElement("input"); search.type = "search"; search.className = "database-view-search"; search.placeholder = "查找当前 Sheet"; search.setAttribute("aria-label", "查找记录"); search.value = view.settings.search ?? "";
  search.oninput = () => {
    const visible = actions.search(search.value);
    controls.parentElement?.querySelectorAll<HTMLElement>("[data-record-id]").forEach(row => { row.hidden = !visible.has(row.dataset.recordId ?? ""); });
  };
  search.onchange = () => update({ ...view.settings, search: search.value });
  controls.append(search);

  const sortKey = document.createElement("select"); sortKey.className = "database-view-sort-key"; sortKey.setAttribute("aria-label", "排序字段");
  [["", "默认顺序"], ...database.fields.map(field => [field.key, field.title])].forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; sortKey.append(option); });
  sortKey.value = view.settings.sort?.[0]?.key ?? "";
  const direction = document.createElement("select"); direction.className = "database-view-sort-direction"; direction.setAttribute("aria-label", "排序方向");
  [["asc", "升序"], ["desc", "降序"]].forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; direction.append(option); });
  direction.value = view.settings.sort?.[0]?.direction ?? "asc";
  const saveSort = () => update({ ...view.settings, sort: sortKey.value ? [{ key: sortKey.value, direction: direction.value as "asc" | "desc" }] : [] });
  sortKey.onchange = saveSort; direction.onchange = saveSort;
  controls.append(sortKey, direction);

  const columns = document.createElement("details"); columns.className = "database-view-columns";
  const columnSummary = document.createElement("summary"); columnSummary.textContent = "显示字段"; columns.append(columnSummary);
  const visibleKeys = view.settings.fieldKeys?.length ? view.settings.fieldKeys : database.fields.map(field => field.key);
  database.fields.forEach(field => {
    const label = document.createElement("label"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = field.key; checkbox.checked = visibleKeys.includes(field.key);
    checkbox.onchange = () => { const keys = checkbox.checked ? [...visibleKeys, field.key] : visibleKeys.filter(key => key !== field.key); if (!keys.length) { checkbox.checked = true; return; } update({ ...view.settings, fieldKeys: keys }); };
    label.append(checkbox, document.createTextNode(field.title)); columns.append(label);
  });
  controls.append(columns);

  if (view.type === "board") {
    const group = document.createElement("select"); group.className = "database-view-group"; group.setAttribute("aria-label", "看板分组字段");
    database.fields.filter(field => field.type === "text" || field.type === "number").forEach(field => { const option = document.createElement("option"); option.value = field.key; option.textContent = field.title; group.append(option); });
    group.value = view.settings.groupBy ?? group.options[0]?.value ?? "";
    group.onchange = () => update({ ...view.settings, groupBy: group.value });
    controls.append(group);
  }
  const filterArea = document.createElement("div"); filterArea.className = "database-view-filters";
  (view.settings.filters ?? []).forEach((filter, index) => {
    const line = document.createElement("div"); line.className = "database-view-filter";
    const key = document.createElement("select"); key.setAttribute("aria-label", `筛选字段 ${index + 1}`);
    database.fields.forEach(field => { const option = document.createElement("option"); option.value = field.key; option.textContent = field.title; key.append(option); }); key.value = filter.key;
    const operator = document.createElement("select"); operator.setAttribute("aria-label", `筛选条件 ${index + 1}`);
    [["contains", "包含"], ["=", "等于"], ["!=", "不等于"], [">", "大于"], [">=", "不小于"], ["<", "小于"], ["<=", "不大于"]].forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; operator.append(option); }); operator.value = filter.operator;
    const value = document.createElement("input"); value.setAttribute("aria-label", `筛选值 ${index + 1}`); value.value = String(filter.value ?? "");
    const change = () => { const filters = [...(view.settings.filters ?? [])]; filters[index] = { key: key.value, operator: operator.value as typeof filter.operator, value: database.fields.find(field => field.key === key.value)?.type === "number" ? Number(value.value) : value.value }; update({ ...view.settings, filters }); };
    key.onchange = change; operator.onchange = change; value.onchange = change;
    const del = document.createElement("button"); del.type = "button"; del.textContent = "×"; del.title = "移除筛选条件"; del.onclick = () => update({ ...view.settings, filters: (view.settings.filters ?? []).filter((_, i) => i !== index) });
    line.append(key, operator, value, del); filterArea.append(line);
  });
  const addFilter = document.createElement("button"); addFilter.type = "button"; addFilter.className = "database-view-add-filter"; addFilter.textContent = "+ 筛选";
  addFilter.onclick = () => update({ ...view.settings, filters: [...(view.settings.filters ?? []), { key: database.fields[0]?.key ?? "", operator: "contains", value: "" }] });
  filterArea.append(addFilter); controls.append(filterArea);
  if (view.type !== "table") {
    const addRecord = document.createElement("button"); addRecord.type = "button"; addRecord.textContent = "+ 记录";
    addRecord.onclick = () => actions.addRecord();
    const addColumn = document.createElement("button"); addColumn.type = "button"; addColumn.textContent = "+ 字段"; addColumn.onclick = () => actions.addField(addColumn);
    controls.append(addRecord, addColumn);
  }
  return controls;
}

export function renderDatabaseCards(database: DatabaseSource, records: DatabaseRecord[], computedById: Map<string, { values: Record<string, unknown> }>, view: DatabaseView, onEditRecord: (recordId: string) => void) {
  const surface = document.createElement("div"); surface.className = `database-${view.type}-surface`;
  const groupKey = view.settings.groupBy ?? (database.fields.find(field => field.key === "status" && field.type === "text") ?? database.fields.find(field => field.type === "text") ?? database.fields[0])?.key ?? "";
  const groups = view.type === "board" ? [...new Set(records.map(record => String(computedById.get(record.id)?.values[groupKey] ?? record.values[groupKey] ?? "未分类")))] : [""];
  groups.forEach(groupName => {
    const lane = document.createElement("section"); lane.className = view.type === "board" ? "database-board-lane" : "database-gallery-grid";
    if (view.type === "board") { const title = document.createElement("h3"); title.textContent = groupName; lane.append(title); }
    records.filter(record => view.type !== "board" || String(computedById.get(record.id)?.values[groupKey] ?? record.values[groupKey] ?? "未分类") === groupName).forEach(record => {
      const card = document.createElement("article"); card.className = "database-record-card"; card.dataset.recordId = record.id;
      const keys = view.settings.fieldKeys?.length ? view.settings.fieldKeys : database.fields.map(field => field.key);
      keys.forEach(key => { const field = database.fields.find(item => item.key === key); if (!field) return; const line = document.createElement("div"); line.className = "database-card-field";
        const label = document.createElement("span"); label.textContent = field.title;
        const raw = computedById.get(record.id)?.values[key] ?? record.values[key];
        const value = document.createElement("span");
        if (field.type === "media" && raw && typeof raw === "object" && "kind" in raw && raw.kind === "image" && "url" in raw) {
          const image = document.createElement("img"); image.className = "database-card-image"; image.src = String(raw.url); image.alt = field.title; value.append(image);
        } else value.textContent = formulaDisplay(raw);
        line.append(label, value); card.append(line); });
      const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "编辑记录"; edit.onclick = () => onEditRecord(record.id);
      card.append(edit); lane.append(card);
    });
    surface.append(lane);
  });
  return surface;
}
