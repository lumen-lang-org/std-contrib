// Finding text in a thread's artifacts, and finding it inside one body.
//
//   let found = searchArtifacts(db, threadId, "getVersion(");   // discovery
//   let hits  = editHits(body, oldText, 8);                     // the edit's match
//
// Every scanner here is a hand-written byte walk in the scan.ts idiom: a Lumen
// string is UTF-8 bytes, charAt and charCodeAt address bytes, and nothing is
// folded, normalized or pattern-matched. That is the contract edit_artifact
// depends on — `old` matches the stored body byte for byte or not at all —
// and the reason a search query containing `a.*b` finds those four bytes and
// nothing else.
//
// Every length in this file is therefore a byte count, and every sentence that
// reports one to the model says "bytes" — see searchQueryProblem.
//
// The namespace is flat, so every export here is `search`- or `edit`-prefixed.
//
//   cd packages/agents && lumen test artifacts-search.test.ts

import { Db } from "../plume/driver.ts";
import { countWhere, placeholderAt } from "../plume/plume.ts";
import { artifactsMapping } from "./artifacts.ts";
import { likeLiteral } from "./knowledge.ts";

// The caps a search answer lives under: hits across the thread, hits per
// artifact, and the query's own bounds. Twenty lines is a screen the model
// can act on; a body's worth is the file again, which read_artifact already
// serves.
export const SEARCH_HITS_MAX: int = 20;
export const SEARCH_ARTIFACT_HITS_MAX: int = 5;
export const SEARCH_QUERY_MIN: int = 2;
export const SEARCH_QUERY_MAX: int = 200;

// One place a search query was found.
export type ArtifactHit = {
  path: string,
  slot: int,
  version: int,
  // 1-based body line, or 0 for a hit on the path or title rather than in
  // the body.
  line: int,
  // The matching line, cut to SEARCH_SNIPPET_MAX bytes with a visible marker
  // when it was longer — see searchSnippet.
  text: string,
  cut: bool,
};

// The longest line a search hit or a refusal will quote, in bytes. Long
// enough to widen an ambiguous `old` from, short enough that twenty hits do
// not cost a screen each.
export const SEARCH_SNIPPET_MAX: int = 160;

// The marker a cut line ends in. Visible on purpose: a model that copies a
// cut snippet into edit_artifact's `old` copies the marker too, the marker is
// not in the body, and the exact match refuses — loudly — instead of splicing
// a line whose invisible tail would be silently orphaned.
export const SEARCH_CUT_MARK: string = " [cut]";

// One occurrence of an edit's `old` inside a body: its byte offset and its
// 1-based line.
export type EditHit = {
  at: int,
  line: int,
};

// Whether `needle` sits at byte `at` of `body`, compared byte for byte.
function editMatchAt(body: string, at: int, needle: string): bool {
  let i: int = 0;
  while (i < needle.length) {
    if (body.charCodeAt(at + i) != needle.charCodeAt(i)) { return false; }
    i = i + 1;
  }
  return true;
}

// Every occurrence of `needle` in `body`, counted OVERLAPPING: the walk
// advances by one byte, never by the needle's length, so "aa" occurs twice in
// "aaa". Counted non-overlapping it would be "unique", and the edit built on
// that answer would splice the wrong region — a silent failure hiding inside
// the uniqueness rule.
//
// Stops as soon as most+1 hits are found: "more than most" is then knowable
// without walking a 512 KiB body to its end, and the caller treats a result
// longer than `most` as "too many to list".
//
// An empty needle matches nothing rather than everywhere — the refusal for an
// empty `old` belongs to the edit, and a scanner that answered "every offset"
// would hand it a lie to refuse with.
export function editHits(body: string, needle: string, most: int): EditHit[] {
  let out: EditHit[] = [];
  if (needle.length == 0) { return out; }
  if (needle.length > body.length) { return out; }
  let line: int = 1;
  let i: int = 0;
  let last = body.length - needle.length;
  while (i <= last) {
    if (editMatchAt(body, i, needle)) {
      let hit: EditHit = { at: i, line: line };
      out.push(hit);
      if (out.length > most) { return out; }
    }
    if (body.charAt(i) == "\n") { line = line + 1; }
    i = i + 1;
  }
  return out;
}

