import type { Block, BlockContent } from "../../protocol/types";
import { markdownFromContent } from "./markdown";
import type { BlockSnapshotReader } from "./block-snapshot";
import { readTextBlockSnapshotWithVariant, type TextBlockVariant, type TextSnapshotVariant } from "./text-block-editor";

export function todoBodyMarkdown(content: BlockContent) {
  const source = markdownFromContent(content).replace(/\r\n?/g, "\n");
  return source.replace(/^\s*[-*+]\s+\[[ xX]\]\s?/, "");
}

export function todoMarkdownFromContent(content: BlockContent) {
  const body = todoBodyMarkdown(content);
  return `- [${content.checked ? "x" : " "}]${body ? ` ${body}` : ""}`;
}

export function todoSourcePrefix(block: Block) {
  return `- [${block.content.checked ? "x" : " "}] `;
}

export function contentFromTodoMarkdown(
  source: string, fallback: BlockContent,
  fromMarkdown: (source: string, fallback: BlockContent) => BlockContent
): BlockContent {
  const normalized = source.replace(/\r\n?/g, "\n");
  const firstLineEnd = normalized.indexOf("\n");
  const firstLine = firstLineEnd < 0 ? normalized : normalized.slice(0, firstLineEnd);
  const marker = firstLine.match(/^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/);
  const checked = marker ? marker[1].toLowerCase() === "x" : (fallback.checked ?? false);
  const body = marker ? [marker[2], ...normalized.split("\n").slice(1)].join("\n") : normalized;
  const content = fromMarkdown(body, fallback);
  return { ...content, checked, markdown: body };
}

export function splitTodoSource(
  current: Block, next: Block, source: string, start: number, end: number,
  fromMarkdown: (source: string, fallback: BlockContent) => BlockContent
) {
  const firstLineEnd = source.indexOf("\n");
  const firstLine = firstLineEnd < 0 ? source : source.slice(0, firstLineEnd);
  const marker = firstLine.match(/^(\s*[-*+]\s+\[([ xX])\]\s?)(.*)$/);
  const markerLength = marker ? marker[1].length : 0;
  const body = marker ? [marker[3], ...source.split("\n").slice(1)].join("\n") : source;
  const bodyStart = marker ? Math.min(body.length, Math.max(0, start - markerLength)) : start;
  const bodyEnd = marker ? Math.min(body.length, Math.max(bodyStart, end - markerLength)) : end;
  current.content = fromMarkdown(body.slice(0, bodyStart), current.content);
  current.content.checked = marker ? marker[2].toLowerCase() === "x" : (current.content.checked ?? false);
  next.content = fromMarkdown(body.slice(bodyEnd), { ...current.content, checked: false });
  return todoMarkdownFromContent(current.content);
}

const todoSnapshotVariant: TextSnapshotVariant = {
  content: (shell, previous, context) => {
    const editable = shell.querySelector<HTMLElement>(":scope > .block-row > .block-text");
    if (!editable || context.mode === "preview") return previous?.content ?? { text: "", html: "", markdown: "", checked: false };
    return context.mode === "source"
      ? contentFromTodoMarkdown(context.sourceText(editable), previous?.content ?? { text: "", html: "", checked: false }, context.contentFromMarkdown)
      : context.contentFromRichEditable(editable, previous?.content ?? { text: "", html: "", checked: false });
  },
  enrich: (shell, previous, content, properties, context) => {
    const checked = context.mode === "source"
      ? content.checked ?? previous?.content.checked ?? false
      : shell.querySelector<HTMLInputElement>(".todo-check")?.checked ?? previous?.content.checked ?? false;
    const completed = shell.querySelector<HTMLInputElement>(".todo-completed-date")?.value || undefined;
    return {
      content: { ...content, checked },
      properties: {
        ...properties,
        todoCreatedAt: shell.querySelector<HTMLInputElement>(".todo-created-date")?.value || undefined,
        todoDueAt: shell.querySelector<HTMLInputElement>(".todo-due-date")?.value || undefined,
        todoCompletedAt: checked ? (completed || previous?.properties.todoCompletedAt || todayIsoDate()) : undefined
      }
    };
  }
};

export const readTodoBlockSnapshot: BlockSnapshotReader = (shell, previous, context) =>
  readTextBlockSnapshotWithVariant(shell, previous, context, todoSnapshotVariant);

export const todoTextVariant: TextBlockVariant = {
  source: block => todoMarkdownFromContent(block.content),
  preview: block => todoBodyMarkdown(block.content),
  rich: block => ({ markdown: todoBodyMarkdown(block.content), text: block.content.text }),
  mount: (row, block, mode, onChange) => attachTodoControls(row, block, mode, onChange)
};

export function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

type TodoStatus = "pending" | "overdue" | "complete-early" | "complete-late" | "none";

export function isTodoBlock(block: Pick<Block, "type">) {
  return block.type === "todo";
}

export function todoStatus(checked: boolean, dueAt?: string, completedAt?: string, today = todayIsoDate()): TodoStatus {
  if (checked) {
    const completed = completedAt || today;
    return dueAt && completed > dueAt ? "complete-late" : "complete-early";
  }
  if (dueAt && today > dueAt) return "overdue";
  return dueAt ? "pending" : "none";
}

