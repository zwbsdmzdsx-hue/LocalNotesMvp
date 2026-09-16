import type { BlockType, LinkToken, BlockContent, BlockProperties, Block, Note, Backlink, OverrideNotice, ReferenceOverride, ReferenceMode, ReferenceInstance, EditorState, SaveMutation, RequestMap } from "../../protocol/types";
import type { EditorHostApi } from "./editor-host-api";

// The existing renderer and editing operations are shared by browser and desktop.
export function mountEditor(host: EditorHostApi) {
const titleInput = document.querySelector<HTMLInputElement>("#title")!;
const blockSurface = document.querySelector<HTMLDivElement>("#blocks")!;
const saveStatus = document.querySelector<HTMLSpanElement>("#status")!;
const linkSuggestions = document.querySelector<HTMLDivElement>("#link-suggestions")!;
const backlinksPanel = document.querySelector<HTMLDivElement>("#backlinks")!;
const noticesPanel = document.querySelector<HTMLDivElement>("#override-notices")!;
const referenceSidebarSection = document.querySelector<HTMLElement>("#reference-sidebar-section")!;
const referenceSidebarPanel = document.querySelector<HTMLDivElement>("#reference-sidebar")!;
let state: EditorState | null = null;
let mutationVersion = 0;
let inFlightMutation: SaveMutation | null = null;
let queuedMutation: SaveMutation | null = null;
let commandTail: Promise<void> = Promise.resolve();
let commandFailure: Error | null = null;
let saveFailure: string | null = null;
const saveDrainWaiters: Array<() => void> = [];
let activeEditable: HTMLElement | null = null;
let activeBlock: HTMLElement | null = null;
let linkMenuItems: Array<{ id: string; blockId?: string; title: string; meta: string; label: string }> = [];
let linkMenuIndex = 0;

const referenceModeLabels: Record<ReferenceMode, string> = {
  inline: "正文直显",
  collapsed: "折叠卡片",
  sidebar: "右侧分栏",
  link: "仅标题链接"
};

type Message = { [K in keyof RequestMap]: { type: K } & RequestMap[K] }[keyof RequestMap];
function post(message: Message, sourceDocumentId = state?.note.id): Promise<void> {
  const { type, ...payload } = message;
  if (type === "saveDocument") {
    return host.saveDocument(payload as SaveMutation).then(handleSaveAck, error =>
      handleSaveNack({ mutationId: (payload as SaveMutation).mutationId, error: error.message }));
  }
  if (type === "openDocument" || type === "navigateBack" || type === "navigateForward") {
    return flush().then(() => host.request(type, payload as RequestMap[typeof type], sourceDocumentId))
      .then(() => undefined).catch(showError);
  }
  const owner = sourceDocumentId;
  if (!owner) return Promise.resolve();
  const commandKinds = new Set(["createReference", "setReferenceMode", "saveOverride", "saveInstanceBlock", "moveReferenceBlock", "deleteInstanceBlock", "hideReferenceBlock", "resetOverride", "resetReference", "removeReference"]);
  const operationName = (value: string) => value.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
  commandTail = commandTail.catch(() => undefined).then(async () => {
    const result = commandKinds.has(type)
      ? await host.executeCommand({ operation: operationName(type), ...(payload as Record<string, unknown>) }, owner)
      : await host.request(type, payload as RequestMap[typeof type], owner);
    commandFailure = null;
    if (result && "state" in result && state?.note.id === owner) {
      // Text edits keep the caret; structural commands redraw after their ACK.
      if (type === "saveOverride" || type === "saveInstanceBlock" || type === "moveReferenceBlock") {
        state.references = result.state.references;
      } else render(result.state);
    }
    saveStatus.textContent = "已保存";
  }).catch(error => { commandFailure = error; showError(error); });
  return commandTail;
}
function showError(error: unknown) {
  saveStatus.textContent = "保存失败：" + (error instanceof Error ? error.message : String(error));
}
async function flush() {
  if (saveFailure) throw new Error(saveFailure);
  await new Promise<void>(resolve => runAfterSaveDrain(resolve));
  await commandTail;
  if (saveFailure) throw new Error(saveFailure);
  if (commandFailure) throw commandFailure;
}

function pumpSaveQueue() {
  if (inFlightMutation || !queuedMutation) {
    finishSaveDrain();
    return;
  }
  inFlightMutation = queuedMutation;
  queuedMutation = null;
  const mutation = inFlightMutation;
  post({
    type: "saveDocument",
    documentId: mutation.documentId,
    mutationId: mutation.mutationId,
    clientVersion: mutation.clientVersion,
    title: mutation.title,
    blocks: mutation.blocks
  }, mutation.documentId);
}

function finishSaveDrain() {
  if (inFlightMutation || queuedMutation || !saveDrainWaiters.length) return;
  const waiters = saveDrainWaiters.splice(0);
  waiters.forEach((action) => action());
}

function enqueueDocumentSave() {
  if (!state?.note.id) return;
  saveFailure = null;
  const documentId = state.note.id;
  // Coalesced edits replace the queued snapshot; they must keep its version.
  // SQLite versions are contiguous, so only a transaction that will be sent
  // needs a new version number.
  const clientVersion = queuedMutation?.documentId === documentId
    ? queuedMutation.clientVersion
    : Math.max(mutationVersion, state.note.clientVersion ?? 0, inFlightMutation?.clientVersion ?? 0) + 1;
  mutationVersion = clientVersion;
  const mutation: SaveMutation = {
    documentId,
    mutationId: newId(),
    clientVersion,
    title: titleInput.value.trim() || "未命名笔记",
    blocks: readOwnBlocks()
  };
  state.blocks = mutation.blocks;
  queuedMutation = mutation;
  saveStatus.textContent = "正在保存...";
  pumpSaveQueue();
}

function handleSaveAck(message: { mutationId: string; documentId: string; clientVersion: number }) {
  if (!inFlightMutation || inFlightMutation.mutationId !== message.mutationId) return;
  if (inFlightMutation.documentId !== message.documentId) return;
  if (state?.note.id === message.documentId) state.note.clientVersion = message.clientVersion;
  saveFailure = null;
  inFlightMutation = null;
  saveStatus.textContent = "已保存到本地数据库";
  pumpSaveQueue();
  finishSaveDrain();
  if (!inFlightMutation && !queuedMutation && state?.references.some(reference => reference.targetDocumentId === message.documentId)) {
    void refreshLiveReferences();
  }
  if (!inFlightMutation && !queuedMutation && sidebarLink?.documentId === message.documentId && !sidebarLink.referenceId) void showLinkSidebar(sidebarLink);
}

let deferredReferenceRefresh = false;
let referenceRefreshSequence = 0;
async function refreshLiveReferences() {
  const current = state;
  if (!current) return;
  const sequence = ++referenceRefreshSequence;
  try {
    await commandTail;
    const next = await host.loadDocument(current.note.id);
    if (state !== current || sequence !== referenceRefreshSequence) return;
    // Never replace an active local edit, including one whose command ACK is pending.
    if (document.activeElement?.closest(".reference-card")) {
      deferredReferenceRefresh = true;
      return;
    }
    next.references.forEach(reference => {
      const previous = current.references.find(item => item.id === reference.id);
      if (JSON.stringify(previous) === JSON.stringify(reference)) return;
      document.querySelectorAll<HTMLElement>(".reference-card[data-reference-id]").forEach(card => {
        if (card.dataset.referenceId !== reference.id) return;
        const replacement = renderReference(reference, reference.mode === "sidebar");
        card.replaceWith(replacement);
      });
      const shell = blockSurface.querySelector<HTMLElement>(`[data-id="${CSS.escape(reference.hostBlockId)}"]`);
      shell?.querySelectorAll<HTMLElement>(".reference-heading strong, .sidebar-reference-entry strong").forEach(title => title.textContent = reference.targetTitle);
    });
    current.references = next.references;
  } catch (error) {
    saveStatus.textContent = "引用刷新失败：" + (error instanceof Error ? error.message : String(error));
  }
}
document.addEventListener("focusout", () => {
  if (!deferredReferenceRefresh) return;
  queueMicrotask(() => {
    if (document.activeElement?.closest(".reference-card")) return;
    deferredReferenceRefresh = false;
    void refreshLiveReferences();
  });
});

function handleSaveNack(message: { mutationId: string; error: string }) {
  if (!inFlightMutation || inFlightMutation.mutationId !== message.mutationId) return;
  const error = message.error || "本地数据库拒绝了这次保存";
  inFlightMutation = null;
  queuedMutation = null;
  mutationVersion = state?.note.clientVersion ?? 0;
  saveFailure = error;
  saveStatus.textContent = `保存失败：${error}`;
  showError(error);
  saveDrainWaiters.splice(0).forEach(resolve => resolve());
}

function runAfterSaveDrain(action: () => void) {
  if (saveFailure) return;
  saveDrainWaiters.push(action);
  pumpSaveQueue();
}

function postAfterFlush(message: Message) {
  const documentId = state?.note.id;
  runAfterSaveDrain(() => post(message, documentId));
}

function newId() {
  const secureCrypto = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof secureCrypto.randomUUID === "function") return secureCrypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  if (typeof secureCrypto.getRandomValues === "function") secureCrypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function sanitizeHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("[data-reference-host-id]").forEach(anchor => anchor.replaceChildren());
  const allowed = new Set(["B", "STRONG", "I", "EM", "MARK", "BR", "SPAN"]);
  [...template.content.querySelectorAll("*")].forEach((element) => {
    if (!allowed.has(element.tagName)) element.replaceWith(...element.childNodes);
    else [...element.attributes].forEach((attribute) => {
      const allowedLinkAttribute = ["data-target-id", "data-target-block-id", "data-target-title", "data-reference-host-id"].includes(attribute.name);
      if (attribute.name !== "style" && !allowedLinkAttribute || attribute.name === "style" && !/^(background-color|color):/i.test(attribute.value)) element.removeAttribute(attribute.name);
    });
  });
  return template.innerHTML;
}

function renderLinkedHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = sanitizeHtml(html);
  template.content.querySelectorAll<HTMLElement>("[data-target-id]").forEach((link) => { link.className = "wiki-link"; link.contentEditable = "false"; });
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest(".wiki-link")) textNodes.push(node);
  }
  textNodes.forEach((node) => {
    const value = node.nodeValue ?? "";
    const matches = [...value.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)];
    if (!matches.length) return;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    matches.forEach((match) => {
      fragment.append(value.slice(offset, match.index));
      const link = document.createElement("span");
      link.className = "wiki-link";
      link.contentEditable = "false";
      link.dataset.title = match[1].trim();
      const anchor = match[2]?.trim();
      if (anchor?.startsWith("^")) link.dataset.targetBlockId = anchor.slice(1);
      link.textContent = match[0];
      fragment.append(link);
      offset = (match.index ?? 0) + match[0].length;
    });
    fragment.append(value.slice(offset));
    node.replaceWith(fragment);
  });
  return template.innerHTML;
}

type LinkDestination = { documentId: string; blockId?: string; referenceId?: string; anchor: HTMLElement };
let sidebarLink: LinkDestination | null = null;
let sidebarSequence = 0;
let previewSequence = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function linkDestination(element: EventTarget | null): LinkDestination | null {
  const anchor = (element as HTMLElement | null)?.closest<HTMLElement>(".wiki-link, .reference-title");
  if (!anchor || !state) return null;
  const documentId = anchor.dataset.targetId ?? state.documents.find(item => item.title === anchor.dataset.title)?.id;
  return documentId ? { documentId, blockId: anchor.dataset.targetBlockId, referenceId: anchor.dataset.referenceId, anchor } : null;
}
function dismissPreview() {
  clearTimeout(previewTimer); previewSequence++;
  document.querySelector(".link-preview")?.remove();
}
async function targetProjection(target: LinkDestination): Promise<ReferenceInstance> {
  const instance = state?.references.find(item => item.id === target.referenceId);
  if (instance) return instance;
  const source = await host.loadDocument(target.documentId);
  let blocks = source.blocks;
  if (target.blockId) {
    const ids = new Set([target.blockId]);
    for (let count = -1; count !== ids.size;) {
      count = ids.size;
      blocks.forEach(block => { if (block.parentId && ids.has(block.parentId)) ids.add(block.id); });
    }
    blocks = blocks.filter(block => ids.has(block.id));
  }
  return { id: "link-preview", hostBlockId: "", targetDocumentId: target.documentId, targetBlockId: target.blockId, targetTitle: source.note.title, mode: "link", blocks, overrides: [], hiddenBlockIds: [], broken: !!target.blockId && blocks.length === 0 };
}
function readOnlyProjection(reference: ReferenceInstance) {
  const container = document.createElement("div");
  container.className = "link-preview-content";
  const hidden = new Set(reference.hiddenBlockIds);
  const visible = (block: Block) => {
    let current: Block | undefined = block;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (hidden.has(current.id)) return false;
      seen.add(current.id); current = reference.blocks.find(item => item.id === current?.parentId);
    }
    return true;
  };
  reference.blocks.filter(visible).forEach(block => {
    const override = reference.overrides.find(item => item.targetBlockId === block.id);
    const content = override?.patch.content ?? block.content;
    const paragraph = document.createElement("div");
    paragraph.className = "preview-block";
    paragraph.innerHTML = sanitizeHtml(content.html || escapeText(content.text));
    container.append(paragraph);
  });
  if (!container.childElementCount) container.textContent = reference.broken ? "引用目标不存在" : "暂无内容";
  return container;
}
async function showLinkPreview(target: LinkDestination) {
  const sequence = ++previewSequence;
  try {
    const reference = await targetProjection(target);
    if (sequence !== previewSequence || !target.anchor.isConnected) return;
    const popup = document.createElement("aside");
    popup.className = "link-preview"; popup.setAttribute("role", "tooltip");
    const title = document.createElement("div"); title.className = "preview-title"; title.textContent = reference.targetTitle;
    popup.append(title, readOnlyProjection(reference));
    document.body.append(popup);
    const rect = target.anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(innerWidth - popup.offsetWidth - 8, rect.left))}px`;
    popup.style.top = `${Math.max(8, Math.min(innerHeight - popup.offsetHeight - 8, rect.bottom + 6))}px`;
    popup.addEventListener("mouseleave", dismissPreview);
  } catch { if (sequence === previewSequence) dismissPreview(); }
}
async function showLinkSidebar(target: LinkDestination) {
  dismissPreview(); sidebarLink = target;
  const sequence = ++sidebarSequence;
  const owner = state?.note.id;
  try {
    const reference = await targetProjection(target);
    if (sequence !== sidebarSequence || owner !== state?.note.id) return;
    referenceSidebarSection.hidden = false;
    referenceSidebarPanel.replaceChildren();
    const header = document.createElement("div"); header.className = "sidebar-preview-heading";
    const title = document.createElement("span"); title.textContent = reference.targetTitle;
    const close = document.createElement("button"); close.textContent = "×"; close.setAttribute("aria-label", "关闭分栏");
    close.onclick = () => { sidebarLink = null; sidebarSequence++; renderRelations(); };
    const embed = document.createElement("button"); embed.textContent = "嵌入正文";
    embed.onclick = () => {
      if (target.referenceId) {
        sidebarLink = null;
        const current = state?.references.find(item => item.id === target.referenceId);
        if (current) setReferenceMode(current, "inline");
      } else createReferenceForTarget(target.documentId, target.blockId, "inline", target.anchor);
    };
    header.append(title, embed, close);
    referenceSidebarPanel.append(header, target.referenceId ? renderReference(reference, true) : readOnlyProjection(reference));
  } catch (error) { showError(error); }
}
document.addEventListener("mouseover", event => {
  const target = linkDestination(event.target);
  if (!target || target.anchor.contains(event.relatedTarget as Node | null)) return;
  dismissPreview(); previewTimer = setTimeout(() => void showLinkPreview(target), 400);
});
document.addEventListener("mouseout", event => {
  const target = linkDestination(event.target);
  if (!target || target.anchor.contains(event.relatedTarget as Node | null)) return;
  if ((event.relatedTarget as HTMLElement | null)?.closest?.(".link-preview")) return;
  dismissPreview();
});
document.addEventListener("click", event => {
  const target = linkDestination(event.target);
  if (!target) return;
  event.preventDefault();
  if (event.detail < 2) void showLinkSidebar(target);
});
document.addEventListener("dblclick", event => {
  const target = linkDestination(event.target);
  if (!target) return;
  event.preventDefault(); dismissPreview(); sidebarSequence++;
  postAfterFlush({ type: "openDocument", documentId: target.documentId, blockId: target.blockId });
});
document.addEventListener("contextmenu", event => {
  const target = linkDestination(event.target);
  if (!target) return;
  event.preventDefault();
  const instance = state?.references.find(item => item.id === target.referenceId);
  if (instance) showReferenceMenu(target.anchor, undefined, instance);
  else showLinkChoiceMenu(target.anchor, { id: target.documentId, blockId: target.blockId, label: target.anchor.textContent ?? "链接" });
});
document.addEventListener("keydown", event => { if (event.key === "Escape") dismissPreview(); });

function blockDepth(block: Block, all: Block[]) {
  let depth = 0;
  let parentId = block.parentId;
  const visited = new Set<string>();
  while (parentId && depth < 8 && !visited.has(parentId)) {
    visited.add(parentId);
    parentId = all.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    depth++;
  }
  return depth;
}

function render(next: EditorState) {
  document.querySelector(".block-menu")?.remove();
  hideInlineLinkSuggestions();
  const changed = state?.note.id !== next.note.id;
  dismissPreview();
  if (changed) { sidebarLink = null; sidebarSequence++; }
  state = next;
  activeEditable = null;
  if (changed) { saveFailure = null; commandFailure = null; mutationVersion = next.note.clientVersion ?? 0; }
  else mutationVersion = Math.max(mutationVersion, next.note.clientVersion ?? 0);
  titleInput.value = next.note.title;
  blockSurface.innerHTML = "";
  (next.blocks.length ? next.blocks : [createBlock()]).forEach((block) => renderOwnBlock(block));
  mountEmbeddedReferences();
  renderRelations();
  saveStatus.textContent = "已同步本地数据库";
}

function mountEmbeddedReferences() {
  blockSurface.querySelectorAll<HTMLElement>("[data-reference-host-id]").forEach(anchor => {
    const shell = blockSurface.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(anchor.dataset.referenceHostId!)}"]`);
    if (!shell || shell.contains(anchor)) return;
    anchor.contentEditable = "false";
    anchor.className = "embedded-reference";
    shell.style.setProperty("--depth", "0");
    anchor.replaceChildren(shell);
  });
}