// What a search answered.
export type ArtifactSearch = {
  ok: bool,
  hits: ArtifactHit[],
  // How many artifacts the thread holds — every one of them was searched.
  searched: int,
  // Whether either cap dropped a hit that exists.
  capped: bool,
  problem: string,
};

function searchRefusal(why: string): ArtifactSearch {
  let none: ArtifactHit[] = [];
  let out: ArtifactSearch = { ok: false, hits: none, searched: 0, capped: false, problem: why };
  return out;
}

// The sentence for a query the tool will not run. "" when the query is fine.
// One line only and no control characters, because every hit is quoted back
// into model context one line at a time, and a query that could match across
// a line break would produce hits no line can carry.
//
// The length is a byte count and the sentence says so. A string here is UTF-8
// bytes, so a query of Arabic or an emoji is two to four bytes per character,
// and a refusal that said "characters" would hand a model arithmetic it cannot
// reproduce — it counts what it wrote, sees 150, and is told that is 300.
function searchQueryProblem(query: string): string {
  if (query.length < SEARCH_QUERY_MIN || query.length > SEARCH_QUERY_MAX) {
    return "a search query is " + `${SEARCH_QUERY_MIN}` + " to " + `${SEARCH_QUERY_MAX}`
      + " bytes of UTF-8; this one is " + `${query.length}`;
  }
  let i: int = 0;
  while (i < query.length) {
    let c = query.charCodeAt(i);
    if (c < 32 || c == 127) {
      return "a search query is one line of plain text — no newlines or control characters";
    }
    i = i + 1;
  }
  return "";
}

// Where the line beginning at `from` ends: its newline, or the body's end.
// A CR before the newline is stepped off, so a CRLF body's snippet never
// carries an invisible tail.
function searchLineStop(body: string, from: int): int {
  let i = from;
  while (i < body.length && body.charAt(i) != "\n") { i = i + 1; }
  if (i > from && body.charAt(i - 1) == "\r") { return i - 1; }
  return i;
}

// Whether `line` contains `query` as an exact substring — the same byte walk
// as editHits, answering only yes or no.
function searchLineHas(line: string, query: string): bool {
  if (query.length > line.length) { return false; }
  let last = line.length - query.length;
  let i: int = 0;
  while (i <= last) {
    if (editMatchAt(line, i, query)) { return true; }
    i = i + 1;
  }
  return false;
}

