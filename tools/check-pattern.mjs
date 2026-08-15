// check-pattern — the lumen-route skill, as a check that fails.
//
// Every rule here was broken at least once today and found by reading rather
// than by tooling, which is the same as saying it was found by luck. A rule
// nobody can run is a rule that gets half-applied: two mappings converted and
// thirty-four left, and nothing says so.
//
//   node tools/check-pattern.mjs                 # scorecard, exits 1 if anything is broken
//   node tools/check-pattern.mjs --route tasks   # one route
//   node tools/check-pattern.mjs --summary       # counts only
//
// It reports per rule and per route, so "is this route done" and "what is left
// across the engine" are one command, not a reading exercise.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, extname, dirname, resolve, relative } from "node:path";

const ENGINE = "packages/agents";
const ROUTES = join(ENGINE, "routes");

const only = process.argv.includes("--route")
  ? process.argv[process.argv.indexOf("--route") + 1]
  : null;
const summaryOnly = process.argv.includes("--summary");

function walk(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return extname(path) === ".ts" ? [path] : [];
  return readdirSync(path).flatMap((e) => walk(join(path, e)));
}

const read = (p) => readFileSync(p, "utf8");
const lines = (p) => read(p).split("\n");

// A V1 mapping is a snapshot of an older schema, used by a migration to build
// the table as it was. A snapshot that follows the current class is not a
// snapshot, so these are exempt by design rather than by oversight.
const isSnapshot = (name) => /V\d+$/.test(name);

// Every top-level packages/agents/*.ts file (not a route, not a package) that
// owns table access the old way: a field()-mapped DbRepository, or CRUD verbs
// (persist/executeWith/deleteById/...) called anywhere in the file. A
// repository.ts that imports FROM one of these hasn't adopted the Repository
// pattern — it has delegated to the thing the pattern replaces.
function legacyMappingModules() {
  const found = new Set();
  const root = resolve(ENGINE);
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    const full = join(root, name);
    if (extname(full) !== ".ts" || statSync(full).isDirectory()) continue;
    if (name.endsWith(".test.ts")) continue;
    const src = read(full);
    const ownsMapping = /: DbRepository \{[\s\S]*?field\(/.test(src);
    const runsCrud = /\b(persist|executeWith|deleteById|deleteWhere|listOrdered|findById)\(/.test(src);
    if (ownsMapping || runsCrud) found.add(full);
  }
  return found;
}
const LEGACY_MODULES = legacyMappingModules();

const rules = [
  {
    id: "mapping-not-entity",
    what: "a hand-written field() mapping that should be an @entity class",
    scan(path) {
      if (path.endsWith(".entity.ts")) return [];
      const found = [];
      const src = read(path);
      const re = /export function (\w+)\(([^)]*)\): DbRepository \{([\s\S]*?)\n\}/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        if (isSnapshot(m[1])) continue;
        if (!/field\("/.test(m[3])) continue;
        const line = src.slice(0, m.index).split("\n").length;
        found.push({ line, detail: m[1] });
      }
      return found;
    },
  },
  {
    id: "repository-delegates-to-legacy-module",
    what: "a *.repository.ts importing from a top-level module instead of owning an @entity",
    scan(path) {
      if (!path.endsWith(".repository.ts")) return [];
      const found = [];
      lines(path).forEach((l, i) => {
        const m = l.match(/^import\s*\{[^}]*\}\s*from\s*"([^"]+)"/);
        if (!m || !m[1].startsWith(".")) return;
        const target = resolve(dirname(path), m[1]);
        if (LEGACY_MODULES.has(target)) {
          found.push({ line: i + 1, detail: `${basename(target)}: ${l.trim().slice(0, 70)}` });
        }
      });
      return found;
    },
  },
  {
    id: "handler-takes-request",
    what: "a handler taking Request instead of bound parameters",
    scan(path) {
      if (!path.includes("controller")) return [];
      return lines(path).flatMap((l, i) =>
        /^\s+\w+\((request|req): Request[,)]/.test(l) && !/: Guarded/.test(l)
          ? [{ line: i + 1, detail: l.trim().slice(0, 60) }]
          : [],
      );
    },
  },
  {
    id: "sql-outside-plume",
    what: "SQL written by hand where a plume verb belongs",
    scan(path) {
      if (path.includes("packages/plume")) return [];
      return lines(path).flatMap((l, i) =>
        /"(INSERT INTO|DELETE FROM|UPDATE) /.test(l)
          ? [{ line: i + 1, detail: l.trim().slice(0, 60) }]
          : [],
      );
    },
  },
  {
    id: "lowercase-verb",
    what: "a lowercase route decorator",
    scan(path) {
      return lines(path).flatMap((l, i) =>
        /^\s*@(get|post|put|patch|del|delete|head)\(/.test(l)
          ? [{ line: i + 1, detail: l.trim() }]
          : [],
      );
    },
  },
  {
    id: "lowercase-reply",
    what: "a lowercase reply helper",
    scan(path) {
      return lines(path).flatMap((l, i) =>
        /(?<![\w.])(ok|created|badRequest|notFound|noContent|okJson)\(/.test(l)
          ? [{ line: i + 1, detail: l.trim().slice(0, 60) }]
          : [],
      );
    },
  },
  {
    id: "missing-bindings",
    what: "a @controller class without @bindings, so parameter decorators do nothing",
    scan(path) {
      const src = read(path);
      const found = [];
      const re = /@controller\("([^"]*)"\)\n((?:\s*@\w+[^\n]*\n)*)\s*(?:export )?class (\w+)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        if (!/@bindings/.test(m[2])) {
          found.push({ line: src.slice(0, m.index).split("\n").length, detail: m[3] });
        }
      }
      return found;
    },
  },
  {
    id: "discarded-dbresult",
    what: "a plume write whose DbResult is thrown away",
    scan(path) {
      if (path.includes("packages/plume") || path.endsWith(".test.ts")) return [];
      // A call that IS the statement discards its result. One ending in a
      // comma is an element of a list being collected, which is the fix, not
      // the fault — a rule that cries wolf is a rule nobody runs.
      //
      // plume exports 23 functions returning DbResult and this names 12 of
      // them. The other 11 are left out on purpose, having been checked one by
      // one: rollbackTransaction (34 sites) is called from inside an error path
      // that is already returning a fault, dropTable (31) and createTable are
      // schema setup in tests and examples/, execute (54) is the raw escape
      // hatch and matches far more DDL than writing, and connectDatabase,
      // beginTransaction, commitTransaction, createHistory, repairChecksums and
      // forgetMigrations are start-up and migration plumbing. Adding them would
      // add ~119 hits nobody would act on and drown the ones that matter.
      //
      // setOn, setWhere, deleteWhere and persistMany are here because they are
      // ordinary writes whose failure loses data exactly like persist's does.
      // They were missing until two real defects came through the gap: an
      // engine that crashed inside the migrator on a database that never
      // opened, and a project whose deletion orphaned its conversations
      // (a01d441), which a setWhere discard had hidden.
      return lines(path).flatMap((l, i) =>
        /^\s+(persistMany|persist|link|unlink|unlinkAllOwnedBy|unlinkAllPointingAt|setEvery|setOn|setWhere|executeWith|deleteById|deleteWhere)\(.*\);\s*$/.test(l)
          ? [{ line: i + 1, detail: l.trim().slice(0, 60) }]
          : [],
      );
    },
  },
  {
    id: "abbreviated-name",
    what: "an abbreviated name where the full word belongs",
    scan(path) {
      return lines(path).flatMap((l, i) =>
        /\b(this\.db|this\.repo|this\.cfg|this\.svc)\b/.test(l)
          ? [{ line: i + 1, detail: l.trim().slice(0, 60) }]
          : [],
      );
    },
  },
  {
    id: "route-imports-schema",
    what: "a route importing schema.ts instead of an entity",
    scan(path) {
      if (!path.includes("/routes/")) return [];
      return lines(path).flatMap((l, i) =>
        /from "[^"]*\/schema\.ts"/.test(l) ? [{ line: i + 1, detail: l.trim() }] : [],
      );
    },
  },
  {
    id: "banned-word",
    what: 'the word "problem" in an identifier',
    scan(path) {
      return lines(path).flatMap((l, i) =>
        /\b\w*[Pp]roblem\w*\b/.test(l) && !/^\s*\/\//.test(l)
          ? [{ line: i + 1, detail: l.trim().slice(0, 60) }]
          : [],
      );
    },
  },
];