function focusBlock(blockId: string) {
  window.setTimeout(() => {
    const block = document.querySelector<HTMLElement>(`[data-own-block][data-id="${CSS.escape(blockId)}"]`);
    if (!block) return;
    block.scrollIntoView({ block: "center", behavior: "smooth" });
    block.querySelector<HTMLElement>(".block-text")?.focus({ preventScroll: true });
    block.classList.add("navigation-target");
    window.setTimeout(() => block.classList.remove("navigation-target"), 900);
  }, 50);
}

function createBlock(type: BlockType = "paragraph", parentId: string | null = null): Block {
  return { id: newId(), parentId, position: "", type, content: { text: "", html: "", checked: false }, properties: {}, revision: 1 };
}

function renderOwnBlock(block: Block) {
  if (!state) return;
  const shell = document.createElement("div");
  shell.className = "block-shell";
  shell.dataset.ownBlock = "true";
  shell.dataset.id = block.id;
  shell.dataset.parentId = block.parentId ?? "";
  shell.dataset.type = block.type;
  shell.style.setProperty("--depth", String(blockDepth(block, state.blocks)));

  if (block.type === "reference") {
    const reference = state.references.find((item) => item.hostBlockId === block.id);
    const mode = reference?.mode ?? "inline";
    shell.innerHTML = `<div class="reference-heading"><button type="button" class="grip" aria-label="引用菜单" title="引用显示方式">⠿</button></div>`;
    if (reference && (mode === "sidebar" || mode === "link")) {
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = "sidebar-reference-entry reference-title";
      entry.dataset.targetId = reference.targetDocumentId;
      if (reference.targetBlockId) entry.dataset.targetBlockId = reference.targetBlockId;
      entry.dataset.referenceId = reference.id;
      entry.textContent = reference.targetTitle;
      entry.title = "悬停预览 · 单击分栏 · 双击打开源";
      shell.append(entry);
    } else if (reference) shell.append(renderReference(reference));
  } else {
    shell.append(createEditableRow(block));
  }
  blockSurface.append(shell);
}

