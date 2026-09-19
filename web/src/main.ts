type HistoryEntry = { id: string; timestamp: number; label: string; kind: string; title: string; preview: string };
type HistoryModel = { documentId: string; entries: HistoryEntry[]; currentId: string; canUndo: boolean; canRedo: boolean };
type BlockType = "paragraph" | "heading" | "todo" | "reference";
type LinkToken = { targetDocumentId?: string; targetBlockId?: string; targetText: string; alias?: string; start: number; end: number };
type BlockContent = { text: string; html: string; checked?: boolean; targetDocumentId?: string; links?: LinkToken[] };
type BlockProperties = { background?: string; textColor?: string };
type Block = { id: string; parentId: string | null; position: string; type: BlockType; content: BlockContent; properties: BlockProperties; revision: number; scopeType?: "canonical" | "reference_instance" };
type Note = { id: string; title: string; isSticky: boolean; clientVersion: number };
type Backlink = { sourceDocumentId: string; sourceTitle: string; sourceBlockId: string; excerpt: string };
type OverrideNotice = { referenceInstanceId: string; targetBlockId: string; sourceUpdated: boolean; hostTitle: string; hostDocumentId: string; excerpt: string; kind: "content_style" | "hide" | "move" | "insert" };
type ReferenceOverride = { targetBlockId: string; patch: { content: BlockContent; properties: BlockProperties }; baseRevision: number };
type ReferenceMode = "inline" | "collapsed" | "sidebar";
type ReferenceInstance = { id: string; hostBlockId: string; targetDocumentId: string; targetTitle: string; mode: ReferenceMode; broken?: boolean; blocks: Block[]; overrides: ReferenceOverride[]; hiddenBlockIds: string[] };
type EditorState = { history?: HistoryModel; note: Note; blocks: Block[]; documents: Array<{ id: string; title: string }>; backlinks: Backlink[]; overrideNotices: OverrideNotice[]; references: ReferenceInstance[] };
type SaveDocumentPayload = { title: string; blocks: Block[] };
type SaveMutation = SaveDocumentPayload & { documentId: string; mutationId: string; historyGroup?: string; clientVersion: number };

const titleInput = document.querySelector<HTMLInputElement>("#title")!;
const blockSurface = document.querySelector<HTMLDivElement>("#blocks")!;
const saveStatus = document.querySelector<HTMLSpanElement>("#status")!;
const linkSuggestions = document.querySelector<HTMLDivElement>("#link-suggestions")!;
const backlinksPanel = document.querySelector<HTMLDivElement>("#backlinks")!;
const noticesPanel = document.querySelector<HTMLDivElement>("#override-notices")!;
let state: EditorState | null = null;
let mutationVersion = 0;
let inFlightMutation: SaveMutation | null = null;
let queuedMutation: SaveMutation | null = null;
let flushRequestId: string | undefined;
let saveFailure: string | null = null;
const saveDrainWaiters: Array<() => void> = [];
let activeEditable: HTMLElement | null = null;
let activeBlock: HTMLElement | null = null;
let linkMenuItems: Array<{ id: string; blockId?: string; title: string; meta: string; label: string }> = [];
let linkMenuIndex = 0;

