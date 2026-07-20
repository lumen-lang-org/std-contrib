// code-index (cidx) — compact codebase symbol index for AI navigation.
//
// Scans source files for top-level declarations and emits a token-lean map:
// one line per file, `path: sym:line, sym:line, ...`. An assistant reads the
// map once (or queries one symbol) instead of grepping whole trees — the same
// idea as aider's repomap / ctags, pattern-based, no parser dependency.
//
// Languages: TypeScript/JavaScript/Lumen (.ts/.js), Zig (.zig), Python (.py),
// Rust (.rs), Go (.go).
//
// Run tests: lumen test packages/code-index/code-index.ts

// --- language detection ---

export function langOf(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".js")) return "ts";
  if (path.endsWith(".zig")) return "zig";
  if (path.endsWith(".py")) return "py";
  if (path.endsWith(".rs")) return "rs";
  if (path.endsWith(".go")) return "go";
  return "";
}

// --- identifier scanning ---

function isIdentChar(c: string): bool {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
}

// The identifier starting at position i (empty when none).
export function identAt(s: string, i: int): string {
  let j = i;
  while (j < s.length && isIdentChar(s.charAt(j))) j = j + 1;
  return s.substring(i, j);
}

// The identifier right after a keyword prefix, or "" when the line does not
// start with that keyword (leading whitespace is the caller's concern).
function afterKeyword(line: string, kw: string): string {
  if (!line.startsWith(kw)) return "";
  return identAt(line, kw.length);
}

// --- per-language top-level declaration matchers ---

// The declared symbol on this line, or "" if it declares nothing top-level.
export function symbolOnLine(line: string, lang: string): string {
  if (lang === "ts") {
    // Only unindented (top-level) declarations; class members stay out.
    if (line.startsWith(" ") || line.startsWith("\t")) return "";
    let l = line;
    if (l.startsWith("export default ")) l = l.substring(15);
    else if (l.startsWith("export ")) l = l.substring(7);
    if (l.startsWith("async ")) l = l.substring(6);
    let n = afterKeyword(l, "function ");
    if (n.length > 0) return n;
    n = afterKeyword(l, "class ");
    if (n.length > 0) return n;
    n = afterKeyword(l, "interface ");
    if (n.length > 0) return n;
    n = afterKeyword(l, "enum ");
    if (n.length > 0) return n;
    n = afterKeyword(l, "type ");
    if (n.length > 0) return n;
    return "";
  }
  if (lang === "zig") {
    const t = line.trimStart();
    let n = afterKeyword(t, "pub fn ");
    if (n.length > 0) return n;
    n = afterKeyword(t, "pub const ");
    if (n.length > 0) return n;
    n = afterKeyword(t, "pub var ");
    if (n.length > 0) return n;
    return "";
  }
  if (lang === "py") {
    // Top-level only: indented defs are methods.
    let n = afterKeyword(line, "def ");
    if (n.length > 0) return n;
    n = afterKeyword(line, "async def ");
    if (n.length > 0) return n;
    n = afterKeyword(line, "class ");
    if (n.length > 0) return n;
    return "";
  }
  if (lang === "rs") {
    const t = line.trimStart();
    let l = t;
    if (l.startsWith("pub ")) l = l.substring(4);
    else return "";
    if (l.startsWith("async ")) l = l.substring(6);
    let n = afterKeyword(l, "fn ");
    if (n.length > 0) return n;
    n = afterKeyword(l, "struct ");
    if (n.length > 0) return n;
    n = afterKeyword(l, "enum ");
    if (n.length > 0) return n;
    n = afterKeyword(l, "trait ");
    if (n.length > 0) return n;
    return "";
  }
  if (lang === "go") {
    let n = afterKeyword(line, "func ");
    if (n.length > 0) return n;
    // Method with receiver: `func (r *T) Name(` — take the name after ')'.
    if (line.startsWith("func (")) {
      const close = line.indexOf(") ");
      if (close > 0) return identAt(line, close + 2);
    }
    n = afterKeyword(line, "type ");
    if (n.length > 0) return n;
    return "";
  }
  return "";
}

// --- whole-source outline ---

// All `name:line` entries for a source text (1-based lines).
export function outlineSource(src: string, lang: string): string[] {
  let out: string[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i = i + 1) {
    const name = symbolOnLine(lines[i], lang);
    if (name.length > 0) out.push(name + ":" + (i + 1));
  }
  return out;
}

