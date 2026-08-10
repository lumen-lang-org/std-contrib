#!/usr/bin/env node
// Derives the REST route table statically from the controllers, so a refactor can prove it moved no route.
// Usage: node route-table.mjs [files...] > before.txt   then diff after the split.

import { readFileSync } from "node:fs";

const VERB = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", del: "DELETE", head: "HEAD" };
const files = process.argv.slice(2).length ? process.argv.slice(2) : ["api.ts"];
const routes = [];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  let prefix = null, cls = null, pending = [];
  for (const line of lines) {
    const c = /@controller\("([^"]*)"\)/.exec(line);
    if (c) { prefix = c[1]; cls = null; pending = []; continue; }
    if (prefix && !cls) { const k = /\bclass\s+(\w+)/.exec(line); if (k) { cls = k[1]; continue; } }
    const v = /@(get|post|put|patch|del|head)\("([^"]*)"\)/.exec(line);
    if (v && prefix) { pending.push({ method: VERB[v[1]], path: v[2] }); continue; }
    // The decorators sit above the method they describe; the name closes them.
    const m = /^\s*(?:@\w+\([^)]*\)\s*)*(\w+)\s*\(\s*\w+\s*:\s*Request\s*\)/.exec(line);
    if (m && pending.length) {
      for (const p of pending) {
        const full = (prefix + p.path).replace(/\/+$/, "") || "/";
        routes.push(`${p.method.padEnd(6)} ${full.padEnd(44)} ${cls}.${m[1]}`);
      }
      pending = [];
    }
  }
}
routes.sort();
for (const r of routes) console.log(r);
console.error(`${routes.length} routes across ${files.length} file(s)`);
