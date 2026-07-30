// A line diff between two versions of a text artifact.
//
// LCS over lines, exact — no heuristics, no hunk headers. The panel shows a
// whole file, so the diff shows the whole file too: unchanged lines stay in
// place and the changed ones carry a sign, which is how a reader keeps their
// bearings in a document they know.

export type DiffRow = {
  kind: "same" | "add" | "del";
  text: string;
  // 1-based line numbers in the old and new versions; 0 where the row does
  // not exist on that side.
  a: number;
  b: number;
};

// Past this many lines a side, the quadratic table stops being free and the
// reader stopped reading anyway.
export const DIFF_MAX_LINES = 4000;

export function diffLines(oldText: string, newText: string): DiffRow[] | null {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null;

  // Trim the common prefix and suffix first: a version edit usually changes
  // a few lines in the middle of a file that is otherwise identical, and the
  // quadratic LCS table then only has to cover the changed middle. The
  // product cap below bounds the table's memory; a pair of versions whose
  // middles are both enormous answers null and the panel says so, rather
  // than allocating tens of megabytes to draw it.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > 1_000_000) return null;

  const w = midB.length + 1;
  const table = new Uint16Array((midA.length + 1) * w);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      table[i * w + j] = midA[i] === midB[j]
        ? table[(i + 1) * w + j + 1] + 1
        : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  for (let n = 0; n < start; n++) rows.push({ kind: "same", text: a[n], a: n + 1, b: n + 1 });
  let i = 0, j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      rows.push({ kind: "same", text: midA[i], a: start + i + 1, b: start + j + 1 });
      i++; j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
      rows.push({ kind: "del", text: midA[i], a: start + i + 1, b: 0 });
      i++;
    } else {
      rows.push({ kind: "add", text: midB[j], a: 0, b: start + j + 1 });
      j++;
    }
  }
  while (i < midA.length) { rows.push({ kind: "del", text: midA[i], a: start + i + 1, b: 0 }); i++; }
  while (j < midB.length) { rows.push({ kind: "add", text: midB[j], a: 0, b: start + j + 1 }); j++; }
  for (let n = 0; n < a.length - endA; n++) {
    rows.push({ kind: "same", text: a[endA + n], a: endA + n + 1, b: endB + n + 1 });
  }
  return rows;
}

// How many rows changed, for the toggle's own label.
export function diffCounts(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    if (r.kind === "del") removed++;
  }
  return { added, removed };
}
