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

// --- tests ---

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
