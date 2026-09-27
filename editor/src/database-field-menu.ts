import type { DatabaseField, DatabaseSource } from "../../protocol/types";
import { databaseFieldMeta } from "./database-presentation";

export function showDatabaseFieldMenu(
  anchor: HTMLElement,
  database: DatabaseSource,
  field: DatabaseField | undefined,
  createId: () => string,
  saveFields: (fields: DatabaseField[]) => Promise<unknown>
) {
  document.querySelector(".database-field-menu")?.remove();
  const menu = document.createElement("div"); menu.className = "database-field-menu"; menu.setAttribute("role", "menu");
  const draft: DatabaseField = field ? { ...field } : {
    id: createId(), databaseId: database.id, key: `field_${database.fields.length + 1}`,
    title: "新字段", type: "text", position: ""
  };
  const name = document.createElement("input"); name.value = draft.title; name.placeholder = "字段名称";
  const key = document.createElement("input"); key.value = draft.key; key.placeholder = "稳定 key";
  const type = document.createElement("select");
  (Object.keys(databaseFieldMeta) as DatabaseField["type"][]).forEach(value => {
    const option = document.createElement("option"); option.value = value;
    option.textContent = `${databaseFieldMeta[value].icon} ${databaseFieldMeta[value].label}`;
    option.selected = draft.type === value; type.append(option);
  });
  const formula = document.createElement("textarea"); formula.value = draft.formula ?? "";
  formula.placeholder = 'prop("数值") * 2'; formula.hidden = draft.type !== "formula" && draft.type !== "rule";
  type.onchange = () => { draft.type = type.value as DatabaseField["type"]; formula.hidden = draft.type !== "formula" && draft.type !== "rule"; };
  const actions = document.createElement("div"); actions.className = "database-field-menu-actions";
  const save = document.createElement("button"); save.textContent = field ? "保存" : "添加列";
  save.onclick = () => {
    draft.title = name.value.trim() || "未命名字段";
    draft.key = key.value.trim() || `field_${database.fields.length + 1}`;
    draft.formula = formula.value.trim() || undefined;
    const fields = field ? database.fields.map(item => item.id === field.id ? draft : item) : [...database.fields, draft];
    void saveFields(fields).then(() => menu.remove());
  };
  actions.append(save);
  if (field) {
    const remove = document.createElement("button"); remove.className = "danger"; remove.textContent = "删除列";
    remove.onclick = () => {
      if (!confirm(`删除列「${field.title}」？`)) return;
      void saveFields(database.fields.filter(item => item.id !== field.id)).then(() => menu.remove());
    };
    actions.append(remove);
  }
  menu.append(name, key, type, formula, actions); document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(window.innerWidth - 270, rect.left)}px`;
  menu.style.top = `${Math.min(window.innerHeight - 280, rect.bottom + 5)}px`;
  const close = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node) && event.target !== anchor) {
      menu.remove(); document.removeEventListener("mousedown", close);
    }
  };
  window.setTimeout(() => document.addEventListener("mousedown", close), 0);
}
