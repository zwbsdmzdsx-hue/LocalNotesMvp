import type { BlockProperties, DatabaseValue } from "../../protocol/types";
import { aggregateDashboardRows, type DashboardQuery, type DashboardResult, type DashboardRow, type DashboardSource } from "./dashboard-query";

type Config = NonNullable<BlockProperties["dashboardWidget"]>;
export type DataViewKind = "metric" | "detailTable" | "pivotTable" | "barChart" | "pieChart" | "trendChart" | "todoCalendar" | "locationMap" | "relationGraph";

const categorySources: DashboardSource[] = ["documents", "blocks", "todos", "keywords", "locations", "databaseRecords"];
export const dataViews: Record<DataViewKind, { label: string; icon: string; sources: DashboardSource[]; defaultSource: DashboardSource }> = {
  metric: { label: "指标", icon: "∑", sources: categorySources, defaultSource: "documents" },
  detailTable: { label: "明细表", icon: "▤", sources: categorySources, defaultSource: "databaseRecords" },
  pivotTable: { label: "透视表", icon: "▦", sources: categorySources, defaultSource: "todos" },
  barChart: { label: "柱状图", icon: "▥", sources: categorySources, defaultSource: "todos" },
  pieChart: { label: "占比图", icon: "◕", sources: categorySources, defaultSource: "todos" },
  trendChart: { label: "时间趋势", icon: "⌁", sources: ["todos", "databaseRecords"], defaultSource: "todos" },
  todoCalendar: { label: "待办日历", icon: "▦", sources: ["todos"], defaultSource: "todos" },
  locationMap: { label: "地点地图", icon: "⌖", sources: ["locations"], defaultSource: "locations" },
  relationGraph: { label: "关系图", icon: "◎", sources: ["documentLinks", "recordRelations"], defaultSource: "documentLinks" }
};
export const sourceNames: Record<DashboardSource, string> = {
  documents: "文档", blocks: "正文块", todos: "待办", keywords: "关键字", locations: "文档地点",
  databaseRecords: "表格记录", documentLinks: "文档引用与链接", recordRelations: "表格记录关系"
};
const defaultColumns: Record<DashboardSource, string[]> = {
  documents: ["title", "notebookId", "blockCount"], blocks: ["documentTitle", "type", "text"],
  todos: ["documentTitle", "text", "status", "dueAt"], keywords: ["documentTitle", "keyword", "text"],
  locations: ["documentTitle", "name", "address"], databaseRecords: ["recordId", "documentId"],
  documentLinks: ["sourceTitle", "targetTitle", "relation"], recordRelations: ["sourceTitle", "targetTitle", "relation"]
};
export const defaultGroupField: Partial<Record<DashboardSource, string>> = {
  documents: "notebookId", blocks: "type", todos: "status", keywords: "documentTitle",
  locations: "name", databaseRecords: "databaseId"
};
const cellText = (value: DatabaseValue | undefined) => value === null || value === undefined ? "" :
  Array.isArray(value) ? value.join(", ") : typeof value === "object" ? value.name : String(value);
const empty = (message: string) => { const element = document.createElement("p"); element.className = "dashboard-empty"; element.textContent = message; return element; };

