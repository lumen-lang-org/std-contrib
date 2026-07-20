// token-gate (tkg) — token-optimizing command proxy.
//
// Runs a command and compresses its output before it reaches an AI
// assistant's context window:
//   - strips ANSI color/cursor escape sequences
//   - deduplicates consecutive repeated lines (shown once with an xN count)
//   - drops blank lines
//   - groups `git status` porcelain output by change kind
//   - truncates long output to head + tail with an elision marker
//
// Usage:
//   tkg <command> [args...]
// Examples:
//   tkg git status
//   tkg ls -la
//   tkg zig build test
//
// Run tests: lumen test packages/token-gate/token-gate.ts

// --- pure filters (tested) ---

export function stripAnsi(s: string): string {
  // Drop ESC '[' ... final-letter sequences (colors, cursor codes), char by char.
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 27) {
      i = i + 1;
      if (i < s.length && s.charAt(i) === "[") {
        i = i + 1;
        while (i < s.length) {
          const c = s.charCodeAt(i);
          i = i + 1;
          if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) break;
        }
      }
      continue;
    }
    out += s.charAt(i);
    i = i + 1;
  }
  return out;
}

export function dedupe(lines: string[]): string[] {
  let out: string[] = [];
  let prev = "";
  let count = 0;
  for (const line of lines) {
    if (line === prev) {
      count = count + 1;
      continue;
    }
    if (count > 1) out.push(prev + "  [x" + count + "]");
    else if (count === 1) out.push(prev);
    prev = line;
    count = 1;
  }
  if (count > 1) out.push(prev + "  [x" + count + "]");
  else if (count === 1) out.push(prev);
  return out;
}

export function truncate(lines: string[], maxLines: int): string[] {
  if (lines.length <= maxLines) return lines;
  const head = lines.slice(0, maxLines - 6);
  const tail = lines.slice(-5);
  const dropped = lines.length - head.length - tail.length;
  let out: string[] = [];
  for (const l of head) out.push(l);
  out.push("... [" + dropped + " lines elided] ...");
  for (const l of tail) out.push(l);
  return out;
}

// `git status --porcelain` grouped: one line per change kind with a file count
// and up to 5 example paths — the shape an assistant actually needs.
export function groupGitStatus(lines: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const line of lines) {
    if (line.length < 4) continue;
    const code = line.substring(0, 2).trim();
    const path = line.substring(3);
    const kind =
      code === "M" ? "modified" :
      code === "A" ? "added" :
      code === "D" ? "deleted" :
      code === "R" ? "renamed" :
      code === "??" ? "untracked" : "other";
    const cur = groups.get(kind) ?? [];
    groups.set(kind, [...cur, path]);
  }
  let out: string[] = [];
  for (const [kind, paths] of groups) {
    const shown = paths.slice(0, 5).join(", ");
    const more = paths.length > 5 ? " +" + (paths.length - 5) + " more" : "";
    out.push(kind + " (" + paths.length + "): " + shown + more);
  }
  if (out.length === 0) out.push("clean");
  return out;
}

export function splitLines(s: string): string[] {
  let out: string[] = [];
  for (const l of s.split("\n")) {
    if (l.trim().length > 0) out.push(l);
  }
  return out;
}


// --- per-command handlers ---

// `ls -la` lines compacted to `name  size` (dirs marked with /), header and
// permission/owner columns dropped — the columns are the token cost.
export function lsSummary(lines: string[]): string[] {
  let out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("total ")) continue;
    const parts = line.split(" ").filter(p => p.length > 0);
    if (parts.length < 9) continue;
    const name = parts.slice(8).join(" ");
    if (name === "." || name === "..") continue;
    const size = parseInt(parts[4]) ?? 0;
    const human =
      size >= 1048576 ? ((size / 1048576).toFixed(1) + "M") :
      size >= 1024 ? ((size / 1024).toFixed(0) + "K") :
      (size + "B");
    if (line.startsWith("d")) out.push(name + "/");
    else out.push(name + "  " + human);
  }
  return out;
}

// Full `git log` output compacted to `shorthash subject` per commit.
export function compactLog(lines: string[]): string[] {
  let out: string[] = [];
  let hash = "";
  let wantSubject = false;
  for (const line of lines) {
    if (line.startsWith("commit ")) {
      hash = line.substring(7, 14);
      wantSubject = true;
      continue;
    }
    if (!wantSubject) continue;
    if (line.startsWith("Author:") || line.startsWith("Date:") || line.startsWith("Merge:")) continue;
    const t = line.trim();
    if (t.length === 0) continue;
    out.push(hash + " " + t);
    wantSubject = false;
  }
  return out;
}

// grep output capped to 3 matches per file, with a +N-more marker.
export function capGrep(lines: string[]): string[] {
  const seen = new Map<string, number>();
  let out: string[] = [];
  const extra = new Map<string, number>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    const file = colon > 0 ? line.substring(0, colon) : line;
    const n = seen.get(file) ?? 0;
    seen.set(file, n + 1);
    if (n < 3) out.push(line);
    else extra.set(file, (extra.get(file) ?? 0) + 1);
  }
  for (const [file, n] of extra) out.push(file + ": +" + n + " more matches");
  return out;
}

