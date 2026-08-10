#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";

const mods = readdirSync(".").filter((f) => /-routes\.ts$/.test(f) || f === "banner-api.ts");
const rename = new Map();

const deepen = (spec) =>
  spec.startsWith("../") ? "../../" + spec
  : spec.startsWith("./") ? "../../" + spec.slice(2)
  : spec;

for (const file of mods) {
  const name = file.replace(/-routes\.ts$/, "").replace(/-api\.ts$/, "");
  const dir = `routes/${name}`;
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  const imports = [], rest = [];
  for (const l of lines) (l.startsWith("import ") ? imports : rest).push(l);

  const body = rest.join("\n").split("\n");
  const typeSpans = [];
  for (let i = 0; i < body.length; i++) {
    if (!/^(?:export\s+)?(?:type|interface|enum)\s+[A-Za-z_$]/.test(body[i])) continue;
    let s = i; while (s > 0 && body[s - 1].trim().startsWith("//")) s--;
    let e = i;
    if (!body[i].trimEnd().endsWith(";")) {
      let d = 0, started = false;
      for (let k = i; k < body.length; k++) {
        for (const ch of body[k]) { if (ch === "{") { d++; started = true; } else if (ch === "}") d--; }
        if (started && d === 0) { e = k; break; }
      }
    }
    typeSpans.push([s, e]);
  }
  const taken = new Set();
  for (const [s, e] of typeSpans) for (let i = s; i <= e; i++) taken.add(i);
  const typeBlocks = typeSpans.map(([s, e]) =>
    body.slice(s, e + 1).join("\n").replace(/^(type|interface|enum) /m, "export $1 "));
  const controllerBody = body.filter((_, i) => !taken.has(i)).join("\n").replace(/\n{3,}/g, "\n\n").trim();

  const codeOnly = (t) => {
    let out = "", i = 0;
    while (i < t.length) {
      const c = t[i], d = t[i + 1];
      if (c === "/" && d === "/") { while (i < t.length && t[i] !== "\n") i++; continue; }
      if (c === "/" && d === "*") { i += 2; while (i < t.length && !(t[i] === "*" && t[i + 1] === "/")) i++; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") {
        const q = c; i++;
        while (i < t.length && t[i] !== q) { if (t[i] === "\\") i++; i++; }
        i++; out += " "; continue;
      }
      out += c; i++;
    }
    return out;
  };
  const ids = (t) => new Set([...codeOnly(t).matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]));

  const parsed = imports.map((l) => {
    const m = /^import \{([^}]*)\} from "([^"]+)";$/.exec(l);
    return { names: m[1].split(",").map((s) => s.trim()).filter(Boolean), spec: m[2] };
  });

  const emit = (need) => parsed
    .map((p) => ({ spec: deepen(p.spec), names: p.names.filter((n) => need.has(n)) }))
    .filter((p) => p.names.length)
    .map((p) => `import { ${p.names.sort().join(", ")} } from "${p.spec}";`)
    .join("\n");

  mkdirSync(dir, { recursive: true });
  const typeNames = typeBlocks.map((b) => /(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(b)[1]);

  if (typeBlocks.length) {
    const need = ids(typeBlocks.join("\n"));
    const head = emit(need);
    writeFileSync(`${dir}/types.ts`, `// The shapes the ${name} routes read and write.\n\n${head ? head + "\n\n" : ""}${typeBlocks.join("\n\n")}\n`);
  }

  const need = ids(controllerBody);
  let head = emit(need);
  if (typeNames.length) {
    const wanted = typeNames.filter((n) => need.has(n));
    if (wanted.length) head += `\nimport { ${wanted.sort().join(", ")} } from "./types.ts";`;
  }
  writeFileSync(`${dir}/controller.ts`, `${controllerBody.startsWith("//") ? "" : `// The ${name} routes.\n\n`}${head}\n\n${controllerBody}\n`);
  rmSync(file);
  rename.set(`./${file.replace(/\.ts$/, "")}.ts`, `./${dir}/controller.ts`);
  console.log(`${file} -> ${dir}/controller.ts${typeBlocks.length ? ` + types.ts (${typeBlocks.length})` : ""}`);
}

for (const f of ["api.ts", "api.test.ts"]) {
  let s = readFileSync(f, "utf8");
  for (const [from, to] of rename) s = s.split(`"${from}"`).join(`"${to}"`);
  writeFileSync(f, s);
}
console.log(`rewrote import paths in api.ts and api.test.ts`);