function updateTodoStatus(row: HTMLElement) {
  const indicator = row.querySelector<HTMLElement>(".todo-status-indicator");
  if (!indicator) return;
  const checked = row.querySelector<HTMLInputElement>(".todo-check")?.checked ?? false;
  const dueAt = row.querySelector<HTMLInputElement>(".todo-due-date")?.value || undefined;
  const completedAt = row.querySelector<HTMLInputElement>(".todo-completed-date")?.value || undefined;
  const status = todoStatus(checked, dueAt, completedAt);
  indicator.className = `todo-status-indicator todo-status-${status}`;
  indicator.textContent = status === "complete-early" || status === "complete-late" ? "✓"
    : status === "overdue" ? "!" : status === "pending" ? "○" : "";
  indicator.title = status === "complete-early" ? "已在目标日期前完成"
    : status === "complete-late" ? "已完成，但晚于目标日期"
      : status === "overdue" ? "已逾期，尚未完成" : status === "pending" ? "等待完成" : "";
  indicator.setAttribute("aria-label", indicator.title || "无日期状态");
}

export function attachTodoControls(
  row: HTMLElement, block: Block, mode: "rich" | "source" | "preview", onChange: () => void
) {
  const grip = row.querySelector<HTMLElement>(".grip")!;
  const editable = row.querySelector<HTMLElement>(".block-text")!;
  const checkbox = document.createElement("input"); checkbox.className = "todo-check";
  checkbox.type = "checkbox"; checkbox.checked = block.content.checked === true;
  const indicator = document.createElement("span"); indicator.className = "todo-status-indicator";
  indicator.setAttribute("aria-label", "无日期状态");
  grip.after(checkbox, indicator);
  const dates = document.createElement("span"); dates.className = "todo-dates";
  dates.setAttribute("aria-label", "待办日期");
  const dateInput = (title: string, label: string, className: string) => {
    const wrapper = document.createElement("label"); wrapper.title = title;
    const text = document.createElement("span"); text.textContent = label;
    const input = document.createElement("input"); input.type = "date"; input.className = className;
    input.setAttribute("aria-label", title); wrapper.append(text, input); dates.append(wrapper);
    return input;
  };
  const created = dateInput("记录创建日期", "创建", "todo-created-date");
  const due = dateInput("目标完成日期", "应完成", "todo-due-date");
  const completed = dateInput("实际完成日期", "完成", "todo-completed-date");
  created.value = block.properties.todoCreatedAt ?? "";
  due.value = block.properties.todoDueAt ?? "";
  completed.value = block.properties.todoCompletedAt ?? (block.content.checked ? todayIsoDate() : "");
  editable.after(dates);
  if (mode === "source") { dates.hidden = true; checkbox.hidden = true; }
  if (mode === "preview") { checkbox.disabled = true; created.disabled = true; due.disabled = true; completed.disabled = true; }
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) { if (!completed.value) completed.value = todayIsoDate(); }
    else completed.value = "";
    updateTodoStatus(row); onChange();
  });
  created.addEventListener("change", onChange);
  for (const input of [due, completed]) {
    input.addEventListener("input", () => updateTodoStatus(row));
    input.addEventListener("change", () => { updateTodoStatus(row); onChange(); });
  }
  updateTodoStatus(row);
}

/** Add the Todo-specific controls around a Canvas text editor. */
export function attachCanvasTodoControls(
  body: HTMLElement,
  block: Block,
  services: { syncPreview(): void; scheduleSave(delay?: number): void }
) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "canvas-todo-check";
  checkbox.checked = block.content.checked === true;
  checkbox.setAttribute("aria-label", "完成待办");
  checkbox.onchange = () => {
    block.content.checked = checkbox.checked;
    block.properties.todoCompletedAt = checkbox.checked
      ? (block.properties.todoCompletedAt || todayIsoDate())
      : undefined;
    const completedInput = body.querySelector<HTMLInputElement>(".todo-completed-date");
    if (completedInput) completedInput.value = block.properties.todoCompletedAt ?? "";
    updateCanvasTodoStatus(body, block);
    services.syncPreview();
  };

  const dates = document.createElement("span");
  dates.className = "canvas-todo-dates";
  dates.setAttribute("aria-label", "待办日期");
  const dateControl = (className: string, labelText: string, value: string | undefined) => {
    const label = document.createElement("label");
    label.title = labelText;
    const caption = document.createElement("span");
    caption.textContent = labelText;
    const input = document.createElement("input");
    input.type = "date";
    input.className = className;
    input.setAttribute("aria-label", labelText);
    input.value = value ?? "";
    input.addEventListener("change", () => {
      const property = className === "todo-created-date" ? "todoCreatedAt"
        : className === "todo-due-date" ? "todoDueAt" : "todoCompletedAt";
      const next = input.value || undefined;
      block.properties[property] = next;
      if (property === "todoCompletedAt") {
        block.content.checked = !!next;
        checkbox.checked = !!next;
      }
      updateCanvasTodoStatus(body, block);
      if (property === "todoCompletedAt") services.syncPreview();
      services.scheduleSave(0);
    });
    label.append(caption, input);
    dates.append(label);
  };
  dateControl("todo-created-date", "创建", block.properties.todoCreatedAt);
  dateControl("todo-due-date", "应完成", block.properties.todoDueAt);
  dateControl("todo-completed-date", "完成", block.properties.todoCompletedAt);
  const status = document.createElement("span");
  status.className = "canvas-todo-status";
  dates.prepend(status);
  body.querySelector<HTMLElement>("textarea.canvas-note-text")?.before(dates);
  body.prepend(checkbox);
  updateCanvasTodoStatus(body, block);
}

function updateCanvasTodoStatus(body: HTMLElement, block: Block) {
  const indicator = body.querySelector<HTMLElement>(".canvas-todo-status");
  if (!indicator) return;
  const status = todoStatus(!!block.content.checked, block.properties.todoDueAt, block.properties.todoCompletedAt);
  indicator.className = `canvas-todo-status todo-status-${status}`;
  indicator.textContent = status === "complete-early" || status === "complete-late" ? "✓"
    : status === "overdue" ? "!" : status === "pending" ? "○" : "";
}
