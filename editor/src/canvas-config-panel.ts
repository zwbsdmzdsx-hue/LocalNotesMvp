import type { CanvasCurve, CanvasNode } from "./workspace-api";
import type { PanelHandle } from "./module-registry";

export type CanvasConfigPanelModel = {
  nodes: CanvasNode[];
  label(node: CanvasNode): string;
  isReference(node: CanvasNode): boolean;
  commitNode(): void;
  commitCurve(delay: number): void;
  setReferenceDisplay(node: CanvasNode, value: "preview" | "icon"): void;
  toggleCanvasMode(node: CanvasNode): void;
  uploadNodeIcon(node: CanvasNode): Promise<void>;
  setCurveEndpoint(node: CanvasNode, key: "start" | "end", side: CanvasCurve["start"]["side"]): void;
  insertControlPoint(node: CanvasNode): void;
  beginBranch(node: CanvasNode): void;
  removeNode(nodeId: string): void;
};
export type CanvasConfigPanelHandle = PanelHandle & {
  setModel(model: CanvasConfigPanelModel | null): void;
  dismissCurve(): void;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function mountCanvasConfigPanel(slot: HTMLElement): CanvasConfigPanelHandle {
  let model: CanvasConfigPanelModel | null = null;
  function closeCurveStyleEditor() {
    slot.querySelector(".canvas-curve-style")?.remove();
  }

  function renderSelectionInspector() {
    slot.replaceChildren();
    const active = model;
    const nodes = active?.nodes ?? [];
    if (!active || !nodes.length) return;
    if (nodes.length > 1) {
      const summary = document.createElement("p"); summary.className = "canvas-inspector-summary";
      summary.textContent = `已选中 ${nodes.length} 个对象`;
      slot.append(summary);
      return;
    }
    const node = nodes[0];
    const section = document.createElement("div"); section.className = "canvas-object-settings";
    const kind = document.createElement("small"); kind.textContent = active.label(node); section.append(kind);
    const field = (label: string, value: string, apply: (value: string) => void, type = "text") => {
      const row = document.createElement("label"); row.textContent = label;
      const input = document.createElement("input"); input.type = type; input.value = value;
      input.addEventListener("change", () => apply(input.value)); row.append(input); section.append(row);
    };
    field("名称", node.name ?? "", value => { node.name = value.trim() || undefined; active.commitNode(); });
    if (node.kind !== "curve" && node.kind !== "draw" && !node.block?.parentId) {
      for (const [label, key] of [["X", "x"], ["Y", "y"], ["宽度", "width"], ["高度", "height"]] as const) {
        field(label, String(node[key]), value => {
          const number = Number(value);
          if (!Number.isFinite(number)) return;
          node[key] = Math.round(key === "width" ? clamp(number, 180, 900) : key === "height" ? clamp(number, 110, 760) : number);
          active.commitNode();
        }, "number");
      }
    }
    if (node.kind === "media" && node.block) {
      field("说明", node.block.content.caption ?? "", value => {
        node.block!.content.caption = value;
        node.block!.revision += 1;
        active.commitNode();
      });
    }
    if (node.block) {
      field("字号", String(node.fontSize ?? 14), value => {
        const size = Number(value);
        if (!Number.isFinite(size)) return;
        node.fontSize = Math.round(clamp(size, 10, 48));
        active.commitNode();
      }, "number");
    }
    const selectField = (label: string, value: string, options: [string, string][], apply: (value: string) => void) => {
      const row = document.createElement("label"); row.textContent = label;
      const select = document.createElement("select");
      options.forEach(([id, text]) => { const option = document.createElement("option"); option.value = id; option.textContent = text; select.append(option); });
      select.value = value;
      select.onchange = () => apply(select.value);
      row.append(select); section.append(row);
    };
    if (active.isReference(node)) {
      selectField("引用显示", node.referenceDisplay ?? "preview", [["preview", "正文预览"], ["icon", "图标"]], value => active.setReferenceDisplay(node, value as "preview" | "icon"));
    } else if (node.kind === "document" || node.kind === "canvas") {
      selectField("显示方式", node.displayMode ?? "preview", [["preview", "内容缩略图"], ["icon", "图标"]], value => {
        if (node.displayMode !== value) active.toggleCanvasMode(node);
      });
    }
    if (active.isReference(node) || node.kind === "document" || node.kind === "canvas") {
      field("图标字符或地址", node.referenceIcon ?? "", value => {
        node.referenceIcon = value.trim() || undefined;
        active.commitNode();
      });
      const upload = document.createElement("button"); upload.type = "button"; upload.className = "canvas-inspector-upload";
      upload.textContent = "上传图标"; upload.onclick = () => { void active.uploadNodeIcon(node); };
      section.append(upload);
    }
    slot.append(section);
    if (node.curve) showCurveStyleEditor(node, active);
  }

  function showCurveStyleEditor(node: CanvasNode, active: CanvasConfigPanelModel) {
    if (!node.curve) return;
    closeCurveStyleEditor();
    const popup = document.createElement("div"); popup.className = "canvas-curve-style"; popup.setAttribute("aria-label", "曲线样式");
    const heading = document.createElement("strong"); heading.textContent = "曲线样式"; popup.append(heading);
    const colorLabel = document.createElement("label"); colorLabel.textContent = "颜色 ";
    const color = document.createElement("input"); color.type = "color"; color.value = node.curve.color; colorLabel.append(color);
    const widthLabel = document.createElement("label"); widthLabel.textContent = "粗细 ";
    const width = document.createElement("input"); width.type = "range"; width.min = "1"; width.max = "10"; width.value = String(node.curve.width);
    const output = document.createElement("output"); output.value = `${node.curve.width}px`; widthLabel.append(width, output);
    const dashLabel = document.createElement("label"); dashLabel.textContent = "线型 ";
    const dash = document.createElement("select");
    [["solid", "实线"], ["dashed", "虚线"], ["dotted", "点线"]].forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; dash.append(option); });
    dash.value = node.curve.dash; dashLabel.append(dash);
    const endpointField = (label: string, key: "start" | "end") => {
      const row = document.createElement("label"); row.textContent = label;
      const select = document.createElement("select"); select.dataset.endpoint = key;
      [["top", "上边"], ["right", "右边"], ["bottom", "下边"], ["left", "左边"]].forEach(([value, text]) => {
        const option = document.createElement("option"); option.value = value; option.textContent = text; select.append(option);
      });
      select.value = node.curve![key].side;
      select.onchange = () => active.setCurveEndpoint(node, key, select.value as CanvasCurve["start"]["side"]);
      row.append(select); return row;
    };
    const arrowLabel = document.createElement("label"); arrowLabel.textContent = "箭头 ";
    const arrow = document.createElement("div"); arrow.className = "canvas-arrow-options";
    let arrowValue: CanvasCurve["arrow"] = node.curve.arrow ?? "none";
    [["none", "无箭头"], ["end", "终点箭头"], ["start", "起点箭头"], ["both", "双向箭头"]].forEach(([value, label]) => {
      const option = document.createElement("button"); option.type = "button"; option.textContent = label; option.dataset.arrow = value; option.setAttribute("aria-pressed", String(value === arrowValue));
      option.onclick = () => { arrowValue = value as CanvasCurve["arrow"]; arrow.querySelectorAll("button").forEach(item => item.setAttribute("aria-pressed", String(item === option))); update(); };
      arrow.append(option);
    });
    arrowLabel.append(arrow);
    const description = document.createElement("label"); description.textContent = "描述 ";
    const descriptionInput = document.createElement("input"); descriptionInput.type = "text"; descriptionInput.value = node.curve.label ?? ""; descriptionInput.placeholder = "连接说明"; descriptionInput.maxLength = 120; description.append(descriptionInput);
    popup.append(endpointField("起点连接", "start"), endpointField("终点连接", "end"), colorLabel, widthLabel, dashLabel, arrowLabel, description);
    const update = () => { node.curve!.color = color.value; node.curve!.width = Number(width.value); node.curve!.dash = dash.value as CanvasCurve["dash"]; node.curve!.arrow = arrowValue; node.curve!.label = descriptionInput.value.trim() || undefined; output.value = `${node.curve!.width}px`; active.commitCurve(120); };
    color.oninput = width.oninput = dash.oninput = descriptionInput.oninput = update;
    const control = document.createElement("button"); control.type = "button"; control.textContent = "插入控制点"; control.onclick = () => active.insertControlPoint(node);
    const branch = document.createElement("button"); branch.type = "button"; branch.textContent = "添加分支点"; branch.onclick = () => active.beginBranch(node);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger"; remove.textContent = "删除曲线"; remove.onclick = () => active.removeNode(node.id);
    popup.append(control, branch, remove);
    slot.append(popup);
  }

  return {
    update(context) { if (!context && model) { model = null; slot.replaceChildren(); } },
    setModel(next) { model = next; renderSelectionInspector(); },
    dismissCurve() { closeCurveStyleEditor(); },
    dispose() { model = null; slot.replaceChildren(); }
  };
}
