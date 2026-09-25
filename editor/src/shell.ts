import type { WorkspaceApi, WorkspaceCommand, WorkspaceDocument, CalendarTodo } from "./workspace-api";
import type { HistoryModel } from "./history";
import type { Block, EditorState } from "../../protocol/types";
import type { PanelContext } from "./panel-context";
import { mergeSurfaceTodos } from "./panel-context";
import { markdownFromContent, renderMarkdown } from "./markdown";

const STORAGE_KEY = "lnm-shell-layout-v1";

type Layout = {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightActiveTab: string;
  leftActiveTab: string;
};

const DEFAULT_LAYOUT: Layout = {
  leftWidth: 240,
  rightWidth: 260,
  leftCollapsed: false,
  rightCollapsed: false,
  rightActiveTab: "overrides",
  leftActiveTab: "docs"
};

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<Layout>;
    return { ...DEFAULT_LAYOUT, ...parsed };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function saveLayout(layout: Layout) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch {}
}

export interface ShellCallbacks {
  onOpenDocument: (documentId: string, blockId?: string) => void;
  onOpenCanvas: (canvasId: string) => void;
  onOpenDashboard: (dashboardId: string) => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onOpenSticky: () => void;
  onCreateNote: () => void;
  onFocusBlock: (blockId: string) => void;
  onError: (error: unknown) => void;
  onRestoreHistory: (entryId: string) => void;
  onLoadDocumentPreview: (documentId: string) => Promise<EditorState>;
  onCreateDiary: (documentId: string, heading: string) => Promise<void>;
  onInsertDiaryLink: (targetDocumentId: string, targetBlockId?: string, targetScope?: "block" | "heading", label?: string) => void;
}

export interface ShellApi {
  refresh(): void;
  highlightActiveDocument(documentId: string): void;
  showReferences(): void;
  showLocations(): void;
  showHistory(): void;
  setDatabaseContext(visible: boolean, activate?: boolean): void;
  setDashboardWidgetContext(visible: boolean, activate?: boolean): void;
  updateHistory(model: HistoryModel): void;
  setPanelContext(context: PanelContext | null): void;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]!));
}

function uid(): string {
  return Math.random().toString(36).slice(2, 8);
}

function descendantCount(documentId: string, documents: WorkspaceDocument[]) {
  const children = new Map<string, WorkspaceDocument[]>();
  for (const document of documents) {
    if (!document.parentId) continue;
    const list = children.get(document.parentId) ?? [];
    list.push(document);
    children.set(document.parentId, list);
  }
  const pending = [...(children.get(documentId) ?? [])];
  const visited = new Set<string>();
  let count = 0;
  while (pending.length) {
    const child = pending.pop()!;
    if (visited.has(child.id)) continue;
    visited.add(child.id);
    count++;
    pending.push(...(children.get(child.id) ?? []));
  }
  return count;
}

const BOOKMARK_COLORS = [
  "#3B82F6", "#16A34A", "#7C3AED", "#EA580C", "#0891B2",
  "#DB2777", "#CA8A04", "#DC2626", "#0D9488", "#7C2D12"
];

