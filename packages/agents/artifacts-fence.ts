// Files created by fencing them in a reply, instead of calling write_artifact.
//
//   let out = extractFiles(db, threadId, baseSeq, reply, now);
//   // out.text    — the reply, each saved fence now a one-line reference
//   // out.written — the paths that were created, in reply order
//   // out.notes   — every refusal and rewrite, in words, for the run log
//
// A reply that ends with
//
//   ```html path=/index.html title=Landing page
//   <h1>Hello</h1>
//   ```
//
// is using the second door to the same storage write_artifact uses: same
// putArtifact, same versioning, same limits. What differs is the trust. A
// reply is downstream of retrieved passages, tool results and delegated
// answers, and the model echoing an injected `path=` block *is* the attack —
// so this door may only CREATE a path the thread does not have, and only of
// an inert kind (html, svg, markdown, json, text). Updates re-point preview
// links that were already handed out, and a script or stylesheet executes
// inside the shared preview page; both need write_artifact, which requires a
// provider that deliberately called a tool.
//
// The stored turn keeps a reference line instead of the body, marked with a
// nonce minted at extraction: "[artifact:<nonce>:<slot>@v<n>] /index.html".
// The model never sees the nonce in advance, so a marker already in its text
// is a parrot or a forgery, and is flattened to plain words. The raw reply,
// fences and all, still reaches the run log — the rewrite is for the thread's
// memory, not the audit trail.
//
// The scanner is written by hand in the style of scan.ts. An unterminated
// fence is not a fence: rewriting text the model did not finish quoting would
// eat half its answer.

import { Db } from "../plume/driver.ts";
import { placeholderAt } from "../plume/plume.ts";
import { ARTIFACT_MAX, ArtifactRow, getVersion, kindOf, listArtifacts, putArtifact, utf8Length } from "./artifacts.ts";
import { normalScope } from "./knowledge.ts";

// How many fences one reply may save, and how many bytes they may total. Per
// reply, on top of putArtifact's per-body and per-thread caps: a single reply
// that manufactures dozens of files or megabytes of them is not a
// conversation producing results, it is a loop — or an injection — filling
// the thread's quota in one turn.
export const REPLY_FENCES_MAX: int = 8;
export const REPLY_EXTRACT_MAX: int = 2097152;

// What a marker-lookalike becomes. Plain words, no bracket, so nothing
// downstream can mistake the replacement for a reference either.
export const CLAIMED_SAVE: string = "(claimed save — nothing was written)";

// One fence, located. The offsets are what the rewrite consumes: the fence
// occupies [open, closeEnd) — the first byte of the opener line to the last
// byte of the closing line — and the body sits at [bodyAt, close), so the
// newline after the closing line survives the replacement and the reference
// line ends a line the way the fence did. Byte offsets, and CRLF text keeps
// them byte-accurate: a "\r" before a line's "\n" is treated as trailing
// blank, never counted out of the offsets.
export type FencedFile = {
  lang: string,
  path: string,
  title: string,
  body: string,
  open: int,
  bodyAt: int,
  close: int,
  closeEnd: int,
};

// What an info string declares.
export type FenceHint = {
  lang: string,
  path: string,
  title: string,
};

// Where the line beginning at `from` ends: the index of its newline, or the
// text's length on the last line.
function lineEnd(text: string, from: int): int {
  let i = from;
  while (i < text.length && text.charAt(i) != "\n") { i = i + 1; }
  return i;
}

// How many times `mark` repeats at `at`.
function runLength(text: string, at: int, mark: string): int {
  let i = at;
  while (i < text.length && text.charAt(i) == mark) { i = i + 1; }
  return i - at;
}

// What separates info-string tokens. "\r" is a separator so CRLF text does
// not end every language and path with an invisible character.
function infoBlank(ch: string): bool {
  return ch == " " || ch == "\t" || ch == "\r";
}

