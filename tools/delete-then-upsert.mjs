// delete-then-upsert: a deleteById on a mapping, followed within a
// few lines by a persist to the same mapping.
//
// persist is an upsert, so the delete cannot add anything the write after it
// does not already do — and it is the only reason the row can end up gone. It
// lands, the write fails, and a grant that was working, a connector on
// somebody's list, or a task's own row is deleted rather than updated. That
// happened three times in this sweep before anyone looked for the shape:
// markUnrefreshable (ffe4fd4), then writeGrant and enable (4219e03).
//
// Only the plume form is matched, deliberately. The raw-SQL form is not the
// same defect wherever the delete and the write use different keys —
// triggers.ts's rememberAsk clears every ask for a chat and then writes one
// with a fresh id, so its delete is doing real work. A rule that read DELETE
// FROM ... followed by persist would call that a bug.
//
// Proved before its clean result was believed, the way narrow-read.mjs and the
// rest had to be: a planted delete-then-persist is found on adjacent lines and
// five lines apart, the same lines inside a block comment are not, and with
// the plant removed it goes quiet again.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
const ROOT = "/home/ubuntu/projects/std-contrib/packages/agents";
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...sources(full)); continue; }
    if (extname(full) !== ".ts" || name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}
// Comments go, their newlines stay. Removing a block comment outright shifts
// every line after it, and the numbers this prints are meant to be opened —
// the first run of this tool reported a delete on a line holding a return.
function stripComments(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}
// Not a line window. The first version of this used six lines and missed
// storeCredential, where the delete and the persist that replaces it sit eight
// lines apart with the row literal between them — the same defect, found by
// hand the day after this tool called the engine clean. The search now runs to
// the end of the enclosing function, which is what "in front of" actually
// means, and stops there so a delete in one function and a persist in the next
// are not read as a pair.
// The search runs from the delete to the end of the enclosing function, and
// stops early at a return that leaves the branch the delete is in — a delete
// whose branch answers and returns is not standing in front of anything.
// task-tools.ts and workflow-tools.ts both have a delete_x branch that returns
// and a persist further down the same dispatch function; without the return
// rule they read as pairs, and they are not.
function indentOf(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}
function searchEnd(lines, from) {
  const depth = indentOf(lines[from]);
  for (let j = from + 1; j < lines.length; j++) {
    if (/^\}/.test(lines[j])) { return j; }
    const text = lines[j].trim();
    if (text.startsWith("return") && indentOf(lines[j]) <= depth) { return j; }
  }
  return lines.length - 1;
}
const hits = [];
for (const file of sources(ROOT)) {
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    // deleteById only. A deleteWhere clears a set, and the writes after it do
    // not necessarily cover that set — discover.ts's refreshFeed drops every
    // story of a feed and writes new ones under new ids, which is a replace,
    // not a delete standing in front of an upsert to the same row.
    const del = line.match(/deleteById\(\s*[\w.]+\s*,\s*(?:[\w.]+\.)?(\w+)\(/);
    if (!del) return;
    const stop = searchEnd(lines, i);
    for (let j = i + 1; j <= stop; j++) {
      const put = lines[j].match(/persist(?:Many)?\(\s*[\w.]+\s*,\s*(?:[\w.]+\.)?(\w+)\(/);
      if (put && put[1] === del[1]) {
        hits.push({ file: file.replace(ROOT + "/", ""), line: i + 1, mapping: del[1], at: j + 1 });
        break;
      }
    }
  });
}
console.log(`examined ${sources(ROOT).length} file(s) for a delete standing in front of an upsert to the same mapping`);
if (!hits.length) { console.log("\nnone: every persist writes over the row rather than replacing it"); }
else for (const h of hits) console.log(`\n${h.file}:${h.line}  delete on ${h.mapping}(), persist to the same mapping at line ${h.at}`);