// --route takes a bare route name ("templates") or a domain-qualified one
// ("extensions/templates"); routes live one domain folder deep now.
function routeDir(name) {
  const direct = join(ROUTES, name);
  if (existsSync(direct)) return direct;
  for (const domain of readdirSync(ROUTES, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    const nested = join(ROUTES, domain.name, name);
    if (existsSync(nested)) return nested;
  }
  console.error(`no route "${name}" under ${ROUTES}`);
  process.exit(2);
}

const files = walk(only ? routeDir(only) : ENGINE).filter((f) => !f.endsWith(".test.ts"));

const byRule = new Map();
const byRoute = new Map();
for (const rule of rules) byRule.set(rule.id, []);

for (const path of files) {
  for (const rule of rules) {
    for (const hit of rule.scan(path)) {
      byRule.get(rule.id).push({ path, ...hit });
      // routes/ groups routes under a domain folder (routes/<domain>/<route>/…),
      // so the route is the second segment. Reported without its domain, to stay
      // directly comparable with the scorecards taken before the regrouping.
      const under = path.includes("/routes/") ? path.split("/routes/")[1].split("/") : null;
      const route = under ? (under[1] ?? under[0]) : "(engine)";
      if (!byRoute.has(route)) byRoute.set(route, 0);
      byRoute.set(route, byRoute.get(route) + 1);
    }
  }
}

let total = 0;
console.log("rule                      count  what");
console.log("------------------------  -----  ----------------------------------------");
for (const rule of rules) {
  const hits = byRule.get(rule.id);
  total += hits.length;
  console.log(`${rule.id.padEnd(24)}  ${String(hits.length).padStart(5)}  ${rule.what}`);
}

if (!summaryOnly && total > 0) {
  console.log("\nby route (worst first):");
  for (const [route, n] of [...byRoute.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${route}`);
  }
}

console.log(`\n${total} departures from the lumen-route pattern across ${files.length} files`);
process.exit(total > 0 ? 1 : 0);