// Read "html path=/index.html title=Landing page" as its three parts.
//
// The first token is the language, whatever it says — a fence's info string
// has meant that since fences existed, and reading it any other way would
// misfile ordinary quoted code. `path` and `title` are read with tolerance a
// model has earned: spaces around the separator, `:` as well as `=`, and
// quoted values — the convention is taught in one prompt line, and dropping a
// file over a byte of punctuation style would fail silently where it matters.
// An unquoted `title=` runs to the end of the line, because a title is prose
// and demanding quotes would invent a rule the model was never told.
export function fenceHint(info: string): FenceHint {
  let lang = "";
  let path = "";
  let title = "";
  let first = true;
  let i: int = 0;
  while (i < info.length) {
    while (i < info.length && infoBlank(info.charAt(i))) { i = i + 1; }
    if (i >= info.length) { break; }
    // A word runs to a blank or a separator; "path" and "title" are the two
    // words that may be keys.
    let ws = i;
    while (i < info.length) {
      let ch = info.charAt(i);
      if (infoBlank(ch) || ch == "=" || ch == ":") { break; }
      i = i + 1;
    }
    let word = info.slice(ws, i);
    let at = i;
    while (at < info.length && infoBlank(info.charAt(at))) { at = at + 1; }
    let sep = at < info.length ? info.charAt(at) : "";
    let keyed = (sep == "=" || sep == ":") && (word == "path" || word == "title");
    if (!keyed) {
      // A plain token. Only the first token of the line can be the language;
      // whatever remains of this one (a colon-joined tail, say) is consumed
      // and ignored.
      if (first && word != "") { lang = word; }
      first = false;
      while (i < info.length && !infoBlank(info.charAt(i))) { i = i + 1; }
      continue;
    }
    first = false;
    i = at + 1;
    while (i < info.length && infoBlank(info.charAt(i))) { i = i + 1; }
    let value = "";
    if (i < info.length && info.charAt(i) == "\"") {
      // A quoted value ends at the next quote, so a quoted title need not be
      // the last thing on the line.
      i = i + 1;
      let vs = i;
      while (i < info.length && info.charAt(i) != "\"") { i = i + 1; }
      value = info.slice(vs, i);
      if (i < info.length) { i = i + 1; }
    } else if (word == "title") {
      value = info.slice(i, info.length);
      // An info line often ends in a stray space or the CR of a CRLF ending,
      // and a title should carry neither.
      while (value.length > 0 && infoBlank(value.charAt(value.length - 1))) {
        value = value.slice(0, value.length - 1);
      }
      i = info.length;
    } else {
      let vs = i;
      while (i < info.length && !infoBlank(info.charAt(i))) { i = i + 1; }
      value = info.slice(vs, i);
    }
    // The last occurrence of a key on the line wins, same as the last fence
    // of a path in a reply.
    if (word == "path") { path = value; } else { title = value; }
  }
  let out: FenceHint = { lang: lang, path: path, title: title };
  return out;
}

// Whether the line [from, end) closes a fence of `n` marks of `mark`: up to
// three leading spaces, at least n of the same mark, then nothing but blanks.
// At least n, per CommonMark — which is also what keeps a three-backtick
// opener quoted inside a four-backtick block from closing anything.
function closesFence(text: string, from: int, end: int, mark: string, n: int): bool {
  let i = from;
  let spaces: int = 0;
  while (i < end && text.charAt(i) == " " && spaces < 3) { i = i + 1; spaces = spaces + 1; }
  let run = runLength(text, i, mark);
  if (run < n) { return false; }
  i = i + run;
  while (i < end) {
    if (!infoBlank(text.charAt(i))) { return false; }
    i = i + 1;
  }
  return true;
}