export function renderDataView(kind: DataViewKind, config: Config, query: DashboardQuery, result: DashboardResult): { element: HTMLElement; dispose: () => void } {
  const element = document.createElement("div"); element.className = `dashboard-data-view dashboard-data-view-${kind}`;
  let disposed = false;
  let cleanup = () => { disposed = true; };
  if (result.error) { element.append(empty(result.error)); return { element, dispose: cleanup }; }
  if (kind === "metric") {
    const total = document.createElement("strong"); total.className = "dashboard-query-total"; total.textContent = String(result.value); element.append(total);
    if (query.groupBy) appendGroups(element, result.groups);
  } else if (kind === "detailTable") {
    const columns = config.view?.columns?.length ? config.view.columns : defaultColumns[query.source];
    const available = [...new Set(result.rows.flatMap(row => Object.keys(row)))];
    const visible = query.source === "databaseRecords" && !config.view?.columns?.length ? [...columns, ...available.filter(key => ![...columns, "databaseId"].includes(key))] : columns;
    element.append(table(result.rows, visible));
  } else if (kind === "pivotTable" || kind === "barChart" || kind === "pieChart") {
    const groupBy = query.groupBy || defaultGroupField[query.source];
    if (!groupBy) element.append(empty("请选择分类字段"));
    else {
      const groups = groupBy === query.groupBy ? result.groups : groupRows(result.rows, groupBy, query);
      if (!groups.length) element.append(empty("当前范围没有可分类的数据"));
      else if (kind === "pivotTable") element.append(table(groups.map(group => ({ [groupBy]: group.key, count: group.count, value: group.value })), [groupBy, "count", "value"]));
      else cleanup = drawChart(element, kind === "barChart" ? { xAxis: { type: "category", data: groups.map(group => group.key) }, yAxis: { type: "value" }, tooltip: { trigger: "axis" }, series: [{ type: "bar", data: groups.map(group => group.value), itemStyle: { color: "#168579" } }] } : { tooltip: { trigger: "item" }, legend: { bottom: 0, type: "scroll" }, series: [{ type: "pie", radius: ["38%", "67%"], center: ["50%", "44%"], data: groups.map(group => ({ name: group.key, value: group.value })) }] });
    }
  } else if (kind === "trendChart") {
    const dateField = config.view?.dateField || (query.source === "todos" ? "dueAt" : "");
    const grain = config.view?.dateGrain ?? "day";
    const dates = new Map<string, DashboardRow[]>();
    result.rows.forEach(row => {
      const raw = cellText(row[dateField]);
      if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || Number.isNaN(Date.parse(raw))) return;
      const key = raw.slice(0, grain === "month" ? 7 : 10);
      dates.set(key, [...(dates.get(key) ?? []), row]);
    });
    if (!dateField || !dates.size) element.append(empty("当前数据没有可用日期"));
    else {
      const points = [...dates].sort(([a], [b]) => a.localeCompare(b));
      cleanup = drawChart(element, { xAxis: { type: "category", data: points.map(([date]) => date) }, yAxis: { type: "value" }, tooltip: { trigger: "axis" }, series: [{ type: "line", smooth: false, areaStyle: { opacity: .12 }, data: points.map(([, rows]) => measure(rows, query)), color: "#168579" }] });
    }
  } else if (kind === "todoCalendar") {
    const dated = result.rows.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(cellText(row.dueAt))).sort((a, b) => cellText(a.dueAt).localeCompare(cellText(b.dueAt)));
    if (!dated.length) element.append(empty("当前范围没有设置日期的待办"));
    else element.append(table(dated, ["dueAt", "text", "status", "documentTitle"]));
  } else if (kind === "locationMap") {
    const points = result.rows.filter(row => Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)));
    if (!points.length) element.append(empty("当前文档范围没有带坐标的地点块"));
    else {
      const mapHost = document.createElement("div"); mapHost.className = "dashboard-map"; mapHost.setAttribute("aria-label", "地点矢量地图"); element.append(mapHost);
      cleanup = drawMap(mapHost, points);
    }
  } else if (kind === "relationGraph") {
    const edges = result.rows.filter(row => row.sourceId && row.targetId);
    if (!edges.length) element.append(empty("当前范围没有关系数据"));
    else {
      const nodes = new Map<string, string>();
      edges.forEach(row => { nodes.set(cellText(row.sourceId), cellText(row.sourceTitle) || cellText(row.sourceId)); nodes.set(cellText(row.targetId), cellText(row.targetTitle) || cellText(row.targetId)); });
      cleanup = drawChart(element, { tooltip: {}, series: [{ type: "graph", layout: "force", roam: true, label: { show: true, position: "right" }, force: { repulsion: 110, edgeLength: 85 }, data: [...nodes].map(([id, name]) => ({ id, name, symbolSize: 19 })), links: edges.map(row => ({ source: cellText(row.sourceId), target: cellText(row.targetId), value: cellText(row.relation) })), lineStyle: { color: "#94a3b8", width: 1.4 }, itemStyle: { color: "#168579" } }] });
    }
  }
  return { element, dispose: () => { disposed = true; cleanup(); } };

  function drawChart(target: HTMLElement, options: Record<string, unknown>) {
    target.classList.add("dashboard-chart");
    let chart: import("echarts").ECharts | undefined;
    let observer: ResizeObserver | undefined;
    void import("echarts").then(echarts => {
      if (disposed || !target.isConnected) return;
      chart = echarts.init(target, undefined, { renderer: "canvas" }); chart.setOption(options);
      observer = new ResizeObserver(() => chart?.resize()); observer.observe(target);
    });
    return () => { observer?.disconnect(); chart?.dispose(); };
  }
}

