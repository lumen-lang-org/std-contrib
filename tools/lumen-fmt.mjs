// lumen-fmt — the formatting rules Lumen code follows, applied.
//
// Rule 1: a block is never written on one line.
//
//   if (!gone.ok) { return refused(gone.error); }      is not readable
//   one(id: string): string { return this.repo.one(id); }
//
// Both hide a statement inside a line you skim past. The body goes on its own
// line, indented, always — no exception for short ones, because "short enough"
// is the judgement that produced the two above.
//
// The parse is TypeScript's, which reads Lumen source: same syntax, and it
// gives real block boundaries rather than a brace-counting guess that a string
// containing "{" would defeat.
//
//   node tools/lumen-fmt.mjs <paths...>   [--check]
//
// --check reports and exits 1 without writing, for a build to fail on.

import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire("/home/ubuntu/projects/joule-console/");
const ts = require("typescript");

const checkOnly = process.argv.includes("--check");
const roots = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function sources(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    console.error("lumen-fmt: no such path: " + path);
    process.exit(2);
  }
  if (stat.isFile()) return extname(path) === ".ts" ? [path] : [];
  return readdirSync(path).flatMap((e) => sources(join(path, e)));
}

// Every block whose braces sit on one line, innermost first so that rewriting
// one never moves another's offsets.
function oneLiners(file) {
  const found = [];
  const walk = (node) => {
    if (node.kind === ts.SyntaxKind.Block) {
      const open = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
      const close = file.getLineAndCharacterOfPosition(node.end - 1).line;
      if (open === close && node.statements.length > 0) found.push(node);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  // One nesting level per pass. A block containing another one-line block is
  // left for the next pass: rewriting the inner one first invalidates the outer
  // one's offsets, and using them anyway spliced source into the middle of a
  // call — `fs.rmSync(dropped, fal });`. Descending order is only safe among
  // blocks that do not contain one another.
  const inner = found.filter(
    (b) => !found.some((o) => o !== b && o.getStart(file) > b.getStart(file) && o.end <= b.end),
  );
  return inner.sort((a, b) => b.getStart(file) - a.getStart(file));
}

// Rule 2: a record does not sit inline in a line that has run long.
//
//   return listOrdered(this.db, this.full, { where: "enabled = " + this.db.placeholder, args: ["1"], order: keys });
//
// The fields are the argument, and reading them means counting brackets to the
// end of a line nobody can see the end of. Short records stay inline — the rule
// is the length of the line, not the presence of braces.
const WIDTH = 100;

function longRecords(file, text) {
  const lines = text.split("\n");
  const found = [];
  const walk = (node) => {
    if (node.kind === ts.SyntaxKind.ObjectLiteralExpression && node.properties.length > 0) {
      const start = file.getLineAndCharacterOfPosition(node.getStart(file));
      const end = file.getLineAndCharacterOfPosition(node.end - 1);
      if (start.line === end.line && lines[start.line].length > WIDTH) found.push(node);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  // Outermost first, one per pass: expanding a nested record first would leave
  // the enclosing one holding offsets that no longer mean anything.
  const outer = found.filter(
    (b) => !found.some((o) => o !== b && o.getStart(file) < b.getStart(file) && o.end >= b.end),
  );
  return outer.sort((a, b) => b.getStart(file) - a.getStart(file));
}

function spread(path, text) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const records = longRecords(file, text);
  if (records.length === 0) return { text, count: 0 };

  let out = text;
  for (const rec of records) {
    const start = rec.getStart(file);
    const pad = indentOf(out, start);
    const inner = pad + "  ";
    const body = rec.properties
      .map((prop) => inner + out.slice(prop.getStart(file), prop.end).trim() + ",")
      .join("\n");
    out = out.slice(0, start) + "{\n" + body + "\n" + pad + "}" + out.slice(rec.end);
  }
  return { text: out, count: records.length };
}

function indentOf(text, pos) {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const line = text.slice(lineStart, pos);
  return line.slice(0, line.length - line.trimStart().length);
}

function expand(path, text) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const blocks = oneLiners(file);
  if (blocks.length === 0) return { text, count: 0 };

  let out = text;
  for (const block of blocks) {
    const start = block.getStart(file);
    const pad = indentOf(out, start);
    const inner = pad + "  ";
    const body = block.statements
      .map((s) => inner + out.slice(s.getStart(file), s.end).trim())
      .join("\n");
    out = out.slice(0, start) + "{\n" + body + "\n" + pad + "}" + out.slice(block.end);
  }
  return { text: out, count: blocks.length };
}

let total = 0;
const offenders = [];
for (const root of roots) {
  for (const path of sources(root)) {
    let text = readFileSync(path, "utf8");
    let count = 0;
    // Re-read until it settles: expanding an outer block can leave an inner one
    // sitting on a line of its own that was previously nested inside it.
    for (let pass = 0; pass < 12; pass++) {
      const r = expand(path, text);
      if (r.count === 0) break;
      count += r.count;
      text = r.text;
    }
    for (let pass = 0; pass < 12; pass++) {
      const r = spread(path, text);
      if (r.count === 0) break;
      count += r.count;
      text = r.text;
    }
    // A record broken open can leave a block on one line inside it.
    for (let pass = 0; pass < 12; pass++) {
      const r = expand(path, text);
      if (r.count === 0) break;
      count += r.count;
      text = r.text;
    }
    if (count > 0) {
      offenders.push(`${path}: ${count}`);
      total += count;
      if (!checkOnly) writeFileSync(path, text);
    }
  }
}

if (total === 0) {
  console.log("lumen-fmt: every block is on its own lines");
  process.exit(0);
}
console.log(offenders.join("\n"));
console.log(`lumen-fmt: ${total} one-line blocks ${checkOnly ? "found" : "expanded"}`);
process.exit(checkOnly ? 1 : 0);