// Every completed backtick fence in the text, in order.
//
// Openers are 3 or more backticks or tildes at up to three leading spaces
// (CommonMark; a fourth space makes indented code, which is quotation). A
// tilde fence is recognised so its contents stay opaque, but never extracted
// from — and nothing is ever extracted from inside another fence: once an
// opener is found, the scan resumes strictly after its close, so a `path=`
// block quoted inside a wider fence is content the reply is talking *about*,
// not a file it meant to write. That is the injection this scanner exists to
// refuse.
export function fencedFiles(text: string): FencedFile[] {
  let out: FencedFile[] = [];
  let i: int = 0;
  while (i < text.length) {
    let end = lineEnd(text, i);
    let j = i;
    let spaces: int = 0;
    while (j < end && text.charAt(j) == " " && spaces < 3) { j = j + 1; spaces = spaces + 1; }
    let mark = j < end ? text.charAt(j) : "";
    if (mark != "`" && mark != "~") { i = end + 1; continue; }
    let n = runLength(text, j, mark);
    if (n < 3) { i = end + 1; continue; }
    // An opener whose info string is the last line of the text encloses
    // nothing.
    if (end >= text.length) { return out; }
    let info = text.slice(j + n, end);
    let bodyAt = end + 1;
    let k = bodyAt;
    let close: int = -1;
    let closeEnd: int = -1;
    while (k < text.length) {
      let le = lineEnd(text, k);
      if (closesFence(text, k, le, mark, n)) { close = k; closeEnd = le; break; }
      k = le + 1;
    }
    // Unterminated is not a fence, and nothing after it is either: to a
    // renderer the rest of the reply sits inside this block, and pulling
    // files out of what reads as quotation would extract exactly what the
    // nesting rule refuses.
    if (close < 0) { return out; }
    if (mark == "`") {
      let hint = fenceHint(info);
      let found: FencedFile = {
        lang: hint.lang,
        path: hint.path,
        title: hint.title,
        body: text.slice(bodyAt, close),
        open: i,
        bodyAt: bodyAt,
        close: close,
        closeEnd: closeEnd,
      };
      out.push(found);
    }
    i = closeEnd + 1;
  }
  return out;
}

// What extraction did to a reply.
export type Extracted = {
  // The reply with each saved fence replaced by its reference marker and
  // every marker-lookalike flattened to plain words.
  text: string,
  // The normalised paths that were created, in reply order.
  written: string[],
  // Each refusal as a sentence. These reach the run log through the reply's
  // notes — a fence that could not be saved must not fail silently, because
  // the reader was promised a file.
  notes: string[],
  // This round's marker nonce. Minted here, at random, and never shown to
  // the model in advance — which is what makes a marker unforgeable. The
  // transcript route strips it before anything reaches a DOM.
  nonce: string,
};

// A rewrite's outcome, since arrays and records do not mutate across a call.
export type Neutralised = {
  text: string,
  changed: bool,
};

// The reply with every marker-lookalike flattened to plain words.
//
// Only extraction knows this round's nonce, so "[artifact:...]" text that
// does not carry it was never written by extraction: it is the model
// parroting a marker it saw in an earlier turn, or third-party text forging
// one so a client renders a card for a file that was never written. Either
// way the honest reading is the same sentence. Genuine markers — minted
// moments ago by the caller — are copied through whole.
export function neutraliseMarkers(text: string, nonce: string): Neutralised {
  let out = "";
  let changed = false;
  let stamp = "[artifact:" + nonce + ":";
  let i: int = 0;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (ch != "[") { out = out + ch; i = i + 1; continue; }
    if (text.slice(i, i + 10) != "[artifact:") { out = out + ch; i = i + 1; continue; }
    let end = lineEnd(text, i);
    let j = i;
    while (j < end && text.charAt(j) != "]") { j = j + 1; }
    if (text.slice(i, i + stamp.length) == stamp) {
      // Ours. Copied through its bracket so the scan does not trip over the
      // "[" it starts with.
      let stop = j < end ? j + 1 : end;
      out = out + text.slice(i, stop);
      i = stop;
      continue;
    }
    // A lookalike. Consumed through its closing bracket when it has one on
    // this line; an unclosed one loses only the telltale opener.
    out = out + CLAIMED_SAVE;
    changed = true;
    i = j < end ? j + 1 : i + 10;
  }
  let done: Neutralised = { text: out, changed: changed };
  return done;
}

// One reference as the wire carries it: the slot and version a chat card
// resolves by — never the position of the marker in the prose — and the path
// its caption shows.
export type WireRef = {
  slot: int,
  version: int,
  path: string,
};