function measure(rows: DashboardRow[], query: DashboardQuery) {
  const value = aggregateDashboardRows(rows, query);
  return typeof value === "number" ? value : 0;
}
function groupRows(rows: DashboardRow[], key: string, query: DashboardQuery) {
  const groups = new Map<string, DashboardRow[]>();
  rows.forEach(row => { const label = cellText(row[key]) || "未分类"; groups.set(label, [...(groups.get(label) ?? []), row]); });
  return [...groups].map(([label, items]) => ({ key: label, count: items.length, value: measure(items, query) }));
}
function appendGroups(parent: HTMLElement, groups: DashboardResult["groups"]) {
  const container = document.createElement("div"); container.className = "dashboard-query-groups";
  groups.forEach(group => { const row = document.createElement("div"); const label = document.createElement("span"); label.textContent = group.key; const value = document.createElement("strong"); value.textContent = String(group.value); row.append(label, value); container.append(row); });
  parent.append(container);
}
function table(rows: DashboardRow[], columns: string[]) {
  if (!rows.length) return empty("当前范围没有数据");
  const wrap = document.createElement("div"); wrap.className = "dashboard-table-wrap";
  const table = document.createElement("table"); const head = document.createElement("thead"); const body = document.createElement("tbody");
  let sortField = ""; let descending = false; let page = 0;
  const pageSize = 20;
  const tr = document.createElement("tr"); columns.forEach(column => {
    const th = document.createElement("th"); const button = document.createElement("button"); button.type = "button"; button.textContent = column;
    button.title = `按 ${column} 排序`; button.onclick = () => { descending = sortField === column && !descending; sortField = column; page = 0; update(); };
    th.append(button); tr.append(th);
  }); head.append(tr);
  table.append(head, body); wrap.append(table);
  const pagination = document.createElement("div"); pagination.className = "dashboard-table-pagination"; wrap.append(pagination);
  function update() {
    body.replaceChildren();
    const ordered = sortField ? [...rows].sort((a, b) => {
      const left = a[sortField], right = b[sortField];
      const comparison = typeof left === "number" && typeof right === "number" ? left - right : cellText(left).localeCompare(cellText(right), "zh-CN", { numeric: true });
      return descending ? -comparison : comparison;
    }) : rows;
    ordered.slice(page * pageSize, (page + 1) * pageSize).forEach(row => { const line = document.createElement("tr"); columns.forEach(column => { const td = document.createElement("td"); td.textContent = cellText(row[column]); line.append(td); }); body.append(line); });
    pagination.replaceChildren();
    if (rows.length <= pageSize) return;
    const previous = document.createElement("button"); previous.type = "button"; previous.textContent = "‹"; previous.title = "上一页"; previous.disabled = page === 0; previous.onclick = () => { page -= 1; update(); };
    const next = document.createElement("button"); next.type = "button"; next.textContent = "›"; next.title = "下一页"; next.disabled = (page + 1) * pageSize >= rows.length; next.onclick = () => { page += 1; update(); };
    const label = document.createElement("span"); label.textContent = `${page + 1} / ${Math.ceil(rows.length / pageSize)} · ${rows.length} 条`;
    pagination.append(previous, label, next);
  }
  update();
  return wrap;
}
function drawMap(target: HTMLElement, points: DashboardRow[]) {
  let disposed = false;
  let map: import("maplibre-gl").Map | undefined;
  void import("maplibre-gl").then(maplibre => {
    if (disposed || !target.isConnected) return;
    map = new maplibre.Map({ container: target, style: "https://tiles.openfreemap.org/styles/liberty", center: [Number(points[0].longitude), Number(points[0].latitude)], zoom: 7, attributionControl: false });
    const bounds = new maplibre.LngLatBounds();
    points.forEach(point => {
      const coordinates: [number, number] = [Number(point.longitude), Number(point.latitude)];
      bounds.extend(coordinates);
      const pin = document.createElement("button"); pin.type = "button"; pin.className = "dashboard-map-pin"; pin.title = cellText(point.name); pin.setAttribute("aria-label", `地图标记：${cellText(point.name)}`);
      new maplibre.Marker({ element: pin }).setLngLat(coordinates).setPopup(new maplibre.Popup().setText(`${cellText(point.name)} · ${cellText(point.documentTitle)}`)).addTo(map!);
    });
    if (points.length > 1) map.fitBounds(bounds, { padding: 42, maxZoom: 11 });
  });
  return () => { disposed = true; map?.remove(); };
}