let editGroup = newId();
let editTarget: EventTarget | null = null;
let editTime = 0;
let historyTail: Promise<void> = Promise.resolve();
let historyBusy = false;
let commandTail: Promise<void> = Promise.resolve();
let commandFailure: string | null = null;
const commandWaiters = new Map<string, { documentId: string; resolve(state: EditorState): void; reject(error: Error): void }>();
const referenceCommands = new Set(["create-reference", "set-reference-mode", "remove-reference", "reset-reference", "save-override", "save-instance-block", "move-reference-block", "delete-instance-block", "hide-reference-block", "reset-override"]);
function sendCommand(payload: object, owner: string): Promise<EditorState> {
  const requestId = newId();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { commandWaiters.delete(requestId); reject(new Error("操作超时，请重新载入确认结果")); }, 10000);
    commandWaiters.set(requestId, { documentId: owner, resolve: next => { clearTimeout(timer); resolve(next); }, reject: error => { clearTimeout(timer); reject(error); } });
    bridgePost({ type: "editor-command", requestId, ...payload }, owner);
  });
}
function post(message: object, sourceDocumentId = state?.note.id) {
  const payload = message as { type: string; [key: string]: unknown };
  if (referenceCommands.has(payload.type) && sourceDocumentId) {
    commandTail = commandTail.then(async () => {
      const { type, ...args } = payload;
      const next = await sendCommand({ operation: type, ...args }, sourceDocumentId);
      commandFailure = null;
      if (state?.note.id === sourceDocumentId) {
        if (type === "save-override" || type === "save-instance-block" && document.querySelector(`[data-id="${CSS.escape((args.block as Block).id)}"]`)) { state.references = next.references; state.history = next.history; publishHistory(); }
        else render(next);
      }
      saveStatus.textContent = "已保存到本地数据库";
    }).catch(error => { commandFailure = error.message; window.localNotesError?.(error.message); });
    return;
  }
  // Reference commands already return their authoritative state.
  if (payload.type === "reload-state") { void commandTail.then(() => bridgePost(message, sourceDocumentId)); return; }
  bridgePost(message, sourceDocumentId);
}
function bridgePost(message: object, sourceDocumentId = state?.note.id) {
  const serialized = JSON.stringify({ sourceDocumentId, ...message });
  const bridge = window.chrome?.webview;
  const legacy = window.external as unknown as { postMessage?(value: string): void; sendMessage?(value: string): void } | undefined;
  if (bridge) bridge.postMessage(serialized);
  else if (legacy?.postMessage) legacy.postMessage(serialized);
  else if (legacy?.sendMessage) legacy.sendMessage(serialized);
  else saveStatus.textContent = "桌面桥接不可用";
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
    type: "save-transaction",
    documentId: mutation.documentId,
    mutationId: mutation.mutationId,
    clientVersion: mutation.clientVersion,
    title: mutation.title,
    blocks: mutation.blocks,
    historyGroup: mutation.historyGroup
  }, mutation.documentId);
}

function finishSaveDrain() {
  if (inFlightMutation || queuedMutation || !saveDrainWaiters.length) return;
  const waiters = saveDrainWaiters.splice(0);
  waiters.forEach((action) => action());
}

function enqueueDocumentSave() {
  if (!state) return;
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
    historyGroup: editGroup,
    clientVersion,
    title: titleInput.value.trim() || "未命名笔记",
    blocks: readOwnBlocks()
  };
  state.blocks = mutation.blocks;
  queuedMutation = mutation;
  saveStatus.textContent = "正在保存...";
  pumpSaveQueue();
}

function handleSaveAck(message: { mutationId: string; documentId: string; clientVersion: number; history?: HistoryModel }) {
  if (!inFlightMutation || inFlightMutation.mutationId !== message.mutationId) return;
  if (inFlightMutation.documentId !== message.documentId) return;
  if (state?.note.id === message.documentId) state.note.clientVersion = message.clientVersion;
  if (state?.note.id === message.documentId && message.history) { state.history = message.history; publishHistory(); }
  saveFailure = null;
  inFlightMutation = null;
  saveStatus.textContent = "已保存到本地数据库";
  pumpSaveQueue();
  finishSaveDrain();
}

function handleSaveNack(message: { mutationId: string; error: string }) {
  if (!inFlightMutation || inFlightMutation.mutationId !== message.mutationId) return;
  const error = message.error || "本地数据库拒绝了这次保存";
  inFlightMutation = null;
  queuedMutation = null;
  mutationVersion = state?.note.clientVersion ?? 0;
  saveFailure = error;
  saveStatus.textContent = `保存失败：${error}`;
  window.localNotesError?.(error);
  const requestId = flushRequestId;
  flushRequestId = undefined;
  saveDrainWaiters.splice(0).forEach(resolve => resolve());
  if (requestId) post({ type: "editor-flush-failed", requestId, error });
}

function runAfterSaveDrain(action: () => void) {
  if (saveFailure) return;
  saveDrainWaiters.push(action);
  pumpSaveQueue();
}

function postAfterFlush(message: object) {
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
  const allowed = new Set(["B", "STRONG", "I", "EM", "MARK", "BR", "SPAN"]);
  [...template.content.querySelectorAll("*")].forEach((element) => {
    if (!allowed.has(element.tagName)) element.replaceWith(...element.childNodes);
    else [...element.attributes].forEach((attribute) => {
      const allowedLinkAttribute = ["data-target-id", "data-target-block-id", "data-target-title"].includes(attribute.name);
      if (attribute.name !== "style" && !allowedLinkAttribute || attribute.name === "style" && !/^(background-color|color):/i.test(attribute.value)) element.removeAttribute(attribute.name);
    });
  });
  return template.innerHTML;
}

function renderLinkedHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = sanitizeHtml(html);
  template.content.querySelectorAll<HTMLElement>("[data-target-id]").forEach((link) => link.className = "wiki-link");
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

function openWikiLink(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest<HTMLElement>(".wiki-link");
  if (!link || !state) return;
  const target = state.documents.find((document) => document.id === link.dataset.targetId) ??
    state.documents.find((document) => document.title.toLocaleLowerCase() === link.dataset.title?.toLocaleLowerCase());
  if (target) postAfterFlush({ type: "open-document", documentId: target.id, blockId: link.dataset.targetBlockId });
}

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
  if (state?.note.id !== next.note.id) { editGroup = newId(); commandFailure = null; }
  state = next;
  publishHistory();
  mutationVersion = Math.max(mutationVersion, next.note.clientVersion ?? 0);
  titleInput.value = next.note.title;
  blockSurface.innerHTML = "";
  (next.blocks.length ? next.blocks : [createBlock()]).forEach((block) => renderOwnBlock(block));
  renderRelations();
  saveStatus.textContent = "已同步本地数据库";
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
    shell.innerHTML = `<div class="reference-heading"><button type="button" class="grip" aria-label="块菜单">⠿</button><span>实时引用</span><strong>${escapeText(reference?.targetTitle ?? "未绑定")}</strong><span class="reference-state">${reference?.broken ? "引用失效" : reference?.mode ?? "inline"}</span></div>`;
    if (reference) shell.append(renderReference(reference));
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
  editable.addEventListener("input", () => scheduleDocumentSave());
  editable.addEventListener("keydown", handleBlockKeydown);
  editable.addEventListener("click", openWikiLink);
  row.querySelector("input")?.addEventListener("change", () => scheduleDocumentSave(0));
  row.querySelector(".delete-block")?.addEventListener("click", () => {
    const shell = row.closest<HTMLElement>("[data-own-block]");
    if (shell) {
      blockSurface.querySelectorAll<HTMLElement>("[data-own-block]").forEach(child => {
        if (child.dataset.parentId === shell.dataset.id && !shell.contains(child))
          child.dataset.parentId = shell.dataset.parentId ?? "";
      });
      shell.remove();
      recalculateDepths();
    }
    if (!blockSurface.querySelector("[data-own-block]")) addBlock("paragraph");
    scheduleDocumentSave(0);
  });
  return row;
}

function handleBlockKeydown(event: KeyboardEvent) {
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
  const text = editable.innerText;
  const links: LinkToken[] = [];
  editable.querySelectorAll<HTMLElement>(".wiki-link").forEach((link) => {
    const targetText = link.textContent ?? "";
    const start = text.indexOf(targetText);
    links.push({ targetDocumentId: link.dataset.targetId, targetBlockId: link.dataset.targetBlockId, targetText, start: Math.max(0, start), end: Math.max(0, start) + targetText.length });
  });
  return { ...fallback, text, html: sanitizeHtml(editable.innerHTML), links };
}

function scheduleDocumentSave(structural?: number) {
  if (structural !== undefined) editGroup = newId();
  enqueueDocumentSave();
}

function saveDocument() {
  editGroup = newId();
  enqueueDocumentSave();
}

