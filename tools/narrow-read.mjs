// Find a JSON.parse<T>(...) reading a row whose column set does not exactly
// match T's fields.
//
// Confirmed empirically (see the commit this shipped with): Lumen's
// JSON.parse<T> is strict in both directions. An extra field in the JSON that
// T does not declare throws "the field \"x\" is not one this accepts". A field
// T declares that the JSON does not carry throws "the field \"x\" is required
// and was not sent". Neither is silent — so a mismatch here is not the
// narrow-write class (which corrupts a persisted row without complaint). It is
// a landmine: the code compiles, because Lumen's checker has no idea what
// columns a mapping actually has, and it throws the first time that exact
// code path runs with a real row. A test suite that never happens to hit it
// will not know it is there.
//
// This is exactly the shape that bit routes/prompts earlier in this sweep: a
// type narrower than the row it read, invisible until a second version made
// the code path fire for the first time.

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

const FILES = sources(ROOT);
const ALL = FILES.map(f => [f, readFileSync(f, "utf8")]);

// Same resolution as narrow-write.mjs: field names of every declared type,
// and every mapping's declared columns, followed through the delegation
// chain (mapping -> repository accessor -> entity, or a withoutRelations
// wrapper) since almost every mapping is a forwarder now.
// See narrow-write.mjs's stripComments comment: a JSDoc field comment
// routinely contains "word:" prose, which without stripping reads as a
// phantom field. Confirmed live against EnvRow before this existed.
function stripComments(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const types = new Map();
for (const [, text] of ALL) {
  for (const m of text.matchAll(/(?:export\s+)?type\s+(\w+)\s*=\s*\{([^}]*)\}/g)) {
    const fields = [...stripComments(m[2]).matchAll(/(\w+)\??\s*:/g)].map(f => f[1]);
    if (fields.length) types.set(m[1], fields);
  }
}

