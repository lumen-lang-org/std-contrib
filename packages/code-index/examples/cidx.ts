// cidx — the code-index CLI: compact symbol maps for AI navigation.
//
//   cidx map <dir> [--rank]     one line per file: `path: sym:line, ...`
//                               --rank sorts a flat symbol list by call count
//   cidx find <symbol> [dir]    where a symbol is defined: `path:line name`
//   cidx refs <symbol> [dir]    who calls it: `path:line: <source line>`
//   cidx outline <file>         one file's symbols (incl. class members)
//
// Build: lumen compile --release-fast packages/code-index/examples/cidx.ts

import { langOf, outlineDeep, symbolOnLine, classMemberOnLine, formatMapLine, findSymbol, refLinesInSource, countRefs, skipDir, cacheLine, cachePath, cacheOutline } from "../code-index.ts";

const CACHE = ".cidx";

function walk(dir: string, acc: string[]): string[] {
  const entries = fs.readdirSync(dir);
  let files = acc;
  for (const name of entries) {
    const path = dir + "/" + name;
    const st = fs.statSync(path);
    if (st.isDirectory) {
      if (!skipDir(name)) files = walk(path, files);
    } else if (langOf(name).length > 0) {
      files.push(path);
    }
  }
  return files;
}

function buildOutlines(paths: string[]): string[][] {
  let out: string[][] = [];
  for (const p of paths) out.push(outlineDeep(fs.readFileSync(p), langOf(p)));
  return out;
}

function readAll(paths: string[]): string[] {
  let out: string[] = [];
  for (const p of paths) out.push(fs.readFileSync(p));
  return out;
}

// Cache lines if a `.cidx` file exists, else empty (caller falls back to walk).
function readCacheLines(): string[] {
  if (!fs.existsSync(CACHE)) return [];
  let out: string[] = [];
  for (const l of fs.readFileSync(CACHE).split("\n")) {
    if (l.length > 0) out.push(l);
  }
  return out;
}

function main(): void {
  const argv = process.argv;
  if (argv.length < 3) {
    console.log("usage: cidx build <dir> | cidx map <dir> [--rank] | cidx find <symbol> [dir] | cidx refs <symbol> [dir] | cidx outline <file>");
    process.exit(2);
  }
  const mode = argv[1];

  if (mode === "build") {
    const dir = argv.length > 2 ? argv[2] : ".";
    const files = walk(dir, []);
    const outs = buildOutlines(files);
    let body = "";
    let n = 0;
    for (let i = 0; i < files.length; i = i + 1) {
      const line = cacheLine(files[i], outs[i]);
      if (line.length > 0) { body += line + "\n"; n = n + 1; }
    }
    fs.writeFileSync(CACHE, body);
    console.log("indexed " + n + " files -> " + CACHE);
    process.exit(0);
  }

  if (mode === "find") {
    // Prefer the cache: instant, no walk.
    const cache = readCacheLines();
    if (cache.length > 0) {
      let paths: string[] = [];
      let outs: string[][] = [];
      for (const cl of cache) { paths.push(cachePath(cl)); outs.push(cacheOutline(cl)); }
      const hits = findSymbol(paths, outs, argv[2]);
      if (hits.length === 0) { console.log("not found: " + argv[2]); process.exit(1); }
      for (const h of hits.slice(0, 20)) console.log(h);
      if (hits.length > 20) console.log("+" + (hits.length - 20) + " more");
      process.exit(0);
    }
  }

  if (mode === "map") {
    const dir = argv[2];
    const rank = argv.length > 3 && argv[3] === "--rank";
    const files = walk(dir, []);
    const outs = buildOutlines(files);
    if (!rank) {
      for (let i = 0; i < files.length; i = i + 1) {
        const line = formatMapLine(files[i], outs[i]);
        if (line.length > 0) console.log(line);
      }
      process.exit(0);
    }
    // --rank: flatten to unique symbols, sort by whole-corpus call count.
    const srcs = readAll(files);
    let names: string[] = [];
    let places: string[] = [];
    for (let i = 0; i < files.length; i = i + 1) {
      for (const entry of outs[i]) {
        const colon = entry.lastIndexOf(":");
        names.push(entry.substring(0, colon));
        places.push(files[i] + ":" + entry.substring(colon + 1));
      }
    }
    let counts: number[] = [];
    for (const n of names) {
      const dot = n.lastIndexOf(".");
      const tail = dot >= 0 ? n.substring(dot + 1) : n;
      counts.push(countRefs(srcs, tail));
    }
    // index-sort by counts descending (simple selection, corpus is small)
    let order: number[] = [];
    for (let i = 0; i < names.length; i = i + 1) order.push(i);
    order = order.sort((a, b) => counts[b] - counts[a]);
    for (const i of order.slice(0, 40)) {
      console.log(counts[i] + "  " + names[i] + "  " + places[i]);
    }
    process.exit(0);
  }

  if (mode === "find") {
    const dir = argv.length > 3 ? argv[3] : ".";
    const files = walk(dir, []);
    const hits = findSymbol(files, buildOutlines(files), argv[2]);
    if (hits.length === 0) { console.log("not found: " + argv[2]); process.exit(1); }
    for (const h of hits.slice(0, 20)) console.log(h);
    if (hits.length > 20) console.log("+" + (hits.length - 20) + " more");
    process.exit(0);
  }

  if (mode === "refs") {
    const dir = argv.length > 3 ? argv[3] : ".";
    const files = walk(dir, []);
    const name = argv[2];
    let shown = 0;
    for (const p of files) {
      const src = fs.readFileSync(p);
      const lang = langOf(p);
      const lines = src.split("\n");
      for (const ln of refLinesInSource(src, name, 0)) {
        const text = lines[ln - 1];
        // Skip the definition itself; `refs` is call sites only.
        if (symbolOnLine(text, lang) === name || classMemberOnLine(text, lang) === name) continue;
        if (shown < 40) console.log(p + ":" + ln + ": " + text.trim());
        shown = shown + 1;
      }
    }
    if (shown === 0) { console.log("no references: " + name); process.exit(1); }
    if (shown > 40) console.log("+" + (shown - 40) + " more");
    process.exit(0);
  }

  if (mode === "outline") {
    for (const s of outlineDeep(fs.readFileSync(argv[2]), langOf(argv[2]))) console.log(s);
    process.exit(0);
  }

  console.log("unknown mode: " + mode);
  process.exit(2);
}

main();
