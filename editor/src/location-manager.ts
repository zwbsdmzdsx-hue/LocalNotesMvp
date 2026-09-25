import * as L from "leaflet";
import type * as MapLibre from "maplibre-gl";
import type { LeafletMouseEvent } from "leaflet";
import "../../web/node_modules/leaflet/dist/leaflet.css";
import "../../web/node_modules/maplibre-gl/dist/maplibre-gl.css";
import type { EditorCommand } from "../../protocol/types";
import type { GeoLocation, LocationPrecision, LocationScope, LocationSource } from "../../protocol/types";

export type LocationManagerState = {
  locations: GeoLocation[];
  locationVersion: number;
  notebookId?: string;
};

type LocationDraft = GeoLocation;

type LocationManagerOptions = {
  panel: HTMLElement;
  getState: () => LocationManagerState | null;
  execute: (command: EditorCommand, label: string) => Promise<void>;
  insert: (locationId: string) => void;
  onError: (error: unknown) => void;
};

const sourceLabels: Record<LocationSource, string> = { manual: "手动", map: "地图选点", browser: "浏览器定位", ip: "IP 粗定位" };
const precisionLabels: Record<LocationPrecision, string> = { exact: "精确", street: "道路", district: "区域", city: "城市", unknown: "未知精度" };

