import type { Block, BlockComment, EditorState } from "../../protocol/types";
import { blockModules } from "./block-modules";

export type CommentActions = {
  add(blockId: string, content: string): void;
  edit(blockId: string, commentId: string, content: string): void;
  delete(blockId: string, commentId: string): void;
};

export function commentsFor(block: Block): BlockComment[] {
  return Array.isArray(block.properties.comments) ? block.properties.comments : [];
}

export function activeCommentsFor(block: Block) {
  return commentsFor(block).filter(comment => !comment.deletedAt);
}

export function blockCommentSummary(block: Block, state?: EditorState) {
  const definition = blockModules.require(block.type);
  const summary = definition.commentSummary?.(block, state)
    ?? definition.label(block).replace(/\s+/g, " ").trim();
  if (summary) return summary.length > 54 ? `${summary.slice(0, 54)}…` : summary;
  return definition.typeLabel || "空白块";
}

function formatCommentTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function appendCommentComposer(container: HTMLElement, block: Block, commands: CommentActions, state?: EditorState, autofocus = false) {
  const composer = document.createElement("div");
  composer.className = "comment-composer";
  const input = document.createElement("textarea");
  input.rows = 3;
  input.placeholder = "写下注释或评论…";
  input.setAttribute("aria-label", `为“${blockCommentSummary(block, state)}”添加注释`);
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "添加注释";
  add.disabled = true;
  input.addEventListener("input", () => { add.disabled = !input.value.trim(); });
  const submit = () => {
    if (!input.value.trim()) return;
    commands.add(block.id, input.value);
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submit(); }
  });
  composer.append(input, add);
  container.append(composer);
  if (autofocus) window.setTimeout(() => input.focus(), 0);
}

export function appendCommentThread(container: HTMLElement, block: Block, includeComposer: boolean, commands: CommentActions, state?: EditorState) {
  const active = activeCommentsFor(block);
  if (!active.length) {
    const empty = document.createElement("p");
    empty.className = "comment-empty";
    empty.textContent = "这个块当前没有注释。";
    container.append(empty);
  }
  for (const comment of active) {
    const item = document.createElement("article");
    item.className = "comment-item";
    item.dataset.commentId = comment.id;
    const content = document.createElement("p");
    content.className = "comment-content";
    content.textContent = comment.content;
    const meta = document.createElement("div");
    meta.className = "comment-meta";
    const time = document.createElement("time");
    time.dateTime = comment.updatedAt;
    time.textContent = formatCommentTime(comment.updatedAt);
    const actions = document.createElement("span");
    actions.className = "comment-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => {
      const editor = document.createElement("div");
      editor.className = "comment-inline-editor";
      const textarea = document.createElement("textarea");
      textarea.value = comment.content;
      textarea.rows = 3;
      textarea.setAttribute("aria-label", "编辑注释");
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "保存";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消";
      save.onclick = () => commands.edit(block.id, comment.id, textarea.value);
      cancel.onclick = () => editor.replaceWith(content);
      editor.append(textarea, save, cancel);
      content.replaceWith(editor);
      textarea.focus();
      textarea.select();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除";
    remove.addEventListener("click", () => commands.delete(block.id, comment.id));
    actions.append(edit, remove);
    meta.append(time, actions);
    item.append(content, meta);
    container.append(item);
  }

  const history = commentsFor(block).flatMap(comment => (comment.history?.length ? comment.history : [{
    id: `legacy-${comment.id}`,
    action: "created" as const,
    content: comment.content,
    timestamp: comment.createdAt
  }])).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  if (history.length) {
    const details = document.createElement("details");
    details.className = "comment-history";
    const summary = document.createElement("summary");
    summary.textContent = `注释历史 · ${history.length}`;
    details.append(summary);
    const labels = { created: "新增", edited: "编辑", deleted: "删除" } as const;
    for (const entry of history) {
      const row = document.createElement("div");
      row.className = `comment-history-entry action-${entry.action}`;
      const head = document.createElement("span");
      head.textContent = `${labels[entry.action]} · ${formatCommentTime(entry.timestamp)}`;
      const text = document.createElement("p");
      text.textContent = entry.content;
      row.append(head, text);
      details.append(row);
    }
    container.append(details);
  }
  if (includeComposer) appendCommentComposer(container, block, commands, state);
}
