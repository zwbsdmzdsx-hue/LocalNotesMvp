export type DashboardFilterDocument = { id: string; title: string };

export function renderDashboardDocumentFilter(options: {
  documents: readonly DashboardFilterDocument[];
  selectedIds: readonly string[];
  onChange(ids: string[]): void;
}) {
  const body = document.createElement("div");
  body.className = "dashboard-document-filter";
  const selected = new Set(options.selectedIds);
  const all = document.createElement("button");
  all.type = "button";
  all.textContent = selected.size ? "显示全部文档" : "全部文档";
  all.onclick = () => options.onChange([]);
  body.append(all);
  options.documents.forEach(documentItem => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selected.has(documentItem.id);
    input.setAttribute("aria-label", `筛选文档：${documentItem.title}`);
    input.onchange = () => {
      if (input.checked) selected.add(documentItem.id);
      else selected.delete(documentItem.id);
      options.onChange([...selected]);
    };
    label.append(input, document.createTextNode(documentItem.title));
    body.append(label);
  });
  return body;
}