function createEditableRow(block: Block) {
  const row = document.createElement("div");
  row.className = "block-row";
  const checkbox = block.type === "todo" ? `<input class="todo-check" type="checkbox" ${block.content.checked ? "checked" : ""}>` : "";
  row.innerHTML = `<button type="button" class="grip" aria-label="块菜单">⠿</button>${checkbox}<div class="block-text ${block.type === "heading" ? "heading" : ""}" contenteditable="true"></div><button class="delete-block" title="删除块">×</button>`;
  const editable = row.querySelector<HTMLElement>(".block-text")!;
  editable.innerHTML = renderLinkedHtml(block.content.html || escapeText(block.content.text));
  editable.style.backgroundColor = block.properties.background ?? "";
  editable.style.color = block.properties.textColor ?? "";
  editable.addEventListener("focus", () => activeEditable = editable);
  editable.addEventListener("input", event => { if (event.target === editable) scheduleDocumentSave(); });
  editable.addEventListener("keydown", handleBlockKeydown);
  row.querySelector("input")?.addEventListener("change", () => scheduleDocumentSave(0));
  row.querySelector(".delete-block")?.addEventListener("click", () => {
    row.closest("[data-own-block]")?.remove();
    if (!blockSurface.querySelector("[data-own-block]")) addBlock("paragraph");
    scheduleDocumentSave(0);
  });
  return row;
}

function handleBlockKeydown(event: KeyboardEvent) {
  if (event.target !== event.currentTarget) return;
  if (event.defaultPrevented) return;
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  const current = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-own-block]")!;
  const next = createBlock("paragraph", current.dataset.parentId || null);
  const shell = document.createElement("div");
  shell.className = "block-shell";
  shell.dataset.ownBlock = "true";
  shell.dataset.id = next.id;
  shell.dataset.parentId = next.parentId ?? "";
  shell.dataset.type = next.type;
  shell.style.setProperty("--depth", String(Number(current.style.getPropertyValue("--depth")) || 0));
  shell.append(createEditableRow(next));
  current.after(shell);
  shell.querySelector<HTMLElement>(".block-text")?.focus();
  scheduleDocumentSave(0);
}

function readOwnBlocks(): Block[] {
  return [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")].map((shell, index) => {
    const old = state?.blocks.find((block) => block.id === shell.dataset.id);
    if (shell.dataset.type === "reference") return {
      id: shell.dataset.id!, parentId: shell.dataset.parentId || null, position: String((index + 1) * 1000).padStart(8, "0"),
      type: "reference", content: old?.content ?? { text: "", html: "" }, properties: old?.properties ?? {}, revision: old?.revision ?? 1
    };
    const editable = shell.querySelector<HTMLElement>(".block-text")!;
    return {
      id: shell.dataset.id!, parentId: shell.dataset.parentId || null, position: String((index + 1) * 1000).padStart(8, "0"),
      type: shell.dataset.type as BlockType,
      content: { ...editableContent(editable, old?.content), checked: shell.querySelector<HTMLInputElement>(".todo-check")?.checked ?? false },
      properties: { background: editable.style.backgroundColor || undefined, textColor: editable.style.color || undefined }, revision: old?.revision ?? 1
    };
  });
}

function editableContent(editable: HTMLElement, fallback: BlockContent = { text: "", html: "" }): BlockContent {
  const clean = editable.cloneNode(true) as HTMLElement;
  clean.querySelectorAll("[data-reference-host-id]").forEach(anchor => anchor.replaceChildren());
  const textOnly = clean.cloneNode(true) as HTMLElement;
  textOnly.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
  const text = textOnly.textContent ?? "";
  const links: LinkToken[] = [];
  clean.querySelectorAll<HTMLElement>(".wiki-link").forEach((link) => {
    const targetText = link.textContent ?? "";
    const start = text.indexOf(targetText);
    links.push({ targetDocumentId: link.dataset.targetId, targetBlockId: link.dataset.targetBlockId, targetText, start: Math.max(0, start), end: Math.max(0, start) + targetText.length });
  });
  return { ...fallback, text, html: sanitizeHtml(clean.innerHTML), links };
}

function scheduleDocumentSave(_delay = 0) {
  enqueueDocumentSave();
}

function saveDocument() {
  enqueueDocumentSave();
}

