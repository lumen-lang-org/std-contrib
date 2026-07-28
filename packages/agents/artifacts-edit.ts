// Changing part of an artifact without resending the rest.
//
//   let done = editArtifact(db, { threadId: t, path: "/report.html",
//                                 oldText: was, newText: is,
//                                 note: "", turnSeq: seq, now: now });
//
// `old` is matched against the current body as an exact substring — counted
// overlapping by editHits, so an ambiguous old is refused rather than spliced
// — and replaced once, saved as the next version through the same append-only
// log putArtifact writes. The echoed `old` is the load-bearing safety
// property: it can only have come from a read_artifact body or a
// search_artifacts hit, so an edit is proof its author read the file.
//
// On the wire the fields are `old` and `new`; here they are oldText and
// newText, because `new` is a reserved word and the compiler would refuse the
// field. The scan.ts unpacking in tools.ts is what decouples the spellings.
//
// No failure path below throws. A `throw` does not propagate out of a lambda
// — the fixpoint pass cannot see through a function value, so a `try` in the
// dispatch loop would catch nothing — and every scanner this calls is a
// straight-line loop. Failure is a returned `problem` sentence, in
// putArtifact's refusal() idiom.
//
//   cd packages/agents && lumen test artifacts-edit.test.ts

import { Db } from "../plume/driver.ts";
import { executeWith, placeholderAt, beginTransaction, commitTransaction, rollbackTransaction } from "../plume/plume.ts";
import { ARTIFACT_MAX, ARTIFACT_NOTE_MAX, THREAD_BYTES_MAX, getArtifact, getVersion, labelProblem, nextVersion, threadBytes, utf8Length } from "./artifacts.ts";
import { ArtifactHit, editHits, editLineAt, editLoose, editContext, searchSnippet } from "./artifacts-search.ts";
import { normalScope } from "./knowledge.ts";

// How many numbered matches a multi-match refusal will list before saying
// "more than". Eight is enough to widen `old` from; a body's worth is not a
// refusal, it is the file again.
export const EDIT_HITS_MOST: int = 8;

// How many times the edit re-reads and re-matches after losing the version
// race before giving up — the same figure as putArtifact's WRITE_ATTEMPTS,
// for the same reason: two writers colliding is ordinary, four collisions on
// one path in the time this takes is a loop.
const EDIT_ATTEMPTS: int = 4;

// One edit, as the transaction takes it. A record and not seven positional
// arguments, for the same reason ArtifactWrite is (artifacts.ts:359): five of
// these are consecutive strings, and `oldText` sitting where `note` belongs
// files the text to replace as an audit comment without complaint.
export type ArtifactEdit = {
  threadId: string,
  path: string,
  // Wire names old/new; `new` is a reserved word here.
  oldText: string,
  newText: string,
  // Why this version exists. "" is synthesized as "edit at line L" so the
  // human version log never shows a blank reason for a machine-made version.
  note: string,
  turnSeq: int,
  now: string,
};

export type ArtifactEdited = {
  ok: bool,
  slot: int,
  version: int,
  // The 1-based line the change begins on.
  line: int,
  // The new body's size in bytes.
  bytes: int,
  // The changed lines with two either side, when ok. Untrusted the way every
  // artifact body is — the tool layer passes it through wireView before it
  // reaches model context.
  context: string,
  // The numbered matches, only on a multi-match refusal.
  hits: ArtifactHit[],
  problem: string,
};

function editRefusal(why: string): ArtifactEdited {
  let none: ArtifactHit[] = [];
  let out: ArtifactEdited = {
    ok: false, slot: -1, version: 0, line: 0, bytes: 0,
    context: "", hits: none, problem: why,
  };
  return out;
}

// The multi-match refusal, hits attached: numbered lines with snippets, so
// widening `old` is a copy job rather than a fresh read.
function editAmbiguous(path: string, version: int, found: ArtifactHit[], tooMany: bool): ArtifactEdited {
  let count = tooMany ? "more than " + `${EDIT_HITS_MOST}` + " times" : `${found.length}` + " times";
  let why = "old matches " + count + " in " + path + " (version " + `${version}` + "); "
    + "include more surrounding text until it matches exactly once:";
  let i: int = 0;
  while (i < found.length) {
    why = why + "\n  " + `${i + 1}` + ". line " + `${found[i].line}` + ": " + found[i].text;
    i = i + 1;
  }
  let out: ArtifactEdited = {
    ok: false, slot: -1, version: 0, line: 0, bytes: 0,
    context: "", hits: found, problem: why,
  };
  return out;
}