// A stored reply, fit for a client.
export type WireView = {
  text: string,
  refs: WireRef[],
};

// Where the run of ASCII digits starting at `at` ends.
function digitsEnd(text: string, at: int): int {
  let i = at;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c < 48 || c > 57) { break; }
    i = i + 1;
  }
  return i;
}

// The stored reply as the wire serves it: every genuine reference marker
// becomes a plain "[saved <path> v<n>]" caption plus a structured ref, and
// the nonce never leaves the server. The nonce's whole value is that nothing
// client-side can learn it — a marker in the DOM would be a marker the next
// reply could parrot with its round's stamp intact.
//
// Anything bracketed that does not parse as a whole marker is copied through
// untouched: storage already flattened the lookalikes it saw, and half a
// marker is prose, not a reference.
export function wireView(text: string): WireView {
  let out = "";
  let refs: WireRef[] = [];
  let i: int = 0;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (ch != "[" || text.slice(i, i + 10) != "[artifact:") { out = out + ch; i = i + 1; continue; }
    // The nonce: extraction minted a UUID, so it runs to the next ":" and
    // holds neither a bracket nor a line break.
    let j = i + 10;
    while (j < text.length) {
      let c = text.charAt(j);
      if (c == ":" || c == "]" || c == "\n") { break; }
      j = j + 1;
    }
    if (j <= i + 10 || j >= text.length || text.charAt(j) != ":") { out = out + ch; i = i + 1; continue; }
    let slotAt = j + 1;
    let slotEnd = digitsEnd(text, slotAt);
    if (slotEnd == slotAt || text.slice(slotEnd, slotEnd + 2) != "@v") { out = out + ch; i = i + 1; continue; }
    let versionAt = slotEnd + 2;
    let versionEnd = digitsEnd(text, versionAt);
    if (versionEnd == versionAt || versionEnd >= text.length || text.charAt(versionEnd) != "]") {
      out = out + ch;
      i = i + 1;
      continue;
    }
    // The path: the one blank-free token extraction always wrote after the
    // bracket. A marker without one is not one of ours.
    let k = versionEnd + 1;
    while (k < text.length && text.charAt(k) == " ") { k = k + 1; }
    let ps = k;
    while (k < text.length) {
      let c = text.charAt(k);
      if (infoBlank(c) || c == "\n") { break; }
      k = k + 1;
    }
    let path = text.slice(ps, k);
    if (path == "") { out = out + ch; i = i + 1; continue; }
    let slot = parseInt(text.slice(slotAt, slotEnd)) ?? -1;
    let version = parseInt(text.slice(versionAt, versionEnd)) ?? 0;
    out = out + "[saved " + path + " v" + `${version}` + "]";
    let ref: WireRef = { slot: slot, version: version, path: path };
    refs.push(ref);
    i = k;
  }
  let view: WireView = { text: out, refs: refs };
  return view;
}

// The paths this round has already written, lowercased for comparison.
//
// Read from the version log rather than from the run's own steps because a
// delegated child's write_artifact never appears in the parent's steps — the
// join is the only witness that sees every door and every agent. The
// `turn_seq >= 0` guard is belted on even though the caller checks baseSeq:
// TURN_SEQ_NONE marks writes no round made, and a turn-scoped read that
// could match it would credit console uploads to a conversation round.
function roundPaths(db: Db, threadId: string, baseSeq: int): string[] {
  let out: string[] = [];
  if (baseSeq < 0) { return out; }
  let sql = "SELECT artifacts.path FROM artifact_versions"
    + " JOIN artifacts ON artifacts.id = artifact_versions.artifact_id"
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1)
    + " AND artifact_versions.turn_seq = " + placeholderAt(db, 2)
    + " AND artifact_versions.turn_seq >= 0";
  if (!db.query(sql, [threadId, `${baseSeq}`])) { return out; }
  let i: int = 0;
  while (i < db.rows()) {
    out.push(db.value(i, 0).toLowerCase());
    i = i + 1;
  }
  return out;
}

function contains(list: string[], item: string): bool {
  let i: int = 0;
  while (i < list.length) {
    if (list[i] == item) { return true; }
    i = i + 1;
  }
  return false;
}