function renderReference(reference: ReferenceInstance) {
  const card = document.createElement("section");
  card.className = `reference-card ${reference.mode === "collapsed" ? "collapsed" : ""} ${reference.mode === "sidebar" ? "sidebar" : ""}`;
  card.dataset.referenceId = reference.id;
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
    editable.innerHTML = renderLinkedHtml(content.html || escapeText(content.text));
    editable.style.backgroundColor = properties.background ?? "";
    editable.style.color = properties.textColor ?? "";
    editable.addEventListener("focus", () => activeEditable = editable);
    editable.addEventListener("click", openWikiLink);
    editable.addEventListener("input", () => local ? scheduleInstanceBlock(row, source) : scheduleOverride(row, source, properties));
    row.querySelector(".add-child")!.addEventListener("click", () => addInstanceBlock(reference, source.id, row));
    row.querySelector(".hide")!.addEventListener("click", () => postAfterFlush(local
      ? { type: "delete-instance-block", referenceInstanceId: reference.id, blockId: source.id }
      : { type: "hide-reference-block", referenceInstanceId: reference.id, targetBlockId: source.id }));
    row.querySelector(".reset")?.addEventListener("click", () => postAfterFlush({ type: "reset-override", referenceInstanceId: reference.id, targetBlockId: source.id }));
    card.append(row);
  });
  const footer = document.createElement("footer");
  footer.className = "reference-footer";
  footer.innerHTML = `<button class="add-root">+ 引用内新增</button>${hidden.size ? `<span>已隐藏 ${hidden.size} 块</span><button class="restore-hidden">恢复隐藏块</button>` : ""}`;
  footer.querySelector(".add-root")!.addEventListener("click", () => addInstanceBlock(reference, null));
  footer.querySelector(".restore-hidden")?.addEventListener("click", () => {
    const documentId = state?.note.id;
    runAfterSaveDrain(() => reference.hiddenBlockIds.forEach((id) => post({ type: "reset-override", referenceInstanceId: reference.id, targetBlockId: id }, documentId)));
  });
  card.append(footer);
  if (reference.mode === "collapsed") card.addEventListener("click", () => card.classList.remove("collapsed"), { once: true });
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
  post({ type: "save-instance-block", referenceInstanceId, block, historyGroup: editGroup }, documentId);
  saveStatus.textContent = "正在保存引用专属块...";
}