// Change one occurrence of `oldText` to `newText` in the artifact at `path`,
// as the next version.
//
// Attempted up to EDIT_ATTEMPTS times, mirroring putAttempt (artifacts.ts:430).
// The INSERT lands at exactly N+1 and the unique index on (artifact_id,
// version) from migration 53 is the compare-and-swap: anything that appended
// N+1 in between fails the INSERT, the transaction rolls back, and the retry
// re-reads the NEW body and re-matches oldText against it — merging when the
// concurrent change was elsewhere in the file, refusing when it touched the
// edited region. A version row, once written, is never replaced.
export function editArtifact(db: Db, edit: ArtifactEdit): ArtifactEdited {
  if (edit.threadId == "") { return editRefusal("an artifact belongs to a thread"); }
  if (edit.oldText == "") {
    return editRefusal("old is empty, and empty text would match everywhere; send the exact text to replace, verbatim from the current version");
  }
  if (edit.oldText == edit.newText) {
    return editRefusal("old and new are identical; nothing would change, and a version that changes nothing is not saved");
  }
  let badNote = labelProblem("note", edit.note, ARTIFACT_NOTE_MAX);
  if (badNote != "") { return editRefusal(badNote); }
  return editAttempt(db, edit, 1);
}

function editAttempt(db: Db, edit: ArtifactEdit, attempt: int): ArtifactEdited {
  let path = normalScope(edit.path);

  let opened = beginTransaction(db);
  if (!opened.ok) { return editRefusal("the edit could not be saved; try again"); }

  // An edit never creates — so a typoed path cannot fork a second file the
  // way a mistyped write_artifact path silently does. The sentence is
  // read_artifact's (tools.ts), so the two doors describe absence identically.
  let artifact = getArtifact(db, edit.threadId, path);
  if (artifact.id == "") {
    rollbackTransaction(db);
    return editRefusal("There is no artifact at " + path + " in this conversation.");
  }

  // The base version N. The first attempt reads the pointer — the version
  // read_artifact advertises, and the broken-pointer state must refuse, not
  // be papered over. A retry is only reached after the unique index proved a
  // newer version exists, and the pointer may not have caught up to the
  // winner yet, so the retry reads the log's own MAX instead.
  let n = artifact.currentVersion;
  if (attempt > 1) {
    let past = nextVersion(db, artifact.id);
    if (past < 2) {
      rollbackTransaction(db);
      return editRefusal("could not read the version history of " + path);
    }
    n = past - 1;
  }
  let current = getVersion(db, artifact.id, n);
  if (current.id == "") {
    rollbackTransaction(db);
    return editRefusal("Artifact " + path + " points at version " + `${n}`
      + ", which is not in its history.");
  }
  let body = current.body;

  let found = editHits(body, edit.oldText, EDIT_HITS_MOST);
  if (found.length == 0) {
    rollbackTransaction(db);
    let why = "old matches nothing in " + path + " (version " + `${n}` + ").";
    if (attempt > 1) {
      why = "The artifact changed while you were editing: " + why
        + " Read or search it again before retrying.";
      return editRefusal(why);
    }
    let near = editLoose(body, edit.oldText);
    if (near >= 0) {
      why = why + " A whitespace-insensitive scan matches at line " + `${near}`
        + " — read_artifact the file and copy the text exactly, whitespace, quotes and indentation included.";
    } else {
      why = why + " No near miss either: search_artifacts for the text, or read_artifact the file, and copy from what comes back.";
    }
    return editRefusal(why);
  }
  if (found.length > 1) {
    rollbackTransaction(db);
    let tooMany = found.length > EDIT_HITS_MOST;
    let listed: ArtifactHit[] = [];
    let shown = tooMany ? EDIT_HITS_MOST : found.length;
    let i: int = 0;
    while (i < shown) {
      let lineStart = editLineStartAt(body, found[i].at);
      let lineStop = editLineStopAt(body, found[i].at);
      let snip = searchSnippet(body.slice(lineStart, lineStop));
      let hit: ArtifactHit = {
        path: path, slot: artifact.slot, version: n,
        line: found[i].line, text: snip.text, cut: snip.cut,
      };
      listed.push(hit);
      i = i + 1;
    }
    let out = editAmbiguous(path, n, listed, tooMany);
    if (attempt > 1) {
      let raced: ArtifactEdited = {
        ok: false, slot: -1, version: 0, line: 0, bytes: 0, context: "",
        hits: out.hits,
        problem: "The artifact changed while you were editing, and " + out.problem
          + "\nRead or search it again before retrying.",
      };
      return raced;
    }
    return out;
  }

  let at = found[0].at;
  let spliced = body.slice(0, at) + edit.newText + body.slice(at + edit.oldText.length);

  // putArtifact's byte checks, in putArtifact's words, so the model learns
  // that a retry will not help. Inside the transaction, with the sum it read.
  let bytes = utf8Length(spliced);
  if (bytes > ARTIFACT_MAX) {
    rollbackTransaction(db);
    return editRefusal("an artifact is at most " + `${ARTIFACT_MAX}` + " bytes; this one is " + `${bytes}`);
  }
  let held = threadBytes(db, edit.threadId);
  if (held < 0) {
    rollbackTransaction(db);
    return editRefusal("could not read how much this thread's artifacts hold");
  }
  if (held + bytes > THREAD_BYTES_MAX) {
    rollbackTransaction(db);
    return editRefusal("a thread's artifacts hold at most " + `${THREAD_BYTES_MAX}` + " bytes across all versions; this edit would exceed that");
  }

  let line = editLineAt(spliced, at);
  let note = edit.note == "" ? "edit at line " + `${line}` : edit.note;

  // Explicit INSERT at exactly N+1, never `persist`: persist upserts, and an
  // upsert on the append-only log is a silent overwrite (artifacts.ts:524).
  // The unique index arbitrates the race.
  let version = n + 1;
  let wrote = executeWith(db,
    "INSERT INTO artifact_versions (id, artifact_id, version, body, bytes, origin, turn_seq, note, created_at) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ", " + placeholderAt(db, 3) + ", "
    + placeholderAt(db, 4) + ", " + placeholderAt(db, 5) + ", " + placeholderAt(db, 6) + ", "
    + placeholderAt(db, 7) + ", " + placeholderAt(db, 8) + ", " + placeholderAt(db, 9) + ")",
    [artifact.id + ":" + `${version}`, artifact.id, `${version}`, spliced, `${bytes}`,
     // Fixed, not read from anywhere: an edit is the model writing.
     "generated", `${edit.turnSeq}`, note, edit.now]);
  if (!wrote.ok) {
    rollbackTransaction(db);
    // Something appended N+1 between the read and this INSERT. The retry
    // re-reads the winner's body and recomputes the splice from it — never
    // replays this one, because this body was computed FROM a base the log
    // has moved past, and re-inserting it blindly is the stale-base
    // overwrite itself.
    if (attempt < EDIT_ATTEMPTS) {
      return editAttempt(db, edit, attempt + 1);
    }
    return editRefusal("this artifact is being written to too quickly; try again");
  }

  // A column-scoped UPDATE of the pointer, never a full-row persist — a
  // full-row persist is exactly how the rotate bug rewound a pointer and
  // orphaned a version (api.ts:1351). Title, kind, mime, slot and
  // previewToken are untouched: an edit has no opinion about metadata.
  let moved = executeWith(db,
    "UPDATE artifacts SET current_version = " + placeholderAt(db, 1)
    + ", updated_at = " + placeholderAt(db, 2)
    + " WHERE id = " + placeholderAt(db, 3),
    [`${version}`, edit.now, artifact.id]);
  if (!moved.ok) {
    rollbackTransaction(db);
    return editRefusal("the edit could not be saved; try again");
  }

  let done = commitTransaction(db);
  if (!done.ok) {
    rollbackTransaction(db);
    if (attempt < EDIT_ATTEMPTS) {
      return editAttempt(db, edit, attempt + 1);
    }
    return editRefusal("the edit could not be saved; try again");
  }

  let none: ArtifactHit[] = [];
  let out: ArtifactEdited = {
    ok: true, slot: artifact.slot, version: version, line: line, bytes: bytes,
    context: editContext(spliced, at, at + edit.newText.length),
    hits: none, problem: "",
  };
  return out;
}

// The start of the line holding byte `at`.
function editLineStartAt(body: string, at: int): int {
  let i = at;
  while (i > 0 && body.charAt(i - 1) != "\n") { i = i - 1; }
  return i;
}

// The end of the line holding byte `at`: its newline, or the body's end. A
// CR before the newline is dropped so a CRLF body's snippet does not carry an
// invisible tail.
function editLineStopAt(body: string, at: int): int {
  let i = at;
  while (i < body.length && body.charAt(i) != "\n") { i = i + 1; }
  if (i > 0 && body.charAt(i - 1) == "\r") { return i - 1; }
  return i;
}