// Find `query` in every current body, path and title of the thread's
// artifacts. Exact substring — no patterns, no case folding — so the line a
// hit quotes is text edit_artifact's `old` can match verbatim.
//
// The SQL is a pre-filter: it narrows the walk to artifacts whose path,
// title or current body can contain the query, and the byte-exact line scan
// decides what is actually a hit. The query passes through likeLiteral or a
// "%" or "_" in it silently widens the LIKE. Only the current version is
// joined — a hit against an old version is a line edit_artifact can no
// longer match. No transaction: version rows are immutable, so the worst
// staleness is a hit against a version that is no longer newest, which the
// edit's own match then refuses.
export function searchArtifacts(db: Db, threadId: string, query: string): ArtifactSearch {
  let bad = searchQueryProblem(query);
  if (bad != "") { return searchRefusal(bad); }

  let searched = countWhere(db, artifactsMapping(), "thread_id = " + placeholderAt(db, 1), [threadId]);
  if (searched < 0) { return searchRefusal("could not count this thread's artifacts"); }

  // ESCAPE '!' is likeLiteral's own escape character (knowledge.ts:186),
  // written literally because the two must agree and the constant is that
  // file's private business.
  let pattern = "%" + likeLiteral(query) + "%";
  let sql = "SELECT artifacts.path, artifacts.slot, artifacts.title, artifacts.current_version, artifact_versions.body"
    + " FROM artifacts"
    + " JOIN artifact_versions ON artifact_versions.artifact_id = artifacts.id"
    + " AND artifact_versions.version = artifacts.current_version"
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1)
    + " AND (artifacts.path LIKE " + placeholderAt(db, 2) + " ESCAPE '!'"
    + " OR artifacts.title LIKE " + placeholderAt(db, 3) + " ESCAPE '!'"
    + " OR artifact_versions.body LIKE " + placeholderAt(db, 4) + " ESCAPE '!')"
    + " ORDER BY artifacts.slot";
  if (!db.query(sql, [threadId, pattern, pattern, pattern])) {
    return searchRefusal("could not search this thread's artifacts");
  }

  // The rows are read out whole before the walk: the line scans below issue
  // no queries, but a driver whose cursor did not survive one would make
  // this loop fragile for no reason.
  let paths: string[] = [];
  let slots: int[] = [];
  let titles: string[] = [];
  let versions: int[] = [];
  let bodies: string[] = [];
  let r: int = 0;
  while (r < db.rows()) {
    paths.push(db.value(r, 0));
    slots.push(parseInt(db.value(r, 1)) ?? -1);
    titles.push(db.value(r, 2));
    versions.push(parseInt(db.value(r, 3)) ?? 0);
    bodies.push(db.value(r, 4));
    r = r + 1;
  }

  let hits: ArtifactHit[] = [];
  let capped = false;
  let a: int = 0;
  while (a < paths.length) {
    let mine: int = 0;

    // Path and title first — they are what the pre-filter may have matched
    // on, and a hit on either is an artifact worth reading even when the
    // body says nothing. Line 0 marks a hit that is not a body line.
    if (searchLineHas(paths[a], query)) {
      let snip = searchSnippet(paths[a]);
      let hit: ArtifactHit = { path: paths[a], slot: slots[a], version: versions[a], line: 0, text: snip.text, cut: snip.cut };
      if (hits.length >= SEARCH_HITS_MAX) { capped = true; } else { hits.push(hit); mine = mine + 1; }
    }
    if (titles[a] != "" && searchLineHas(titles[a], query)) {
      let snip = searchSnippet(titles[a]);
      let hit: ArtifactHit = { path: paths[a], slot: slots[a], version: versions[a], line: 0, text: snip.text, cut: snip.cut };
      if (mine >= SEARCH_ARTIFACT_HITS_MAX || hits.length >= SEARCH_HITS_MAX) { capped = true; } else { hits.push(hit); mine = mine + 1; }
    }

    let body = bodies[a];
    let i: int = 0;
    let line: int = 1;
    while (i <= body.length) {
      let stop = searchLineStop(body, i);
      let text = body.slice(i, stop);
      if (searchLineHas(text, query)) {
        if (mine >= SEARCH_ARTIFACT_HITS_MAX || hits.length >= SEARCH_HITS_MAX) {
          // A hit exists that the answer will not carry.
          capped = true;
          break;
        }
        let snip = searchSnippet(text);
        let hit: ArtifactHit = { path: paths[a], slot: slots[a], version: versions[a], line: line, text: snip.text, cut: snip.cut };
        hits.push(hit);
        mine = mine + 1;
      }
      // Past the newline (and the CR the stop stepped off, when there was
      // one) to the next line's first byte.
      while (stop < body.length && body.charAt(stop) != "\n") { stop = stop + 1; }
      i = stop + 1;
      line = line + 1;
    }
    a = a + 1;
  }

  let out: ArtifactSearch = { ok: true, hits: hits, searched: searched, capped: capped, problem: "" };
  return out;
}

// A byte the loose scan may skip: space, tab or CR. Not LF — a newline is
// structure, and skipping it would find "near misses" that splice two lines.
function editLooseBlank(c: int): bool {
  return c == 32 || c == 9 || c == 13;
}

// Whether `needle` matches at `at` with both sides skipping runs of space,
// tab and CR. Byte-exact everywhere else.
function editLooseAt(body: string, at: int, needle: string): bool {
  let bi = at;
  let ni: int = 0;
  while (ni < needle.length) {
    if (editLooseBlank(needle.charCodeAt(ni))) { ni = ni + 1; continue; }
    while (bi < body.length && editLooseBlank(body.charCodeAt(bi))) { bi = bi + 1; }
    if (bi >= body.length) { return false; }
    if (body.charCodeAt(bi) != needle.charCodeAt(ni)) { return false; }
    bi = bi + 1;
    ni = ni + 1;
  }
  return true;
}

