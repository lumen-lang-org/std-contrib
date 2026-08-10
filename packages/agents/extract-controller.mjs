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

const stillLocal = [...used].filter((n) => defined.has(n) && !origin.has(n) && n !== cls);
if (stillLocal.length) {
  console.error(`${target} still needs api.ts internals, move them to api-core.ts first: ${stillLocal.join(", ")}`);
  process.exit(1);
}

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
writeFileSync(outFile, `// The ${target} routes.\n\n${imports}\n\n${exported}\n`);

let rest = lines.slice(0, start).concat(lines.slice(end + 1)).join("\n");
const anchor = 'import { stamp, callerTags,';
const at = rest.indexOf(anchor);
const eol = rest.indexOf("\n", at);
rest = rest.slice(0, eol + 1) + `import { ${cls} } from "./${outFile.replace(/\.ts$/, "")}.ts";\n` + rest.slice(eol + 1);
writeFileSync("api.ts", rest.replace(/\n{4,}/g, "\n\n\n"));
console.log(`${target}: ${cls} -> ${outFile} (${end - start + 1} lines, ${byModule.size} import sources)`);
