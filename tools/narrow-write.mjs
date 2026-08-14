// Find a write that serialises a type narrower than the mapping it writes into.
//
// plume's persist takes a JSON document and writes the columns its mapping
// declares. If the document is missing one of them, that column is written from
// nothing rather than left alone — so a row edited through a type that has
// fallen behind its table loses whatever the type forgot. The failure is silent
// and it is delayed: it shows up as a column that quietly empties on the next
// edit, long after the type and the mapping drifted apart.
//
// This compares the field names of the type being stringified against the field
// names the mapping declares, for every persist(...) in the package. It reports
// only the difference; whether a missing column matters is a judgement, and a
// column deliberately left out of a mapping (threads.cancel_asked, written by
// its own statement) will not appear here at all, because persist never touches
// what the mapping does not name.

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

// A JSDoc comment on a field routinely contains prose like "answers to on the
// wire: 16 hex characters" — which the field regex below, run against the raw
// body, would read as a field named "wire". Confirmed live: it was reading
// phantom fields "wire" and "s" out of environments.ts's EnvRow before this
// strip existed, which silently changes what a mismatch check downstream can
// even see. Every type body is stripped of comments before it is scanned, in
// both this tool and its narrow-read.mjs sibling — checked identically, kept
// in sync by hand since sharing a module was not worth the coupling.
function stripComments(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Field names of every `export type X = { a: T, b: U }`.
const types = new Map();
for (const [, text] of ALL) {
  for (const m of text.matchAll(/(?:export\s+)?type\s+(\w+)\s*=\s*\{([^}]*)\}/g)) {
    const fields = [...stripComments(m[2]).matchAll(/(\w+)\??\s*:/g)].map(f => f[1]);
    if (fields.length) types.set(m[1], fields);
  }
}

// Field names each mapping declares: field("name", ...) lists, and @Column on
// an entity class.
const mappings = new Map();
for (const [, text] of ALL) {
  for (const m of text.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*:\s*DbRepository\s*\{([\s\S]*?)\n\}/g)) {
    const fields = [...m[2].matchAll(/field\(\s*"(\w+)"/g)].map(f => f[1]);
    if (fields.length) mappings.set(m[1], fields);
  }
  for (const m of text.matchAll(/@entity\("(\w+)"\)\s*export\s+class\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const body = m[3];
    const fields = [];
    for (const c of body.matchAll(/@Column\([^)]*\)\s*\n\s*(\w+)\s*:/g)) fields.push(c[1]);
    if (fields.length) mappings.set(m[2], fields);
  }
}

// Follow the delegation chain. Since the entity extractions, almost every
// mapping is a forwarder rather than a field() list:
//
//   triggerBotsMapping() -> triggerBotRepository() -> entityTriggerBot
//
// The first cut of this resolved only the last hop, so every extracted table —
// which is to say most of them — fell out of the map and the sweep reported
// "clean" while seeing almost nothing. Confirmed by deleting a field from
// TriggerBotRow and watching it stay quiet.
const forwards = new Map();
for (const [, text] of ALL) {
  for (const m of text.matchAll(/function\s+(\w+)\s*\(\s*\)\s*:\s*DbRepository\s*\{\s*return\s+entity(\w+);/g)) {
    forwards.set(m[1], m[2]);
  }
  for (const m of text.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*:\s*DbRepository\s*\{\s*return\s+(\w+)\(\s*[\w.]*\s*\);/g)) {
    forwards.set(m[1], m[2]);
  }
  // `return withoutRelations(agentRepository());` — a wrapper around the real
  // accessor. plume's withoutRelations copies fields through untouched and only
  // empties relations, so the column set is the inner one. agentsMapping and
  // promptsMapping are both written this way, which is to say the two busiest
  // tables in the package were the ones being skipped.
  for (const m of text.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*:\s*DbRepository\s*\{\s*return\s+\w+\(\s*(\w+)\(\s*\)\s*\)\s*;/g)) {
    forwards.set(m[1], m[2]);
  }
}
for (const name of forwards.keys()) {
  let at = name, hops = 0;
  while (!mappings.has(at) && forwards.has(at) && hops < 6) { at = forwards.get(at); hops++; }
  if (mappings.has(at)) mappings.set(name, mappings.get(at));
}

const findings = [];
const skipped = [];
let examined = 0;
for (const [file, text] of ALL) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const w = lines[i].match(/persist\(\s*[\w.]+\s*,\s*(?:[\w.]+\.)?(\w+)\([^)]*\)\s*,\s*JSON\.stringify\(\s*(\w+)\s*\)/);
    if (!w) continue;
    const [, mapping, variable] = w;
    const columns = mappings.get(mapping);
    if (!columns) {
      skipped.push(`${file.replace(ROOT + "/", "")}:${i + 1} (mapping ${mapping} not resolved)`);
      continue;
    }
    examined++;

    // The variable's declared type, from its nearest declaration above.
    let declared = null;
    for (let j = i; j >= 0 && j > i - 60; j--) {
      const d = lines[j].match(new RegExp(`let\\s+${variable}\\s*:\\s*(\\w+)\\s*=`));
      if (d) { declared = d[1]; break; }
    }
    if (!declared) continue;
    const fields = types.get(declared);
    if (!fields) continue;

    const missing = columns.filter(c => !fields.includes(c));
    if (missing.length === 0) continue;
    findings.push({
      file: file.replace(ROOT + "/", ""), line: i + 1,
      mapping, variable, declared, missing,
    });
  }
}

// Coverage, printed always. "Clean" from a sweep that resolved nothing is the
// failure this tool already had once, and a bare reassuring line is exactly how
// it hid.
console.log(`examined ${examined} write(s) against a resolved mapping; ${skipped.length} skipped`);
for (const s of skipped) console.log(`  skipped: ${s}`);
console.log();

if (findings.length === 0) {
  console.log("no narrow writes: every persisted type covers the columns its mapping declares");
} else {
  console.log(`${findings.length} write(s) whose type is missing a mapped column:\n`);
  for (const f of findings) {
    console.log(`${f.file}:${f.line}  persist(..., ${f.mapping}(), JSON.stringify(${f.variable}))`);
    console.log(`    ${f.variable} is ${f.declared}, which does not carry: ${f.missing.join(", ")}`);
    console.log();
  }
}