const mappings = new Map();
for (const [, text] of ALL) {
  for (const m of text.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*:\s*DbRepository\s*\{([\s\S]*?)\n\}/g)) {
    // Plain columns plus hasOne/hasMany/hasManyThrough relations — a joined
    // read type declares the relation's own field name (e.g. `model:
    // NestedModel`), not a column, and a mapping that has one is not a match
    // failure for not declaring it as a field() column. Confirmed live: this
    // mistook run.ts's ConfigWithModel.model (a real hasOne join) for a bug,
    // three separate call sites, before relations were counted here.
    const fields = [...m[2].matchAll(/field\(\s*"(\w+)"/g)].map(f => f[1]);
    const relations = [...m[2].matchAll(/hasOne(?:Through)?\(\s*\{\s*field:\s*"(\w+)"/g),
                        ...m[2].matchAll(/hasMany(?:Through)?\(\s*\{\s*field:\s*"(\w+)"/g)].map(f => f[1]);
    const all = [...fields, ...relations];
    if (all.length) mappings.set(m[1], all);
  }
  for (const m of text.matchAll(/@entity\("(\w+)"\)\s*export\s+class\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const body = m[3];
    const fields = [];
    for (const c of body.matchAll(/@Column\([^)]*\)\s*\n\s*(\w+)\s*:/g)) fields.push(c[1]);
    if (fields.length) mappings.set(m[2], fields);
  }
}
const forwards = new Map();
for (const [, text] of ALL) {
  for (const m of text.matchAll(/function\s+(\w+)\s*\(\s*\)\s*:\s*DbRepository\s*\{\s*return\s+entity(\w+);/g)) {
    forwards.set(m[1], m[2]);
  }
  for (const m of text.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*:\s*DbRepository\s*\{\s*return\s+(\w+)\(\s*[\w.]*\s*\);/g)) {
    forwards.set(m[1], m[2]);
  }
  for (const m of text.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*:\s*DbRepository\s*\{\s*return\s+\w+\(\s*(\w+)\(\s*\)\s*\)\s*;/g)) {
    forwards.set(m[1], m[2]);
  }
}
for (const name of forwards.keys()) {
  let at = name, hops = 0;
  while (!mappings.has(at) && forwards.has(at) && hops < 6) { at = forwards.get(at); hops++; }
  if (mappings.has(at)) mappings.set(name, mappings.get(at));
}

// A parse-target's own field set: JSON.parse<T> where T is a known type, OR a
// literal inline object type: JSON.parse<{a: string, b: int}>(...).
function parseSites(text) {
  const out = [];
  for (const m of text.matchAll(/JSON\.parse<([^>]+)>\(/g)) {
    out.push({ index: m.index, typeText: m[1].trim() });
  }
  return out;
}

const findings = [];
const skipped = [];
let examined = 0;

for (const [file, text] of ALL) {
  const lines = text.split("\n");
  let offset = 0;
  const lineStarts = [0];
  for (const line of lines) { offset += line.length + 1; lineStarts.push(offset); }
  function lineOf(idx) {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }

  for (const site of parseSites(text)) {
    const ln = lineOf(site.index);
    const lineText = lines[ln - 1];
    // Which mapping this read resolves against. The read call is usually not
    // on the same line as the parse — `let doc = findById(db, xMapping(), id);`
    // then `let row: T = JSON.parse<T>(doc)` next — so first try the parse's
    // own argument (a direct call), then walk back through nearby `let name =`
    // bindings the way dead-guard.mjs does, up to a few lines.
    let call = lineText.match(/(?:findById|listWhere|listOrdered)\(\s*[\w.]+\s*,\s*(?:[\w.]+\.)?(\w+)\(/);
    if (!call) {
      const argMatch = text.slice(site.index).match(/^JSON\.parse<[^>]+>\(\s*(\w+)\s*\)/);
      const argName = argMatch ? argMatch[1] : null;
      if (argName) {
        for (let j = ln - 1; j >= 0 && j > ln - 15; j--) {
          const bind = lines[j - 1].match(new RegExp(`let\\s+${argName}\\s*(?::\\s*\\w+)?\\s*=\\s*(?:findById|listWhere|listOrdered)\\([^,]+,\\s*(?:[\\w.]+\\.)?(\\w+)\\(`));
          if (bind) { call = bind; break; }
        }
      }
    }
    if (!call) { continue; } // not a mapping read this tool can trace — out of scope
    const mapping = call[1];
    const columns = mappings.get(mapping);
    if (!columns) {
      skipped.push(`${file.replace(ROOT + "/", "")}:${ln} (mapping ${mapping} not resolved)`);
      continue;
    }

    let fields;
    if (types.has(site.typeText)) {
      fields = types.get(site.typeText);
    } else if (site.typeText.startsWith("{")) {
      fields = [...site.typeText.matchAll(/(\w+)\??\s*:/g)].map(f => f[1]);
    } else {
      continue; // T[] (array parse), a class, or something this tool cannot resolve
    }
    examined++;

    const missing = columns.filter(c => !fields.includes(c)); // T is narrower — throws "required and was not sent"
    const extra = fields.filter(c => !columns.includes(c));   // T is wider — throws "not one this accepts"
    if (missing.length === 0 && extra.length === 0) continue;

    findings.push({
      file: file.replace(ROOT + "/", ""), line: ln,
      mapping, typeText: site.typeText, missing, extra,
    });
  }
}

console.log(`examined ${examined} JSON.parse<T> read(s) against a resolved mapping; ${skipped.length} skipped`);
for (const s of skipped) console.log(`  skipped: ${s}`);
console.log();

if (findings.length === 0) {
  console.log("no narrow reads: every parsed type matches the columns its mapping returns");
} else {
  console.log(`${findings.length} read(s) whose type does not match its mapping's columns:\n`);
  for (const f of findings) {
    console.log(`${f.file}:${f.line}  JSON.parse<${f.typeText}>(... ${f.mapping}() ...)`);
    if (f.missing.length) console.log(`    type is missing (throws "required and was not sent"): ${f.missing.join(", ")}`);
    if (f.extra.length) console.log(`    type has extra (throws "not one this accepts"): ${f.extra.join(", ")}`);
    console.log();
  }
}