// Test-runner output filtered to failures, errors, and summary lines; if
// nothing matches, the last 3 lines (the summary) are kept.
export function filterTestOutput(lines: string[]): string[] {
  let out: string[] = [];
  for (const line of lines) {
    const l = line.toLowerCase();
    if (l.includes("error") || l.includes("fail") || l.includes("panic") ||
        l.includes("passed") || l.includes("test result") || l.includes("assert")) {
      out.push(line);
    }
  }
  if (out.length === 0) return lines.slice(-3);
  return truncate(out, 40);
}

// `find` / path-list output grouped by top-level directory with a count and
// up to 4 example leaf names per group.
export function groupByDir(paths: string[]): string[] {
  const groups = new Map<string, string[]>();
  let order: string[] = [];
  for (const raw of paths) {
    let p = raw;
    if (p.startsWith("./")) p = p.substring(2);
    const slash = p.indexOf("/");
    let dir = ".";
    let leaf = p;
    if (slash >= 0) {
      dir = p.substring(0, slash);
      const lastSlash = p.lastIndexOf("/");
      leaf = p.substring(lastSlash + 1);
    }
    if (groups.get(dir) === null) order.push(dir);
    const cur = groups.get(dir) ?? [];
    groups.set(dir, [...cur, leaf]);
  }
  let out: string[] = [];
  for (const dir of order) {
    const names = groups.get(dir) ?? [];
    const shown = names.slice(0, 4).join(", ");
    const more = names.length > 4 ? " +" + (names.length - 4) + " more" : "";
    out.push(dir + "/ (" + names.length + "): " + shown + more);
  }
  return out;
}

// `du` output (`size<tab>path`) sorted by size descending, top n rows.
export function topBySize(lines: string[], n: int): string[] {
  let sizes: number[] = [];
  let kept: string[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const size = parseInt(parts[0].trim()) ?? 0;
    sizes.push(size);
    kept.push(line);
  }
  let order: number[] = [];
  for (let i = 0; i < kept.length; i = i + 1) order.push(i);
  order = order.sort((a, b) => sizes[b] - sizes[a]);
  let out: string[] = [];
  for (const i of order.slice(0, n)) out.push(kept[i]);
  return out;
}

// Compiler/linter output filtered to error and warning lines (tsc, eslint,
// cargo, gcc, ...). Falls back to the last 3 lines (the summary) when clean.
export function errorLines(lines: string[]): string[] {
  let out: string[] = [];
  for (const line of lines) {
    const l = line.toLowerCase();
    if (l.includes("error") || l.includes("warning") || l.includes("warn ") ||
        l.includes("✖") || l.includes("✘") || l.includes(" fail")) {
      out.push(line);
    }
  }
  if (out.length === 0) return lines.slice(-3);
  return truncate(out, 40);
}

// A long file dump reduced to line-numbered head + tail with an elision
// marker, so an assistant sees the shape and can Read a precise range if it
// needs the middle. Short files (<= head+tail) pass through numbered.
export function numberedHeadTail(lines: string[], head: int, tail: int): string[] {
  let out: string[] = [];
  if (lines.length <= head + tail) {
    for (let i = 0; i < lines.length; i = i + 1) out.push((i + 1) + "\t" + lines[i]);
    return out;
  }
  for (let i = 0; i < head; i = i + 1) out.push((i + 1) + "\t" + lines[i]);
  const from = lines.length - tail;
  out.push("... [lines " + (head + 1) + "-" + from + " elided; Read the file for the middle] ...");
  for (let i = from; i < lines.length; i = i + 1) out.push((i + 1) + "\t" + lines[i]);
  return out;
}

// Tabular output (docker ps, kubectl get, ps aux): keep the header line and up
// to maxRows data rows, appending a `+N more rows` marker.
export function tableHead(lines: string[], maxRows: int): string[] {
  if (lines.length <= maxRows + 1) return lines;
  let out: string[] = [];
  for (let i = 0; i < maxRows + 1; i = i + 1) out.push(lines[i]);
  out.push("... +" + (lines.length - maxRows - 1) + " more rows");
  return out;
}

// --- tests ---

test("groupByDir groups paths with counts", () => {
  const r = groupByDir(["./src/a.ts", "src/b.ts", "src/c.ts", "docs/x.md"]);
  expect(r.length).toBe(2);
  expect(r[0]).toBe("src/ (3): a.ts, b.ts, c.ts");
  expect(r[1]).toBe("docs/ (1): x.md");
});

test("topBySize sorts descending", () => {
  const r = topBySize(["4\t./a", "128\t./b", "16\t./c"], 2);
  expect(r.length).toBe(2);
  expect(r[0]).toBe("128\t./b");
  expect(r[1]).toBe("16\t./c");
});