// The near-miss scanner behind the zero-match refusal: the same walk as
// editHits, with both sides skipping runs of space, tab and CR — so a needle
// whose only drift is tab-for-space indentation or CRLF-for-LF endings is
// found and its line named, and the model is told where to reread instead of
// guessing. Answers the 1-based line of the first loose match, or -1.
//
// It cannot see unicode normalization differences — an NFC body and an NFD
// needle are different bytes everywhere that matters — and it does not claim
// to. That blindness is asserted in the tests, deliberately.
export function editLoose(body: string, needle: string): int {
  // The needle's first byte that is not skippable. A needle of nothing but
  // blanks has no anchor and would "match" at every position.
  let ns: int = 0;
  while (ns < needle.length && editLooseBlank(needle.charCodeAt(ns))) { ns = ns + 1; }
  if (ns >= needle.length) { return -1; }
  let first = needle.charCodeAt(ns);
  let line: int = 1;
  let i: int = 0;
  while (i < body.length) {
    if (body.charCodeAt(i) == first) {
      if (editLooseAt(body, i, needle.slice(ns, needle.length))) { return line; }
    }
    if (body.charAt(i) == "\n") { line = line + 1; }
    i = i + 1;
  }
  return -1;
}

// The 1-based line holding byte `at`: one plus the newlines before it. CRLF
// text counts on the LF alone, so a "\r" never splits a line in two.
export function editLineAt(body: string, at: int): int {
  let line: int = 1;
  let i: int = 0;
  while (i < at && i < body.length) {
    if (body.charAt(i) == "\n") { line = line + 1; }
    i = i + 1;
  }
  return line;
}

// A byte that continues a UTF-8 character rather than starting one: 10xxxxxx.
function searchContinuationByte(b: int): bool {
  return b >= 128 && b < 192;
}

// One line as a hit quotes it: whole up to SEARCH_SNIPPET_MAX bytes, and cut
// there otherwise — on a UTF-8 boundary, walking back off continuation bytes
// the way argsPreview does (steps.ts:212), because a cut through a multi-byte
// character poisons the row that quotes it — with the visible SEARCH_CUT_MARK
// appended so an honestly copied snippet fails an exact match instead of
// splicing a line whose tail it never saw.
//
// Only `text` and `cut` are meaningful here; the caller builds the real hit
// around them, because a record has no defaults to lean on and this function
// does not know the path.
export function searchSnippet(lineText: string): ArtifactHit {
  let text = lineText;
  let cut = false;
  if (lineText.length > SEARCH_SNIPPET_MAX) {
    let end = SEARCH_SNIPPET_MAX;
    while (end > 0 && searchContinuationByte(lineText.charCodeAt(end))) { end = end - 1; }
    text = lineText.slice(0, end) + SEARCH_CUT_MARK;
    cut = true;
  }
  let out: ArtifactHit = { path: "", slot: -1, version: 0, line: 0, text: text, cut: cut };
  return out;
}

// The start of the line holding byte `at`, walked back `up` further lines.
function editLineStart(body: string, at: int, up: int): int {
  let start = at;
  while (start > 0 && body.charAt(start - 1) != "\n") { start = start - 1; }
  let back: int = 0;
  while (back < up && start > 0) {
    start = start - 1;
    while (start > 0 && body.charAt(start - 1) != "\n") { start = start - 1; }
    back = back + 1;
  }
  return start;
}

// The success reply's echo: the lines the splice touched, with two lines
// either side, cut at the file's edges. `from` and `to` are byte offsets into
// the (new) body — the replacement sits at [from, to), and a deletion has
// from == to. The echo is the only tripwire for the wrong-site edit — a
// unique `old` at the wrong one of two near-identical sites — so it shows
// what actually changed, not what the model believes changed.
export function editContext(body: string, from: int, to: int): string {
  let f = from;
  if (f < 0) { f = 0; }
  if (f > body.length) { f = body.length; }
  let t = to;
  if (t < f) { t = f; }
  if (t > body.length) { t = body.length; }
  let start = editLineStart(body, f, 2);
  // The last changed byte's line. A replacement ending in a newline ends a
  // line rather than starting the next, so the anchor steps back off it.
  let anchor = t;
  if (t > f && body.charAt(t - 1) == "\n") { anchor = t - 1; }
  let end = anchor;
  while (end < body.length && body.charAt(end) != "\n") { end = end + 1; }
  let ahead: int = 0;
  while (ahead < 2 && end < body.length) {
    // The next line starts past this newline; a body ending in "\n" has
    // nothing there, and the trailing empty segment is not a line.
    if (end + 1 >= body.length) { break; }
    end = end + 1;
    while (end < body.length && body.charAt(end) != "\n") { end = end + 1; }
    ahead = ahead + 1;
  }
  return body.slice(start, end);
}