export function mountShell(workspace: WorkspaceApi, cb: ShellCallbacks): ShellApi {
  const layout = loadLayout();
  let databaseContextVisible = false;
  let dashboardWidgetContextVisible = false;
  let panelContext: PanelContext | null = null;
  let rightTabBeforeDatabase = layout.rightActiveTab === "databases" ? "reference-sidebar" : layout.rightActiveTab;
  function execute(command: WorkspaceCommand) {
    const task = workspace.execute(command).then(() => renderAll());
    void task.catch(cb.onError);
    return task;
  }

  const sidebarLeft = document.getElementById("sidebar-left") as HTMLElement;
  const sidebarBody = document.getElementById("sidebar-body") as HTMLElement;
  const sidebarRight = document.getElementById("sidebar-right") as HTMLElement;
  const sidebarRightBody = document.getElementById("sidebar-right-body") as HTMLElement;
  const splitterLeft = document.getElementById("splitter-left") as HTMLElement;
  const splitterRight = document.getElementById("splitter-right") as HTMLElement;
  const leftToggle = document.getElementById("sidebar-left-toggle") as HTMLButtonElement;
  const rightToggle = document.getElementById("sidebar-right-toggle") as HTMLButtonElement;
  const notebookTabs = document.getElementById("notebook-tabs") as HTMLElement;
  const notebookAddBtn = document.getElementById("notebook-add-btn") as HTMLButtonElement;
  const notebookAddPopup = document.getElementById("notebook-add-popup") as HTMLElement;
  const notebookAddList = document.getElementById("notebook-add-popup-list") as HTMLElement;
  const notebookAddEmpty = document.getElementById("notebook-add-popup-empty") as HTMLElement;
  const menuFileBtn = document.getElementById("menu-file-btn") as HTMLButtonElement;
  const menuFilePopup = document.getElementById("menu-file-popup") as HTMLElement;
  const menuNewNb = document.getElementById("menu-new-notebook") as HTMLButtonElement;

  // ── Right sidebar panels ───────────────────────────────────────────
  function buildRightPanels() {
    sidebarRightBody.innerHTML = "";
    const sections = [
      { tab: "reference-sidebar", label: "实时引用", slot: "reference-sidebar" },
      { tab: "backlinks", label: "反向链接", slot: "backlinks" },
      { tab: "overrides", label: "外部覆写", slot: "override-notices" },
      { tab: "comments", label: "注释管理", slot: "comments" },
      { tab: "history", label: "历史记录", slot: "history" },
      { tab: "calendar", label: "日历", slot: "calendar" },
      { tab: "locations", label: "地图管理", slot: "locations" },
      { tab: "styles", label: "CSS 管理", slot: "styles" },
      { tab: "databases", label: "数据表属性", slot: "databases" },
      { tab: "dashboard-config", label: "组件设置", slot: "dashboard-config" }
    ];
    for (const s of sections) {
      const sec = document.createElement("section");
      sec.id = s.tab + "-section";
      sec.dataset.panel = s.tab;
      sec.className = "relations-section";
      const inner = document.createElement("div");
      inner.id = s.tab === "history" ? "history-list" : s.tab;
      inner.className = "relations-slot";
      inner.dataset.slot = s.slot;
      sec.innerHTML = `<div class="panel-head"><span>${s.label}</span></div>`;
      sec.appendChild(inner);
      sidebarRightBody.appendChild(sec);
    }
    applyRightTab();
  }

  function applyRightTab(tab?: string) {
    let active = tab ?? layout.rightActiveTab;
    if (active === "databases" && !databaseContextVisible) active = rightTabBeforeDatabase || "reference-sidebar";
    if (active === "dashboard-config" && !dashboardWidgetContextVisible) active = "reference-sidebar";
    if (active !== "databases") rightTabBeforeDatabase = active;
    layout.rightActiveTab = active;
    sidebarRight.querySelectorAll<HTMLElement>("[data-pane-btn]").forEach((b) => {
      if (b.dataset.paneBtn === "databases") b.hidden = !databaseContextVisible;
      if (b.dataset.paneBtn === "dashboard-config") b.hidden = !dashboardWidgetContextVisible;
      b.classList.toggle("active", b.dataset.paneBtn === active);
    });
    // Only top-level panel sections (direct children of sidebarRightBody), not inner reference cards.
    [...sidebarRightBody.children].forEach((s) => {
      if (s instanceof HTMLElement && s.dataset.panel) s.hidden = s.dataset.panel !== active;
    });
    saveLayout(layout);
  }

  function setDatabaseContext(visible: boolean, activate = false) {
    databaseContextVisible = visible;
    if (visible && activate) {
      if (layout.rightCollapsed) {
        layout.rightCollapsed = false;
        applyWidths();
      }
      applyRightTab("databases");
      return;
    }
    applyRightTab(!visible && layout.rightActiveTab === "databases" ? rightTabBeforeDatabase : undefined);
  }

  function setDashboardWidgetContext(visible: boolean, activate = false) {
    dashboardWidgetContextVisible = visible;
    if (visible && activate) {
      if (layout.rightCollapsed) { layout.rightCollapsed = false; applyWidths(); }
      applyRightTab("dashboard-config");
    } else applyRightTab(!visible && layout.rightActiveTab === "dashboard-config" ? "reference-sidebar" : undefined);
  }

  // ── Left sidebar top tabs (docs / search / outline) ────────────────
  const leftTabsBar = document.createElement("div");
  leftTabsBar.className = "sidebar-tabs sidebar-left-tabs";
  leftTabsBar.setAttribute("role", "tablist");
  leftTabsBar.innerHTML = `
    <button class="sidebar-tab active" data-left-pane="docs" title="文档列表" aria-label="文档列表">&#128196;</button>
    <button class="sidebar-tab" data-left-pane="search" title="搜索" aria-label="搜索">&#128269;</button>
    <button class="sidebar-tab" data-left-pane="outline" title="大纲" aria-label="大纲">&#8801;</button>
  `;
  sidebarLeft.insertBefore(leftTabsBar, sidebarBody);

  // Panel containers (inserted before body content)
  const docPanel = document.createElement("div");
  docPanel.className = "panel";
  docPanel.dataset.leftPanel = "docs";
  sidebarBody.insertBefore(docPanel, sidebarBody.firstChild);

  const searchPanel = document.createElement("div");
  searchPanel.className = "panel";
  searchPanel.dataset.leftPanel = "search";
  searchPanel.hidden = true;
  searchPanel.innerHTML = `<input id="search-input" type="search" placeholder="搜索标题或正文..." class="panel-search"><div id="search-results" class="panel-list"></div>`;
  sidebarBody.insertBefore(searchPanel, sidebarBody.firstChild);

  const outlinePanel = document.createElement("div");
  outlinePanel.className = "panel";
  outlinePanel.dataset.leftPanel = "outline";
  outlinePanel.hidden = true;
  outlinePanel.innerHTML = `<div class="panel-list" id="outline-list"></div>`;
  sidebarBody.insertBefore(outlinePanel, sidebarBody.firstChild);

  function applyLeftTab(tab?: string) {
    const active = tab ?? layout.leftActiveTab ?? "docs";
    layout.leftActiveTab = active;
    leftTabsBar.querySelectorAll<HTMLElement>("[data-left-pane]").forEach((b) => {
      b.classList.toggle("active", b.dataset.leftPane === active);
    });
    docPanel.hidden = active !== "docs";
    searchPanel.hidden = active !== "search";
    outlinePanel.hidden = active !== "outline";
    if (active === "docs") renderSidebarBody();
    if (active === "search") {
      renderSearch();
      const inp = searchPanel.querySelector<HTMLInputElement>("#search-input");
      if (inp) inp.focus();
    }
    if (active === "outline") renderOutline();
    saveLayout(layout);
  }

  leftTabsBar.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLElement>("[data-left-pane]");
    if (!btn) return;
    applyLeftTab(btn.dataset.leftPane);
  });

  // ── Notebook tab bar ────────────────────────────────────────────────
  function renderNotebookTabs() {
    const snap = workspace.snapshot();
    notebookTabs.innerHTML = "";
    for (const nbId of snap.openNotebookIds) {
      const nb = snap.notebooks.find((n) => n.id === nbId);
      if (!nb) continue;
      const tab = document.createElement("button");
      tab.className = "notebook-tab" + (nbId === snap.activeNotebookId ? " active" : "");
      tab.dataset.nbId = nbId;
      tab.textContent = nb.name;
      tab.title = nb.name + "\n右键可重命名或删除";
      tab.onclick = () => {
        execute({ type: "selectNotebook", id: nbId });
      };
      tab.addEventListener("dragover", event => {
        const types = event.dataTransfer?.types ?? [];
        if (!types.includes("text/x-document-id") && !types.includes("text/x-block-id")) return;
        event.preventDefault();
        event.stopPropagation();
        tab.classList.add("drop-target");
        if (event.dataTransfer) event.dataTransfer.dropEffect = types.includes("text/x-block-id") ? "copy" : "move";
      });
      tab.addEventListener("dragleave", () => tab.classList.remove("drop-target"));
      tab.addEventListener("drop", event => {
        event.preventDefault();
        event.stopPropagation();
        tab.classList.remove("drop-target");
        const blockId = event.dataTransfer?.getData("text/x-block-id");
        const sourceDocumentId = event.dataTransfer?.getData("text/x-source-document-id");
        if (blockId && sourceDocumentId) {
          const targetBookmark = snap.bookmarks.find(bookmark => bookmark.notebookId === nbId);
          const target = targetBookmark && snap.documents.find(item => item.bookmarkId === targetBookmark.id);
          if (!target || target.id === sourceDocumentId) return;
          const choice = prompt("将此块拖入目标笔记本：输入 1 作为引用，输入 2 复制一份", "1");
          const mode = choice === "2" ? "copy" : choice === "1" ? "reference" : null;
          if (mode) void execute({ type: "transferBlock", sourceDocumentId, targetDocumentId: target.id, blockId, mode }).then(() => cb.onOpenDocument(target.id));
          return;
        }
        const dragged = event.dataTransfer?.getData("text/x-document-id");
        if (!dragged) return;
        const targetBookmark = snap.bookmarks.find(bookmark => bookmark.notebookId === nbId);
        const source = snap.documents.find(item => item.id === dragged);
        if (!source || !targetBookmark || source.bookmarkId === targetBookmark.id) return;
        const roots = snap.documents.filter(item => item.bookmarkId === targetBookmark.id && !item.parentId);
        execute({ type: "moveDocument", id: dragged, bookmarkId: targetBookmark.id, parentId: null, index: roots.length });
      });
      tab.oncontextmenu = (e) => {
        e.preventDefault();
        showContextMenu(tab, [
          { label: "重命名", run: () => renameNotebook(nbId, nb.name) },
          { label: "删除笔记本", danger: true, run: () => removeNotebook(nbId) }
        ]);
      };
      const closeBtn = document.createElement("span");
      closeBtn.className = "notebook-tab-close";
      closeBtn.textContent = "\u2715";
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        execute({ type: "closeNotebook", id: nbId });
      };
      tab.appendChild(closeBtn);
      notebookTabs.appendChild(tab);
    }
  }

  // ── Notebook add popup ─────────────────────────────────────────────
  function renderNotebookAddPopup() {
    const snap = workspace.snapshot();
    const closed = snap.notebooks.filter((n) => !snap.openNotebookIds.includes(n.id));
    notebookAddList.innerHTML = "";
    if (closed.length === 0) {
      notebookAddEmpty.hidden = false;
    } else {
      notebookAddEmpty.hidden = true;
      for (const nb of closed) {
        const item = document.createElement("button");
        item.className = "notebook-add-popup-item";
        item.textContent = nb.name;
        item.onclick = () => {
          execute({ type: "openNotebook", id: nb.id });
          notebookAddPopup.hidden = true;
          renderAll();
        };
        notebookAddList.appendChild(item);
      }
    }
  }

  // ── File dropdown menu ──────────────────────────────────────────────
  function setupFileMenu() {
    menuFileBtn.onclick = (e) => {
      e.stopPropagation();
      menuFilePopup.hidden = !menuFilePopup.hidden;
    };
    menuNewNb.onclick = () => {
      menuFilePopup.hidden = true;
      const name = prompt("笔记本名称：", "新笔记本");
      if (!name) return;
      const id = "nb-" + uid();
      execute({ type: "createNotebook", notebook: { id, name } });
    };
    document.addEventListener("click", (e) => {
      if (!(e.target as Element).closest("#menu-file")) {
        menuFilePopup.hidden = true;
      }
    });
  }

  // ── Notebook add button ─────────────────────────────────────────────
  notebookAddBtn.onclick = (e) => {
    e.stopPropagation();
    renderNotebookAddPopup();
    notebookAddPopup.hidden = !notebookAddPopup.hidden;
  };
  document.addEventListener("click", (e) => {
    if (!(e.target as Element).closest("#notebook-add-popup, #notebook-add-btn")) {
      notebookAddPopup.hidden = true;
    }
  });

  // ── Three-level sidebar body ────────────────────────────────────────
  function renderSidebarBody() {
    const snap = workspace.snapshot();
    docPanel.innerHTML = "";
    const myBookmarks = snap.bookmarks.filter((b) => b.notebookId === snap.activeNotebookId);
    const clearDocumentDropIndicators = () => {
      docPanel.querySelectorAll<HTMLElement>(".doc-drop-zone.active, .doc-node.drop-before, .doc-node.drop-after, .doc-node.drop-child, .bk-strip.drop-target")
        .forEach(element => element.classList.remove("active", "drop-before", "drop-after", "drop-child", "drop-target"));
    };
    const documentDropZone = (container: HTMLElement, bookmarkId: string, parentId: string | null, index: number) => {
      const zone = document.createElement("div");
      zone.className = "doc-drop-zone";
      zone.dataset.parentId = parentId ?? "";
      zone.dataset.index = String(index);
      zone.setAttribute("aria-label", parentId ? "放入子文档列表" : "放入顶级文档列表");
      zone.addEventListener("dragover", event => {
        if (!event.dataTransfer?.types.includes("text/x-document-id")) return;
        event.preventDefault();
        event.stopPropagation();
        clearDocumentDropIndicators();
        zone.classList.add("active");
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      });
      zone.addEventListener("dragleave", event => {
        event.stopPropagation();
        if (!(event.relatedTarget instanceof Node && zone.contains(event.relatedTarget))) zone.classList.remove("active");
      });
      zone.addEventListener("drop", event => {
        event.preventDefault();
        event.stopPropagation();
        clearDocumentDropIndicators();
        const dragged = event.dataTransfer?.getData("text/x-document-id");
        if (!dragged || dragged === parentId) return;
        execute({ type: "moveDocument", id: dragged, bookmarkId, parentId, index });
      });
      container.appendChild(zone);
    };
    const renderDocument = (docId: string, depth: number, container: HTMLElement) => {
      const doc = snap.documents.find(item => item.id === docId);
      if (!doc || depth > 2) return;
      const node = document.createElement("div");
      node.className = "doc-node";
      node.dataset.documentId = doc.id;
      const btn = document.createElement("button");
      btn.className = "list-item doc-item";
      btn.draggable = true;
      btn.style.setProperty("--doc-depth", String(depth));
      const count = descendantCount(doc.id, snap.documents);
      const itemIcon = doc.kind === "canvas" ? "◇" : doc.kind === "dashboard" ? "▦" : "&#128196;";
      btn.innerHTML = `<span class="list-icon${doc.kind === "canvas" ? " canvas-item-icon" : doc.kind === "dashboard" ? " dashboard-item-icon" : ""}">${itemIcon}</span><span class="list-label">${escapeHtml(doc.title)}</span>${count ? `<span class="doc-count">${count}</span>` : ""}`;
      btn.onclick = () => doc.kind === "canvas" ? cb.onOpenCanvas(doc.id) : doc.kind === "dashboard" ? cb.onOpenDashboard(doc.id) : cb.onOpenDocument(doc.id);
      btn.oncontextmenu = (e) => { e.preventDefault(); showDocumentMenu(btn, doc); };
      btn.addEventListener("dragstart", event => {
        event.stopPropagation();
        event.dataTransfer?.setData("text/x-document-id", doc.id);
        event.dataTransfer?.setData("text/x-workspace-item-id", doc.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "all";
        node.classList.add("is-dragging");
      });
      btn.addEventListener("dragend", () => node.classList.remove("is-dragging"));
      node.appendChild(btn);
      const children = snap.documents.filter(item => item.bookmarkId === doc.bookmarkId && item.parentId === doc.id).sort((a, b) => a.position - b.position);
      if (children.length) {
        const childList = document.createElement("div"); childList.className = "doc-children";
        children.forEach((child, index) => {
          documentDropZone(childList, doc.bookmarkId, doc.id, index);
          renderDocument(child.id, depth + 1, childList);
        });
        documentDropZone(childList, doc.bookmarkId, doc.id, children.length);
        node.appendChild(childList);
      }
      btn.addEventListener("dragover", event => {
        const types = event.dataTransfer?.types ?? [];
        if (types.includes("text/x-block-id")) {
          const source = event.dataTransfer?.getData("text/x-source-document-id");
          if (source !== doc.id) { event.preventDefault(); event.stopPropagation(); clearDocumentDropIndicators(); node.classList.add("drop-child"); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; }
          return;
        }
        if (!types.includes("text/x-document-id")) return;
        event.preventDefault();
        event.stopPropagation();
        clearDocumentDropIndicators();
        node.classList.remove("drop-child", "drop-before", "drop-after");
        // Use the document row itself. The node's box also contains all descendants,
        // which made the upper/lower hit zones move as the tree grew.
        const rect = btn.getBoundingClientRect();
        const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
        if (ratio < 0.28 || ratio > 0.72) {
          const adjacent = (ratio < 0.28 ? node.previousElementSibling : node.nextElementSibling) as HTMLElement | null;
          if (adjacent?.classList.contains("doc-drop-zone")) adjacent.classList.add("active");
        } else {
          node.classList.add("drop-child");
        }
      });
      btn.addEventListener("dragleave", event => {
        const related = event.relatedTarget as Node | null;
        if (!related || !btn.contains(related)) clearDocumentDropIndicators();
      });
      btn.addEventListener("drop", event => {
        event.preventDefault(); event.stopPropagation(); clearDocumentDropIndicators();
        const blockId = event.dataTransfer?.getData("text/x-block-id");
        const sourceDocumentId = event.dataTransfer?.getData("text/x-source-document-id");
        if (blockId && sourceDocumentId && sourceDocumentId !== doc.id) {
          const choice = prompt("将此块拖入文档：输入 1 作为引用，输入 2 复制一份", "1");
          const mode = choice === "2" ? "copy" : choice === "1" ? "reference" : null;
          if (mode) void execute({ type: "transferBlock", sourceDocumentId, targetDocumentId: doc.id, blockId, mode }).then(() => cb.onOpenDocument(doc.id));
          return;
        }
        const dragged = event.dataTransfer?.getData("text/x-document-id");
        if (!dragged || dragged === doc.id) return;
        const rect = btn.getBoundingClientRect();
        const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
        const parentId = ratio < 0.28 || ratio > 0.72 ? doc.parentId : doc.id;
        const siblings = snap.documents.filter(item => item.bookmarkId === doc.bookmarkId && item.parentId === parentId && item.id !== dragged).sort((a, b) => a.position - b.position);
        const targetIndex = parentId === doc.id
          ? siblings.length
          : Math.max(0, siblings.findIndex(item => item.id === doc.id) + (ratio > 0.72 ? 1 : 0));
        if (!snap.documents.some(item => item.id === dragged)) return;
        execute({ type: "moveDocument", id: dragged, bookmarkId: doc.bookmarkId, parentId, index: targetIndex });
      });
      container.appendChild(node);
    };
    for (const [bookmarkIndex, bk] of myBookmarks.entries()) {
      const isActive = bk.id === snap.activeBookmarkId;
      const strip = document.createElement("div");
      strip.className = "bk-strip" + (isActive ? " active" : "");
      strip.draggable = true;
      strip.dataset.bookmarkId = bk.id;
      const accent = document.createElement("span");
      accent.className = "bk-strip-accent";
      accent.style.background = bk.color;
      const label = document.createElement("span");
      label.className = "bk-strip-label";
      label.textContent = bk.name;
      strip.appendChild(accent);
      strip.appendChild(label);
      const addDoc = document.createElement("button");
      addDoc.type = "button"; addDoc.className = "bookmark-add-document"; addDoc.title = "新建文档或 Canvas"; addDoc.setAttribute("aria-label", `在${bk.name}中新建文档或 Canvas`); addDoc.textContent = "+";
      addDoc.onclick = (event) => { event.stopPropagation(); showWorkspaceCreateMenu(addDoc, bk.id); };
      strip.appendChild(addDoc);
      strip.onclick = () => {
        execute({ type: "selectBookmark", id: bk.id });
      };
      strip.oncontextmenu = (e) => {
        e.preventDefault();
        showBookmarkMenu(strip, bk.id, bk.name, bk.color);
      };
      strip.addEventListener("dragstart", event => { event.dataTransfer?.setData("text/x-bookmark-id", bk.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; strip.classList.add("is-dragging"); });
      strip.addEventListener("dragend", () => strip.classList.remove("is-dragging"));
      strip.addEventListener("dragover", event => { if (event.dataTransfer?.types.includes("text/x-bookmark-id") || event.dataTransfer?.types.includes("text/x-document-id")) { event.preventDefault(); event.stopPropagation(); clearDocumentDropIndicators(); strip.classList.add("drop-target"); } });
      strip.addEventListener("dragleave", event => { const related = event.relatedTarget as Node | null; if (!related || !strip.contains(related)) clearDocumentDropIndicators(); });
      strip.addEventListener("drop", event => {
        event.preventDefault(); event.stopPropagation(); clearDocumentDropIndicators();
        const draggedBookmark = event.dataTransfer?.getData("text/x-bookmark-id");
        if (draggedBookmark) { if (draggedBookmark === bk.id) return; const target = myBookmarks.findIndex(item => item.id === bk.id); execute({ type: "moveBookmark", id: draggedBookmark, index: target >= bookmarkIndex ? target + 1 : target }); return; }
        const draggedDocument = event.dataTransfer?.getData("text/x-document-id");
        if (draggedDocument) execute({ type: "moveDocument", id: draggedDocument, bookmarkId: bk.id, parentId: null, index: snap.documents.filter(item => item.bookmarkId === bk.id && !item.parentId).length });
      });
      docPanel.appendChild(strip);
      if (isActive) {
        const docList = document.createElement("div");
        docList.className = "doc-list doc-tree";
        const roots = snap.documents.filter(item => item.bookmarkId === bk.id && !item.parentId).sort((a, b) => a.position - b.position);
        roots.forEach((doc, index) => {
          documentDropZone(docList, bk.id, null, index);
          renderDocument(doc.id, 0, docList);
        });
        documentDropZone(docList, bk.id, null, roots.length);
        if (roots.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.style.padding = "8px 12px";
          empty.textContent = "暂无文档";
          docList.insertBefore(empty, docList.firstChild);
        }
        docPanel.appendChild(docList);
      }
    }
    if (myBookmarks.length === 0) {
      docPanel.innerHTML = `<div class="empty" style="padding:16px 12px">该笔记本暂无书签</div>`;
    }

    // Add bookmark button at the bottom of the bookmark list (last item)
    const addBk = document.createElement("button");
    addBk.className = "bk-strip bk-strip-add";
    addBk.title = "新建书签";
    addBk.innerHTML = `<span class="bk-strip-accent" style="background:transparent;border:1px dashed #d0d5dd;"></span><span class="bk-strip-label" style="opacity:.7">+ 新建书签</span>`;
    addBk.onclick = () => addBookmark();
    docPanel.appendChild(addBk);
  }

  // ── Outline ─────────────────────────────────────────────────────────
  function renderOutline(highlightId?: string) {
    const list = outlinePanel.querySelector<HTMLElement>("#outline-list");
    if (!list) return;
    list.innerHTML = "";
    const blocks = workspace.outline();
    const headings = blocks.flatMap((b: Block) => {
      const source = markdownFromContent(b.content);
      const match = source.match(/^\s*(#{1,6})(?:[ \u3000]+|$)(.*)$/m);
      if (!match) return [];
      return [{ block: b, level: match[1].length, text: match[2].trim() || b.content.text.trim() || "未命名" }];
    });
    if (headings.length === 0) {
      list.innerHTML = `<div class="outline-empty-state">没有可显示的标题</div>`;
      return;
    }
    for (const h of headings) {
      const btn = document.createElement("button");
      btn.className = "list-item outline-item" + (h.block.id === highlightId ? " active" : "");
      btn.dataset.level = String(h.level);
      btn.style.paddingLeft = `${10 + (h.level - 1) * 14}px`;
      btn.textContent = h.text;
      btn.onclick = () => {
        cb.onFocusBlock(h.block.id);
      };
      list.appendChild(btn);
    }
  }

  // ── Search ──────────────────────────────────────────────────────────
  function renderSearch() {
    const input = searchPanel.querySelector<HTMLInputElement>("#search-input");
    const results = searchPanel.querySelector<HTMLElement>("#search-results");
    if (!input || !results) return;
    if (!input.dataset.bound) {
      input.dataset.bound = "1";
      input.addEventListener("input", () => renderSearch());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          const first = results.querySelector<HTMLElement>(".list-item");
          if (first) first.click();
        } else if (event.key === "Escape") {
          input.value = "";
          renderSearch();
        }
      });
    }
    const q = input.value.trim();
    if (!q) {
      results.innerHTML = `<div class="empty">输入关键字以搜索（标题或正文）。Enter 跳转首条，Esc 清空。</div>`;
      return;
    }
    const hits = workspace.search(q, 80);
    results.innerHTML = "";
    if (hits.length === 0) {
      results.innerHTML = `<div class="empty">没有匹配 “${escapeHtml(q)}”</div>`;
      return;
    }
    // Group hits by document so the user sees "3 hits in Alpha" structure
    const grouped = new Map<string, { title: string; hits: typeof hits }>();
    for (const hit of hits) {
      let group = grouped.get(hit.documentId);
      if (!group) {
        group = { title: hit.documentTitle, hits: [] };
        grouped.set(hit.documentId, group);
      }
      group.hits.push(hit);
    }
    for (const [docId, group] of grouped.entries()) {
      const head = document.createElement("div");
      head.className = "search-group-head";
      head.innerHTML = `<span class="list-icon">&#128196;</span><span class="search-group-title">${escapeHtml(group.title)}</span><span class="search-group-count">${group.hits.length}</span>`;
      results.append(head);
      for (const hit of group.hits) {
        const btn = document.createElement("button");
        btn.className = "list-item search-hit";
        const kindBadge = hit.kind === "title"
          ? `<span class="search-kind-badge kind-title">标题</span>`
          : `<span class="search-kind-badge kind-block">正文</span>`;
        // Highlight the matched substring
        const lower = hit.excerpt.toLocaleLowerCase();
        const lowerQuery = q.toLocaleLowerCase();
        const idx = lower.indexOf(lowerQuery);
        let excerptHtml = escapeHtml(hit.excerpt);
        if (idx >= 0) {
          const before = escapeHtml(hit.excerpt.slice(0, idx));
          const match = escapeHtml(hit.excerpt.slice(idx, idx + q.length));
          const after = escapeHtml(hit.excerpt.slice(idx + q.length));
          excerptHtml = `${before}<mark>${match}</mark>${after}`;
        }
        btn.innerHTML = `${kindBadge}<span class="search-hit-excerpt">${excerptHtml}</span>`;
        btn.onclick = () => cb.onOpenDocument(docId, hit.blockId ?? undefined);
        results.append(btn);
      }
    }
  }

  let historyModel: HistoryModel = { documentId: "", entries: [], currentId: "", canUndo: false, canRedo: false };
  let selectedHistoryId = "";
  function updateHistory(model: HistoryModel) {
    historyModel = model;
    const panel = document.querySelector<HTMLElement>("[data-slot=history]");
    if (!panel) return;
    panel.replaceChildren();
    const intro = document.createElement("p"); intro.className = "history-intro";
    intro.textContent = "最近 80 个版本 · 点击预览，恢复后可撤销"; panel.append(intro);
    if (!model.entries.length) { const empty = document.createElement("p"); empty.textContent = "编辑后自动记录版本"; panel.append(empty); return; }
    for (const entry of [...model.entries].reverse()) {
      const button = document.createElement("button"); button.className = "history-entry" + (entry.id === model.currentId ? " current" : "");
      button.textContent = `${entry.label} · ${new Date(entry.timestamp).toLocaleString()}${entry.id === model.currentId ? " · 当前" : ""}`;
      button.onclick = () => { selectedHistoryId = entry.id; updateHistory(historyModel); }; panel.append(button);
    }
    const selected = model.entries.find(e => e.id === selectedHistoryId) ?? model.entries.find(e => e.id === model.currentId)!;
    const preview = document.createElement("section"); preview.className = "history-preview";
    const title = document.createElement("strong"); title.textContent = selected.title;
    const content = document.createElement("pre"); content.textContent = selected.preview || "（空白正文）";
    const restore = document.createElement("button"); restore.textContent = "恢复此版本"; restore.disabled = selected.id === model.currentId;
    restore.onclick = () => cb.onRestoreHistory(selected.id);
    preview.append(title, content, restore); panel.append(preview);
  }

  // ── Calendar / diary index ─────────────────────────────────────────
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
    const source = markdownFromContent(block.content);
    const line = source.split(/\r?\n/).find(value => value.trim()) ?? "";
    const match = line.match(/^\s*(#{1,6})[ \u3000]+(.+?)\s*$/);
    return match ? { level: match[1].length, title: match[2].trim() } : block.type === "heading"
      ? { level: block.properties.headingLevel ?? 1, title: block.content.text.trim() }
      : null;
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
      renderAll(document.id);
    } catch (error) {
      cb.onError(error);
    }
  }

  function renderCalendar() {
    const panel = document.querySelector<HTMLElement>("[data-slot=calendar]");
    if (!panel) return;
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

  // ── Render all ─────────────────────────────────────────────────────
  function renderAll(highlightId?: string) {
    renderNotebookTabs();
    renderSidebarBody();
    renderOutline(highlightId);
    renderSearch();
    renderCalendar();
    applyRightTab();
  }

  // ── Splitters ───────────────────────────────────────────────────────
  // The `.app` grid uses CSS variables --left-w / --right-w for the column widths.
  // Drag updates those variables; the grid re-flows and the center content auto-resizes.
  const appEl = document.querySelector<HTMLElement>(".app")!;
  function applyWidths() {
    sidebarLeft.style.width = layout.leftCollapsed ? "0px" : `${layout.leftWidth}px`;
    splitterLeft.style.display = layout.leftCollapsed ? "none" : "";
    sidebarRight.style.width = layout.rightCollapsed ? "0px" : `${layout.rightWidth}px`;
    splitterRight.style.display = layout.rightCollapsed ? "none" : "";
    if (!layout.leftCollapsed) appEl.style.setProperty("--left-w", `${layout.leftWidth}px`);
    if (!layout.rightCollapsed) appEl.style.setProperty("--right-w", `${layout.rightWidth}px`);
    document.body.classList.toggle("left-collapsed", layout.leftCollapsed);
    document.body.classList.toggle("right-collapsed", layout.rightCollapsed);
    leftToggle.textContent = layout.leftCollapsed ? "\u2039" : "\u2039";
    rightToggle.textContent = layout.rightCollapsed ? "\u2039" : "\u2039";
  }

  function bindSplitter(el: HTMLElement, side: "left" | "right") {
    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    el.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX;
      startWidth = side === "left" ? layout.leftWidth : layout.rightWidth;
      e.preventDefault();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      // Both splitters drag "outward" → larger pane, or "inward" → smaller pane.
      // Moving left splitter RIGHT grows the left pane; moving right splitter LEFT grows the right pane.
      const next = side === "left"
        ? Math.max(180, Math.min(520, startWidth + delta))
        : Math.max(180, Math.min(520, startWidth - delta));
      if (side === "left") layout.leftWidth = next;
      else layout.rightWidth = next;
      applyWidths();
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveLayout(layout);
    });
  }
  bindSplitter(splitterLeft, "left");
  bindSplitter(splitterRight, "right");

  // ── Collapse toggles ───────────────────────────────────────────────
  leftToggle.onclick = () => {
    layout.leftCollapsed = !layout.leftCollapsed;
    applyWidths();
    saveLayout(layout);
  };
  rightToggle.onclick = () => {
    layout.rightCollapsed = !layout.rightCollapsed;
    applyWidths();
    saveLayout(layout);
  };
  sidebarLeft.addEventListener("dblclick", (e) => {
    if (!layout.leftCollapsed) return;
    if (!(e.target as Element).closest(".sidebar-body, .sidebar-tabs")) return;
    layout.leftCollapsed = false;
    applyWidths();
    saveLayout(layout);
  });
  sidebarRight.addEventListener("dblclick", (e) => {
    if (!layout.rightCollapsed) return;
    if (!(e.target as Element).closest(".sidebar-tabs")) return;
    layout.rightCollapsed = false;
    applyWidths();
    saveLayout(layout);
  });

  // ── Right sidebar tab clicks ────────────────────────────────────────
  sidebarRight.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-pane-btn]");
    if (target) {
      applyRightTab(target.dataset.paneBtn!);
      if (target.dataset.paneBtn === "calendar" && !calendarPreview && !calendarLoading) void loadCalendarPreview();
    }
  });

  // ── Toolbar extras ─────────────────────────────────────────────────
  document.getElementById("navigate-back")!.addEventListener("click", cb.onNavigateBack);
  document.getElementById("navigate-forward")!.addEventListener("click", cb.onNavigateForward);
  document.getElementById("open-sticky")!.addEventListener("click", cb.onOpenSticky);

  // Explicit user intent may open references; data refreshes never change the active tab.
  function showReferences() {
    if (layout.rightCollapsed) {
      layout.rightCollapsed = false;
      applyWidths();
      saveLayout(layout);
    }
    applyRightTab("reference-sidebar");
  }

  function setPanelContext(context: PanelContext | null) {
    panelContext = context;
    renderCalendar();
  }

  function showLocations() {
    if (layout.rightCollapsed) {
      layout.rightCollapsed = false;
      applyWidths();
      saveLayout(layout);
    }
    applyRightTab("locations");
  }

  function showHistory() {
    if (layout.rightCollapsed) {
      layout.rightCollapsed = false;
      applyWidths();
    }
    applyRightTab("history");
    updateHistory(historyModel);
  }

  // ── Context menu (shared) ──────────────────────────────────────────
  let openMenu: HTMLElement | null = null;
  function closeContextMenu() {
    openMenu?.remove();
    openMenu = null;
    document.removeEventListener("mousedown", closeContextMenu);
  }
  function showContextMenu(anchor: HTMLElement, items: Array<{ label: string; run: () => void; danger?: boolean }>) {
    closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    items.forEach((it) => {
      const btn = document.createElement("button");
      btn.textContent = it.label;
      if (it.danger) btn.classList.add("danger");
      btn.onclick = () => { closeContextMenu(); it.run(); };
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    menu.addEventListener("mousedown", e => e.stopPropagation());
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.min(window.innerWidth - 200, rect.right)}px`;
    menu.style.top = `${rect.bottom + 2}px`;
    openMenu = menu;
    setTimeout(() => document.addEventListener("mousedown", closeContextMenu), 0);
  }

  // ── Notebook / bookmark / document actions ────────────────────────
  function renameNotebook(id: string, current: string) {
    const name = prompt("重命名笔记本：", current);
    if (name && name.trim()) {
      execute({ type: "renameNotebook", id, name: name.trim() });
    }
  }
  function removeNotebook(id: string) {
    const snap = workspace.snapshot();
    const nb = snap.notebooks.find((n) => n.id === id);
    if (!nb) return;
    if (snap.notebooks.length <= 1) { alert("至少保留一个笔记本。"); return; }
    if (!confirm(`删除笔记本「${nb.name}」？其书签会归入第一个保留的笔记本。`)) return;
    execute({ type: "removeNotebook", id });
  }
  function showBookmarkMenu(anchor: HTMLElement, id: string, name: string, color: string) {
    showContextMenu(anchor, [
      { label: "重命名", run: () => {
          const newName = prompt("重命名书签：", name);
          if (newName && newName.trim()) execute({ type: "renameBookmark", id, name: newName.trim() });
        }
      },
      { label: "更改颜色", run: () => showColorPicker(id) },
      { label: "删除书签", danger: true, run: () => {
          if (!confirm(`删除书签「${name}」？其下的文档会归入同笔记本下第一个书签。`)) return;
          execute({ type: "removeBookmark", id });
        }
      }
    ]);
  }
  function showDocumentMenu(anchor: HTMLElement, item: WorkspaceDocument) {
    const noun = item.kind === "canvas" ? "Canvas" : "文档";
    showContextMenu(anchor, [
      { label: "重命名", run: () => {
          const newName = prompt(`重命名${noun}：`, item.title);
          if (newName && newName.trim()) execute({ type: "renameDocument", id: item.id, name: newName.trim() });
        }
      },
      { label: `删除${noun}`, danger: true, run: () => {
          if (!confirm(`删除${noun}「${item.title}」？画布中的引用会显示为目标已删除。`)) return;
          execute({ type: "removeDocument", id: item.id });
        }
      }
    ]);
  }
  function showColorPicker(bookmarkId: string) {
    closeContextMenu();
    const popup = document.createElement("div");
    popup.className = "color-picker-popup";
    BOOKMARK_COLORS.forEach((color) => {
      const sw = document.createElement("button");
      sw.className = "swatch";
      sw.style.background = color;
      sw.onclick = () => { execute({ type: "recolorBookmark", id: bookmarkId, color }); popup.remove(); };
      popup.appendChild(sw);
    });
    document.body.appendChild(popup);
    popup.style.left = "50%";
    popup.style.top = "50%";
    popup.style.transform = "translate(-50%, -50%)";
    setTimeout(() => {
      const close = (e: MouseEvent) => {
        if (!popup.contains(e.target as Node)) {
          popup.remove();
          document.removeEventListener("mousedown", close);
        }
      };
      document.addEventListener("mousedown", close);
    }, 0);
  }
  function addBookmark() {
    const snap = workspace.snapshot();
    if (!snap.activeNotebookId) return;
    const name = prompt("新书签名称：", "新书签");
    if (!name || !name.trim()) return;
    const id = "bk-" + uid();
    const color = BOOKMARK_COLORS[Math.floor(Math.random() * BOOKMARK_COLORS.length)];
    execute({ type: "createBookmark", bookmark: { id, notebookId: snap.activeNotebookId, name: name.trim(), color } });
  }
  function createDocument(bookmarkId: string) {
    const title = prompt("文档名称：", "未命名文档");
    if (!title || !title.trim()) return;
    const id = "doc-" + uid();
    void execute({ type: "createDocument", document: { id, title: title.trim() }, bookmarkId, parentId: null })
      .then(() => cb.onOpenDocument(id));
  }
  function createCanvas(bookmarkId: string) {
    const title = prompt("Canvas 名称：", "未命名 Canvas");
    if (!title || !title.trim()) return;
    const id = "canvas-" + uid();
    void execute({ type: "createCanvas", canvas: { id, title: title.trim() }, bookmarkId, parentId: null })
      .then(() => cb.onOpenCanvas(id));
  }
  function createDashboard(bookmarkId: string) {
    const title = prompt("Dashboard 名称：", "工作台 Dashboard");
    if (!title || !title.trim()) return;
    const id = "dashboard-" + uid();
    void execute({ type: "createDashboard", dashboard: { id, title: title.trim() }, bookmarkId, parentId: null })
      .then(() => cb.onOpenDashboard(id));
  }
  function showWorkspaceCreateMenu(anchor: HTMLElement, bookmarkId: string) {
    document.querySelector(".workspace-create-menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "workspace-create-menu";
    const options = [
      { icon: "▤", label: "新建文档", run: () => createDocument(bookmarkId) },
      { icon: "◇", label: "新建 Canvas", run: () => createCanvas(bookmarkId) },
      { icon: "▦", label: "新建 Dashboard", run: () => createDashboard(bookmarkId) }
    ];
    options.forEach(option => {
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = `<span aria-hidden="true">${option.icon}</span><span>${option.label}</span>`;
      button.onclick = event => { event.stopPropagation(); menu.remove(); option.run(); };
      menu.append(button);
    });
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.min(window.innerWidth - 184, rect.left)}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    const close = (event: MouseEvent) => {
      if (!menu.contains(event.target as Node) && event.target !== anchor) {
        menu.remove();
        document.removeEventListener("mousedown", close);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", close), 0);
  }

  // ── Init ───────────────────────────────────────────────────────────
  buildRightPanels();
  setupFileMenu();
  applyWidths();
  applyLeftTab(layout.leftActiveTab ?? "docs");
  renderAll();

  (window as unknown as { shell: ShellApi & { renderAll: typeof renderAll; renderOutline: typeof renderOutline } }).shell = {
    refresh: () => renderAll(),
    highlightActiveDocument: (id: string) => renderAll(id),
    showReferences,
    showLocations,
    showHistory,
    setDatabaseContext,
    setDashboardWidgetContext,
    updateHistory,
    setPanelContext,
    renderAll,
    renderOutline
  };

  return {
    refresh: () => renderAll(),
    showReferences,
    showLocations,
    showHistory,
    setDatabaseContext,
    setDashboardWidgetContext,
    updateHistory,
    setPanelContext,
    highlightActiveDocument: (id: string) => renderAll(id)
  };
}
