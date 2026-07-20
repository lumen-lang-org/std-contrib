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
  if (path.endsWith(".java")) return "java";
  if (path.endsWith(".c") || path.endsWith(".h")) return "c";
  if (path.endsWith(".cpp") || path.endsWith(".cc") || path.endsWith(".hpp")) return "c";
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
  if (lang === "java") {
    // Types at any indent (after modifiers); methods are class members.
    let l = line.trimStart();
    let changed = true;
    while (changed) {
      changed = false;
      for (const kw of ["public ", "private ", "protected ", "static ", "final ", "abstract ", "sealed "]) {
        if (l.startsWith(kw)) { l = l.substring(kw.length); changed = true; }
      }
    }
    let n = afterKeyword(l, "class ");
    if (n.length > 0) return n;
    n = afterKeyword(l, "interface ");
    if (n.length > 0) return n;
    n = afterKeyword(l, "enum ");
    if (n.length > 0) return n;
    n = afterKeyword(l, "record ");
    if (n.length > 0) return n;
    return "";
  }
  if (lang === "c") {
    // Top-level only. struct/enum/union tags, and function definitions
    // (`ret name(args) {` at column 0, not a call or control keyword).
    if (line.startsWith(" ") || line.startsWith("\t") || line.startsWith("#")) return "";
    let n = afterKeyword(line, "struct ");
    if (n.length > 0) return n;
    n = afterKeyword(line, "enum ");
    if (n.length > 0) return n;
    n = afterKeyword(line, "union ");
    if (n.length > 0) return n;
    n = afterKeyword(line, "class ");
    if (n.length > 0) return n;
    // A function definition: an identifier immediately before the first '(',
    // on a line that opens a body or continues a signature.
    const paren = line.indexOf("(");
    if (paren <= 0) return "";
    const trimmedEnd = line.trimEnd();
    const last = trimmedEnd.charAt(trimmedEnd.length - 1);
    if (last !== "{" && last !== ")" && last !== ",") return "";
    const name = identBeforeParen(line, paren);
    if (name.length === 0 || isMemberKeyword(name) || name === "sizeof") return "";
    return name;
  }
  return "";
}