test("errorLines extracts errors and warnings", () => {
  const r = errorLines(["compiling...", "src/x.ts:3:1 - error TS2304: name", "1 warning", "done"]);
  expect(r.length).toBe(2);
  expect(r[0]).toBe("src/x.ts:3:1 - error TS2304: name");
});

test("errorLines falls back to tail when clean", () => {
  const r = errorLines(["a", "b", "c", "d"]);
  expect(r.length).toBe(3);
  expect(r[2]).toBe("d");
});

test("numberedHeadTail passes short files through numbered", () => {
  const r = numberedHeadTail(["a", "b", "c"], 40, 15);
  expect(r.length).toBe(3);
  expect(r[0]).toBe("1\ta");
  expect(r[2]).toBe("3\tc");
});

test("numberedHeadTail elides the middle of a long file", () => {
  let lines: string[] = [];
  for (let i = 0; i < 100; i = i + 1) lines.push("L" + i);
  const r = numberedHeadTail(lines, 3, 2);
  expect(r.length).toBe(6);
  expect(r[0]).toBe("1\tL0");
  expect(r[3]).toBe("... [lines 4-98 elided; Read the file for the middle] ...");
  expect(r[5]).toBe("100\tL99");
});

test("tableHead keeps header and caps rows", () => {
  const r = tableHead(["HEADER", "r1", "r2", "r3", "r4"], 2);
  expect(r.length).toBe(4);
  expect(r[0]).toBe("HEADER");
  expect(r[3]).toBe("... +2 more rows");
});

test("dedupe collapses consecutive repeats", () => {
  const r = dedupe(["same", "same", "same", "other"]);
  expect(r.length).toBe(2);
  expect(r[0]).toBe("same  [x3]");
  expect(r[1]).toBe("other");
});

test("dedupe keeps non-consecutive lines", () => {
  const r = dedupe(["a", "b", "a"]);
  expect(r.length).toBe(3);
});

test("truncate keeps short input", () => {
  const r = truncate(["a", "b"], 40);
  expect(r.length).toBe(2);
});

test("truncate elides the middle", () => {
  let lines: string[] = [];
  for (let i = 0; i < 100; i = i + 1) lines.push("line" + i);
  const r = truncate(lines, 40);
  expect(r.length).toBe(40);
  expect(r[0]).toBe("line0");
  expect(r[34]).toBe("... [61 lines elided] ...");
  expect(r[39]).toBe("line99");
});

test("groupGitStatus groups by kind", () => {
  const r = groupGitStatus(["?? a.txt", "?? b.txt", " M src/x.ts"]);
  expect(r.length).toBe(2);
  expect(r[0]).toBe("untracked (2): a.txt, b.txt");
  expect(r[1]).toBe("modified (1): src/x.ts");
});

test("groupGitStatus empty is clean", () => {
  const r = groupGitStatus([]);
  expect(r[0]).toBe("clean");
});

test("splitLines drops blanks", () => {
  const r = splitLines("a\n\n  \nb\n");
  expect(r.length).toBe(2);
});

test("stripAnsi removes color codes", () => {
  // Build ESC (27) at runtime: string literals cannot hold raw control bytes.
  const esc = String.fromCharCode(27);
  const colored = esc + "[31mred" + esc + "[0m plain";
  expect(stripAnsi(colored)).toBe("red plain");
});

test("lsSummary drops columns and marks dirs", () => {
  const r = lsSummary([
    "total 12",
    "drwxr-xr-x 2 root root 4096 Jul 20 00:00 src",
    "-rw-r--r-- 1 root root 2048 Jul 20 00:00 a.ts",
  ]);
  expect(r.length).toBe(2);
  expect(r[0]).toBe("src/");
  expect(r[1]).toBe("a.ts  2K");
});

test("compactLog emits hash and subject", () => {
  const r = compactLog([
    "commit abcdef1234567890",
    "Author: A <a@b.c>",
    "Date: today",
    "",
    "    fix: the thing",
    "",
    "    body detail",
  ]);
  expect(r.length).toBe(1);
  expect(r[0]).toBe("abcdef1 fix: the thing");
});

test("capGrep caps per file", () => {
  const r = capGrep(["f.ts:1:a", "f.ts:2:b", "f.ts:3:c", "f.ts:4:d", "f.ts:5:e", "g.ts:1:x"]);
  expect(r.length).toBe(5);
  expect(r[4]).toBe("f.ts: +2 more matches");
});

test("filterTestOutput keeps failures and summary", () => {
  const r = filterTestOutput(["running 3 tests", "test a ... FAILED", "2 passed; 1 failed"]);
  expect(r.length).toBe(2);
});

test("filterTestOutput falls back to tail", () => {
  const r = filterTestOutput(["a", "b", "c", "d"]);
  expect(r.length).toBe(3);
  expect(r[2]).toBe("d");
});
