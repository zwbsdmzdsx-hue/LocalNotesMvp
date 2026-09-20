import type { DatabaseValue, FormulaError } from "../../protocol/types";

export type ExpressionResult = DatabaseValue | FormulaError;
type Token = { kind: "number" | "string" | "identifier" | "operator" | "paren" | "comma"; value: string };
type Node =
  | { kind: "literal"; value: DatabaseValue }
  | { kind: "property"; key: string }
  | { kind: "unary"; op: string; value: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

const error = (code: FormulaError["code"], message: string): FormulaError => ({ code, message });
const isError = (value: unknown): value is FormulaError => typeof value === "object" && value !== null && "code" in value;

function tokenize(source: string): Token[] | FormulaError {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index++; continue; }
    if (/[0-9]/.test(char) || char === "." && /[0-9]/.test(source[index + 1] ?? "")) {
      const start = index++;
      while (/[0-9.]/.test(source[index] ?? "")) index++;
      tokens.push({ kind: "number", value: source.slice(start, index) });
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char; let value = ""; index++;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\" && index + 1 < source.length) value += source[++index];
        else value += source[index];
        index++;
      }
      if (source[index] !== quote) return error("syntax", "字符串缺少结束引号");
      index++; tokens.push({ kind: "string", value }); continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (/[A-Za-z0-9_]/.test(source[index] ?? "")) index++;
      tokens.push({ kind: "identifier", value: source.slice(start, index) }); continue;
    }
    const pair = source.slice(index, index + 2);
    if ([">=", "<=", "!=", "=="].includes(pair)) { tokens.push({ kind: "operator", value: pair }); index += 2; continue; }
    if ("+-*/><=".includes(char)) { tokens.push({ kind: "operator", value: char }); index++; continue; }
    if (char === "(" || char === ")") { tokens.push({ kind: "paren", value: char }); index++; continue; }
    if (char === ",") { tokens.push({ kind: "comma", value: char }); index++; continue; }
    return error("syntax", "不支持的公式字符：" + char);
  }
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}
  private peek() { return this.tokens[this.index]; }
  private take() { return this.tokens[this.index++]; }
  private accept(value: string) { if (this.peek()?.value === value) { this.index++; return true; } return false; }
  parse(): Node | FormulaError {
    const value = this.compare();
    if (isError(value)) return value;
    if (this.peek()) return error("syntax", "公式中存在多余内容：" + this.peek()!.value);
    return value;
  }
  private compare(): Node | FormulaError {
    let left = this.add(); if (isError(left)) return left;
    while (["=", "==", "!=", ">", ">=", "<", "<="].includes(this.peek()?.value ?? "")) {
      const op = this.take()!.value; const right = this.add(); if (isError(right)) return right;
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  private add(): Node | FormulaError {
    let left = this.multiply(); if (isError(left)) return left;
    while (["+", "-"].includes(this.peek()?.value ?? "")) {
      const op = this.take()!.value; const right = this.multiply(); if (isError(right)) return right;
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  private multiply(): Node | FormulaError {
    let left = this.unary(); if (isError(left)) return left;
    while (["*", "/"].includes(this.peek()?.value ?? "")) {
      const op = this.take()!.value; const right = this.unary(); if (isError(right)) return right;
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  private unary(): Node | FormulaError {
    if (this.accept("-")) { const value = this.unary(); return isError(value) ? value : { kind: "unary", op: "-", value }; }
    return this.primary();
  }
  private primary(): Node | FormulaError {
    const token = this.take();
    if (!token) return error("syntax", "公式缺少值");
    if (token.kind === "number") return { kind: "literal", value: Number(token.value) };
    if (token.kind === "string") return { kind: "literal", value: token.value };
    if (token.kind === "identifier") {
      if (token.value === "true" || token.value === "false") return { kind: "literal", value: token.value === "true" };
      if (token.value === "null") return { kind: "literal", value: null };
      if (this.accept("(")) {
        const args: Node[] = [];
        if (!this.accept(")")) {
          while (true) {
            const value = this.compare(); if (isError(value)) return value; args.push(value);
            if (this.accept(")")) break;
            if (!this.accept(",")) return error("syntax", "函数参数之间需要逗号");
          }
        }
        return { kind: "call", name: token.value, args };
      }
      return { kind: "property", key: token.value };
    }
    if (token.value === "(") {
      const value = this.compare();
      if (isError(value) || !this.accept(")")) return isError(value) ? value : error("syntax", "括号不匹配");
      return value;
    }
    return error("syntax", "无法解析：" + token.value);
  }
}

function toNumber(value: DatabaseValue): number | FormulaError {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return error("type", "需要数字值");
}
function asText(value: DatabaseValue) { return value === null ? "" : Array.isArray(value) ? value.join(", ") : typeof value === "object" ? value.name || value.url : String(value); }

function evaluate(node: Node, values: Record<string, DatabaseValue>): ExpressionResult {
  if (node.kind === "literal") return node.value;
  if (node.kind === "property") {
    if (!(node.key in values)) return error("unknown_property", "未知属性：" + node.key);
    return values[node.key];
  }
  if (node.kind === "unary") {
    const value = evaluate(node.value, values); if (isError(value)) return value;
    const number = toNumber(value); return isError(number) ? number : -number;
  }
  if (node.kind === "binary") {
    const left = evaluate(node.left, values); if (isError(left)) return left;
    const right = evaluate(node.right, values); if (isError(right)) return right;
    if (["=", "==", "!=", ">", ">=", "<", "<="].includes(node.op)) {
      const equal = JSON.stringify(left) === JSON.stringify(right);
      if (node.op === "=" || node.op === "==") return equal;
      if (node.op === "!=") return !equal;
      const a = Number(left); const b = Number(right);
      return node.op === ">" ? a > b : node.op === ">=" ? a >= b : node.op === "<" ? a < b : a <= b;
    }
    const a = toNumber(left); if (isError(a)) return a; const b = toNumber(right); if (isError(b)) return b;
    if (node.op === "/" && b === 0) return error("runtime", "不能除以零");
    return node.op === "+" ? a + b : node.op === "-" ? a - b : node.op === "*" ? a * b : a / b;
  }
  const args: DatabaseValue[] = [];
  for (const arg of node.args) { const value = evaluate(arg, values); if (isError(value)) return value; args.push(value); }
  if (node.name === "prop") {
    if (args.length !== 1) return error("syntax", "prop 需要一个属性名");
    const key = asText(args[0]); return key in values ? values[key] : error("unknown_property", "未知属性：" + key);
  }
  if (node.name === "if") return args.length === 3 ? (args[0] ? args[1] : args[2]) : error("syntax", "if 需要三个参数");
  if (node.name === "concat") return args.map(asText).join("");
  if (node.name === "coalesce") return args.find(value => value !== null && value !== "") ?? null;
  if (node.name === "round") { const value = toNumber(args[0] ?? null); if (isError(value)) return value; const digits = Number(args[1] ?? 0); return Number(value.toFixed(digits)); }
  if (node.name === "today") return new Date().toISOString().slice(0, 10);
  if (node.name === "dateDiff") { const a = Date.parse(asText(args[0] ?? null)); const b = Date.parse(asText(args[1] ?? null)); if (!Number.isFinite(a) || !Number.isFinite(b)) return error("type", "dateDiff 需要日期"); return Math.floor((a - b) / 86400000); }
  return error("syntax", "不支持的函数：" + node.name);
}

export function evaluateFormula(source: string, values: Record<string, DatabaseValue>): ExpressionResult {
  const tokens = tokenize(source); if (isError(tokens)) return tokens;
  const tree = new Parser(tokens).parse(); if (isError(tree)) return tree;
  return evaluate(tree, values);
}