// The identifier ending immediately before position `paren` (the '(' index).
function identBeforeParen(s: string, paren: int): string {
  let end = paren;
  while (end > 0 && s.charAt(end - 1) === " ") end = end - 1;
  let start = end;
  while (start > 0) {
    const c = s.charAt(start - 1);
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_") start = start - 1;
    else break;
  }
  return s.substring(start, end);
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
      // Match the full name (`Stack.push`) or the unqualified tail (`push`).
      const dot = name.lastIndexOf(".");
      const tail = dot >= 0 ? name.substring(dot + 1) : name;
      if (name === query || tail === query) exact.push(paths[i] + ":" + lineNo + " " + name);
      else if (name.startsWith(query) || tail.startsWith(query)) prefix.push(paths[i] + ":" + lineNo + " " + name);
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

// --- class members (TS) ---

function isMemberKeyword(name: string): bool {
  return name === "if" || name === "for" || name === "while" || name === "switch" ||
    name === "catch" || name === "return" || name === "do" || name === "else" ||
    name === "new" || name === "await" || name === "yield" || name === "constructor" ||
    name === "function" || name === "throw" || name === "typeof";
}

// An indented TypeScript class member (`method(`, `get x()`, `async run(`), or
// "" when the line is not a member declaration. Caller supplies class context.
export function classMemberOnLine(line: string, lang: string): string {
  if (lang !== "ts") return "";
  if (!(line.startsWith(" ") || line.startsWith("\t"))) return "";
  let l = line.trimStart();
  // Strip leading modifiers, in any order.
  let changed = true;
  while (changed) {
    changed = false;
    for (const kw of ["public ", "private ", "protected ", "static ", "async ", "readonly ", "abstract ", "override "]) {
      if (l.startsWith(kw)) { l = l.substring(kw.length); changed = true; }
    }
  }
  // get/set accessors keep their property name.
  if (l.startsWith("get ") || l.startsWith("set ")) l = l.substring(4);
  const name = identAt(l, 0);
  if (name.length === 0 || isMemberKeyword(name)) return "";
  // Must be a call-like member: `name(` or `name<...>(` (generic method).
  const after = l.substring(name.length);
  const t = after.trimStart();
  if (t.startsWith("(") || t.startsWith("<")) return name;
  return "";
}

// Top-level symbols plus TS class members as `Class.member:line`. Class context
// is the most recent top-level `class`/`interface`, cleared when another
// top-level declaration or a column-0 `}` closes it.
export function outlineDeep(src: string, lang: string): string[] {
  let out: string[] = [];
  const lines = src.split("\n");
  let curClass = "";
  for (let i = 0; i < lines.length; i = i + 1) {
    const line = lines[i];
    const top = symbolOnLine(line, lang);
    if (top.length > 0) {
      out.push(top + ":" + (i + 1));
      if (lang === "ts" && (line.indexOf("class ") >= 0 || line.indexOf("interface ") >= 0)) curClass = top;
      else curClass = "";
      continue;
    }
    // A column-0 closing brace ends the current class body.
    if (line.startsWith("}")) { curClass = ""; continue; }
    if (curClass.length > 0) {
      const m = classMemberOnLine(line, lang);
      if (m.length > 0) out.push(curClass + "." + m + ":" + (i + 1));
    }
  }
  return out;
}

// --- references (who calls X) ---

function identCharBefore(s: string, i: int): bool {
  if (i <= 0) return false;
  const c = s.charAt(i - 1);
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
}

// 1-based line numbers where `name` appears as a whole-word call (`name(`),
// excluding its own definition line (defLine, 0 to keep all).
export function refLinesInSource(src: string, name: string, defLine: int): int[] {
  let out: int[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i = i + 1) {
    if (i + 1 === defLine) continue;
    const line = lines[i];
    let from = 0;
    let found = false;
    while (from <= line.length - name.length) {
      const idx = line.indexOf(name, from);
      if (idx < 0) break;
      const end = idx + name.length;
      // Whole word, immediately followed by `(` (allowing a generic `<`).
      const nextOk = end < line.length && (line.charAt(end) === "(" || line.charAt(end) === "<");
      if (!identCharBefore(line, idx) && nextOk) { found = true; break; }
      from = idx + 1;
    }
    if (found) out.push(i + 1);
  }
  return out;
}

// Total whole-word call references to `name` across all sources (importance
// signal, PageRank's cheap cousin).
export function countRefs(srcs: string[], name: string): int {
  let total = 0;
  for (const src of srcs) total = total + refLinesInSource(src, name, 0).length;
  return total;
}

// --- persistent index cache ---
//
// The cache file is one line per source file: `path\tsym:line,sym:line,...`.
// `cidx build` writes it once; `find`/`map` read it back instantly instead of
// re-walking and re-parsing the tree.

// One cache line for a file (""  when it has no symbols).
export function cacheLine(path: string, outline: string[]): string {
  if (outline.length === 0) return "";
  return path + "\t" + outline.join(",");
}

// The path recorded on a cache line.
export function cachePath(line: string): string {
  const tab = line.indexOf("\t");
  return tab < 0 ? line : line.substring(0, tab);
}

// The outline entries recorded on a cache line.
export function cacheOutline(line: string): string[] {
  const tab = line.indexOf("\t");
  if (tab < 0) return [];
  const rest = line.substring(tab + 1);
  if (rest.length === 0) return [];
  return rest.split(",");
}

// --- tests ---

test("cache round-trips path and outline", () => {
  const line = cacheLine("src/x.ts", ["a:1", "B.m:4"]);
  expect(line).toBe("src/x.ts\ta:1,B.m:4");
  expect(cachePath(line)).toBe("src/x.ts");
  const o = cacheOutline(line);
  expect(o.length).toBe(2);
  expect(o[0]).toBe("a:1");
  expect(o[1]).toBe("B.m:4");
});

test("cacheLine empty for no symbols", () => {
  expect(cacheLine("src/x.ts", [])).toBe("");
});

test("classMemberOnLine detects members and skips control flow", () => {
  expect(classMemberOnLine("  push(x: T): void {", "ts")).toBe("push");
  expect(classMemberOnLine("  async fetchAll(): Promise<void> {", "ts")).toBe("fetchAll");
  expect(classMemberOnLine("  get celsius(): number {", "ts")).toBe("celsius");
  expect(classMemberOnLine("  private v: number = 0;", "ts")).toBe("");
  expect(classMemberOnLine("  if (x > 0) {", "ts")).toBe("");
  expect(classMemberOnLine("  for (const y of xs) {", "ts")).toBe("");
  expect(classMemberOnLine("function top() {", "ts")).toBe("");
});

test("outlineDeep includes qualified members", () => {
  const src = "class Stack {\n  push(x: number): void {}\n  pop(): number { return 0; }\n}\nfunction free() {}\n";
  const r = outlineDeep(src, "ts");
  expect(r.length).toBe(4);
  expect(r[0]).toBe("Stack:1");
  expect(r[1]).toBe("Stack.push:2");
  expect(r[2]).toBe("Stack.pop:3");
  expect(r[3]).toBe("free:5");
});

test("refLinesInSource finds whole-word calls only", () => {
  const src = "run();\nmyRun();\nx = run(1) + 2;\nfunction run() {}\n";
  const r = refLinesInSource(src, "run", 4);
  expect(r.length).toBe(2);
  expect(r[0]).toBe(1);
  expect(r[1]).toBe(3);
});

test("countRefs sums across sources", () => {
  const a = "foo();\nfoo();\n";
  const b = "bar(); foo();\n";
  expect(countRefs([a, b], "foo")).toBe(3);
  expect(countRefs([a, b], "bar")).toBe(1);
});

// --- original tests ---

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

test("java types after modifiers", () => {
  expect(symbolOnLine("public final class Widget {", "java")).toBe("Widget");
  expect(symbolOnLine("interface Drawable {", "java")).toBe("Drawable");
  expect(symbolOnLine("public enum Color {", "java")).toBe("Color");
  expect(symbolOnLine("    int x = 0;", "java")).toBe("");
});

test("c functions and tags", () => {
  expect(symbolOnLine("int main(int argc, char **argv) {", "c")).toBe("main");
  expect(symbolOnLine("static void handle_signal(int sig) {", "c")).toBe("handle_signal");
  expect(symbolOnLine("struct Node {", "c")).toBe("Node");
  expect(symbolOnLine("    return foo(1);", "c")).toBe("");
  expect(symbolOnLine("if (x > 0) {", "c")).toBe("");
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