// One compact map line for a file: `path: a:12, b:40` ("" when no symbols).
export function formatMapLine(path: string, syms: string[]): string {
  if (syms.length === 0) return "";
  return path + ": " + syms.join(", ");
}

// Entries matching a query — exact symbol match, or prefix when exact finds
// nothing. Input entries are `name:line`; returns `path:line name`.
export function findSymbol(paths: string[], outlines: string[][], query: string): string[] {
  let exact: string[] = [];
  let prefix: string[] = [];
  for (let i = 0; i < paths.length; i = i + 1) {
    for (const entry of outlines[i]) {
      const colon = entry.lastIndexOf(":");
      const name = entry.substring(0, colon);
      const lineNo = entry.substring(colon + 1);
      if (name === query) exact.push(paths[i] + ":" + lineNo + " " + name);
      else if (name.startsWith(query)) prefix.push(paths[i] + ":" + lineNo + " " + name);
    }
  }
  if (exact.length > 0) return exact;
  return prefix;
}

// Directories never worth indexing.
export function skipDir(name: string): bool {
  return name === ".git" || name === "node_modules" || name === ".zig-cache" ||
    name === "zig-out" || name === "target" || name === "dist" || name === ".venv" ||
    name === "__pycache__" || name === "vendor" || name === "build";
}

// --- tests ---

test("ts function and class", () => {
  expect(symbolOnLine("export function greet(name: string): string {", "ts")).toBe("greet");
  expect(symbolOnLine("class Stack<T> {", "ts")).toBe("Stack");
  expect(symbolOnLine("  push(x: T): void {", "ts")).toBe("");
  expect(symbolOnLine("export default function main() {", "ts")).toBe("main");
  expect(symbolOnLine("type Point = { x: number };", "ts")).toBe("Point");
  expect(symbolOnLine("interface Shape {", "ts")).toBe("Shape");
});

test("zig pub declarations", () => {
  expect(symbolOnLine("pub fn exprType(self: *Checker) ?Type {", "zig")).toBe("exprType");
  expect(symbolOnLine("    pub fn method(self: *Self) void {", "zig")).toBe("method");
  expect(symbolOnLine("pub const Checker = struct {", "zig")).toBe("Checker");
  expect(symbolOnLine("fn private() void {", "zig")).toBe("");
});

test("python defs top-level only", () => {
  expect(symbolOnLine("def parse(x):", "py")).toBe("parse");
  expect(symbolOnLine("class Node:", "py")).toBe("Node");
  expect(symbolOnLine("    def method(self):", "py")).toBe("");
});

test("rust pub items", () => {
  expect(symbolOnLine("pub fn run() {", "rs")).toBe("run");
  expect(symbolOnLine("pub struct Config {", "rs")).toBe("Config");
  expect(symbolOnLine("fn private() {}", "rs")).toBe("");
});

test("go funcs and receivers", () => {
  expect(symbolOnLine("func Handle(w http.ResponseWriter) {", "go")).toBe("Handle");
  expect(symbolOnLine("func (s *Server) Start() error {", "go")).toBe("Start");
  expect(symbolOnLine("type Config struct {", "go")).toBe("Config");
});

test("outlineSource collects with line numbers", () => {
  const src = "function a() {}\n\nclass B {}\n";
  const r = outlineSource(src, "ts");
  expect(r.length).toBe(2);
  expect(r[0]).toBe("a:1");
  expect(r[1]).toBe("B:3");
});

test("formatMapLine compact shape", () => {
  expect(formatMapLine("src/x.ts", ["a:1", "B:3"])).toBe("src/x.ts: a:1, B:3");
  expect(formatMapLine("src/y.ts", [])).toBe("");
});

test("findSymbol exact beats prefix", () => {
  const paths = ["a.ts", "b.ts"];
  const outlines = [["run:5", "runner:9"], ["run:2"]];
  const exact = findSymbol(paths, outlines, "run");
  expect(exact.length).toBe(2);
  expect(exact[0]).toBe("a.ts:5 run");
  const pre = findSymbol(paths, outlines, "runn");
  expect(pre.length).toBe(1);
  expect(pre[0]).toBe("a.ts:9 runner");
});

test("langOf and skipDir", () => {
  expect(langOf("src/a.zig")).toBe("zig");
  expect(langOf("README.md")).toBe("");
  expect(skipDir("node_modules")).toBe(true);
  expect(skipDir("src")).toBe(false);
});
