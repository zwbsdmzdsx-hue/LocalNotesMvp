import type { WorkspaceApi, WorkspaceCommand } from "./workspace-api";
import type { HistoryModel } from "./history";

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
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onOpenSticky: () => void;
  onCreateNote: () => void;
  onFocusBlock: (blockId: string) => void;
  onError: (error: unknown) => void;
  onRestoreHistory: (entryId: string) => void;
}

export interface ShellApi {
  refresh(): void;
  highlightActiveDocument(documentId: string): void;
  showReferences(): void;
  showHistory(): void;
  updateHistory(model: HistoryModel): void;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]!));
}

function uid(): string {
  return Math.random().toString(36).slice(2, 8);
}

const BOOKMARK_COLORS = [
  "#3B82F6", "#16A34A", "#7C3AED", "#EA580C", "#0891B2",
  "#DB2777", "#CA8A04", "#DC2626", "#0D9488", "#7C2D12"
];

export function mountShell(workspace: WorkspaceApi, cb: ShellCallbacks): ShellApi {
  const layout = loadLayout();
  function execute(command: WorkspaceCommand) {
    void workspace.execute(command).then(() => renderAll()).catch(cb.onError);
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
      { tab: "history", label: "历史记录", slot: "history" }
    ];
    for (const s of sections) {
      const sec = document.createElement("section");
      sec.id = s.tab + "-section";
      sec.dataset.panel = s.tab;
      sec.className = "relations-section";
      const inner = document.createElement("div");
      inner.id = s.tab;
      inner.className = "relations-slot";
      inner.dataset.slot = s.slot;
      sec.innerHTML = `<div class="panel-head"><span>${s.label}</span></div>`;
      sec.appendChild(inner);
      sidebarRightBody.appendChild(sec);
    }
    applyRightTab();
  }

  function applyRightTab(tab?: string) {
    const active = tab ?? layout.rightActiveTab;
    layout.rightActiveTab = active;
    sidebarRight.querySelectorAll<HTMLElement>("[data-pane-btn]").forEach((b) => {
      b.classList.toggle("active", b.dataset.paneBtn === active);
    });
    // Only top-level panel sections (direct children of sidebarRightBody), not inner reference cards.
    [...sidebarRightBody.children].forEach((s) => {
      if (s instanceof HTMLElement && s.dataset.panel) s.hidden = s.dataset.panel !== active;
    });
    saveLayout(layout);
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
    for (const bk of myBookmarks) {
      const isActive = bk.id === snap.activeBookmarkId;
      const strip = document.createElement("div");
      strip.className = "bk-strip" + (isActive ? " active" : "");
      const accent = document.createElement("span");
      accent.className = "bk-strip-accent";
      accent.style.background = bk.color;
      const label = document.createElement("span");
      label.className = "bk-strip-label";
      label.textContent = bk.name;
      strip.appendChild(accent);
      strip.appendChild(label);
      strip.onclick = () => {
        execute({ type: "selectBookmark", id: bk.id });
      };
      strip.oncontextmenu = (e) => {
        e.preventDefault();
        showBookmarkMenu(strip, bk.id, bk.name, bk.color);
      };
      docPanel.appendChild(strip);
      if (isActive) {
        const docList = document.createElement("div");
        docList.className = "doc-list";
        const docs = snap.documentIds;
        for (const docId of docs) {
          const btn = document.createElement("button");
          btn.className = "list-item doc-item";
          const title = workspace.documentTitle(docId);
          btn.innerHTML = `<span class="list-icon">&#128196;</span><span class="list-label">${escapeHtml(title)}</span>`;
          btn.onclick = () => cb.onOpenDocument(docId);
          btn.oncontextmenu = (e) => {
            e.preventDefault();
            showDocumentMenu(btn, docId, title);
          };
          docList.appendChild(btn);
        }
        if (docs.length === 0) {
          docList.innerHTML = `<div class="empty" style="padding:8px 12px">暂无文档</div>`;
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
    const headings = blocks.filter(
      (b: { type: string; content: { text: string } }) =>
        b.type === "heading" || (b.type === "paragraph" && b.content.text.length < 40)
    );
    if (headings.length === 0) {
      list.innerHTML = `<div class="empty">没有可显示的标题</div>`;
      return;
    }
    for (const h of headings) {
      const btn = document.createElement("button");
      btn.className = "list-item outline-item" + (h.id === highlightId ? " active" : "");
      btn.textContent = h.content.text || "未命名";
      btn.onclick = () => {
        cb.onFocusBlock(h.id);
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
  function updateHistory(model: HistoryModel) {
    historyModel = model;
    const panel = document.querySelector<HTMLElement>("[data-slot=history]");
    if (!panel) return;
    panel.replaceChildren();
    if (!model.entries.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "还没有历史记录";
      panel.append(empty);
      return;
    }
    const intro = document.createElement("div");
    intro.className = "history-intro";
    intro.textContent = "自动保存最近 80 个版本";
    panel.append(intro);
    [...model.entries].reverse().forEach(entry => {
      const item = document.createElement("div");
      item.className = "history-item" + (entry.id === model.currentId ? " current" : "");
      const main = document.createElement("button");
      main.type = "button";
      main.className = "history-entry";
      main.title = entry.id === model.currentId ? "当前版本" : "恢复到此版本";
      const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      main.innerHTML = `<strong>${escapeHtml(entry.label)}</strong><span>${time}${entry.id === model.currentId ? " · 当前" : ""}</span>`;
      main.onclick = () => { if (entry.id !== historyModel.currentId) cb.onRestoreHistory(entry.id); };
      item.append(main);
      if (entry.id !== model.currentId) {
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "history-restore";
        restore.textContent = "恢复";
        restore.onclick = () => cb.onRestoreHistory(entry.id);
        item.append(restore);
      }
      panel.append(item);
    });
  }

  // ── Render all ─────────────────────────────────────────────────────
  function renderAll(highlightId?: string) {
    renderNotebookTabs();
    renderSidebarBody();
    renderOutline(highlightId);
    renderSearch();
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
    if (target) applyRightTab(target.dataset.paneBtn!);
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
  function showDocumentMenu(anchor: HTMLElement, id: string, title: string) {
    showContextMenu(anchor, [
      { label: "重命名", run: () => {
          const newName = prompt("重命名文档：", title);
          if (newName && newName.trim()) execute({ type: "renameDocument", id, name: newName.trim() });
        }
      },
      { label: "删除文档", danger: true, run: () => {
          if (!confirm(`删除文档「${title}」？此操作不可恢复。`)) return;
          execute({ type: "removeDocument", id });
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
    showHistory,
    updateHistory,
    renderAll,
    renderOutline
  };

  return {
    refresh: () => renderAll(),
    showReferences,
    showHistory,
    updateHistory,
    highlightActiveDocument: (id: string) => renderAll(id)
  };
}