function renderReference(reference: ReferenceInstance, inSidebar = false) {
  const card = document.createElement("section");
  const collapsed = !inSidebar && reference.mode === "collapsed";
  card.className = `reference-card ${collapsed ? "collapsed is-collapsed" : "is-expanded"} ${inSidebar ? "sidebar" : ""}`;
  card.dataset.referenceId = reference.id;
  if (!inSidebar) {
    const summary = document.createElement("div");
    summary.className = "reference-card-summary";
    summary.innerHTML = `<button type="button" class="reference-expand" aria-expanded="${!collapsed}" aria-label="${collapsed ? "展开" : "收起"}" title="${collapsed ? "展开引用正文" : "折叠引用正文"}">${collapsed ? "▸" : "▾"}</button><button type="button" class="reference-title" data-target-id="${escapeText(reference.targetDocumentId)}" data-reference-id="${escapeText(reference.id)}">${escapeText(reference.targetTitle)}</button>`;
    const title = summary.querySelector<HTMLElement>(".reference-title")!;
    if (reference.targetBlockId) title.dataset.targetBlockId = reference.targetBlockId;
    const toggle = summary.querySelector<HTMLButtonElement>(".reference-expand")!;
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setReferenceMode(reference, collapsed ? "inline" : "collapsed");
    });
    card.append(summary);
  }
  const overrideMap = new Map(reference.overrides.map((item) => [item.targetBlockId, item]));
  const hidden = new Set(reference.hiddenBlockIds);
  const isHidden = (block: Block) => {
    let candidate: Block | undefined = block;
    const visited = new Set<string>();
    while (candidate && !visited.has(candidate.id)) {
      if (hidden.has(candidate.id)) return true;
      visited.add(candidate.id);
      candidate = reference.blocks.find((item) => item.id === candidate?.parentId);
    }
    return false;
  };
  reference.blocks.filter((block) => !isHidden(block)).forEach((source) => {
    const override = overrideMap.get(source.id);
    const content = override?.patch.content ?? source.content;
    const properties = override?.patch.properties ?? source.properties;
    const row = document.createElement("div");
    row.className = "reference-row";
    row.dataset.referenceInstanceId = reference.id;
    row.dataset.targetBlockId = source.id;
    row.dataset.parentId = source.parentId ?? "";
    row.dataset.position = source.position;
    row.dataset.scopeType = source.scopeType ?? "canonical";
    row.dataset.type = source.type;
    row.style.setProperty("--depth", String(blockDepth(source, reference.blocks)));
    const local = source.scopeType === "reference_instance";
    row.innerHTML = `<div class="reference-meta"><span>${local ? "本地新增" : override ? "已覆写" : "继承"}</span><button class="add-child" title="在引用中添加子块">+</button>${local ? "" : '<button class="reset" title="恢复源内容与位置">↺</button>'}<button class="hide" title="${local ? "删除本地块" : "在此引用中隐藏"}">×</button></div><button type="button" class="grip" aria-label="块菜单">⠿</button><div class="block-text ${source.type === "heading" ? "heading" : ""}" contenteditable="true"></div>`;
    const editable = row.querySelector<HTMLElement>(".block-text")!;
    if (override && source.revision > override.baseRevision) row.querySelector(".reference-meta span")!.textContent = "已覆写 · 源内容已更新";
    editable.innerHTML = renderLinkedHtml(content.html || escapeText(content.text));
    editable.style.backgroundColor = properties.background ?? "";
    editable.style.color = properties.textColor ?? "";
    editable.addEventListener("focus", () => activeEditable = editable);
    editable.addEventListener("input", () => local ? scheduleInstanceBlock(row, source) : scheduleOverride(row, source, properties));
    row.querySelector(".add-child")!.addEventListener("click", () => addInstanceBlock(reference, source.id, row));
    row.querySelector(".hide")!.addEventListener("click", () => postAfterFlush(local
      ? { type: "deleteInstanceBlock", referenceInstanceId: reference.id, blockId: source.id }
      : { type: "hideReferenceBlock", referenceInstanceId: reference.id, targetBlockId: source.id }));
    row.querySelector(".reset")?.addEventListener("click", () => postAfterFlush({ type: "resetOverride", referenceInstanceId: reference.id, targetBlockId: source.id }));
    card.append(row);
  });
  const footer = document.createElement("footer");
  footer.className = "reference-footer";
  footer.innerHTML = `<button class="add-root">+ 引用内新增</button>${hidden.size ? `<span>已隐藏 ${hidden.size} 块</span><button class="restore-hidden">恢复隐藏块</button>` : ""}`;
  footer.querySelector(".add-root")!.addEventListener("click", () => addInstanceBlock(reference, null));
  footer.querySelector(".restore-hidden")?.addEventListener("click", () => {
    const documentId = state?.note.id;
    runAfterSaveDrain(() => reference.hiddenBlockIds.forEach((id) => post({ type: "resetOverride", referenceInstanceId: reference.id, targetBlockId: id }, documentId)));
  });
  card.append(footer);
  return card;
}

function blockFromReferenceRow(row: HTMLElement, fallback: Block): Block {
  const editable = row.querySelector<HTMLElement>(".block-text")!;
  return {
    ...fallback,
    parentId: row.dataset.parentId || null,
    position: row.dataset.position || fallback.position,
    content: editableContent(editable, fallback.content),
    properties: { ...fallback.properties, background: editable.style.backgroundColor || undefined, textColor: editable.style.color || undefined }
  };
}

function scheduleInstanceBlock(row: HTMLElement, source: Block) {
  const documentId = state?.note.id;
  const referenceInstanceId = row.dataset.referenceInstanceId!;
  const block = blockFromReferenceRow(row, source);
  saveStatus.textContent = "正在保存引用专属块...";
  post({ type: "saveInstanceBlock", referenceInstanceId, block }, documentId);

}

function addInstanceBlock(reference: ReferenceInstance, parentId: string | null, afterRow?: HTMLElement) {
  const documentId = state?.note.id;
  const block = createBlock("paragraph", parentId);
  block.scopeType = "reference_instance";
  const rows = [...(afterRow?.closest(".reference-card") ?? blockSurface).querySelectorAll<HTMLElement>(".reference-row")];
  block.position = String((rows.length + 1) * 1000).padStart(8, "0");
  runAfterSaveDrain(() => {
    void post({ type: "saveInstanceBlock", referenceInstanceId: reference.id, block }, documentId)
      .then(() => { if (!commandFailure) return post({ type: "reloadDocument", }, documentId); });
  });
}

function scheduleOverride(row: HTMLElement, source: Block, originalProperties: BlockProperties) {
  const documentId = state?.note.id;
  const referenceInstanceId = row.dataset.referenceInstanceId!;
  const targetBlockId = row.dataset.targetBlockId!;
  const editable = row.querySelector<HTMLElement>(".block-text")!;
  const content = editableContent(editable, source.content);
  const properties = { ...originalProperties, background: editable.style.backgroundColor || undefined, textColor: editable.style.color || undefined };
  saveStatus.textContent = "正在保存局部覆写...";
  post({ type: "saveOverride", referenceInstanceId, targetBlockId, content, properties }, documentId);

}

function renderRelations() {
  if (!state) return;
  referenceSidebarPanel.innerHTML = "";
  const sidebarReferences = state.references.filter((reference) => reference.mode === "sidebar");
  referenceSidebarSection.hidden = sidebarReferences.length === 0;
  sidebarReferences.forEach((reference) => referenceSidebarPanel.append(renderReference(reference, true)));
  if (sidebarLink) void showLinkSidebar(sidebarLink);
  backlinksPanel.innerHTML = "";
  state.backlinks.forEach((link) => {
    const button = document.createElement("button");
    button.className = "relation-item";
    button.innerHTML = `<strong>${escapeText(link.sourceTitle)}</strong><span>${escapeText(link.excerpt)}</span>`;
    button.addEventListener("click", () => postAfterFlush({ type: "openDocument", documentId: link.sourceDocumentId }));
    backlinksPanel.append(button);
  });
  if (!state.backlinks.length) backlinksPanel.innerHTML = `<div class="empty">暂无反向链接</div>`;

  noticesPanel.innerHTML = "";
  state.overrideNotices.forEach((notice) => {
    const button = document.createElement("button");
    button.className = `relation-item ${notice.sourceUpdated ? "warning" : ""}`;
    const labels = { content_style: "引用位置修改了内容或样式", hide: "引用位置隐藏了此块", move: "引用位置调整了层级或顺序", insert: "引用位置增加了专属块" };
    button.innerHTML = `<strong>${escapeText(notice.hostTitle)}</strong><span>${notice.sourceUpdated ? "源内容更新后仍保留覆写" : labels[notice.kind]}</span>`;
    button.addEventListener("click", () => postAfterFlush({ type: "openDocument", documentId: notice.hostDocumentId }));
    noticesPanel.append(button);
  });
  if (!state.overrideNotices.length) noticesPanel.innerHTML = `<div class="empty">暂无外部覆写</div>`;
}

