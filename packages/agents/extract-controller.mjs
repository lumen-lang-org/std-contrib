#!/usr/bin/env node
// Moves one @controller class out of api.ts into its own module, imports and all.
// Usage: node extract-controller.mjs /banner banner-api.ts

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [target, outFile] = process.argv.slice(2);
if (!target || !outFile) { console.error("usage: extract-controller.mjs <route-prefix> <out.ts>"); process.exit(2); }

const src = readFileSync("api.ts", "utf8");
const lines = src.split("\n");

// Where api.ts gets each name it uses, so the moved class can ask the same places.
const origin = new Map();
for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/gm))
  for (const n of m[1].split(",")) { const t = n.trim(); if (t) origin.set(t, m[2]); }

const defined = new Set();
for (const l of lines) {
  const m = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|type|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(l);
  if (m) defined.add(m[1]);
}

let start = -1;
for (let i = 0; i < lines.length; i++) if (lines[i].includes(`@controller("${target}")`)) { start = i; break; }
if (start < 0) { console.error(`no @controller("${target}") in api.ts`); process.exit(1); }
// Carry the comment block that introduces it.
while (start > 0 && lines[start - 1].trim().startsWith("//")) start--;

let j = start; while (!/\bclass\s+(\w+)/.test(lines[j])) j++;
const cls = /\bclass\s+(\w+)/.exec(lines[j])[1];
let depth = 0, started = false, end = j;
for (let k = j; k < lines.length; k++) {
  for (const ch of lines[k]) { if (ch === "{") { depth++; started = true; } else if (ch === "}") depth--; }
  if (started && depth === 0) { end = k; break; }
}

const block = lines.slice(start, end + 1).join("\n");
// Identifiers in code only. A name inside a string or a comment is text:
// `this.db.name != "postgres"` was importing plume/postgres.ts.
const code = block
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ")
  .replace(/`(?:\\.|[^`\\])*`/g, " ")
  .replace(/"(?:\\.|[^"\\])*"/g, " ")
  .replace(/'(?:\\.|[^'\\])*'/g, " ");
const used = new Set();
for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) used.add(m[1]);

// A helper only this controller uses travels with it. One used by another
// controller, or by anything left behind, would have to be imported back from
// here and that is the cycle; those go to api-core.ts instead.
function declAt(name) {
  const pat = new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function|const|let|type|interface|enum)\\s+${name}\\b`);
  for (let i = 0; i < lines.length; i++) if (pat.test(lines[i])) {
    if (/^(?:export\s+)?(?:const|let|type)\b/.test(lines[i]) && lines[i].trimEnd().endsWith(";")) {
      let s = i; while (s > 0 && lines[s - 1].trim().startsWith("//")) s--;
      return { from: s, to: i };
    }
    let d = 0, started = false, e = i;
    for (let k = i; k < lines.length; k++) {
      for (const ch of lines[k]) { if (ch === "{") { d++; started = true; } else if (ch === "}") d--; }
      if (started && d === 0) { e = k; break; }
    }
    let s = i; while (s > 0 && lines[s - 1].trim().startsWith("//")) s--;
    return { from: s, to: e };
  }
  return null;
}

const idsOf = (text) => new Set([...text
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ")
  .replace(/`(?:\\.|[^`\\])*`/g, " ").replace(/"(?:\\.|[^"\\])*"/g, " ").replace(/'(?:\\.|[^'\\])*'/g, " ")
  .matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]));

const carry = new Map();
const queue = [...used].filter((n) => defined.has(n) && !origin.has(n) && n !== cls);
while (queue.length) {
  const n = queue.shift();
  if (carry.has(n)) continue;
  const at = declAt(n);
  if (!at) { console.error(`${target}: cannot locate ${n} in api.ts`); process.exit(1); }
  carry.set(n, at);
  for (const m of idsOf(lines.slice(at.from, at.to + 1).join("\n")))
    if (defined.has(m) && !origin.has(m) && m !== cls && !carry.has(m)) queue.push(m);
}

// Refuse if anything left in api.ts still needs a name we are taking.
const carrySpans = [...carry.values()];
const takenLines = new Set([...Array(end - start + 1).keys()].map((i) => i + start));
for (const sp of carrySpans) for (let i = sp.from; i <= sp.to; i++) takenLines.add(i);
const remaining = lines.filter((_, i) => !takenLines.has(i)).join("\n");
const stillWanted = [...carry.keys()].filter((n) => new RegExp(`\\b${n}\\b`).test(remaining));
if (stillWanted.length) {
  console.error(`${target}: api.ts still uses ${stillWanted.join(", ")} — put those in api-core.ts first`);
  process.exit(1);
}

for (const sp of carrySpans) for (const m of idsOf(lines.slice(sp.from, sp.to + 1).join("\n"))) used.add(m);
const byModule = new Map();
for (const n of used) {
  const from = origin.get(n);
  if (!from) continue;
  if (!byModule.has(from)) byModule.set(from, new Set());
  byModule.get(from).add(n);
}
byModule.set("../rest/controller.ts", new Set([...(byModule.get("../rest/controller.ts") ?? []), "controller"]));

const imports = [...byModule.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([mod, names]) => `import { ${[...names].sort().join(", ")} } from "${mod}";`)
  .join("\n");

const exported = block.replace(new RegExp(`^class ${cls}\\b`, "m"), `export class ${cls}`);
const carried = carrySpans
  .sort((a, b) => a.from - b.from)
  .map((sp) => lines.slice(sp.from, sp.to + 1).join("\n"))
  .join("\n\n");
writeFileSync(outFile, `// The ${target} routes.\n\n${imports}\n\n${carried ? carried + "\n\n" : ""}${exported}\n`);

let rest = lines.filter((_, i) => !takenLines.has(i)).join("\n");
const anchor = 'import { stamp, callerTags,';
const at = rest.indexOf(anchor);
const eol = rest.indexOf("\n", at);
rest = rest.slice(0, eol + 1) + `import { ${cls} } from "./${outFile.replace(/\.ts$/, "")}.ts";\n` + rest.slice(eol + 1);
writeFileSync("api.ts", rest.replace(/\n{4,}/g, "\n\n\n"));
console.log(`${target}: ${cls} -> ${outFile} (${end - start + 1} lines, ${byModule.size} import sources)`);
