// cidx — the code-index CLI: compact symbol maps for AI navigation.
//
//   cidx map <dir>              one line per file: `path: sym:line, ...`
//   cidx find <symbol> [dir]    where a symbol is defined: `path:line name`
//   cidx outline <file>         one file's symbols
//
// Build: lumen compile --release-fast packages/code-index/examples/cidx.ts

import { langOf, outlineSource, formatMapLine, findSymbol, skipDir } from "../code-index.ts";

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
  for (const p of paths) {
    out.push(outlineSource(fs.readFileSync(p), langOf(p)));
  }
  return out;
}

function main(): void {
  const argv = process.argv;
  if (argv.length < 3) {
    console.log("usage: cidx map <dir> | cidx find <symbol> [dir] | cidx outline <file>");
    process.exit(2);
  }
  const mode = argv[1];

  if (mode === "map") {
    const files = walk(argv[2], []);
    const outs = buildOutlines(files);
    for (let i = 0; i < files.length; i = i + 1) {
      const line = formatMapLine(files[i], outs[i]);
      if (line.length > 0) console.log(line);
    }
    process.exit(0);
  }

  if (mode === "find") {
    const dir = argv.length > 3 ? argv[3] : ".";
    const files = walk(dir, []);
    const hits = findSymbol(files, buildOutlines(files), argv[2]);
    if (hits.length === 0) {
      console.log("not found: " + argv[2]);
      process.exit(1);
    }
    for (const h of hits.slice(0, 20)) console.log(h);
    if (hits.length > 20) console.log("+" + (hits.length - 20) + " more");
    process.exit(0);
  }

  if (mode === "outline") {
    const syms = outlineSource(fs.readFileSync(argv[2]), langOf(argv[2]));
    for (const s of syms) console.log(s);
    process.exit(0);
  }

  console.log("unknown mode: " + mode);
  process.exit(2);
}

main();