function showMenu(anchor: HTMLElement, actions: Array<{ label: string; run: () => void }>) {
  document.querySelector(".block-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "block-menu";
  menu.setAttribute("role", "menu");
  actions.forEach((action) => {
    const button = document.createElement("button");
    button.textContent = action.label;
    button.addEventListener("click", () => { menu.remove(); action.run(); });
    menu.append(button);
  });
  const host = anchor.closest<HTMLElement>(".block-shell") ?? anchor.parentElement ?? document.body;
  host.append(menu);
  menu.style.display = "block";
  const close = (event: MouseEvent) => { if (!menu.contains(event.target as Node) && event.target !== anchor) { menu.remove(); document.removeEventListener("mousedown", close); } };
  window.setTimeout(() => document.addEventListener("mousedown", close), 0);
}

function showOwnBlockMenu(anchor: HTMLElement, block: Block) {
  activeEditable = anchor.closest("[data-own-block]")?.querySelector<HTMLElement>(".block-text") ?? activeEditable;
  showMenu(anchor, [
    { label: "复制块链接", run: () => navigator.clipboard?.writeText(`[[${state?.note.title}^${block.id}]]`) },
    { label: "插入块链接", run: () => insertTarget(block.id, state?.note.id, block.content.text || "块") },
    { label: "嵌入为实时引用", run: () => createReferenceForTarget(state?.note.id, block.id) }
  ]);
}

function showReferenceMenu(anchor: HTMLElement, _block: Block | undefined, reference?: ReferenceInstance) {
  if (!reference) return;
  showMenu(anchor, [
    { label: "仅标题链接", run: () => setReferenceMode(reference, "link") },
    { label: "正文直显", run: () => setReferenceMode(reference, "inline") },
    { label: "折叠卡片", run: () => setReferenceMode(reference, "collapsed") },
    { label: "右侧分栏", run: () => setReferenceMode(reference, "sidebar") },
    { label: "打开源文档", run: () => postAfterFlush({ type: "openDocument", documentId: reference.targetDocumentId }) },
    { label: "断开引用", run: () => postAfterFlush({ type: "removeReference", referenceInstanceId: reference.id }) },
    { label: "恢复全部继承内容", run: () => postAfterFlush({ type: "resetReference", referenceInstanceId: reference.id }) }
  ]);
}

function setReferenceMode(reference: ReferenceInstance, mode: ReferenceMode) {
  postAfterFlush({ type: "setReferenceMode", referenceInstanceId: reference.id, mode });
}

function createReferenceForTarget(targetDocumentId?: string, targetBlockId?: string, mode: ReferenceMode = "inline", anchor?: HTMLElement) {
  if (!state || !targetDocumentId) return;
  const documentId = state.note.id;
  const block = createBlock("reference");
  block.content.targetDocumentId = targetDocumentId;
  if (anchor?.closest(".reference-row")) { showError("请在普通正文块中嵌入引用；引用内的链接可在分栏预览。"); return; }
  const ownerShell = (anchor ?? activeEditable)?.closest<HTMLElement>("[data-own-block]");
  if (anchor?.isConnected && ownerShell) {
    const marker = document.createElement("span");
    marker.dataset.referenceHostId = block.id;
    marker.contentEditable = "false";
    anchor.replaceWith(marker);
    block.parentId = ownerShell.dataset.id!;
  } else block.parentId = ownerShell?.dataset.parentId || null;
  state.blocks = readOwnBlocks();
  const index = state.blocks.findIndex(item => item.id === ownerShell?.dataset.id);
  state.blocks.splice(index < 0 ? state.blocks.length : index + 1, 0, block);
  sidebarLink = null;
  render(state);
  saveDocument();
  runAfterSaveDrain(() => {
    void post({ type: "createReference", hostBlockId: block.id, targetDocumentId, targetBlockId }, documentId).then(() => {
      if (mode === "inline") return;
      const reference = state?.references.find((item) => item.hostBlockId === block.id);
      if (reference) return post({ type: "setReferenceMode", referenceInstanceId: reference.id, mode }, documentId);
    });
  });
}

function insertTarget(targetBlockId?: string, targetDocumentId?: string, label = "链接") {
  if (!activeEditable || !targetDocumentId) return;
  activeEditable.focus();
  const escapedLabel = escapeText(label);
  const html = `<span contenteditable="false" class="wiki-link" data-target-id="${escapeText(targetDocumentId)}"${targetBlockId ? ` data-target-block-id="${escapeText(targetBlockId)}"` : ""} data-target-title="${escapedLabel}">${escapedLabel}</span>`;
  document.execCommand("insertHTML", false, html);
  activeEditable.closest(".reference-row") ? activeEditable.dispatchEvent(new Event("input", { bubbles: true })) : scheduleDocumentSave(0);
  const links = [...activeEditable.querySelectorAll<HTMLElement>(".wiki-link")];
  const inserted = links[links.length - 1];
  if (inserted) showLinkChoiceMenu(inserted, { id: targetDocumentId, blockId: targetBlockId, label });
}

function suggestionItems(query: string) {
  if (!state) return [];
  const normalized = query.toLocaleLowerCase();
  const items: Array<{ id: string; blockId?: string; title: string; meta: string; label: string }> = [];
  state.documents.filter((item) => item.id !== state?.note.id).forEach((item) => {
    if (!normalized || item.title.toLocaleLowerCase().includes(normalized)) items.push({ id: item.id, title: item.title, meta: "文档", label: item.title });
  });
  state.blocks.filter((block) => block.content.text.toLocaleLowerCase().includes(normalized)).slice(0, 8).forEach((block) => {
    items.push({ id: state!.note.id, blockId: block.id, title: block.content.text.slice(0, 48) || "未命名块", meta: "当前文档中的块", label: block.content.text.slice(0, 48) || "块" });
  });
  return items.slice(0, 12);
}

function updateInlineLinkSuggestions(editable: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !selection.anchorNode) return hideInlineLinkSuggestions();
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(editable);
  try { beforeRange.setEnd(selection.anchorNode, selection.anchorOffset); } catch { return hideInlineLinkSuggestions(); }
  const before = beforeRange.toString();
  const marker = before.lastIndexOf("[[");
  if (marker < 0 || before.slice(marker).includes("]]")) return hideInlineLinkSuggestions();
  activeEditable = editable;
  linkMenuItems = suggestionItems(before.slice(marker + 2));
  linkMenuIndex = 0;
  renderInlineLinkSuggestions(editable);
}