function newId(prefix = "loc") {
  return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function nowIso() { return new Date().toISOString(); }

function clampCoordinate(value: string, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : 0;
}

function createDraft(notebookId?: string): LocationDraft {
  const now = nowIso();
  return {
    id: newId(), scope: "notebook", notebookId, name: "新位置", address: "",
    latitude: 23.1291, longitude: 113.2644, source: "manual", precision: "unknown", createdAt: now, updatedAt: now
  };
}

export function renderLocationMap(container: HTMLElement, location: Pick<GeoLocation, "latitude" | "longitude" | "name">, interactive = false, onPoint?: (latitude: number, longitude: number) => void) {
  container.replaceChildren();
  container.classList.add("location-map-canvas");
  const map = L.map(container, { zoomControl: true, attributionControl: true, dragging: true, scrollWheelZoom: interactive });
  map.setView([location.latitude, location.longitude], interactive ? 13 : 14);
  // Defer remote tile images until the document has finished loading. Edge can
  // defer dynamic images and hold the page's `load` event while the OSM tiles
  // are unreachable, which otherwise makes the editor appear not to start.
  const addTiles = () => {
    if (!map.getPane("tilePane")?.querySelector(".leaflet-tile")) {
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
    }
  };
  if (document.readyState === "complete") addTiles();
  else window.addEventListener("load", addTiles, { once: true });
  const marker = L.marker([location.latitude, location.longitude], {
    draggable: interactive,
    icon: L.divIcon({ className: "location-map-pin", html: "📍", iconSize: [24, 24], iconAnchor: [12, 24] })
  });
  marker.bindTooltip(location.name || "位置", { direction: "top", offset: [0, -8] }).addTo(map);
  if (interactive && onPoint) {
    map.on("click", (event: LeafletMouseEvent) => onPoint(event.latlng.lat, event.latlng.lng));
    marker.on("dragend", () => {
      const point = marker.getLatLng();
      onPoint(point.lat, point.lng);
    });
    // Circle markers are selected by map clicks; coordinate inputs provide precise adjustment.
  }
  requestAnimationFrame(() => map.invalidateSize());
  return { map, marker };
}

export class LocationManager {
  private scope: LocationScope = "notebook";
  private draft: LocationDraft | null = null;
  private map: L.Map | null = null;
  private marker: L.Marker | null = null;
  private overviewMap: MapLibre.Map | null = null;
  private overviewMarkers: MapLibre.Marker[] = [];
  private overviewObserver: IntersectionObserver | null = null;
  private reverseTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: LocationManagerOptions) {}

  render() {
    const state = this.options.getState();
    if (!state) { this.options.panel.replaceChildren(); return; }
    if (this.draft) { this.renderEditor(state); return; }
    this.renderList(state);
  }

  private renderList(state: LocationManagerState) {
    this.disposeMap();
    this.disposeOverviewMap();
    const panel = this.options.panel;
    panel.replaceChildren();
    const head = document.createElement("div"); head.className = "location-manager-head";
    const title = document.createElement("strong"); title.textContent = "地图管理";
    const add = document.createElement("button"); add.className = "location-create"; add.textContent = "+ 新建位置"; add.onclick = () => { this.draft = createDraft(state.notebookId); this.render(); };
    head.append(title, add); panel.append(head);
    const scopes = document.createElement("div"); scopes.className = "location-scopes";
    (["notebook", "global"] as LocationScope[]).forEach(scope => {
      const button = document.createElement("button"); button.type = "button"; button.textContent = scope === "notebook" ? "当前笔记本" : "全局位置"; button.className = scope === this.scope ? "active" : "";
      button.onclick = () => { this.scope = scope; this.render(); }; scopes.append(button);
    });
    panel.append(scopes);
    const locations = state.locations.filter(location => location.scope === this.scope && (this.scope === "global" || location.notebookId === state.notebookId));
    const active = locations.filter(location => !location.deletedAt);
    const deleted = locations.filter(location => !!location.deletedAt);
    const mapCanvas = document.createElement("div"); mapCanvas.className = "location-overview-map"; mapCanvas.setAttribute("aria-label", "位置矢量地图"); mapCanvas.setAttribute("aria-busy", "true");
    panel.append(mapCanvas);
    this.overviewObserver = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) return;
      this.overviewObserver?.disconnect(); this.overviewObserver = null;
      this.renderOverviewMap(mapCanvas, active);
    });
    this.overviewObserver.observe(mapCanvas);
    if (!active.length && !deleted.length) { const empty = document.createElement("p"); empty.className = "location-empty"; empty.textContent = "暂无位置记录"; panel.append(empty); return; }
    active.forEach(location => panel.append(this.renderCard(location, false)));
    if (deleted.length) {
      const heading = document.createElement("div"); heading.className = "location-deleted-heading"; heading.textContent = "已删除位置"; panel.append(heading);
      deleted.forEach(location => panel.append(this.renderCard(location, true)));
    }
  }

  private renderOverviewMap(container: HTMLElement, locations: GeoLocation[]) {
    void import("maplibre-gl").then(maplibregl => {
      if (!container.isConnected) return;
      const first = locations[0];
      const map = new maplibregl.Map({
        container,
        style: "https://tiles.openfreemap.org/styles/liberty",
        center: first ? [first.longitude, first.latitude] : [113.2644, 23.1291],
        zoom: locations.length > 1 ? 8 : 11,
        attributionControl: false
      });
      this.overviewMap = map;
      map.once("idle", () => container.setAttribute("aria-busy", "false"));
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      locations.forEach(location => {
        const pin = document.createElement("button"); pin.type = "button"; pin.className = "location-vector-pin"; pin.title = location.name; pin.setAttribute("aria-label", `地图标记：${location.name}`);
        pin.onclick = () => container.parentElement?.querySelector<HTMLElement>(`.location-card[data-location-id="${CSS.escape(location.id)}"]`)?.scrollIntoView({ block: "nearest" });
        const marker = new maplibregl.Marker({ element: pin, anchor: "bottom" }).setLngLat([location.longitude, location.latitude]).addTo(map);
        this.overviewMarkers.push(marker);
      });
      if (locations.length > 1) {
        const bounds = new maplibregl.LngLatBounds();
        locations.forEach(location => bounds.extend([location.longitude, location.latitude]));
        map.fitBounds(bounds, { padding: 30, maxZoom: 13, duration: 0 });
      }
      const observer = new ResizeObserver(() => { if (container.isConnected && container.clientWidth) map.resize(); });
      observer.observe(container);
      map.on("remove", () => observer.disconnect());
    }).catch(error => this.options.onError(error));
  }

  private renderCard(location: GeoLocation, deleted: boolean) {
    const card = document.createElement("article"); card.className = `location-card${deleted ? " is-deleted" : ""}`; card.dataset.locationId = location.id;
    const title = document.createElement("div"); title.className = "location-card-title";
    const icon = document.createElement("span"); icon.className = "location-pin-icon"; icon.textContent = "📍";
    const name = document.createElement("strong"); name.textContent = location.name || "未命名位置"; title.append(icon, name);
    const meta = document.createElement("p"); meta.className = "location-card-address"; meta.textContent = location.address || "未填写地址";
    const coords = document.createElement("p"); coords.className = "location-card-coordinates"; coords.textContent = `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)} · ${sourceLabels[location.source]} · ${precisionLabels[location.precision]}`;
    const actions = document.createElement("div"); actions.className = "location-card-actions";
    if (!deleted) {
      const insert = document.createElement("button"); insert.textContent = "插入正文"; insert.onclick = () => this.options.insert(location.id);
      const edit = document.createElement("button"); edit.textContent = "编辑"; edit.onclick = () => { this.draft = { ...location }; this.render(); };
      const remove = document.createElement("button"); remove.className = "danger"; remove.textContent = "删除"; remove.onclick = () => { if (confirm(`删除位置「${location.name}」？`)) void this.saveCommand("delete-location", { locationId: location.id }); };
      actions.append(insert, edit, remove);
    } else {
      const restore = document.createElement("button"); restore.textContent = "恢复"; restore.onclick = () => { this.draft = { ...location, deletedAt: undefined, updatedAt: nowIso() }; void this.saveCommand("update-location", { locationId: location.id, location: this.draft }); };
      actions.append(restore);
    }
    card.append(title, meta, coords, actions); return card;
  }

  private renderEditor(state: LocationManagerState) {
    const draft = this.draft!;
    this.disposeMap();
    this.disposeOverviewMap();
    const panel = this.options.panel; panel.replaceChildren();
    const head = document.createElement("div"); head.className = "location-editor-head";
    const back = document.createElement("button"); back.textContent = "← 返回位置"; back.onclick = () => { this.draft = null; this.render(); };
    const title = document.createElement("strong"); title.textContent = draft.id.startsWith("loc-") && !state.locations.some(location => location.id === draft.id) ? "新建位置" : "编辑位置";
    head.append(back, title); panel.append(head);
    const form = document.createElement("div"); form.className = "location-editor-form";
    const field = (label: string, type: string, value: string, onInput: (value: string) => void) => { const wrap = document.createElement("label"); wrap.className = "location-field"; const text = document.createElement("span"); text.textContent = label; const input = document.createElement("input"); input.type = type; input.value = value; input.oninput = () => onInput(input.value); wrap.append(text, input); return { wrap, input }; };
    const name = field("地点名称", "text", draft.name, value => { draft.name = value; });
    const address = field("地址", "text", draft.address, value => { draft.address = value; });
    form.append(name.wrap, address.wrap);
    const coordRow = document.createElement("div"); coordRow.className = "location-coordinate-row";
    const latitude = field("纬度", "number", String(draft.latitude), value => { draft.latitude = clampCoordinate(value, -90, 90); this.updateMapPoint(draft); });
    const longitude = field("经度", "number", String(draft.longitude), value => { draft.longitude = clampCoordinate(value, -180, 180); this.updateMapPoint(draft); });
    latitude.input.step = "any"; longitude.input.step = "any"; coordRow.append(latitude.wrap, longitude.wrap); form.append(coordRow);
    const scope = document.createElement("label"); scope.className = "location-field"; const scopeLabel = document.createElement("span"); scopeLabel.textContent = "保存范围"; const scopeSelect = document.createElement("select"); ["notebook", "global"].forEach(value => { const option = document.createElement("option"); option.value = value; option.textContent = value === "notebook" ? "当前笔记本" : "全局位置"; option.selected = draft.scope === value; scopeSelect.append(option); }); scopeSelect.onchange = () => { draft.scope = scopeSelect.value as LocationScope; if (draft.scope === "notebook") draft.notebookId = state.notebookId; else delete draft.notebookId; }; scope.append(scopeLabel, scopeSelect); form.append(scope);
    const mapCanvas = document.createElement("div"); mapCanvas.className = "location-editor-map"; form.append(mapCanvas);
    const tools = document.createElement("div"); tools.className = "location-editor-tools";
    const browser = document.createElement("button"); browser.textContent = "使用浏览器当前位置"; browser.onclick = () => navigator.geolocation?.getCurrentPosition(position => { draft.latitude = position.coords.latitude; draft.longitude = position.coords.longitude; draft.source = "browser"; draft.precision = position.coords.accuracy <= 100 ? "exact" : "street"; this.renderEditor(state); }, error => this.options.onError(new Error(`浏览器定位失败：${error.message}`)));
    const ip = document.createElement("button"); ip.textContent = "按公网 IP 定位"; ip.onclick = async () => { try { const response = await fetch("https://ipapi.co/json/"); if (!response.ok) throw new Error("IP 定位服务不可用"); const data = await response.json() as { latitude?: number; longitude?: number; city?: string; region?: string; country_name?: string }; if (!Number.isFinite(data.latitude) || !Number.isFinite(data.longitude)) throw new Error("IP 服务未返回有效坐标"); draft.latitude = Number(data.latitude); draft.longitude = Number(data.longitude); draft.source = "ip"; draft.precision = "city"; draft.address = [data.country_name, data.region, data.city].filter(Boolean).join(" "); this.renderEditor(state); } catch (error) { this.options.onError(error); } };
    const reverse = document.createElement("button"); reverse.textContent = "反查地址"; reverse.onclick = () => void this.reverseGeocode(draft, state);
    tools.append(browser, ip, reverse); form.append(tools);
    const actions = document.createElement("div"); actions.className = "location-editor-actions";
    const cancel = document.createElement("button"); cancel.textContent = "取消"; cancel.onclick = () => { this.draft = null; this.render(); };
    const save = document.createElement("button"); save.className = "primary"; save.textContent = "保存位置"; save.onclick = () => { draft.name = draft.name.trim() || "未命名位置"; draft.notebookId = draft.scope === "notebook" ? state.notebookId : undefined; void this.saveCommand(state.locations.some(location => location.id === draft.id) ? "update-location" : "create-location", { locationId: draft.id, location: { ...draft, updatedAt: nowIso() } }); };
    actions.append(cancel, save); form.append(actions); panel.append(form);
    this.map = L.map(mapCanvas, { zoomControl: true }).setView([draft.latitude, draft.longitude], 13);
    const addTiles = () => {
      if (this.map && !this.map.getPane("tilePane")?.querySelector(".leaflet-tile")) {
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(this.map);
      }
    };
    if (document.readyState === "complete") addTiles();
    else window.addEventListener("load", addTiles, { once: true });
    this.marker = L.marker([draft.latitude, draft.longitude], { draggable: true, icon: L.divIcon({ className: "location-map-pin", html: "📍", iconSize: [24, 24], iconAnchor: [12, 24] }) }).addTo(this.map);
    const updateDraftPoint = (lat: number, lng: number) => { draft.latitude = lat; draft.longitude = lng; draft.source = "map"; draft.precision = "unknown"; latitude.input.value = String(draft.latitude.toFixed(6)); longitude.input.value = String(draft.longitude.toFixed(6)); this.updateMapPoint(draft); this.scheduleReverse(draft, state); };
    this.map.on("click", (event: LeafletMouseEvent) => updateDraftPoint(event.latlng.lat, event.latlng.lng));
    this.marker.on("dragend", () => { const point = this.marker?.getLatLng(); if (point) updateDraftPoint(point.lat, point.lng); });
    requestAnimationFrame(() => this.map?.invalidateSize());
  }

  private updateMapPoint(draft: LocationDraft) { this.marker?.setLatLng([draft.latitude, draft.longitude]); this.map?.setView([draft.latitude, draft.longitude]); }
  private scheduleReverse(draft: LocationDraft, state: LocationManagerState) { clearTimeout(this.reverseTimer); this.reverseTimer = setTimeout(() => void this.reverseGeocode(draft, state), 600); }
  private async reverseGeocode(draft: LocationDraft, _state: LocationManagerState) {
    try { const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=zh-CN&lat=${encodeURIComponent(draft.latitude)}&lon=${encodeURIComponent(draft.longitude)}`); if (!response.ok) throw new Error("地址反查服务不可用"); const data = await response.json() as { display_name?: string; type?: string }; if (data.display_name) { draft.address = data.display_name; draft.precision = data.type === "road" ? "street" : "district"; this.renderEditor(this.options.getState()!); } } catch (error) { this.options.onError(error); }
  }
  private async saveCommand(operation: string, payload: Record<string, unknown>) {
    try { await this.options.execute({ operation, ...payload }, operation); this.draft = null; this.render(); } catch (error) { this.options.onError(error); }
  }
  private disposeMap() { clearTimeout(this.reverseTimer); this.reverseTimer = undefined; this.map?.remove(); this.map = null; this.marker = null; }
  private disposeOverviewMap() { this.overviewObserver?.disconnect(); this.overviewObserver = null; this.overviewMarkers.forEach(marker => marker.remove()); this.overviewMarkers = []; this.overviewMap?.remove(); this.overviewMap = null; }
}
