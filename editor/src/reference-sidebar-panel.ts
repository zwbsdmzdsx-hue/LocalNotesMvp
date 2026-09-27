import type { EditorState, ReferenceInstance } from "../../protocol/types";
import type { PanelHandle } from "./module-registry";
import { ordinaryReferenceEntries, panelDataState } from "./panel-context";

export type OrdinaryLinkSidebarEntry = ReturnType<typeof ordinaryReferenceEntries>[number];
export type ReferencePanelActions = {
  rowSignature(reference: ReferenceInstance): string;
  renderReference(reference: ReferenceInstance, inSidebar: boolean): HTMLElement;
  readOnlyProjection(reference: ReferenceInstance): HTMLElement;
  showOrdinaryLinkModeMenu(anchor: HTMLElement, link: OrdinaryLinkSidebarEntry): void;
  onClosePreview(): void;
};
export type ReferencePanelHandle = PanelHandle & {
  setState(state: EditorState | null, previewActive: boolean): void;
  showLoading(): void;
  showPreview(reference: ReferenceInstance, referenceId?: string, ordinaryLink?: OrdinaryLinkSidebarEntry | null): void;
  showError(message: string): void;
  clear(): void;
};

export function mountReferencePanel(slot: HTMLElement, actions: ReferencePanelActions): ReferencePanelHandle {
  let state: EditorState | null = null;
  let preview: { reference: ReferenceInstance; referenceId?: string; ordinaryLink?: OrdinaryLinkSidebarEntry | null } | null = null;
  let previewStatus: "none" | "loading" | "error" = "none";

  function closePreview() {
    preview = null;
    previewStatus = "none";
    actions.onClosePreview();
    renderGroup();
  }

  function renderPreview() {
    if (!preview) return;
    const reference = preview.referenceId
      ? state?.references.find(item => item.id === preview!.referenceId) ?? preview.reference
      : preview.reference;
    const header = document.createElement("div"); header.className = "sidebar-preview-heading";
    const title = document.createElement("span"); title.textContent = reference.targetTitle;
    const mode = document.createElement("button");
    mode.type = "button"; mode.className = "link-display-mode"; mode.textContent = "显示方式";
    mode.setAttribute("aria-label", "引用显示方式"); mode.title = "选择引用显示方式";
    if (preview.ordinaryLink) mode.onclick = event => {
      event.stopPropagation();
      actions.showOrdinaryLinkModeMenu(mode, preview!.ordinaryLink!);
    };
    else mode.hidden = true;
    const close = document.createElement("button"); close.textContent = "×"; close.setAttribute("aria-label", "关闭分栏");
    close.onclick = closePreview;
    header.append(title, mode, close);
    slot.replaceChildren(header, preview.referenceId ? actions.renderReference(reference, true) : actions.readOnlyProjection(reference));
  }

  function renderGroup() {
    if (!state) { slot.replaceChildren(); return; }
  const currentState = state;
  // Diff the right-side reference sidebar against `state.references`. Cards whose rendered
  // row signature still matches current state are reused (preserves focused contentEditables
  // and scroll position). Cards that no longer belong are removed. New cards are inserted.
  // The whole fragment is applied with `replaceChildren` so the panel never paints empty.
  const visibleOrdinaryLinks = ordinaryReferenceEntries(state);
  const desiredSidebarRefs = state.references.filter((reference) => reference.mode === "sidebar");
  const visibleReferences = state.references.filter(reference => reference.mode !== "link");
  const showCards: ReferenceInstance[] = visibleReferences;
  let introOrEmpty: "intro" | "empty" | null = null;
  if (desiredSidebarRefs.length === 0)
    introOrEmpty = showCards.length > 0 ? "intro" : visibleOrdinaryLinks.length ? null : "empty";
  else if (!showCards.length && !visibleOrdinaryLinks.length) introOrEmpty = "empty";
  // Index existing cards by their data-reference-id so we can decide reuse vs. rebuild.
  const existingCards = new Map<string, HTMLElement>();
  slot.querySelectorAll<HTMLElement>(".reference-card[data-reference-id]").forEach((el) => {
    existingCards.set(el.dataset.referenceId!, el);
  });
  const documentGroups = new Map<string, { title: string; references: ReferenceInstance[]; links: typeof visibleOrdinaryLinks }>();
  const groupFor = (documentId: string, title: string) => {
    const existing = documentGroups.get(documentId);
    if (existing) return existing;
    const group = { title, references: [], links: [] as typeof visibleOrdinaryLinks };
    documentGroups.set(documentId, group);
    return group;
  };
  showCards.forEach(reference => groupFor(
    reference.targetDocumentId,
    currentState.documents.find(document => document.id === reference.targetDocumentId)?.title ?? reference.targetTitle
  ).references.push(reference));
  visibleOrdinaryLinks.forEach(link => groupFor(link.documentId, link.label || link.documentId).links.push(link));

  // Collect everything into the fragment BEFORE replaceChildren, so the panel is never
  // temporarily blank even if showCards is empty or an error occurs mid-render.
  const fragment = document.createDocumentFragment();
  for (const [documentId, group] of documentGroups) {
    const section = document.createElement("section");
    section.className = "reference-document-group";
    section.dataset.documentId = documentId;
    const header = document.createElement("header");
    header.className = "reference-document-head";
    const title = document.createElement("button");
    title.type = "button";
    title.className = "reference-document-title reference-title";
    title.dataset.targetId = documentId;
    title.textContent = group.title || "未命名文档";
    title.title = "打开源文档";
    const total = document.createElement("span");
    total.className = "reference-document-count";
    total.textContent = `${group.references.length + group.links.length} 项`;
    header.append(title, total);
    section.append(header);
    const items = document.createElement("div");
    items.className = "reference-document-items";
    for (const reference of group.references) {
      const existing = existingCards.get(reference.id);
      const sig = actions.rowSignature(reference);
      const card = existing && (existing as HTMLElement & { __rowSig?: string }).__rowSig === sig
        ? existing
        : actions.renderReference(reference, true);
      (card as HTMLElement & { __rowSig?: string }).__rowSig = sig;
      items.append(card);
      existingCards.delete(reference.id);
    }
    for (const link of group.links) {
      const entry = document.createElement("section");
      // Ordinary [[...]] links and live reference instances share one visual
      // list item in the grouped sidebar. The link remains read-only; only
      // its presentation is aligned with the live reference card.
      entry.className = "linked-reference-entry reference-card sidebar";
      entry.dataset.linkKey = link.key;
      const linkTitle = document.createElement("button");
      linkTitle.type = "button";
      linkTitle.className = "reference-title";
      linkTitle.dataset.targetId = link.documentId;
      linkTitle.dataset.sourceBlockId = link.sourceBlockId;
      if (link.blockId) linkTitle.dataset.targetBlockId = link.blockId;
      linkTitle.textContent = link.label || "未命名链接";
      linkTitle.title = "悬停预览 · 单击分栏 · 双击打开源";
      const summary = document.createElement("div");
      summary.className = "reference-card-summary linked-reference-summary";
      summary.append(linkTitle);
      const modeMenu = document.createElement("button");
      modeMenu.type = "button";
      modeMenu.className = "reference-mode-menu";
      modeMenu.setAttribute("aria-label", "引用显示方式");
      modeMenu.title = "选择引用显示方式";
      modeMenu.textContent = "显示方式";
      modeMenu.addEventListener("click", event => {
        event.stopPropagation();
        actions.showOrdinaryLinkModeMenu(modeMenu, link);
      });
      summary.append(modeMenu);
      const excerpt = document.createElement("p");
      excerpt.className = "linked-reference-excerpt";
      excerpt.textContent = link.excerpt || "（空白段落）";
      entry.append(summary, excerpt);
      entry.addEventListener("click", event => {
        if ((event.target as HTMLElement).closest("button")) return;
        linkTitle.click();
      });
      items.append(entry);
    }
    section.append(items);
    fragment.append(section);
  }
  // Remove cards that no longer belong (e.g. reference was removed).
  existingCards.forEach((el) => el.remove());
  if (introOrEmpty === "intro") {
    const intro = document.createElement("div");
    intro.className = "ref-sidebar-intro";
    intro.textContent = `当前文档包含 ${showCards.length} 处实时引用（不是右侧分栏模式）。可在引用菜单选择「右侧分栏」以在此处查看。`;
    fragment.append(intro);
  } else if (introOrEmpty === "empty") {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无右侧分栏。双链预览会自动展开在此区域。";
    fragment.append(empty);
  }
  // Swap the whole panel atomically — intro/empty is already in the fragment.
  slot.replaceChildren(fragment);
  // An empty result is still a visible selected panel. Only the shell changes tabs.
}

  return {
    update(context) {
      const next = context ? panelDataState(context) : null;
      if (state?.note.id !== next?.note.id) { preview = null; previewStatus = "none"; }
      state = next;
      if (previewStatus === "loading" || previewStatus === "error") return;
      if (preview) { renderPreview(); return; }
      renderGroup();
    },
    setState(next, previewActive) {
      state = next;
      if (!previewActive) { preview = null; previewStatus = "none"; }
      if (previewStatus === "loading" || previewStatus === "error") return;
      if (preview) { renderPreview(); return; }
      renderGroup();
    },
    showLoading() {
      previewStatus = "loading";
      if (!slot.hasChildNodes()) {
        const loading = document.createElement("div"); loading.className = "empty"; loading.textContent = "正在加载引用…";
        slot.append(loading);
      }
    },
    showPreview(reference, referenceId, ordinaryLink) {
      previewStatus = "none";
      preview = { reference, referenceId, ordinaryLink };
      renderPreview();
    },
    showError(message) {
      previewStatus = "error";
      const text = document.createElement("div"); text.className = "empty"; text.textContent = message;
      const close = document.createElement("button"); close.textContent = "关闭分栏"; close.onclick = closePreview;
      slot.replaceChildren(text, close);
    },
    clear() { preview = null; previewStatus = "none"; state = null; slot.replaceChildren(); },
    dispose() { preview = null; state = null; slot.replaceChildren(); }
  };
}