function renderInlineLinkSuggestions(editable: HTMLElement) {
  linkSuggestions.innerHTML = "";
  if (!linkMenuItems.length) {
    const empty = document.createElement("div");
    empty.className = "link-suggestion-empty";
    empty.textContent = "没有匹配的文档或块";
    linkSuggestions.append(empty);
  }
  linkMenuItems.forEach((item, index) => {
    const button = document.createElement("button");
    button.className = `link-suggestion ${index === linkMenuIndex ? "active" : ""}`;
    button.innerHTML = `<strong>${escapeText(item.title)}</strong><span>${escapeText(item.meta)}</span>`;
    button.addEventListener("mousedown", (event) => { event.preventDefault(); insertInlineSuggestion(item); });
    linkSuggestions.append(button);
  });
  const editor = editable.closest<HTMLElement>(".editor") ?? document.body;
  if (linkSuggestions.parentElement !== editor) editor.append(linkSuggestions);
  linkSuggestions.hidden = false;
  const editorRect = editor.getBoundingClientRect();
  const editRect = editable.getBoundingClientRect();
  linkSuggestions.style.left = `${Math.max(36, editRect.left - editorRect.left)}px`;
  linkSuggestions.style.top = `${editRect.bottom - editorRect.top + 8}px`;
}

function hideInlineLinkSuggestions() { linkSuggestions.hidden = true; linkMenuItems = []; }