function addInstanceBlock(reference: ReferenceInstance, parentId: string | null, afterRow?: HTMLElement) {
  const documentId = state?.note.id;
  const block = createBlock("paragraph", parentId);
  block.scopeType = "reference_instance";
  const rows = [...(afterRow?.closest(".reference-card") ?? blockSurface).querySelectorAll<HTMLElement>(".reference-row")];
  block.position = String((rows.length + 1) * 1000).padStart(8, "0");
  runAfterSaveDrain(() => {
    post({ type: "save-instance-block", referenceInstanceId: reference.id, block }, documentId);
    saveStatus.textContent = "正在新增引用专属块...";

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
  post({ type: "save-override", referenceInstanceId, targetBlockId, content, properties, historyGroup: editGroup }, documentId);
  saveStatus.textContent = "正在保存局部覆写...";
}

function renderRelations() {
  if (!state) return;
  backlinksPanel.innerHTML = "";
  state.backlinks.forEach((link) => {
    const button = document.createElement("button");
    button.className = "relation-item";
    button.innerHTML = `<strong>${escapeText(link.sourceTitle)}</strong><span>${escapeText(link.excerpt)}</span>`;
    button.addEventListener("click", () => postAfterFlush({ type: "open-document", documentId: link.sourceDocumentId }));
    backlinksPanel.append(button);
  });
  if (!state.backlinks.length) backlinksPanel.innerHTML = `<div class="empty">暂无反向链接</div>`;

  noticesPanel.innerHTML = "";
  state.overrideNotices.forEach((notice) => {
    const button = document.createElement("button");
    button.className = `relation-item ${notice.sourceUpdated ? "warning" : ""}`;
    const labels = { content_style: "引用位置修改了内容或样式", hide: "引用位置隐藏了此块", move: "引用位置调整了层级或顺序", insert: "引用位置增加了专属块" };
    button.innerHTML = `<strong>${escapeText(notice.hostTitle)}</strong><span>${notice.sourceUpdated ? "源内容更新后仍保留覆写" : labels[notice.kind]}</span>`;
    button.addEventListener("click", () => postAfterFlush({ type: "open-document", documentId: notice.hostDocumentId }));
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
  showMenu(anchor, [
    { label: "复制块链接", run: () => navigator.clipboard?.writeText(`[[${state?.note.title}^${block.id}]]`) },
    { label: "插入块链接", run: () => insertTarget(block.id, state?.note.id, block.content.text || "块") },
    { label: "嵌入为实时引用", run: () => createReferenceForTarget(state?.note.id, block.id) }
  ]);
}

function showReferenceMenu(anchor: HTMLElement, _block: Block | undefined, reference?: ReferenceInstance) {
  if (!reference) return;
  showMenu(anchor, [
    { label: "正文直显", run: () => setReferenceMode(reference, "inline") },
    { label: "折叠卡片", run: () => setReferenceMode(reference, "collapsed") },
    { label: "右侧分栏", run: () => setReferenceMode(reference, "sidebar") },
    { label: "打开源文档", run: () => postAfterFlush({ type: "open-document", documentId: reference.targetDocumentId }) },
    { label: "断开引用", run: () => postAfterFlush({ type: "remove-reference", referenceInstanceId: reference.id }) },
    { label: "恢复全部继承内容", run: () => postAfterFlush({ type: "reset-reference", referenceInstanceId: reference.id }) }
  ]);
}

function setReferenceMode(reference: ReferenceInstance, mode: ReferenceMode) {
  reference.mode = mode;
  render(state!);
  postAfterFlush({ type: "set-reference-mode", referenceInstanceId: reference.id, mode });
}

function createReferenceForTarget(targetDocumentId?: string, targetBlockId?: string) {
  if (!state || !targetDocumentId) return;
  const documentId = state.note.id;
  const block = createBlock("reference");
  block.content.targetDocumentId = targetDocumentId;
  state.blocks.push(block);
  render(state);
  saveDocument();
  runAfterSaveDrain(() => post({ type: "create-reference", hostBlockId: block.id, targetDocumentId, targetBlockId }, documentId));
}

function insertTarget(targetBlockId?: string, targetDocumentId?: string, label = "链接") {
  if (!activeEditable || !targetDocumentId) return;
  activeEditable.focus();
  const escapedLabel = escapeText(label);
  const html = `<span class="wiki-link" data-target-id="${escapeText(targetDocumentId)}"${targetBlockId ? ` data-target-block-id="${escapeText(targetBlockId)}"` : ""} data-target-title="${escapedLabel}">${targetBlockId ? `[[${escapedLabel}^${escapeText(targetBlockId)}]]` : `[[${escapedLabel}]]`}</span>`;
  document.execCommand("insertHTML", false, html);
  activeEditable.closest(".reference-row") ? activeEditable.dispatchEvent(new Event("input", { bubbles: true })) : scheduleDocumentSave(0);
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
  const label = item.blockId ? `${item.label}^${item.blockId}` : item.label;
  const link = document.createElement("span");
  link.className = "wiki-link";
  link.dataset.targetId = item.id;
  if (item.blockId) link.dataset.targetBlockId = item.blockId;
  link.dataset.targetTitle = escapeText(item.label);
  link.textContent = `[[${label}]]`;
  range.insertNode(link);
  range.collapse(false);
  selection.removeAllRanges(); selection.addRange(range);
  hideInlineLinkSuggestions();
  activeEditable.dispatchEvent(new Event("input", { bubbles: true }));
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

function selectedOwnBlock() { return activeEditable?.closest<HTMLElement>("[data-own-block]") ?? null; }
function selectedReferenceRow() { return activeEditable?.closest<HTMLElement>(".reference-row") ?? null; }

function persistReferenceStructure(row: HTMLElement) {
  if (!state) return;
  const reference = state.references.find((item) => item.id === row.dataset.referenceInstanceId);
  const block = reference?.blocks.find((item) => item.id === row.dataset.targetBlockId);
  if (!reference || !block) return;
  runAfterSaveDrain(() => {
    if (row.dataset.scopeType === "reference_instance") {
      post({ type: "save-instance-block", referenceInstanceId: reference.id, block: blockFromReferenceRow(row, block) });
    } else {
      post({
        type: "move-reference-block", referenceInstanceId: reference.id, targetBlockId: block.id,
        parentBlockId: row.dataset.parentId || null, position: row.dataset.position
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
  saveStatus.textContent = "正在保存引用结构...";
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
  saveStatus.textContent = "正在保存引用顺序...";
}

function escapeText(value: string) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

window.localNotesError = (message: string) => saveStatus.textContent = `保存失败：${message}`;
window.localNotesSaved = (documentId: string) => {
  if (state?.note.id === documentId) saveStatus.textContent = "已保存到本地数据库";
};
async function drainEdits() {
  if (saveFailure) throw new Error(saveFailure);
  await new Promise<void>(resolve => { saveDrainWaiters.push(resolve); pumpSaveQueue(); });
  await commandTail;
  if (saveFailure || commandFailure) throw new Error(saveFailure || commandFailure!);
}
window.localNotesFlush = (requestId?: string) => {
  void (async () => {
    await historyTail;
    await drainEdits();
    post({ type: "editor-flush-complete", requestId });
  })().catch(error => post({ type: "editor-flush-failed", requestId, error: error.message }));
};
window.localNotesRunAcceptanceEdit = (marker: string) => {
  window.setTimeout(() => {
    const editable = document.querySelector<HTMLElement>('[data-own-block] .block-text');
    if (!editable) return;
    editable.focus();
    editable.append(document.createTextNode(` ${marker}`));
    editable.dispatchEvent(new Event("input", { bubbles: true }));
  }, 500);
};
window.addEventListener("pagehide", () => window.localNotesFlush?.());
window.addEventListener("beforeunload", () => window.localNotesFlush?.());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") window.localNotesFlush?.();
});
window.addEventListener("message", (event: MessageEvent<string>) => {
  const message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
  if (message.type === "command-ack" || message.type === "command-nack") {
    const waiter = commandWaiters.get(message.requestId);
    if (waiter && waiter.documentId === message.documentId) {
      commandWaiters.delete(message.requestId);
      if (message.type === "command-ack") waiter.resolve(message.state);
      else waiter.reject(new Error(message.error || "操作失败"));
    }
  }
  if (message.type === "load-state") render(message.state as EditorState);
  if (message.type === "focus-block" && typeof message.blockId === "string") focusBlock(message.blockId);
  if (message.type === "save-ack") handleSaveAck(message);
  if (message.type === "save-nack") handleSaveNack(message);
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
document.addEventListener("mousedown", (event) => {
  const target = event.target as Node | null;
  if (target && !linkSuggestions.contains(target) && !(target as HTMLElement).closest?.(".block-text")) hideInlineLinkSuggestions();
});
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const grip = target?.closest<HTMLElement>(".grip");
  if (!grip) return;
  event.preventDefault();
  event.stopPropagation();
  const shell = grip.closest<HTMLElement>("[data-own-block]");
  const block = shell?.dataset.id ? state?.blocks.find((item) => item.id === shell.dataset.id) : undefined;
  const reference = shell?.dataset.id ? state?.references.find((item) => item.hostBlockId === shell.dataset.id) : undefined;
  if (reference) showReferenceMenu(grip, block, reference);
  else if (block) showOwnBlockMenu(grip, block);
}, true);
document.addEventListener("input", (event) => {
  const input = event as InputEvent;
  if (event.target !== editTarget || Date.now() - editTime > 900 || input.inputType && !["insertText", "deleteContentBackward", "deleteContentForward", "insertCompositionText", "insertFromComposition"].includes(input.inputType)) editGroup = newId();
  editTarget = event.target; editTime = Date.now();
  const editable = (event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text[contenteditable='true']");
  if (editable) updateInlineLinkSuggestions(editable);
}, true);
document.addEventListener("beforeinput", event => {
  const target = event.target as HTMLElement;
  if (!(event as InputEvent).isComposing && (target === titleInput ? titleInput.selectionStart !== titleInput.selectionEnd : !getSelection()?.isCollapsed)) editGroup = newId();
}, true);
document.addEventListener("pointerdown", () => { editGroup = newId(); }, true);
document.addEventListener("compositionstart", () => { editGroup = newId(); }, true);
document.addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) editGroup = newId();
  const target = event.target as HTMLElement;
  if ((target.matches("input, textarea") && target !== titleInput) || target.closest("#history-panel")) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing && ["z", "y"].includes(event.key.toLowerCase())) {
    event.preventDefault(); event.stopPropagation();
    void runHistory(event.key.toLowerCase() === "y" || event.shiftKey ? "history-redo" : "history-undo"); return;
  }
  if (event.altKey && !event.ctrlKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) post({ type: event.key === "ArrowLeft" ? "navigate-back" : "navigate-forward" });
    return;
  }
  const editable = (event.target as HTMLElement | null)?.closest<HTMLElement>(".block-text[contenteditable='true']");
  if (editable && !linkSuggestions.hidden) handleInlineLinkKeys(event);
}, true);
titleInput.addEventListener("input", () => scheduleDocumentSave());
document.querySelectorAll<HTMLButtonElement>(".icon-tools button").forEach((button) => button.addEventListener("mousedown", (event) => event.preventDefault()));

function runHistory(operation: string, entryId?: string) {
  const owner = state?.note.id;
  historyTail = historyTail.then(async () => {
    if (!owner || state?.note.id !== owner) return;
    await drainEdits();
    if (operation === "history-undo" && !state.history?.canUndo || operation === "history-redo" && !state.history?.canRedo) return;
    historyBusy = true;
    const focused = document.activeElement as HTMLElement | null;
    const titleSelection = focused === titleInput ? [titleInput.selectionStart, titleInput.selectionEnd] : null;
    const selection = getSelection();
    const offsets = focused?.classList.contains("block-text") && selection?.rangeCount ? (() => {
      const range = selection.getRangeAt(0); const prefix = range.cloneRange(); prefix.selectNodeContents(focused); prefix.setEnd(range.startContainer, range.startOffset);
      return [prefix.toString().length, prefix.toString().length + range.toString().length];
    })() : null;
    const blockId = focused?.closest<HTMLElement>("[data-own-block]")?.dataset.id;
    document.querySelectorAll<HTMLElement>(".editor, .toolbar, .relations, .sidebar-right").forEach(el => el.inert = true);
    publishHistory();
    try {
      const next = await sendCommand({ operation, entryId, expectedVersion: state.note.clientVersion }, owner);
      render(next); mutationVersion = next.note.clientVersion; editGroup = newId();
    } finally {
      historyBusy = false;
      document.querySelectorAll<HTMLElement>(".editor, .toolbar, .relations, .sidebar-right").forEach(el => el.inert = false);
      if (titleSelection) { titleInput.focus(); titleInput.setSelectionRange(titleSelection[0], titleSelection[1]); }
      else if (blockId) {
        const editable = document.querySelector<HTMLElement>(`[data-id="${CSS.escape(blockId)}"] .block-text`);
        if (editable) {
          editable.focus(); const range = document.createRange(); range.selectNodeContents(editable); range.collapse(false);
          const point = (offset: number): [Node, number] => {
            const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT); let node = walker.nextNode();
            while (node) { const length = node.textContent?.length ?? 0; if (offset <= length) return [node, offset]; offset -= length; node = walker.nextNode(); }
            return [editable, editable.childNodes.length];
          };
          if (offsets) { range.setStart(...point(offsets[0])); range.setEnd(...point(offsets[1])); }
          const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        }
      }
      publishHistory();
    }
  }).catch(error => window.localNotesError?.(error.message));
  return historyTail;
}
let selectedHistoryId = "";
function publishHistory() {
  const model = state?.history;
  document.querySelector<HTMLButtonElement>("#undo")!.disabled = historyBusy || !model?.canUndo;
  document.querySelector<HTMLButtonElement>("#redo")!.disabled = historyBusy || !model?.canRedo;
  const panel = document.querySelector<HTMLElement>("#history-panel")!;
  panel.replaceChildren();
  const heading = document.createElement("h2"); heading.textContent = "历史记录"; panel.append(heading);
  const intro = document.createElement("p"); intro.className = "history-intro"; intro.textContent = "最近 80 个版本 · 保存在本地数据库"; panel.append(intro);
  if (!model?.entries.length) { const empty = document.createElement("p"); empty.textContent = "编辑后自动记录版本"; panel.append(empty); return; }
  for (const entry of [...model.entries].reverse()) {
    const button = document.createElement("button"); button.className = "history-entry" + (entry.id === model.currentId ? " current" : "");
    button.textContent = `${entry.label} · ${new Date(entry.timestamp).toLocaleString()}${entry.id === model.currentId ? " · 当前" : ""}`;
    button.onclick = () => { selectedHistoryId = entry.id; publishHistory(); }; panel.append(button);
  }
  const selected = model.entries.find(e => e.id === selectedHistoryId) ?? model.entries.find(e => e.id === model.currentId)!;
  const preview = document.createElement("section"); preview.className = "history-preview";
  const title = document.createElement("strong"); title.textContent = selected.title;
  const text = document.createElement("pre"); text.textContent = selected.preview || "（空白正文）";
  const restore = document.createElement("button"); restore.textContent = "恢复此版本"; restore.disabled = historyBusy || selected.id === model.currentId;
  restore.onclick = () => void runHistory("history-restore", selected.id);
  preview.append(title, text, restore); panel.append(preview);
}
document.querySelector("#undo")!.addEventListener("click", () => void runHistory("history-undo"));
document.querySelector("#redo")!.addEventListener("click", () => void runHistory("history-redo"));
document.querySelector("#history")!.addEventListener("click", () => { const panel = document.querySelector<HTMLElement>("#history-panel")!; panel.hidden = !panel.hidden; publishHistory(); });
