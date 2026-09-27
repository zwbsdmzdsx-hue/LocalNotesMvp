import type { StyleSheet } from "../../protocol/types";
import type { PanelHandle } from "./module-registry";
import type { PanelContext } from "./panel-context";
import { panelDataState } from "./panel-context";
import { cleanCss, scopeCss, stylePreviewElement } from "./style-rules";

export type StyleScope = "system" | "notebook" | "document";
export type StylePanelActions = {
  apply(style: StyleSheet): void;
  save(style: StyleSheet, documentId: string): void;
  delete(styleId: string, scope: StyleScope, documentId: string): void;
};
export type StylesPanelHandle = PanelHandle & { setScope(scope: StyleScope): void };

export function mountStylesPanel(slot: HTMLElement, actions: StylePanelActions): StylesPanelHandle {
  let context: PanelContext | null = null;
  let stylePanelScope: StyleScope = "document";
  function renderStyles() {
    document.querySelectorAll<HTMLStyleElement>("style[data-style-preview]").forEach(el => el.remove());
    const state = context ? panelDataState(context) : null;
    if (!state) { slot.replaceChildren(); return; }
    const list = stylePanelScope === "system"
      ? (state.systemStyles ?? [])
      : stylePanelScope === "notebook"
        ? (state.notebookStyles ?? [])
        : (state.documentStyles ?? []);
    slot.replaceChildren();
    const scope = document.createElement("div"); scope.className = "style-scope-switch";
    (["system", "notebook", "document"] as const).forEach(kind => { const button = document.createElement("button"); button.textContent = kind === "system" ? "系统" : kind === "notebook" ? "当前笔记本" : "当前文档"; button.className = stylePanelScope === kind ? "active" : ""; button.onclick = () => { stylePanelScope = kind; renderStyles(); }; scope.append(button); });
    slot.append(scope);
    const scopeLabel = stylePanelScope === "system" ? "系统" : stylePanelScope === "notebook" ? "笔记本" : "文档";
    const add = document.createElement("button"); add.className = "style-add"; add.textContent = `+ 新建${scopeLabel}样式`;
    add.onclick = () => renderStyleCard({ id: crypto.randomUUID().replace(/-/g, ""), title: "新样式", description: "", css: ".callout { padding: 8px; border-left: 3px solid #3b82f6; }", enabled: true, position: String((list.length + 1) * 1000).padStart(8, "0"), scope: stylePanelScope }, true);
    slot.append(add);
    if (!list.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "还没有样式。正文 HTML 或 Markdown 中使用 class 即可套用。"; slot.append(empty); }
    list.forEach(style => renderStyleCard(style, false));
  }
  function renderStyleCard(style: StyleSheet, draft: boolean) {
    const details = document.createElement("details"); details.className = "style-card"; details.open = draft;
    const summary = document.createElement("summary"); summary.className = "style-card-summary";
    const preview = document.createElement("span"); preview.className = `style-preview style-preview-${style.id}`;
    const sample = stylePreviewElement(style); preview.append(sample);
    const desc = document.createElement("span"); desc.className = "style-description"; desc.textContent = style.description || "暂无描述";
    const apply = document.createElement("button"); apply.type = "button"; apply.className = "style-apply"; apply.textContent = "应用"; apply.title = "应用到正文选中内容";
    apply.addEventListener("mousedown", event => event.preventDefault());
    apply.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); actions.apply(style); });
    summary.append(preview, desc, apply); details.append(summary);
    const body = document.createElement("div"); body.className = "style-card-body";
    const title = document.createElement("input"); title.value = style.title; title.placeholder = "标题";
    const description = document.createElement("input"); description.value = style.description; description.placeholder = "简短描述";
    const css = document.createElement("textarea"); css.value = style.css; css.placeholder = ".callout { ... }"; css.rows = 7;
    const enabled = document.createElement("label"); enabled.className = "style-enabled"; const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = style.enabled; enabled.append(checkbox, document.createTextNode("启用"));
    const controls = document.createElement("div"); controls.className = "style-actions";
    const save = document.createElement("button"); save.textContent = "保存"; save.onclick = () => { const state = context ? panelDataState(context) : null; if (!state) return; const next = { ...style, title: title.value.trim() || "未命名样式", description: description.value.trim(), css: cleanCss(css.value), enabled: checkbox.checked, scope: stylePanelScope }; actions.save(next, state.note.id); };
    const remove = document.createElement("button"); remove.className = "danger"; remove.textContent = "删除"; remove.onclick = () => { const state = context ? panelDataState(context) : null; if (!state || !confirm("删除这个样式？")) return; actions.delete(style.id, style.scope, state.note.id); };
    controls.append(save, remove); body.append(title, description, css, enabled, controls); details.append(body); slot.append(details);
    const local = document.createElement("style"); local.dataset.stylePreview = style.id; local.textContent = scopeCss(style.css, `.style-preview-${style.id}`); document.head.append(local);
  }

  return {
    update(next) { context = next; renderStyles(); },
    setScope(scope) { stylePanelScope = scope; renderStyles(); },
    dispose() {
      document.querySelectorAll<HTMLStyleElement>("style[data-style-preview]").forEach(el => el.remove());
      slot.replaceChildren();
    }
  };
}