function insertInlineSuggestion(item: { id: string; blockId?: string; label: string }) {
  const selection = window.getSelection();
  if (!activeEditable || !selection?.rangeCount || !selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(activeEditable);
  try { beforeRange.setEnd(selection.anchorNode!, selection.anchorOffset); } catch { return; }
  const marker = beforeRange.toString().lastIndexOf("[[");
  if (marker < 0) return;
  const textWalker = document.createTreeWalker(activeEditable, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let current: Node | null;
  while ((current = textWalker.nextNode())) {
    const length = current.textContent?.length ?? 0;
    if (offset + length >= marker) {
      startNode = current as Text;
      startOffset = Math.max(0, marker - offset);
      break;
    }
    offset += length;
  }
  if (!startNode) return;
  range.setStart(startNode, Math.min(startOffset, startNode.length));
  range.deleteContents();
  const link = document.createElement("span");
  link.className = "wiki-link";
  link.contentEditable = "false";
  link.dataset.targetId = item.id;
  if (item.blockId) link.dataset.targetBlockId = item.blockId;
  link.dataset.targetTitle = item.label;
  link.textContent = item.label;
  range.insertNode(link);
  range.setStartAfter(link);
  range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range);
  hideInlineLinkSuggestions();
  activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
  showLinkChoiceMenu(link, item);
}

function showLinkChoiceMenu(anchor: HTMLElement, item: { id: string; blockId?: string; label: string }) {
  document.querySelector(".link-mode-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "link-mode-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `<strong>已插入双链</strong><span>选择后续操作</span>`;
  const choices: Array<{ label: string; mode?: ReferenceMode }> = [
    { label: "保持普通双链" },
    { label: "嵌入实时引用 · 正文直显", mode: "inline" },
    { label: "嵌入实时引用 · 折叠卡片", mode: "collapsed" },
    { label: "嵌入实时引用 · 右侧分栏", mode: "sidebar" }
  ];
  choices.forEach((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice.label;
    button.addEventListener("click", () => {
      menu.remove();
      if (choice.mode) createReferenceForTarget(item.id, item.blockId, choice.mode, anchor);
    });
    menu.append(button);
  });
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(window.innerWidth - 260, Math.max(8, rect.left))}px`;
  menu.style.top = `${Math.min(window.innerHeight - 210, rect.bottom + 8)}px`;
  const close = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node) && event.target !== anchor) {
      menu.remove(); document.removeEventListener("mousedown", close);
    }
  };
  window.setTimeout(() => document.addEventListener("mousedown", close), 0);
}

function handleInlineLinkKeys(event: KeyboardEvent) {
  if (linkSuggestions.hidden) return;
  if (event.key === "Escape") { event.preventDefault(); hideInlineLinkSuggestions(); return; }
  if (!linkMenuItems.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    linkMenuIndex = (linkMenuIndex + (event.key === "ArrowDown" ? 1 : -1) + linkMenuItems.length) % linkMenuItems.length;
    renderInlineLinkSuggestions(activeEditable!);
  } else if (event.key === "Enter") {
    event.preventDefault();
    insertInlineSuggestion(linkMenuItems[linkMenuIndex]);
  }
}

function addBlock(type: BlockType) {
  if (!state) return;
  const block = createBlock(type);
  state.blocks.push(block);
  renderOwnBlock(block);
  blockSurface.lastElementChild?.querySelector<HTMLElement>(".block-text")?.focus();
  scheduleDocumentSave(0);
}

function applyFormat(command: "bold" | "italic" | "hiliteColor") {
  if (!activeEditable) return;
  activeEditable.focus();
  document.execCommand(command, false, command === "hiliteColor" ? "#fff2a8" : undefined);
  activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyColor(property: "color" | "backgroundColor", value: string) {
  if (!activeEditable) return;
  activeEditable.style[property] = value;
  activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectedOwnBlock() { return selectedReferenceRow() ? null : activeEditable?.closest<HTMLElement>("[data-own-block]") ?? null; }
function selectedReferenceRow() { return activeEditable?.closest<HTMLElement>(".reference-row") ?? null; }

function persistReferenceStructure(row: HTMLElement) {
  if (!state) return;
  const reference = state.references.find((item) => item.id === row.dataset.referenceInstanceId);
  const block = reference?.blocks.find((item) => item.id === row.dataset.targetBlockId);
  if (!reference || !block) return;
  runAfterSaveDrain(() => {
    if (row.dataset.scopeType === "reference_instance") {
      post({ type: "saveInstanceBlock", referenceInstanceId: reference.id, block: blockFromReferenceRow(row, block) });
    } else {
      post({
        type: "moveReferenceBlock", referenceInstanceId: reference.id, targetBlockId: block.id,
        parentBlockId: row.dataset.parentId || null, position: row.dataset.position ?? "00001000"
      });
    }
  });
}

function recalculateReferenceDepths(card: HTMLElement) {
  const rows = [...card.querySelectorAll<HTMLElement>(".reference-row")];
  const depth = (row: HTMLElement, visited = new Set<string>()): number => {
    const parentId = row.dataset.parentId;
    if (!parentId || visited.has(parentId)) return 0;
    visited.add(parentId);
    const parent = rows.find((candidate) => candidate.dataset.targetBlockId === parentId);
    return parent ? Math.min(8, 1 + depth(parent, visited)) : 0;
  };
  rows.forEach((row) => row.style.setProperty("--depth", String(depth(row))));
}

function indent(direction: "in" | "out") {
  const current = selectedOwnBlock();
  if (current) {
    const rows = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")];
    const index = rows.indexOf(current);
    if (direction === "in" && index > 0) current.dataset.parentId = rows[index - 1].dataset.id!;
    if (direction === "out" && current.dataset.parentId) {
      const parent = rows.find((row) => row.dataset.id === current.dataset.parentId);
      current.dataset.parentId = parent?.dataset.parentId ?? "";
    }
    recalculateDepths();
    scheduleDocumentSave(0);
    return;
  }
  const referenceRow = selectedReferenceRow();
  const card = referenceRow?.closest<HTMLElement>(".reference-card");
  if (!referenceRow || !card) return;
  const rows = [...card.querySelectorAll<HTMLElement>(".reference-row")];
  const index = rows.indexOf(referenceRow);
  if (direction === "in" && index > 0) referenceRow.dataset.parentId = rows[index - 1].dataset.targetBlockId!;
  if (direction === "out" && referenceRow.dataset.parentId) {
    const parent = rows.find((row) => row.dataset.targetBlockId === referenceRow.dataset.parentId);
    referenceRow.dataset.parentId = parent?.dataset.parentId ?? "";
  }
  recalculateReferenceDepths(card);
  persistReferenceStructure(referenceRow);
  saveStatus.textContent = "引用结构已保存";
}

function recalculateDepths() {
  const rows = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")];
  const depth = (row: HTMLElement, visited = new Set<string>()): number => {
    const parentId = row.dataset.parentId;
    if (!parentId || visited.has(parentId)) return 0;
    visited.add(parentId);
    const parent = rows.find((candidate) => candidate.dataset.id === parentId);
    return parent ? Math.min(8, 1 + depth(parent, visited)) : 0;
  };
  rows.forEach((row) => row.style.setProperty("--depth", String(depth(row))));
}

function move(delta: -1 | 1) {
  const current = selectedOwnBlock();
  if (current) {
    const rows = [...blockSurface.querySelectorAll<HTMLElement>("[data-own-block]")];
    const index = rows.indexOf(current);
    const target = rows[index + delta];
    if (!target) return;
    delta < 0 ? target.before(current) : target.after(current);
    scheduleDocumentSave(0);
    return;
  }
  const referenceRow = selectedReferenceRow();
  const card = referenceRow?.closest<HTMLElement>(".reference-card");
  if (!referenceRow || !card) return;
  const rows = [...card.querySelectorAll<HTMLElement>(".reference-row")];
  const index = rows.indexOf(referenceRow);
  const target = rows[index + delta];
  if (!target) return;
  delta < 0 ? target.before(referenceRow) : target.after(referenceRow);
  [...card.querySelectorAll<HTMLElement>(".reference-row")].forEach((row, rowIndex) => {
    const nextPosition = String((rowIndex + 1) * 1000).padStart(8, "0");
    if (row.dataset.position === nextPosition) return;
    row.dataset.position = nextPosition;
    persistReferenceStructure(row);
  });
  saveStatus.textContent = "引用顺序已保存";
}

function escapeText(value: string) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

host.onEvent(event => {
  if (event.kind === "documentChanged" && state?.references.some(reference => reference.targetDocumentId === event.payload.documentId)) void refreshLiveReferences();
  if (event.kind === "documentChanged" && sidebarLink?.documentId === event.payload.documentId && !sidebarLink.referenceId) void showLinkSidebar(sidebarLink);
  if (event.kind === "documentLoaded") render(event.payload.state);
  if (event.kind === "focusBlock") focusBlock(event.payload.blockId);
  if (event.kind === "notification") saveStatus.textContent = event.payload.message;
  if (event.kind === "flush") {
    const requestId = event.payload.requestId;
    void flush().then(() => host.emit({ protocolVersion: 1, kind: "flushResult", payload: { requestId, ok: true } }),
      error => host.emit({ protocolVersion: 1, kind: "flushResult", payload: { requestId, ok: false, error: error.message } }));
  }
});

document.querySelector("#add-paragraph")!.addEventListener("click", () => addBlock("paragraph"));
document.querySelector("#add-heading")!.addEventListener("click", () => addBlock("heading"));
document.querySelector("#add-todo")!.addEventListener("click", () => addBlock("todo"));
document.querySelector("#bold")!.addEventListener("click", () => applyFormat("bold"));
document.querySelector("#italic")!.addEventListener("click", () => applyFormat("italic"));
document.querySelector("#highlight")!.addEventListener("click", () => applyFormat("hiliteColor"));
document.querySelector<HTMLInputElement>("#text-color")!.addEventListener("input", (event) => applyColor("color", (event.target as HTMLInputElement).value));
document.querySelector<HTMLInputElement>("#background-color")!.addEventListener("input", (event) => applyColor("backgroundColor", (event.target as HTMLInputElement).value));
document.querySelector("#indent")!.addEventListener("click", () => indent("in"));
document.querySelector("#outdent")!.addEventListener("click", () => indent("out"));
document.querySelector("#move-up")!.addEventListener("click", () => move(-1));
document.querySelector("#move-down")!.addEventListener("click", () => move(1));
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const grip = target?.closest<HTMLElement>(".grip");
  if (!grip) return;
  event.preventDefault();
  event.stopPropagation();
  const shell = grip.closest<HTMLElement>("[data-own-block]");
  const block = shell?.dataset.id ? state?.blocks.find((item) => item.id === shell.dataset.id) : undefined;
  const instanceId = grip.closest<HTMLElement>(".reference-card")?.dataset.referenceId;
  const reference = instanceId ? state?.references.find(item => item.id === instanceId) : shell?.dataset.id ? state?.references.find((item) => item.hostBlockId === shell.dataset.id) : undefined;
  if (reference) showReferenceMenu(grip, block, reference);
  else if (block) showOwnBlockMenu(grip, block);
}, true);
document.addEventListener("input", (event) => {
  const editable = (event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text[contenteditable='true']");
  if (editable) updateInlineLinkSuggestions(editable);
}, true);
document.addEventListener("keydown", (event) => {
  if (event.altKey && !event.ctrlKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) post({ type: event.key === "ArrowLeft" ? "navigateBack" : "navigateForward" });
    return;
  }
  const editable = (event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text[contenteditable='true']");
  if (editable && !linkSuggestions.hidden) handleInlineLinkKeys(event);
}, true);
titleInput.addEventListener("input", () => scheduleDocumentSave());
document.querySelectorAll<HTMLButtonElement>(".icon-tools button").forEach((button) => button.addEventListener("mousedown", (event) => event.preventDefault()));

void host.request("ready", {}).catch(showError);
return { flush, showError, retry: () => { saveFailure = null; commandFailure = null; enqueueDocumentSave(); }, load: render };
}