// Whether a later fence names the same path, compared lowercased. The last
// body is the file the model meant, and writing both would file a draft as a
// version.
function laterFenceHas(paths: string[], k: int): bool {
  let lower = paths[k].toLowerCase();
  let m = k + 1;
  while (m < paths.length) {
    if (paths[m] != "" && paths[m].toLowerCase() == lower) { return true; }
    m = m + 1;
  }
  return false;
}

// Where `path` sits among the thread's artifacts, compared lowercased, or -1.
function existingIndex(haveLower: string[], path: string): int {
  let lower = path.toLowerCase();
  let i: int = 0;
  while (i < haveLower.length) {
    if (haveLower[i] == lower) { return i; }
    i = i + 1;
  }
  return -1;
}

// Save every fenced file in `text` that the fence door admits, and hand back
// the reply the thread should keep.
//
// `baseSeq` is the round's base turn seq — the same number the tool door
// stamps — so "what did this round produce" is one join whichever door was
// used. The caller appends the raw turns first; extraction only runs against
// a round that is actually stored.
export function extractFiles(db: Db, threadId: string, baseSeq: int, text: string, now: string): Extracted {
  let written: string[] = [];
  let notes: string[] = [];
  let nonce = crypto.randomUUID();

  // No stored round, no extraction. A write stamped TURN_SEQ_NONE would
  // dodge every turn-scoped join — the round dedupe below included — and a
  // file the transcript cannot account for is worse than a fence left in
  // prose. The lookalike pass still runs: forged markers are forged whether
  // or not anything was extractable.
  if (baseSeq < 0) {
    notes.push("no files were extracted: this reply has no stored round to attach them to");
    let bare = neutraliseMarkers(text, nonce);
    if (bare.changed) {
      notes.push("text resembling a saved-file reference was not one; rewritten to say so");
    }
    let bail: Extracted = { text: bare.text, written: written, notes: notes, nonce: nonce };
    return bail;
  }

  let fences = fencedFiles(text);

  // What the thread already holds, spelled as stored, compared lowercased:
  // /Report.html must not slip past /report.html as "new". The preview host
  // would happily serve both, and a reader cannot tell which one a link
  // means.
  let have: ArtifactRow[] = listArtifacts(db, threadId);
  let haveLower: string[] = [];
  let h: int = 0;
  while (h < have.length) {
    haveLower.push(have[h].path.toLowerCase());
    h = h + 1;
  }
  let round = roundPaths(db, threadId, baseSeq);

  // Every fence path normalised once, and snapped to an existing artifact's
  // spelling when it differs only by case — which the create-only rule below
  // then refuses as an update, correctly: a near-miss spelling meant the
  // existing file, not a second one.
  let paths: string[] = [];
  let f: int = 0;
  while (f < fences.length) {
    let raw = fences[f].path;
    if (raw == "") {
      paths.push("");
      f = f + 1;
      continue;
    }
    let p = normalScope(raw);
    let snap = existingIndex(haveLower, p);
    if (snap >= 0) { p = have[snap].path; }
    paths.push(p);
    f = f + 1;
  }

  // Every fence is decided before any is written: the caps are per reply,
  // and a cap discovered halfway through the write pass would leave the
  // reply half extracted. This also keeps refusals ahead of any transaction.
  let act: int[] = [];
  let accepted: int = 0;
  let bytesTotal: int = 0;
  let k: int = 0;
  while (k < fences.length) {
    let fence = fences[k];
    let path = paths[k];
    let take: int = 0;
    let bytes = utf8Length(fence.body);
    let existing = path == "" ? -1 : existingIndex(haveLower, path);
    let kind = path == "" ? "" : kindOf(path);
    if (path == "") {
      // No path= means quoted code, untouched.
    } else if (laterFenceHas(paths, k)) {
      // Superseded within the reply; the last occurrence wins, silently —
      // nothing failed, the model revised as it wrote.
    } else if (contains(round, path.toLowerCase())) {
      // Already written this round through some door — write_artifact, a
      // delegated child, an earlier extraction. One file, and the write that
      // already ran wins; a second write here would stamp a version the
      // model was never told about.
      notes.push("left the fence for " + path + " as written: this round already saved that path");
    } else if (existing >= 0) {
      // Create-only. Appending a version through a fence is the
      // overwrite-a-shared-link attack: the preview token survives versions
      // by design, so an echoed fence would silently re-point every link
      // already handed out.
      let current = getVersion(db, have[existing].id, have[existing].currentVersion);
      if (current.id != "" && current.body == fence.body) {
        // The model re-displayed the file. Nothing changed, so nothing is
        // written — at zero false positives.
        notes.push("did not save " + path + ": unchanged from version " + `${have[existing].currentVersion}`);
      } else {
        notes.push("did not save " + path + ": update " + path + " needs write_artifact");
      }
    } else if (kind == "javascript" || kind == "css") {
      // Executable kinds run inside the shared preview page. They only enter
      // through the tool, which requires a provider that deliberately called
      // it — never through text the model may merely be echoing.
      notes.push("did not save " + path + ": a " + kind + " file needs write_artifact — a fence only creates inert files");
    } else if (kind == "code") {
      notes.push("did not save " + path + ": a fenced file may only create html, svg, markdown, json or text — save it with write_artifact");
    } else if (bytes > ARTIFACT_MAX) {
      // Checked here so an oversized body never opens a transaction, and the
      // refusal is worded about a fence rather than surfacing as a tool
      // answer nobody called for.
      notes.push("did not save " + path + ": an artifact is at most " + `${ARTIFACT_MAX}` + " bytes; this one is " + `${bytes}`);
    } else if (accepted >= REPLY_FENCES_MAX) {
      notes.push("did not save " + path + ": at most " + `${REPLY_FENCES_MAX}` + " fenced files are saved per reply");
    } else if (bytesTotal + bytes > REPLY_EXTRACT_MAX) {
      notes.push("did not save " + path + ": a reply's fences save at most " + `${REPLY_EXTRACT_MAX}` + " bytes in total");
    } else {
      accepted = accepted + 1;
      bytesTotal = bytesTotal + bytes;
      take = 1;
    }
    // An unknown extension (kind == "") falls through to putArtifact, whose
    // path refusal names the legal extensions better than this file could.
    act.push(take);
    k = k + 1;
  }

  let out = "";
  let cursor: int = 0;
  let w: int = 0;
  while (w < fences.length) {
    if (act[w] == 1) {
      let fence = fences[w];
      let path = paths[w];
      let saved = putArtifact(db, {
        threadId: threadId,
        path: path,
        title: fence.title,
        content: fence.body,
        note: "written in reply",
        // This call site knows who produced the body, same as the tool door:
        // a fence is the model writing, never an upload.
        origin: "generated",
        // Create-only, enforced inside the write's own transaction: the
        // snapshot this function checked above can be stale by one concurrent
        // request, and a fence must never append to a path it did not create.
        mustCreate: true,
        turnSeq: baseSeq,
        now: now,
      });
      if (!saved.ok) {
        // The fence stays exactly as written and the refusal goes to the run
        // log: replacing it with a reference to a version that does not
        // exist would show the reader a save that never happened.
        notes.push("did not save " + path + ": " + saved.problem);
      } else {
        out = out + text.slice(cursor, fence.open)
          + "[artifact:" + nonce + ":" + `${saved.slot}` + "@v" + `${saved.version}` + "] " + path;
        cursor = fence.closeEnd;
        written.push(path);
      }
    }
    w = w + 1;
  }
  out = out + text.slice(cursor, text.length);

  // Last, so it covers the prose between fences and the bodies of refused
  // ones alike — anything that stays in the stored turn is text the
  // transcript route will read markers out of.
  let neutral = neutraliseMarkers(out, nonce);
  if (neutral.changed) {
    notes.push("text resembling a saved-file reference was not one; rewritten to say so");
  }
  let done: Extracted = { text: neutral.text, written: written, notes: notes, nonce: nonce };
  return done;
}
