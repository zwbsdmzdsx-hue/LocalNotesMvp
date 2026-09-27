import type { DatabaseField } from "../../protocol/types";
import type { PanelHandle } from "./module-registry";
import type { PanelContext } from "./panel-context";
import { panelDataState } from "./panel-context";
import { databaseFieldMeta } from "./database-presentation";
import { databaseBlockRole } from "./block-modules";

export type DatabasePanelActions = {
  saveQuery(blockId: string, query: string, documentId: string): void;
  saveSchema(databaseId: string, fields: DatabaseField[], title: string, documentId: string): void;
  export(databaseId: string, csv: boolean, documentId: string): void;
};
export type DatabasePanelHandle = PanelHandle & { setSelectedBlockId(blockId: string | null): void };

export function mountDatabasePanel(slot: HTMLElement, actions: DatabasePanelActions): DatabasePanelHandle {
  let context: PanelContext | null = null;
  let selectedBlockId: string | null = null;
  function renderDatabases() {
    const state = context ? panelDataState(context) : null;
    if (!state) { slot.replaceChildren(); return; }
    slot.replaceChildren();
    const activeId = selectedBlockId;
    const block = activeId ? state.blocks.find(item => item.id === activeId) : undefined;
    const role = block ? databaseBlockRole(block) : undefined;
    if (!block || !role) {
      return;
    }
    const database = state.databases?.find(item => item.id === block.properties.databaseId);
    if (!database) {
      return;
    }
    const sources = state.databases ?? [];
    const panel = document.createElement("section");
    panel.className = "database-context-panel";
    const heading = document.createElement("div");
    heading.className = "database-context-heading";
    const headingText = document.createElement("strong");
    headingText.textContent = role === "query" ? "查询视图属性" : "数据表属性";
    const count = document.createElement("span");
    count.textContent = `${database.recordCount} 条记录`;
    heading.append(headingText, count);
    panel.append(heading);

    if (role === "query") {
      const source = document.createElement("div");
      source.className = "database-context-source";
      source.textContent = `数据源 · ${database.title}`;
      const query = document.createElement("textarea");
      query.className = "database-context-query";
      query.value = block.properties.dataQuery ?? "FROM current";
      query.setAttribute("aria-label", "DQL 查询");
      const refresh = document.createElement("button");
      refresh.textContent = "保存并刷新";
      refresh.onclick = () => {
        actions.saveQuery(block.id, query.value, state.note.id);
      };
      panel.append(source, query, refresh);
      slot.append(panel);
      return;
    }

    const titleLabel = document.createElement("label");
    titleLabel.className = "database-context-control";
    const titleCaption = document.createElement("span");
    titleCaption.textContent = "数据表名称";
    const title = document.createElement("input");
    title.value = database.title;
    title.placeholder = "数据表名称";
    title.setAttribute("aria-label", "数据表名称");
    titleLabel.append(titleCaption, title);
    panel.append(titleLabel);

    const fields = document.createElement("div");
    fields.className = "database-context-fields";
    const drafts = database.fields.map(field => ({ ...field }));
    const addControl = (container: HTMLElement, caption: string, control: HTMLElement) => {
      const label = document.createElement("label");
      label.className = "database-context-control";
      const text = document.createElement("span");
      text.textContent = caption;
      label.append(text, control);
      container.append(label);
    };
    const databaseSelect = (field: DatabaseField) => {
      const select = document.createElement("select");
      for (const source of sources) {
        const option = document.createElement("option");
        option.value = source.id;
        option.textContent = source.title;
        option.selected = (field.relationDatabaseId ?? database.id) === source.id;
        select.append(option);
      }
      select.onchange = () => { field.relationDatabaseId = select.value || database.id; drawFields(); };
      return select;
    };
    const drawFields = () => {
      fields.replaceChildren();
      drafts.forEach((field, index) => {
        const details = document.createElement("details");
        details.className = "database-context-field";
        const summary = document.createElement("summary");
        const icon = document.createElement("span");
        icon.className = "database-field-icon";
        icon.textContent = databaseFieldMeta[field.type].icon;
        const fieldTitle = document.createElement("span");
        fieldTitle.textContent = field.title || "未命名字段";
        const fieldType = document.createElement("small");
        fieldType.textContent = databaseFieldMeta[field.type].label;
        summary.append(icon, fieldTitle, fieldType);
        details.append(summary);

        const body = document.createElement("div");
        body.className = "database-context-field-body";
        const name = document.createElement("input");
        name.value = field.title;
        name.oninput = () => { field.title = name.value; fieldTitle.textContent = name.value || "未命名字段"; };
        addControl(body, "字段名称", name);
        const key = document.createElement("input");
        key.value = field.key;
        key.oninput = () => field.key = key.value;
        addControl(body, "属性 key", key);
        const type = document.createElement("select");
        (Object.keys(databaseFieldMeta) as DatabaseField["type"][]).forEach(value => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = `${databaseFieldMeta[value].icon} ${databaseFieldMeta[value].label}`;
          option.selected = field.type === value;
          type.append(option);
        });
        type.onchange = () => { field.type = type.value as DatabaseField["type"]; drawFields(); };
        addControl(body, "字段类型", type);

        if (field.type === "formula" || field.type === "rule") {
          const formula = document.createElement("textarea");
          formula.value = field.formula ?? "";
          formula.placeholder = field.type === "rule" ? 'prop("状态") = "完成"' : 'prop("单价") * prop("数量")';
          formula.oninput = () => field.formula = formula.value;
          addControl(body, field.type === "rule" ? "规则表达式" : "公式表达式", formula);
        }
        if (field.type === "document_relation") {
          field.relationScope = "document";
          const hint = document.createElement("p");
          hint.className = "database-context-hint";
          hint.textContent = "关联当前笔记本中的文档；单元格保存稳定文档 ID。";
          body.append(hint);
        }
        if (field.type === "record_relation" || field.type === "rollup") {
          field.relationScope = "record";
          addControl(body, "关联数据表", databaseSelect(field));
        }
        if (field.type === "rollup") {
          const targetSource = sources.find(source => source.id === field.relationDatabaseId) ?? database;
          const targetField = document.createElement("select");
          for (const candidate of targetSource.fields) {
            const option = document.createElement("option");
            option.value = candidate.key;
            option.textContent = `${databaseFieldMeta[candidate.type].icon} ${candidate.title}`;
            option.selected = field.rollupFieldKey === candidate.key;
            targetField.append(option);
          }
          targetField.onchange = () => field.rollupFieldKey = targetField.value;
          addControl(body, "汇总字段", targetField);
          const operation = document.createElement("select");
          const rollupLabels: Record<NonNullable<DatabaseField["rollup"]>, string> = { count: "计数", sum: "求和", avg: "平均值", min: "最小值", max: "最大值", unique: "去重计数" };
          (Object.keys(rollupLabels) as NonNullable<DatabaseField["rollup"]>[]).forEach(value => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = rollupLabels[value];
            option.selected = (field.rollup ?? "count") === value;
            operation.append(option);
          });
          operation.onchange = () => field.rollup = operation.value as DatabaseField["rollup"];
          addControl(body, "计算方式", operation);
        }
        const remove = document.createElement("button");
        remove.className = "danger database-context-remove";
        remove.textContent = "删除字段";
        remove.onclick = () => {
          drafts.splice(index, 1);
          drafts.forEach((item, itemIndex) => item.position = String((itemIndex + 1) * 1000).padStart(8, "0"));
          drawFields();
        };
        body.append(remove);
        details.append(body);
        fields.append(details);
      });
    };
    drawFields();
    panel.append(fields);

    const controls = document.createElement("div");
    controls.className = "database-manager-actions";
    const add = document.createElement("button");
    add.textContent = "+ 添加字段";
    add.onclick = () => {
      drafts.push({ id: `field-${crypto.randomUUID().replace(/-/g, "")}`, databaseId: database.id, key: `field_${drafts.length + 1}`, title: "新字段", type: "text", position: String((drafts.length + 1) * 1000).padStart(8, "0") });
      drawFields();
      fields.lastElementChild?.setAttribute("open", "");
    };
    const save = document.createElement("button");
    save.className = "primary";
    save.textContent = "保存属性";
    save.onclick = () => { actions.saveSchema(database.id, drafts, title.value.trim() || "未命名数据表", state.note.id); };
    const exportButton = (csv: boolean) => {
      const button = document.createElement("button");
      button.textContent = csv ? "导出 CSV" : "导出 Markdown";
      button.onclick = () => {
        actions.export(database.id, csv, state.note.id);
      };
      return button;
    };
    controls.append(add, save, exportButton(false), exportButton(true));
    panel.append(controls);
    slot.append(panel);
  }

  return {
    update(next) {
      if (context?.state.note.id !== next?.state.note.id) selectedBlockId = null;
      context = next;
      renderDatabases();
    },
    setSelectedBlockId(blockId) { selectedBlockId = blockId; renderDatabases(); },
    dispose() { slot.replaceChildren(); }
  };
}
