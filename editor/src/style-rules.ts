import type { StyleSheet } from "../../protocol/types";

export function cleanCss(css: string): string {
  return (css || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]*;?/gi, "").replace(/url\s*\([^)]*\)/gi, "").replace(/expression\s*\([^)]*\)/gi, "").replace(/javascript\s*:/gi, "");
}

function findCssBlockEnd(css: string, open: number): number {
  let depth = 1;
  let quote = "";
  for (let index = open + 1; index < css.length; index++) {
    const char = css[index];
    if (quote) {
      if (char === "\\" ) index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return css.length - 1;
}

function splitCssSelectors(value: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let parens = 0;
  let brackets = 0;
  let quote = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") quote = char;
    else if (char === "(") parens++;
    else if (char === ")") parens = Math.max(0, parens - 1);
    else if (char === "[") brackets++;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "," && parens === 0 && brackets === 0) {
      if (value.slice(start, index).trim()) selectors.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (value.slice(start).trim()) selectors.push(value.slice(start).trim());
  return selectors;
}

export function scopeCss(css: string, root: string): string {
  const source = cleanCss(css);
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("{", cursor);
    if (open < 0) { output += source.slice(cursor); break; }
    const close = findCssBlockEnd(source, open);
    const prelude = source.slice(cursor, open);
    const body = source.slice(open + 1, close);
    const trimmed = prelude.trim();
    if (trimmed.startsWith("@")) {
      // Media/supports/container/layer blocks contain ordinary selectors and need
      // recursive scoping. Keyframes and declaration at-rules must remain untouched.
      const nested = /^@(media|supports|container|layer|document|scope)\b/i.test(trimmed);
      output += prelude + "{" + (nested ? scopeCss(body, root) : body) + "}";
    } else {
      const scoped = splitCssSelectors(prelude).map(selector => `${root} ${selector}`).join(", ");
      output += (prelude.match(/^\s*/)?.[0] ?? "") + scoped + "{" + body + "}";
    }
    cursor = Math.min(source.length, close + 1);
  }
  return output;
}

function firstCssSelector(css: string): string | null {
  const source = cleanCss(css);
  const match = source.match(/(?:^|})\s*([^@{}][^{}]*)\{/);
  return match ? splitCssSelectors(match[1])[0] ?? null : null;
}

export function stylePreviewElement(style: StyleSheet): HTMLElement {
  const selector = firstCssSelector(style.css) ?? ".callout";
  const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0]?.toLowerCase();
  const allowedTags = new Set(["p", "span", "div", "strong", "em", "h1", "h2", "h3", "blockquote", "code", "pre", "li"]);
  const sample = document.createElement(tag && allowedTags.has(tag) ? tag : "span");
  for (const token of selector.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) sample.classList.add(token[1]);
  const attributeClass = selector.match(/\[class(?:~|\^|\*|\$|\|)?=\s*["']?([A-Za-z_][A-Za-z0-9_-]*)/i)?.[1];
  if (attributeClass) sample.classList.add(attributeClass);
  const id = selector.match(/#([A-Za-z_][A-Za-z0-9_-]*)/)?.[1];
  if (id) sample.id = id;
  sample.textContent = style.title || "样式预览";
  return sample;
}
