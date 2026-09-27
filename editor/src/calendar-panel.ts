import type { Block, EditorState } from "../../protocol/types";
import type { CalendarTodo, WorkspaceApi } from "./workspace-api";
import type { PanelHandle } from "./module-registry";
import type { PanelContext } from "./panel-context";
import { mergeSurfaceTodos } from "./panel-context";
import { markdownFromContent, renderMarkdown } from "./markdown";
import { headingInfo } from "./link-suggestions";

export type CalendarPanelCallbacks = {
  onLoadDocumentPreview: (documentId: string) => Promise<EditorState>;
  onCreateDiary: (documentId: string, heading: string) => Promise<void>;
  onInsertDiaryLink: (documentId: string, blockId?: string, scope?: "block" | "heading", label?: string) => void;
  onOpenDocument: (documentId: string, blockId?: string) => void;
  onCreated: (documentId: string) => void;
  onError: (error: unknown) => void;
};

export type CalendarPanelHandle = PanelHandle & { open(): void };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

export function mountCalendarPanel(slot: HTMLElement, workspace: WorkspaceApi, cb: CalendarPanelCallbacks): CalendarPanelHandle {
  let panelContext: PanelContext | null = null;
  type CalendarPreview = { documentId: string; state: EditorState; headingId?: string; blockIds: string[]; selectedBlockId?: string };
  const now = new Date();
  let calendarYear = now.getFullYear();
  let calendarDate = `${calendarYear}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let calendarPreview: CalendarPreview | null = null;
  let calendarLoading = false;
  let calendarLoadToken = 0;

  function diaryNotebook(snapshot = workspace.snapshot()) {
    return snapshot.notebooks.find(notebook => notebook.id === "nb-diary" || notebook.name === "日记");
  }

  function diaryDocuments(snapshot = workspace.snapshot()) {
    const notebook = diaryNotebook(snapshot);
    if (!notebook) return [];
    const bookmarkIds = new Set(snapshot.bookmarks.filter(bookmark => bookmark.notebookId === notebook.id).map(bookmark => bookmark.id));
    return snapshot.documents.filter(document => bookmarkIds.has(document.bookmarkId) && /^\d{4}-\d{1,2}月$/.test(document.title));
  }

  function diaryMonthTitle(year: number, month: number) { return `${year}-${month}月`; }
  function diaryDocument(year: number, month: number) {
    return diaryDocuments().find(document => document.title === diaryMonthTitle(year, month));
  }

  function headingForCalendar(block: Block) {
    return headingInfo(block);
  }

  function calendarDateFromHeading(title: string, fallbackDate: string) {
    const [fallbackYear, fallbackMonth] = fallbackDate.split("-").map(Number);
    const full = title.match(/^(\d{4})\s*(?:[-\/.年]\s*)(\d{1,2})\s*(?:[-\/.月]\s*)(\d{1,2})/);
    if (full) return formatCalendarDate(Number(full[1]), Number(full[2]), Number(full[3]));
    const monthDay = title.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (monthDay) return formatCalendarDate(fallbackYear, Number(monthDay[1]), Number(monthDay[2]));
    const shortMonthDay = title.match(/^(\d{1,2})\s*[-\/.]\s*(\d{1,2})/);
    if (shortMonthDay) return formatCalendarDate(fallbackYear, Number(shortMonthDay[1]), Number(shortMonthDay[2]));
    const dayOnly = title.match(/^(\d{1,2})\s*日?(?:\s|$)/);
    if (dayOnly) return formatCalendarDate(fallbackYear, fallbackMonth, Number(dayOnly[1]));
    return "";
  }

  function calendarSection(state: EditorState, date: string) {
    const ordered = [...state.blocks].sort((a, b) => a.position.localeCompare(b.position));
    const index = ordered.findIndex(block => {
      const heading = headingForCalendar(block);
      return heading?.level === 1 && calendarDateFromHeading(heading.title, date) === date;
    });
    if (index < 0) return { headingId: undefined, blocks: [] as Block[] };
    const heading = headingForCalendar(ordered[index]);
    const blocks: Block[] = [];
    for (let cursor = index; cursor < ordered.length; cursor++) {
      const current = headingForCalendar(ordered[cursor]);
      if (cursor > index && current && current.level <= (heading?.level ?? 1)) break;
      blocks.push(ordered[cursor]);
    }
    return { headingId: ordered[index].id, blocks };
  }

  function formatCalendarDate(year: number, month: number, day: number) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function todayCalendarDate() {
    const current = new Date();
    return formatCalendarDate(current.getFullYear(), current.getMonth() + 1, current.getDate());
  }

  function calendarTodoStatus(todo: CalendarTodo): "pending" | "overdue" | "complete" {
    if (todo.checked) return "complete";
    return todo.dueAt && todayCalendarDate() > todo.dueAt ? "overdue" : "pending";
  }

  function calendarTodoStatusLabel(todo: CalendarTodo) {
    const status = calendarTodoStatus(todo);
    return status === "complete" ? "已完成" : status === "overdue" ? "已逾期" : "待完成";
  }

  async function loadCalendarPreview(date = calendarDate) {
    const token = ++calendarLoadToken;
    const [yearText, monthText] = date.split("-");
    const document = diaryDocument(Number(yearText), Number(monthText));
    calendarPreview = null;
    calendarLoading = true;
    renderCalendar();
    if (document) {
      try {
        const state = await cb.onLoadDocumentPreview(document.id);
        if (token !== calendarLoadToken) return;
        const section = calendarSection(state, date);
        calendarPreview = { documentId: document.id, state, headingId: section.headingId, blockIds: section.blocks.map(block => block.id), selectedBlockId: section.headingId };
      } catch (error) {
        cb.onError(error);
      }
    }
    if (token !== calendarLoadToken) return;
    calendarLoading = false;
    renderCalendar();
  }

  async function ensureDiaryContainer() {
    let snapshot = workspace.snapshot();
    const previousNotebookId = snapshot.activeNotebookId;
    let notebook = diaryNotebook(snapshot);
    if (!notebook) {
      notebook = { id: "nb-diary", name: "日记" };
      await workspace.execute({ type: "createNotebook", notebook });
      snapshot = workspace.snapshot();
    }
    let bookmark = snapshot.bookmarks.find(item => item.notebookId === notebook!.id && item.name === "日记");
    if (!bookmark) {
      bookmark = { id: "bk-diary", notebookId: notebook.id, name: "日记", color: "#64748B" };
      await workspace.execute({ type: "createBookmark", bookmark });
    }
    if (previousNotebookId && workspace.snapshot().activeNotebookId !== previousNotebookId)
      await workspace.execute({ type: "selectNotebook", id: previousNotebookId });
    return { notebook, bookmark };
  }

  function showDiaryCreatePopup() {
    document.querySelector(".calendar-create-popup")?.remove();
    const popup = document.createElement("div");
    popup.className = "calendar-create-popup";
    const title = document.createElement("strong"); title.textContent = "新建日记";
    const hint = document.createElement("span"); hint.textContent = `${calendarDate} · 将写入对应月份文档`;
    const input = document.createElement("input"); input.placeholder = "日记标题（可选）"; input.value = calendarDate;
    const actions = document.createElement("div"); actions.className = "calendar-create-actions";
    const cancel = document.createElement("button"); cancel.textContent = "取消";
    const confirm = document.createElement("button"); confirm.textContent = "创建"; confirm.className = "primary";
    cancel.onclick = () => popup.remove();
    confirm.onclick = () => {
      const rawHeading = input.value.trim() || calendarDate;
      const heading = rawHeading.startsWith(calendarDate) ? rawHeading : `${calendarDate} ${rawHeading}`;
      popup.remove();
      void createDiaryForDate(heading);
    };
    input.addEventListener("keydown", event => { if (event.key === "Enter") confirm.click(); if (event.key === "Escape") cancel.click(); });
    actions.append(cancel, confirm); popup.append(title, hint, input, actions); document.body.append(popup); input.focus(); input.select();
  }

  async function createDiaryForDate(headingTitle: string) {
    const [yearText, monthText] = calendarDate.split("-");
    try {
      const { bookmark } = await ensureDiaryContainer();
      const monthTitle = diaryMonthTitle(Number(yearText), Number(monthText));
      let document = diaryDocument(Number(yearText), Number(monthText));
      if (!document) {
        const id = `diary-${yearText}-${monthText}`;
        await workspace.execute({ type: "createDocument", document: { id, title: monthTitle }, bookmarkId: bookmark.id, parentId: null });
        document = workspace.snapshot().documents.find(item => item.id === id);
      }
      if (!document) throw new Error("无法创建日记文档");
      await cb.onCreateDiary(document.id, headingTitle);
      await loadCalendarPreview(calendarDate);
      cb.onCreated(document.id);
    } catch (error) {
      cb.onError(error);
    }
  }

  function renderCalendar() {
    const panel = slot;
    panel.replaceChildren();
    const head = document.createElement("div"); head.className = "calendar-head";
    const title = document.createElement("strong"); title.textContent = "日历";
    const create = document.createElement("button"); create.className = "calendar-create"; create.textContent = "+ 新建日记"; create.onclick = showDiaryCreatePopup;
    head.append(title, create); panel.append(head);
    const yearTabs = document.createElement("div"); yearTabs.className = "calendar-years";
    const years = new Set<number>([calendarYear]);
    diaryDocuments().forEach(document => { const year = Number(document.title.slice(0, 4)); if (year) years.add(year); });
    [...years].sort((a, b) => b - a).forEach(year => {
      const button = document.createElement("button"); button.textContent = String(year); button.className = year === calendarYear ? "active" : "";
      button.onclick = () => { calendarYear = year; const month = Number(calendarDate.split("-")[1]); calendarDate = formatCalendarDate(year, month, Number(calendarDate.split("-")[2])); renderCalendar(); void loadCalendarPreview(); };
      yearTabs.append(button);
    });
    panel.append(yearTabs);
    const month = Number(calendarDate.split("-")[1]);
    const monthNav = document.createElement("div"); monthNav.className = "calendar-month-nav";
    const previous = document.createElement("button"); previous.textContent = "‹"; previous.title = "上个月";
    const monthTitle = document.createElement("strong"); monthTitle.textContent = `${calendarYear} 年 ${month} 月`;
    const next = document.createElement("button"); next.textContent = "›"; next.title = "下个月";
    previous.onclick = () => { const date = new Date(calendarYear, month - 2, 1); calendarYear = date.getFullYear(); calendarDate = formatCalendarDate(calendarYear, date.getMonth() + 1, 1); renderCalendar(); void loadCalendarPreview(); };
    next.onclick = () => { const date = new Date(calendarYear, month, 1); calendarYear = date.getFullYear(); calendarDate = formatCalendarDate(calendarYear, date.getMonth() + 1, 1); renderCalendar(); void loadCalendarPreview(); };
    monthNav.append(previous, monthTitle, next); panel.append(monthNav);
    const grid = document.createElement("div"); grid.className = "calendar-grid";
    ["一", "二", "三", "四", "五", "六", "日"].forEach(label => { const cell = document.createElement("span"); cell.className = "calendar-weekday"; cell.textContent = label; grid.append(cell); });
    const first = new Date(calendarYear, month - 1, 1); const offset = (first.getDay() + 6) % 7; const count = new Date(calendarYear, month, 0).getDate();
    const docs = diaryDocuments(); const hasMonth = docs.some(document => document.title === diaryMonthTitle(calendarYear, month));
    const diaryDates = new Set<string>();
    if (calendarPreview && calendarPreview.state.note.id === diaryDocument(calendarYear, month)?.id) {
      calendarPreview.state.blocks.forEach(block => {
        const heading = headingForCalendar(block);
        const date = heading?.level === 1 ? calendarDateFromHeading(heading.title, formatCalendarDate(calendarYear, month, 1)) : "";
        if (date) diaryDates.add(date);
      });
    }
    const todoDates = mergeSurfaceTodos(workspace.todoDates(), panelContext ?? undefined);
    const dueTodosByDate = new Map<string, CalendarTodo[]>();
    todoDates.forEach(todo => {
      if (!todo.dueAt) return;
      const list = dueTodosByDate.get(todo.dueAt) ?? [];
      list.push(todo);
      dueTodosByDate.set(todo.dueAt, list);
    });
    for (let index = 0; index < 42; index++) {
      const day = index - offset + 1; const cell = document.createElement("button"); cell.className = "calendar-day";
      if (day < 1 || day > count) { cell.disabled = true; grid.append(cell); continue; }
      const date = formatCalendarDate(calendarYear, month, day); cell.dataset.date = date;
      const dayLabel = document.createElement("span"); dayLabel.textContent = String(day); cell.append(dayLabel);
      const dots = document.createElement("span"); dots.className = "calendar-dots";
      const appendDot = (className: string, title: string) => { const dot = document.createElement("span"); dot.className = `calendar-dot ${className}`; dot.title = title; dots.append(dot); };
      if (diaryDates.has(date)) appendDot("calendar-dot-diary", "有日记");
      // A day can contain several todos, but the calendar communicates status
      // at day level. Collapse duplicate markers of the same status while
      // keeping every todo in the selected-day preview below.
      const todosByStatus = new Map<ReturnType<typeof calendarTodoStatus>, CalendarTodo[]>();
      for (const todo of dueTodosByDate.get(date) ?? []) {
        const status = calendarTodoStatus(todo);
        const list = todosByStatus.get(status) ?? [];
        list.push(todo);
        todosByStatus.set(status, list);
      }
      for (const [status, todos] of todosByStatus) {
        const className = status === "complete" ? "calendar-dot-todo-complete" : status === "overdue" ? "calendar-dot-todo-overdue" : "calendar-dot-todo-pending";
        const label = todos.length === 1
          ? `${calendarTodoStatusLabel(todos[0])}：${todos[0].text}`
          : `${calendarTodoStatusLabel(todos[0])}：${todos.length} 项待办`;
        appendDot(className, label);
      }
      if (dots.childElementCount) cell.append(dots);
      if (diaryDates.has(date) || dueTodosByDate.has(date)) cell.classList.add("has-calendar-activity");
      if (date === calendarDate) cell.classList.add("selected");
      if (diaryDates.has(date)) cell.classList.add("has-diary");
      cell.onclick = () => { calendarDate = date; renderCalendar(); void loadCalendarPreview(date); };
      grid.append(cell);
    }
    panel.append(grid);
    const preview = document.createElement("section"); preview.className = "calendar-preview";
    const previewTitle = document.createElement("div"); previewTitle.className = "calendar-preview-head";
    const previewLabel = document.createElement("strong"); previewLabel.textContent = calendarDate;
    const link = document.createElement("button"); link.className = "calendar-insert-link"; link.textContent = "📅 插入日记链接";
    const selected = calendarPreview?.state.blocks.find(block => block.id === calendarPreview?.selectedBlockId);
    link.disabled = !calendarPreview?.documentId || !selected;
    link.title = selected && headingForCalendar(selected)?.level === 1 ? "引用这一天的标题及其全部内容" : "引用当前预览块";
    link.onclick = () => {
      if (!calendarPreview?.documentId || !selected) return;
      const heading = headingForCalendar(selected);
      cb.onInsertDiaryLink(calendarPreview.documentId, selected.id, heading?.level === 1 ? "heading" : "block", heading?.title || selected.content.text || calendarDate);
    };
    previewTitle.append(previewLabel, link); preview.append(previewTitle);
    const selectedTodos = todoDates.filter(todo => todo.dueAt === calendarDate || todo.completedAt === calendarDate);
    if (calendarLoading) {
      const loading = document.createElement("p"); loading.className = "calendar-empty"; loading.textContent = "正在加载日记..."; preview.append(loading);
    } else if (!calendarPreview) {
      const empty = document.createElement("p"); empty.className = "calendar-empty"; empty.textContent = hasMonth ? "这一天没有日记内容" : "这一天还没有日记"; preview.append(empty);
    } else if (!calendarPreview.blockIds.length) {
      const empty = document.createElement("p"); empty.className = "calendar-empty"; empty.textContent = "月份文档中没有这一天的 H1 标题"; preview.append(empty);
    } else {
      const blocks = calendarPreview.blockIds.map(id => calendarPreview!.state.blocks.find(block => block.id === id)).filter((block): block is Block => !!block);
      blocks.forEach(block => {
        const button = document.createElement("button"); button.className = `calendar-preview-block${block.id === calendarPreview!.selectedBlockId ? " active" : ""}`; button.dataset.blockId = block.id;
        const content = document.createElement("span"); const source = markdownFromContent(block.content); content.innerHTML = source ? renderMarkdown(source) : escapeHtml(block.content.text || "");
        button.append(content); button.onclick = () => { calendarPreview = { ...calendarPreview!, selectedBlockId: block.id }; renderCalendar(); };
        preview.append(button);
      });
    }
    if (selectedTodos.length) {
      const todoSection = document.createElement("section"); todoSection.className = "calendar-todo-preview";
      const todoTitle = document.createElement("div"); todoTitle.className = "calendar-todo-preview-head"; todoTitle.textContent = "待办"; todoSection.append(todoTitle);
      selectedTodos.forEach(todo => {
        const status = calendarTodoStatus(todo);
        const button = document.createElement("button");
        button.type = "button";
        button.className = `calendar-todo-entry todo-${status}`;
        button.dataset.documentId = todo.documentId;
        button.dataset.blockId = todo.blockId;
        const title = document.createElement("strong"); title.textContent = `${status === "complete" ? "✓" : status === "overdue" ? "!" : "○"} ${todo.text || "未命名待办"}`;
        const dates = [todo.createdAt ? `创建 ${todo.createdAt}` : "", todo.dueAt ? `应完成 ${todo.dueAt}` : "", todo.completedAt ? `完成 ${todo.completedAt}` : ""].filter(Boolean).join(" · ");
        const meta = document.createElement("small"); meta.textContent = `${calendarTodoStatusLabel(todo)}${dates ? ` · ${dates}` : ""}`;
        button.append(title, meta);
        button.onclick = () => { void cb.onOpenDocument(todo.documentId, todo.blockId); };
        todoSection.append(button);
      });
      preview.append(todoSection);
    }
    panel.append(preview);
  }

  return {
    update(context) { panelContext = context; renderCalendar(); },
    open() { if (!calendarPreview && !calendarLoading) void loadCalendarPreview(); },
    dispose() { ++calendarLoadToken; document.querySelector(".calendar-create-popup")?.remove(); slot.replaceChildren(); }
  };
}
