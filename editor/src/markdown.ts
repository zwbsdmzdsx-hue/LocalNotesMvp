import DOMPurify from "dompurify";
import { marked } from "marked";
import TurndownService from "turndown";
import type { BlockContent } from "../../protocol/types";

const turndown = new TurndownService({ bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "_", strongDelimiter: "**" });

turndown.addRule("reference-anchor", {
  filter: node => node instanceof HTMLElement && node.hasAttribute("data-reference-host-id"),
  replacement: (_content, node) => `![[#^${(node as HTMLElement).dataset.referenceHostId ?? ""}]]`
});

turndown.addRule("wiki-link", {
  filter: node => node instanceof HTMLElement && node.classList.contains("wiki-link"),
  replacement: (content, node) => {
    const element = node as HTMLElement;
    const title = element.dataset.targetTitle ?? element.dataset.title ?? content;
    const target = element.dataset.targetBlockId ? `${title}#^${element.dataset.targetBlockId}` : title;
    return content && content !== title ? `[[${target}|${content}]]` : `[[${target}]]`;
  }
});

// Keep managed CSS classes when rich content is converted back to Markdown.
// Turndown's default span rule intentionally drops attributes, which would
// otherwise make a style applied from the sidebar disappear after saving.
turndown.addRule("managed-class", {
  filter: node => node instanceof HTMLElement && node.classList.length > 0 &&
    !node.classList.contains("wiki-link") && !node.hasAttribute("data-reference-host-id"),
  replacement: (content, node) => {
    const element = node as HTMLElement;
    const classes = [...element.classList].filter(token => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(token));
    if (!classes.length) return content;
    const tag = element.tagName.toLowerCase();
    if (["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"].includes(tag)) {
      return `<${tag} class="${escapeAttribute(classes.join(" "))}>`;
    }
    return `<${tag} class="${escapeAttribute(classes.join(" "))}">${content}</${tag}>`;
  }
});

turndown.addRule("highlight", {
  filter: ["mark"],
  replacement: content => `==${content}==`
});

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function protectWikiSyntax(source: string) {
  return source
    .replace(/==([^=\n]+)==/g, (_match, content: string) => `<mark>${escapeAttribute(content)}</mark>`)
    .replace(/!\[\[#\^([A-Za-z0-9_-]+)\]\]/g, (_match, id: string) =>
      `<span data-reference-host-id="${escapeAttribute(id)}"></span>`)
    .replace(/\[\[([^\]|#]+)(?:#\^([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
      (_match, rawTitle: string, rawBlockId?: string, rawAlias?: string) => {
        const title = rawTitle.trim();
        const label = (rawAlias ?? title).trim();
        const block = rawBlockId?.trim();
        return `<span class="wiki-link" data-target-title="${escapeAttribute(title)}"${block ? ` data-target-block-id="${escapeAttribute(block)}"` : ""}>${escapeAttribute(label)}</span>`;
      });
}

const unsafeCss = /(?:url\s*\(|expression\s*\(|javascript\s*:|@import|behavior\s*:|-moz-binding)/i;

function sanitizeCss(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll<HTMLElement>("[style]").forEach(element => {
    if (unsafeCss.test(element.getAttribute("style") ?? "")) element.removeAttribute("style");
  });
  template.content.querySelectorAll<HTMLStyleElement>("style").forEach(style => {
    if (unsafeCss.test(style.textContent ?? "")) style.remove();
  });
  return template.innerHTML;
}

/**
 * Chinese IMEs often emit full-width Markdown punctuation. Normalize only
 * line-leading block markers, and leave fenced code and ordinary prose intact.
 */
export function normalizeMarkdownSyntax(source: string) {
  let inFence = false;
  return source.split(/\r\n?|\n/).map(line => {
    const fence = /^\s*(```|~~~)/.test(line);
    if (fence) {
      const current = line;
      inFence = !inFence;
      return current;
    }
    if (inFence) return line;
    return line
      .replace(/^(\s*)(＃{1,6})(?=[ \u3000])/, (_match, indent: string, fullWidthMarks: string) => {
        const count = fullWidthMarks.length;
        return `${indent}${"#".repeat(count)}`;
      })
      .replace(/^(\s*)[－﹣](?=[ \u3000])/, "$1-")
      .replace(/^(\s*)[＊＊](?=[ \u3000])/, "$1*");
  }).join("\n");
}

/** Render untrusted Markdown and remove scripts, event handlers and unsafe URLs. */
export function renderMarkdown(source: string) {
  const html = marked.parse(protectWikiSyntax(normalizeMarkdownSyntax(source)), { async: false, breaks: true, gfm: true }) as string;
  const clean = DOMPurify.sanitize(html, {
    ADD_TAGS: ["style"],
    ADD_ATTR: ["data-reference-host-id", "data-target-title", "data-target-id", "data-target-block-id", "class", "id", "style"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "base", "link", "meta"],
    FORBID_ATTR: ["srcdoc"]
  });
  return sanitizeCss(clean);
}

/** Preserve exact Markdown when available and convert legacy rich HTML on first source view. */
export function markdownFromContent(content: BlockContent) {
  if (content.markdown !== undefined) return content.markdown.replace(/\r\n?/g, "\n");
  if (content.html) return markdownFromHtml(content.html);
  return content.text ?? "";
}

export function markdownFromHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const referenceIds: string[] = [];
  template.content.querySelectorAll<HTMLElement>("[data-reference-host-id]").forEach(anchor => {
    const index = referenceIds.push(anchor.dataset.referenceHostId ?? "") - 1;
    anchor.replaceWith(document.createTextNode(`LNMREFERENCETOKEN${index}END`));
  });
  let source = turndown.turndown(template.innerHTML).replace(/\r\n?/g, "\n");
  referenceIds.forEach((id, index) => source = source.split(`LNMREFERENCETOKEN${index}END`).join(`![[#^${id}]]`));
  return source;
}

/**
 * Build the text used by block search/link suggestions. Markdown markers and
 * CSS rules are presentation source, so they must never become searchable
 * block labels.
 */
export function plainTextFromContent(content: BlockContent) {
  const source = content.markdown !== undefined
    ? renderMarkdown(content.markdown)
    : (content.html || content.text || "");
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(source, {
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form"]
  });
  template.content.querySelectorAll("style, script").forEach(node => node.remove());
  template.content.querySelectorAll("pre").forEach(pre => {
    const code = pre.querySelector("code");
    const value = code?.textContent ?? pre.textContent ?? "";
    if (/\b(?:color|background|font|display|position|margin|padding|border|width|height)\s*:/i.test(value) || /[.#@][\w-]+\s*\{/.test(value)) pre.remove();
  });
  return (template.content.textContent ?? "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/(?:^|\s)(?:[.#][A-Za-z_][\w-]*|[A-Za-z][\w-]*(?:\s+[.#]?[\w-]+)*)\s*\{[^{}]*:[^{}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
