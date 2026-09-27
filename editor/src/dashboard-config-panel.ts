import type { Block, BlockProperties, DashboardSettingValue, EditorState } from "../../protocol/types";
import type { WorkspaceDocument } from "./workspace-api";
import type { DashboardExternalWidget } from "./dashboard-extension";
import type { PanelHandle } from "./module-registry";
import { dashboardRows, normalizeDashboardQuery, type DashboardOperator, type DashboardQuery } from "./dashboard-query";
import { dataViews, defaultGroupField, sourceNames, type DataViewKind } from "./dashboard-views";
import { createBlockReferenceControls } from "./block-reference-controls";

type DashboardConfig = NonNullable<BlockProperties["dashboardWidget"]>;

export type DashboardConfigPanelModel = {
  block: Block;
  current: EditorState;
  external?: DashboardExternalWidget;
  documents: WorkspaceDocument[];
  dataStatesFor(config: DashboardConfig): EditorState[];
  onChange(rerenderSettings: boolean): void;
  hydrateSources(): Promise<void>;
  openDocument(documentId: string, blockId?: string): void;
  showBacklinks(): void;
};

export type DashboardConfigPanelHandle = PanelHandle & { setModel(model: DashboardConfigPanelModel | null): void };

export function mountDashboardConfigPanel(slot: HTMLElement): DashboardConfigPanelHandle {
  let model: DashboardConfigPanelModel | null = null;
  function renderSettings() {
    slot.replaceChildren();
    const active = model;
    if (!active) return;
    const { block, current } = active;
    const config = block.properties.dashboardWidget as DashboardConfig;
    const query = normalizeDashboardQuery(config.query);
    const external = active.external;
    const form = document.createElement("div"); form.className = "dashboard-settings";
    const update = (rerenderSettings = false) => active.onChange(rerenderSettings);
    const field = (labelText: string, value: string, onChange: (value: string) => void, type = "text") => {
      const label = document.createElement("label"); label.textContent = labelText;
      const input = document.createElement("input"); input.type = type; input.value = value; input.setAttribute("aria-label", labelText);
      input.onchange = () => onChange(input.value); label.append(input); form.append(label); return input;
    };
    const choice = (labelText: string, value: string, options: Array<[string, string]>, onChange: (value: string) => void) => {
      const label = document.createElement("label"); label.textContent = labelText;
      const select = document.createElement("select"); select.setAttribute("aria-label", labelText);
      options.forEach(([key, name]) => { const option = document.createElement("option"); option.value = key; option.textContent = name; select.append(option); });
      select.value = value; select.onchange = () => onChange(select.value); label.append(select); form.append(label); return select;
    };
    field("标题", config.title ?? "", value => { config.title = value.trim(); update(); });
    field("文字描述", config.description ?? "", value => { config.description = value.trim(); update(); });
    const inbound = document.createElement("button"); inbound.type = "button"; inbound.className = "dashboard-inbound";
    inbound.textContent = `被引用 ${current?.backlinks.filter(link => link.targetBlockId === block.id).length ?? 0}`;
    inbound.onclick = () => { if (current) active.showBacklinks(); };
    form.append(inbound);
    if (config.kind !== "documentFilter" && !external && !config.externalSettings) {
      choice("数据范围", config.scope, [["activeDocument", "当前文档"], ["document", "指定文档"], ["notebook", "当前笔记本"], ["workspace", "整个工作区"]], value => { config.scope = value as DashboardConfig["scope"]; update(true); void active.hydrateSources(); });
      if (config.scope === "document") choice("来源文档", config.sourceId ?? "", active.documents.map(item => [item.id, item.title]), value => { config.sourceId = value; update(); void active.hydrateSources(); });
    }
    if (external) {
      config.externalSettings ??= {};
      (external.settings ?? []).forEach(setting => {
        const value = config.externalSettings![setting.key] ?? setting.defaultValue ?? "";
        const set = (next: DashboardSettingValue) => { config.externalSettings![setting.key] = next; update(); };
        if (setting.control === "checkbox") {
          const label = document.createElement("label"); label.textContent = setting.label;
          const input = document.createElement("input"); input.type = "checkbox"; input.checked = Boolean(value); input.setAttribute("aria-label", setting.label); input.onchange = () => set(input.checked);
          label.append(input); form.append(label);
        } else if (setting.control === "select") {
          choice(setting.label, String(value), (setting.options ?? []).map(option => [option.value, option.label]), set);
        } else {
          field(setting.label, String(value), next => set(setting.control === "number" ? Number(next) || 0 : next), setting.control);
        }
      });
    } else if (config.kind === "documentFilter") {
      const hint = document.createElement("small"); hint.className = "dashboard-settings-hint"; hint.textContent = "在看板控件上选择文档；这里的范围会同时约束所有数据组件，并与各组件自身的数据范围取交集。"; form.append(hint);
    } else if (config.kind in dataViews) {
      const definition = dataViews[config.kind as DataViewKind];
      choice("数据类型", query.source, definition.sources.map(source => [source, sourceNames[source]]), value => { query.source = value as DashboardQuery["source"]; query.groupBy = undefined; query.valueField = undefined; query.filters = []; query.condition = undefined; query.formula = undefined; config.view = {}; config.query = { ...query }; update(true); void active.hydrateSources(); });
      if (query.source === "keywords") field("关键字", query.keyword ?? "", value => { query.keyword = value; config.query = { ...query }; update(); });
      if (query.source === "databaseRecords" || query.source === "recordRelations") choice("数据表", query.databaseId ?? "", [["", "全部数据表"], ...[...new Map(active.dataStatesFor(config).flatMap(state => state.databases ?? []).map(database => [database.id, database.title] as [string, string])).entries()]], value => { query.databaseId = value; config.query = { ...query }; update(true); });
      const sample = dashboardRows(active.dataStatesFor(config), query)[0] ?? {};
      const keys = Object.keys(sample);
      const hints = document.createElement("small"); hints.className = "dashboard-settings-hint"; hints.textContent = keys.length ? `可用字段：${keys.join("、")}` : "当前范围无数据"; form.append(hints);
      const filterHeading = document.createElement("strong"); filterHeading.textContent = "筛选条件"; form.append(filterHeading);
      (query.filters ?? []).forEach((filter, index) => {
        const row = document.createElement("div"); row.className = "dashboard-filter-row";
        const key = document.createElement("input"); key.placeholder = "字段"; key.value = filter.field; key.setAttribute("aria-label", `筛选字段 ${index + 1}`);
        const operator = document.createElement("select"); operator.setAttribute("aria-label", `筛选运算符 ${index + 1}`);
        (["=", "!=", ">", ">=", "<", "<=", "contains"] as const).forEach(value => { const option = document.createElement("option"); option.value = value; option.textContent = value; operator.append(option); }); operator.value = filter.operator;
        const value = document.createElement("input"); value.placeholder = "值"; value.value = filter.value; value.setAttribute("aria-label", `筛选值 ${index + 1}`);
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "删除筛选条件"; remove.onclick = () => { query.filters?.splice(index, 1); config.query = { ...query }; update(true); };
        [key, operator, value].forEach(input => { input.onchange = () => { filter.field = key.value.trim(); filter.operator = operator.value as DashboardOperator; filter.value = value.value; config.query = { ...query }; update(); }; });
        row.append(key, operator, value, remove); form.append(row);
      });
      const addFilter = document.createElement("button"); addFilter.type = "button"; addFilter.textContent = "+ 筛选条件"; addFilter.onclick = () => { query.filters = [...(query.filters ?? []), { field: keys[0] ?? "type", operator: "=", value: "" }]; config.query = { ...query }; update(true); }; form.append(addFilter);
      field("条件表达式", query.condition ?? "", value => { query.condition = value; config.query = { ...query }; update(); });
      if (["metric", "pivotTable", "barChart", "pieChart"].includes(config.kind)) field("分类字段", query.groupBy ?? defaultGroupField[query.source] ?? "", value => { query.groupBy = value.trim(); config.query = { ...query }; update(); });
      if (config.kind === "detailTable") field("显示列（逗号分隔）", config.view?.columns?.join(", ") ?? "", value => { config.view ??= {}; config.view.columns = value.split(",").map(key => key.trim()).filter(Boolean); update(); });
      if (config.kind === "trendChart") {
        field("日期字段", config.view?.dateField ?? (query.source === "todos" ? "dueAt" : ""), value => { config.view ??= {}; config.view.dateField = value.trim(); update(); });
        choice("时间粒度", config.view?.dateGrain ?? "day", [["day", "按日"], ["month", "按月"]], value => { config.view ??= {}; config.view.dateGrain = value as "day" | "month"; update(); });
      }
      if (["metric", "pivotTable", "barChart", "pieChart", "trendChart"].includes(config.kind)) {
        choice("汇总方式", query.measure ?? "count", [["count", "计数"], ["sum", "求和"], ["avg", "平均"], ["min", "最小"], ["max", "最大"], ["unique", "去重计数"]], value => { query.measure = value as DashboardQuery["measure"]; config.query = { ...query }; update(); });
        field("数值字段", query.valueField ?? "", value => { query.valueField = value.trim(); config.query = { ...query }; update(); });
        field("计算公式", query.formula ?? "", value => { query.formula = value.trim(); config.query = { ...query }; update(); });
      }
    }
    const layoutHeading = document.createElement("strong"); layoutHeading.textContent = "尺寸与布局"; form.append(layoutHeading);
    (["x", "y", "width", "height", "zIndex"] as const).forEach(key => field(key === "width" ? "宽度" : key === "height" ? "高度" : key === "zIndex" ? "层级" : key.toUpperCase(), String(config.layout[key] ?? (key === "zIndex" ? 1 : 0)), value => { const number = Number(value); if (!Number.isFinite(number)) return; config.layout[key] = key === "width" ? Math.max(220, number) : key === "height" ? Math.max(140, number) : Math.max(0, number); update(); }, "number"));
    const styleHeading = document.createElement("strong"); styleHeading.textContent = "样式"; form.append(styleHeading);
    config.style ??= {};
    ([ ["background", "背景色", "#ffffff"], ["color", "文字色", "#344054"], ["accent", "边框色", "#0f766e"] ] as const).forEach(([key, label, fallback]) => field(label, config.style![key] ?? fallback, value => { config.style![key] = value; update(); }, "color"));
    field("字号", String(config.style.fontSize ?? 12), value => { config.style!.fontSize = Math.max(10, Math.min(32, Number(value) || 12)); update(); }, "number");
    if (current) form.append(createBlockReferenceControls(current, block, () => update(true), active.openDocument));
    slot.append(form);
  }
  return {
    update(context) {
      if (!context && model) { model = null; slot.replaceChildren(); }
    },
    setModel(next) { model = next; renderSettings(); },
    dispose() { model = null; slot.replaceChildren(); }
  };
}
