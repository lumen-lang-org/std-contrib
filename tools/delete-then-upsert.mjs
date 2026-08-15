// delete-then-upsert: a deleteById/deleteWhere on a mapping, followed within a
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
function stripComments(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const WINDOW = 6;
const hits = [];
for (const file of sources(ROOT)) {
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    const del = line.match(/delete(?:ById|Where)\(\s*[\w.]+\s*,\s*(?:[\w.]+\.)?(\w+)\(/);
    if (!del) return;
    for (let j = i + 1; j <= i + WINDOW && j < lines.length; j++) {
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
