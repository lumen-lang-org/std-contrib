// The things a conversation produces that are meant to be looked at.
//
//   putArtifact(db, { threadId: threadId, path: "/report.html", title: "Q3",
//                     content: html, note: "first draft",
//                     origin: "generated", now: now });
//   ... every later write of the same path appends a version ...
//   findByToken(db, token)   // what the preview route serves
//
// An artifact is not a workspace file. A file is current state the agent reads
// and rewrites while it works; an artifact is a result, addressed by a path,
// with every version it has ever had still on disk. That is the whole reason
// for two tables: `artifacts` is identity — one row per (thread, path), the
// pointer a link resolves through — and `artifact_versions` is an append-only
// log of bodies. Nothing ever updates a version row.
//
// Artifacts are self-contained. A body that fetches a script, a font or an
// image from another host is not an artifact, it is a page that breaks the day
// that host does, and it leaks the reader's address to a third party on a URL
// the author never saw. The tool description says so; nothing here can
// enforce it.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, field, repository, asc, desc, persist, findById, listOrdered, listWhere, executeWith, placeholderAt, createTableSql, countWhere, beginTransaction, commitTransaction, rollbackTransaction } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { normalScope } from "./knowledge.ts";

// The largest body an artifact may carry, in bytes. Half a megabyte is far
// more than a page a person reads and far less than a database row anyone
// should hold in memory to serve one preview.
export const ARTIFACT_MAX: int = 524288;

// The cap on how deep a path may nest, and how long it may be in total.
export const ARTIFACT_MAX_SEGMENTS: int = 8;
export const ARTIFACT_MAX_PATH: int = 200;

// The caps on a title and a note. A title rides the briefing into the system
// prompt of every later turn, and a note rides listings and the run log — an
// unbounded title was an unbounded write into the prompt, persistence for a
// one-shot injection. Checked in putArtifact, so both doors and the console
// pass one gate.
export const ARTIFACT_TITLE_MAX: int = 120;
export const ARTIFACT_NOTE_MAX: int = 400;

// What one thread may accumulate: at most this many artifacts, and at most
// this many bytes across every version of every one of them. Enforced at the
// write, in putArtifact, so the fence door, the tool door and the console all
// inherit them — a reply cannot grow a thread past what an operator budgeted
// for it, no matter which door it found.
export const THREAD_ARTIFACTS_MAX: int = 200;
export const THREAD_BYTES_MAX: int = 104857600;

// No turn number. What a write carries when no conversation round made it — a
// console upload — and what every version row holds from before the run loop
// started handing the number through. -1 rather than 0 because 0 is a real
// round, and a row that says "no round, knowingly" beats one that quietly
// claims the first turn.
export const TURN_SEQ_NONE: int = -1;

// --- rows -----------------------------------------------------------------------

export type ArtifactRow = {
  id: string,
  threadId: string,
  // Which artifact this is within the thread, in creation order from 0. The
  // stable number a UI puts on a tab, so reordering the list never renumbers
  // what a reader is pointing at.
  slot: int,
  path: string,
  title: string,
  // One of the six words `kindOf` returns.
  kind: string,
  // Derived from `kind`, never accepted from a caller — see `mimeOf`.
  mime: string,
  // The newest version in artifact_versions. A cache of MAX(version), and
  // never the thing a write reads to decide the next number.
  currentVersion: int,
  // The unguessable half of a preview URL. Minted once, on the first write,
  // and kept across every later version: a link handed to someone must not
  // stop working because the author saved again.
  previewToken: string,
  createdAt: string,
  updatedAt: string,
};

export type ArtifactVersionRow = {
  id: string,
  artifactId: string,
  version: int,
  body: string,
  // The body's length in bytes, stored so a listing can show a size without
  // reading half a megabyte of text per row.
  bytes: int,
  // "uploaded" or "generated".
  origin: string,
  turnSeq: int,
  // Why this version exists, in the writer's words. Free text.
  note: string,
  createdAt: string,
};

// --- mappings -------------------------------------------------------------------

// Frozen the day a column is added: these two generate the CREATE statements
// in migrations 46 and 47, whose checksums every existing database already
// holds. The moment a new column arrives it comes as an ALTER at a new
// version, and each of these must be copied to a private `...MappingV1()` that
// the CREATE keeps using while the exported one below grows. Editing either in
// place changes the generated SQL, changes its CRC, and every deployed
// database refuses to migrate.
export function artifactsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("threadId", "thread_id", "text"),
    field("slot", "slot", "int"),
    field("path", "path", "text"),
    field("title", "title", "text"),
    field("kind", "kind", "text"),
    field("mime", "mime", "text"),
    field("currentVersion", "current_version", "int"),
    field("previewToken", "preview_token", "text"),
    field("createdAt", "created_at", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository({ table: "artifacts", idField: "id", idColumn: "id", fields: fs });
}

// Frozen the day a column is added, for the same reason as the mapping above:
// migration 47 generates its CREATE from this, so a new column is an ALTER at
// a new version plus a private V1 copy here, never an edit.
export function artifactVersionsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("artifactId", "artifact_id", "text"),
    field("version", "version", "int"),
    field("body", "body", "text"),
    field("bytes", "bytes", "int"),
    field("origin", "origin", "text"),
    field("turnSeq", "turn_seq", "int"),
    field("note", "note", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository({ table: "artifact_versions", idField: "id", idColumn: "id", fields: fs });
}

export function artifactPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("46", "artifacts", createTableSql(db, artifactsMapping())),
    migration("47", "artifact versions", createTableSql(db, artifactVersionsMapping())),
    // The lookup every write does first, and the one a thread's tab strip does.
    migration("48", "artifacts by thread",
      "CREATE INDEX IF NOT EXISTS artifacts_by_thread ON artifacts (thread_id, path)"),
    // A preview arrives knowing only the token, so this is the whole of that
    // request's index use. Unique because two artifacts sharing a token would
    // make a link ambiguous, and the first duplicate should fail at the write
    // rather than be discovered by whoever follows the link.
    migration("49", "artifacts by token",
      "CREATE UNIQUE INDEX IF NOT EXISTS artifacts_by_token ON artifacts (preview_token)"),
    // Reads the MAX(version) probe and the version list both walk backwards.
    migration("50", "versions by artifact",
      "CREATE INDEX IF NOT EXISTS artifact_versions_by_artifact ON artifact_versions (artifact_id, version)"),
    // One artifact per path, enforced rather than assumed. Every write looks a
    // path up and appends a version when it finds one; two creates racing on
    // the same path both find nothing and both insert, and the thread then has
    // two artifacts for one path with the version history split between them.
    migration("51", "one artifact per path",
      "CREATE UNIQUE INDEX IF NOT EXISTS artifacts_one_per_path ON artifacts (thread_id, path)"),
    // A slot is a permanent handle and is only handed out once. The SELECT that
    // picks the next one takes no lock, so under two worker connections both
    // creates can read the same maximum; this is what turns "unlikely" into
    // "impossible", by failing the loser's insert instead of letting two rows
    // answer to one number.
    migration("52", "one artifact per slot",
      "CREATE UNIQUE INDEX IF NOT EXISTS artifacts_one_per_slot ON artifacts (thread_id, slot)"),
    // The same argument one level down: a version number is a permanent
    // address, and two writers computing MAX(version)+1 concurrently both get
    // the same answer.
    migration("53", "one body per version",
      "CREATE UNIQUE INDEX IF NOT EXISTS artifact_versions_one_per_version ON artifact_versions (artifact_id, version)"),
  ];
  return plan;
}

// --- paths ----------------------------------------------------------------------

// A path an artifact may have.
//
// Checked on the normalised form, not the raw one, so what is validated is
// exactly what gets stored — a caller cannot approve one string and file
// another. That matters more here than it looks, because `normalScope` only
// fixes the ends: it strips trailing slashes and adds a leading one, and it
// does **not** collapse interior empties. "/a//b" survives it unchanged, so
// the empty-segment rule below is the only thing standing between that and a
// row whose path no URL can round-trip.
export function artifactPathOk(path: string): bool {
  return pathProblem(path) == "";
}

// The same check, with the sentence. One implementation so the predicate and
// the message a writer sees can never disagree about what is legal.
function pathProblem(path: string): string {
  let normal = normalScope(path);
  if (normal.length > ARTIFACT_MAX_PATH) {
    return "an artifact path is at most " + `${ARTIFACT_MAX_PATH}` + " characters; \"" + normal + "\" is " + `${normal.length}`;
  }
  let parts = normal.split("/");
  // A normalised path always starts with "/", so parts[0] is the empty string
  // before it and is not a segment. Everything from 1 up is.
  let segments: int = parts.length - 1;
  if (segments > ARTIFACT_MAX_SEGMENTS) {
    return "an artifact path nests at most " + `${ARTIFACT_MAX_SEGMENTS}` + " deep; \"" + normal + "\" is " + `${segments}`;
  }
  let i: int = 1;
  while (i < parts.length) {
    let seg = parts[i];
    if (seg == "") {
      return "an artifact path has no empty segments — \"" + normal + "\" has one";
    }
    // ".." climbs. "." does not climb but aliases: "/a/./b" and "/a/b" name
    // the same file to every resolver alive and two different rows here, so a
    // preview link would depend on which spelling was saved.
    if (seg == "." || seg == "..") {
      return "an artifact path segment cannot be \"" + seg + "\"";
    }
    if (!segmentCharsOk(seg)) {
      return "an artifact path segment is letters, digits, dot and dash — not \"" + seg + "\"";
    }
    i = i + 1;
  }
  if (kindOf(normal) == "") {
    return "an artifact path ends in a known extension — .html, .svg, .md, .json, .txt or a source suffix — not \"" + normal + "\"";
  }
  return "";
}

// The characters a segment may be made of.
//
// A whitelist, because the offenders worth naming are only the ones already
// thought of: backslash (a separator on the other kind of host), control
// characters (they end up in a header), "%" (a second spelling of every other
// character once this is a URL) and "_" (a single-character wildcard in every
// LIKE this path is ever compared with). A list of four rejects would pass
// quotes, angle brackets, spaces and every byte above 127; this passes none of
// them, and the four are excluded by construction.
function segmentCharsOk(seg: string): bool {
  let i: int = 0;
  while (i < seg.length) {
    let c = seg.charCodeAt(i);
    let ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      || c == 46 || c == 45;
    if (!ok) { return false; }
    i = i + 1;
  }
  return true;
}

// Whether a title or note is fit to store: within its cap, and one line of
// plain text. Control characters are refused along with newlines because a
// title reaches the system prompt and a note reaches the run log — a newline
// in either is a fresh line the reader parses as structure, not as the
// artifact's name.
function labelProblem(what: string, text: string, cap: int): string {
  if (text.length > cap) {
    return "a " + what + " is at most " + `${cap}` + " characters; this one is " + `${text.length}`;
  }
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c < 32 || c == 127) {
      return "a " + what + " is one line of plain text — no newlines or control characters";
    }
    i = i + 1;
  }
  return "";
}

// The suffix, lowercased, or "" when there is none. Compared case-insensitively
// because ".HTML" and ".html" are one kind, and a path that differs only in the
// case of its extension should not become a second artifact.
function extensionOf(path: string): string {
  let dot = path.lastIndexOf(".");
  let slash = path.lastIndexOf("/");
  if (dot < 0 || dot < slash) { return ""; }
  if (dot == path.length - 1) { return ""; }
  return path.slice(dot + 1).toLowerCase();
}

// What an artifact is, from its path. A closed list of six — an artifact is
// something a browser can render as text, and anything outside these words is
// not an artifact but an upload.
//
// "" for an unknown extension, which is how `pathProblem` refuses one.
export function kindOf(path: string): string {
  let ext = extensionOf(path);
  if (ext == "html" || ext == "htm") { return "html"; }
  if (ext == "svg") { return "svg"; }
  if (ext == "md" || ext == "markdown") { return "markdown"; }
  if (ext == "json") { return "json"; }
  // A stylesheet and a script are their own kinds, not "code".
  //
  // Not a cosmetic split. A page that links a sibling stylesheet only works if
  // that sibling arrives as text/css: the preview sandbox gives the document
  // an opaque origin, so every subresource fetch is cross-origin, and a
  // cross-origin stylesheet is rejected on its type alone — `nosniff` on top
  // of that leaves no version of this where text/plain loads. Same for a
  // script. Lumping them under "code" made the whole multi-file relaxation
  // inert: the policy allowed the fetch and the MIME check threw the result
  // away.
  if (ext == "css") { return "css"; }
  if (ext == "js" || ext == "mjs") { return "javascript"; }
  if (ext == "ts" || ext == "tsx" || ext == "jsx"
    || ext == "py" || ext == "sql" || ext == "sh"
    || ext == "yaml" || ext == "yml" || ext == "toml") { return "code"; }
  if (ext == "txt" || ext == "csv" || ext == "log") { return "text"; }
  return "";
}

// The type of a kind.
//
// Derived, never client-supplied: a caller who can name the content type of a
// body it also wrote can serve HTML from any path it likes, which is the whole
// attack the preview host exists to contain.
//
// This is the artifact's declared type — what it *is*. It is not automatically
// what the preview route answers with: that decision belongs to the route,
// which compares the request's Host against the preview host and sends
// text/plain when they do not match. Reading this as "the response header"
// would put text/html on the console origin.
export function mimeOf(kind: string): string {
  if (kind == "html") { return "text/html; charset=utf-8"; }
  if (kind == "svg") { return "image/svg+xml; charset=utf-8"; }
  if (kind == "markdown") { return "text/markdown; charset=utf-8"; }
  if (kind == "json") { return "application/json; charset=utf-8"; }
  // A stylesheet and a script get their real types, because a page that links
  // one cannot use it otherwise. This is only ever sent on the preview host —
  // the route downgrades everything to text/plain anywhere else — so "a
  // browser might execute it" is the intent here rather than the risk: inside
  // that sandbox, with connect-src 'none', a script has nothing to reach.
  if (kind == "css") { return "text/css; charset=utf-8"; }
  if (kind == "javascript") { return "text/javascript; charset=utf-8"; }
  // Everything else is source, and source is text. Serving it as its own
  // language's type gains nothing and asks a browser to run something nobody
  // linked.
  return "text/plain; charset=utf-8";
}

// A body's size in bytes.
//
// A Lumen string is already UTF-8 bytes, so this is its length — the function
// exists so the call site says which unit it means. `bytes` and ARTIFACT_MAX
// are byte counts, and a reader who saw a bare `.length` there would have to
// know how strings are represented to know whether the cap was a character cap
// under another name.
export function utf8Length(text: string): int {
  return text.length;
}

// --- writing --------------------------------------------------------------------

// An artifact to write. A record and not seven positional strings: five of
// these are consecutive strings, and `content` sitting where `note` belongs
// files a whole document as an audit comment and an audit comment as the
// artifact — both of which persist accepts without complaint.
export type ArtifactWrite = {
  threadId: string,
  path: string,
  title: string,
  content: string,
  // Why this version exists. "" is fine.
  note: string,
  // "uploaded" or "generated". There is deliberately no "retrieved": an
  // artifact is made here, and nothing pulls one out of the corpus.
  origin: string,
  // Refuse rather than append when the path already exists. The fence door
  // is create-only by design, and it decides "new" from a listing taken
  // before this call — a concurrent write can create the path in between,
  // and an append the caller never intended is exactly the shared-link
  // overwrite the create-only rule exists to prevent. Checked HERE, inside
  // the transaction, because a check outside one is a race with a rule
  // drawn on top of it.
  mustCreate: bool,
  // The round that caused this write — the thread's turn seq at the round's
  // base — or TURN_SEQ_NONE for a write no round made, like a console upload.
  // Both doors of a round stamp the same number, which is what lets "what did
  // this round produce" be a join on artifact_versions.turn_seq.
  turnSeq: int,
  now: string,
};

// What a write did, or why it did nothing.
export type ArtifactWritten = {
  ok: bool,
  id: string,
  slot: int,
  version: int,
  previewToken: string,
  problem: string,
};

function refusal(why: string): ArtifactWritten {
  let out: ArtifactWritten = {
    ok: false, id: "", slot: -1, version: 0, previewToken: "", problem: why,
  };
  return out;
}

// Save a body under a path, as a new version.
//
// The identity row is keyed by (thread, path) spelled as one string rather
// than by a fresh id per write. That is what makes a second write of the same
// path update the pointer instead of filing a second artifact — with a random
// key, `persist` would upsert on a key nothing else has and quietly leave two
// rows claiming the same path, each with its own version history.
//
// The version number comes from MAX(version) over the log, never from
// currentVersion. The pointer is a cache; if two writers race, one of them
// reads a stale pointer and both compute the same "next", and the loser has
// already overwritten the winner's body by the time anyone looks. Reading the
// log means the loser computes the same number too — and then loses on the
// version row's primary key, which is exactly what should happen.
// How many times a write will re-read the version number and try again before
// giving up. Two writers colliding is ordinary; five doing so on one path in
// the time this takes is a caller in a loop, and answering it forever would
// hide that from them.
const WRITE_ATTEMPTS: int = 4;

export function putArtifact(db: Db, write: ArtifactWrite): ArtifactWritten {
  return putAttempt(db, write, 1);
}

function putAttempt(db: Db, write: ArtifactWrite, attempt: int): ArtifactWritten {
  if (write.threadId == "") { return refusal("an artifact belongs to a thread"); }
  let problem = pathProblem(write.path);
  if (problem != "") { return refusal(problem); }
  if (write.origin != "uploaded" && write.origin != "generated") {
    return refusal("origin must be uploaded or generated");
  }
  // Both doors, one place: the tool and the fence funnel through here, so a
  // title or note neither door checked still cannot reach the briefing.
  let badTitle = labelProblem("title", write.title, ARTIFACT_TITLE_MAX);
  if (badTitle != "") { return refusal(badTitle); }
  let badNote = labelProblem("note", write.note, ARTIFACT_NOTE_MAX);
  if (badNote != "") { return refusal(badNote); }
  let bytes = utf8Length(write.content);
  if (bytes > ARTIFACT_MAX) {
    return refusal("an artifact is at most " + `${ARTIFACT_MAX}` + " bytes; this one is " + `${bytes}`);
  }
  let path = normalScope(write.path);
  let kind = kindOf(path);
  let id = write.threadId + ":" + path;

  let opened = beginTransaction(db);
  if (!opened.ok) { return refusal("the artifact could not be saved; try again"); }

  // What this path already is, if anything. Read inside the transaction: the
  // slot it allocates below is a count of siblings, and counting outside would
  // hand the same number to two artifacts created at once.
  let existing = getArtifact(db, write.threadId, path);
  let slot = existing.slot;
  let token = existing.previewToken;
  let createdAt = existing.createdAt;

  // The thread caps, inside the transaction with the counts they read. The
  // refusal names which cap, because "could not save" tells a writer to
  // retry and a full thread is not something a retry fixes.
  if (write.mustCreate && existing.id != "") {
    rollbackTransaction(db);
    return refusal("update " + path + " needs write_artifact");
  }
  if (existing.id == "") {
    let count = countWhere(db, artifactsMapping(), "thread_id = " + placeholderAt(db, 1), [write.threadId]);
    if (count < 0) {
      rollbackTransaction(db);
      return refusal("could not count this thread's artifacts");
    }
    if (count >= THREAD_ARTIFACTS_MAX) {
      rollbackTransaction(db);
      return refusal("a thread holds at most " + `${THREAD_ARTIFACTS_MAX}` + " artifacts; delete one before creating another");
    }
  }
  let held = threadBytes(db, write.threadId);
  if (held < 0) {
    rollbackTransaction(db);
    return refusal("could not read how much this thread's artifacts hold");
  }
  if (held + bytes > THREAD_BYTES_MAX) {
    rollbackTransaction(db);
    return refusal("a thread's artifacts hold at most " + `${THREAD_BYTES_MAX}` + " bytes across all versions; this write would exceed that");
  }

  if (existing.id == "") {
    // The next slot is however many the thread already has.
    //
    // MAX(slot) + 1, not a count of siblings. Counting reuses the numbers a
    // delete freed: delete the artifact in slot 1 of three and the next write
    // counts 2 and takes slot 2, which the third artifact still holds — two
    // rows answering to one number, and a link to slot 2 quietly resolving to
    // someone else's file. A slot is a permanent handle, so it is only ever
    // handed out once.
    //
    // The unique index on (thread_id, slot) is what makes this true under
    // concurrency rather than merely likely: this SELECT takes no lock, and
    // two creates in one thread on two worker connections can both read the
    // same maximum. With the index, the loser's INSERT fails and it is told
    // so; without it, both commit and the second artifact is unaddressable.
    let top = maxSlot(db, write.threadId);
    if (top < -1) {
      rollbackTransaction(db);
      return refusal("could not read the artifact slots in this thread");
    }
    slot = top + 1;
    token = crypto.randomUUID();
    createdAt = write.now;
  }

  let version = nextVersion(db, id);
  if (version < 1) {
    rollbackTransaction(db);
    return refusal("could not read the version history of " + path);
  }

  // The version row's key is (artifact, version), so a second writer that
  // computed the same number fails here instead of replacing a body. This is
  // also why the insert is explicit and not `persist`: persist upserts, and an
  // upsert on this table is a silent overwrite of an append-only log.
  let row: ArtifactVersionRow = {
    id: id + ":" + `${version}`,
    artifactId: id,
    version: version,
    body: write.content,
    bytes: bytes,
    origin: write.origin,
    turnSeq: write.turnSeq,
    note: write.note,
    createdAt: write.now,
  };
  let wrote = executeWith(db,
    "INSERT INTO artifact_versions (id, artifact_id, version, body, bytes, origin, turn_seq, note, created_at) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ", " + placeholderAt(db, 3) + ", "
    + placeholderAt(db, 4) + ", " + placeholderAt(db, 5) + ", " + placeholderAt(db, 6) + ", "
    + placeholderAt(db, 7) + ", " + placeholderAt(db, 8) + ", " + placeholderAt(db, 9) + ")",
    [row.id, row.artifactId, `${row.version}`, row.body, `${row.bytes}`,
     row.origin, `${row.turnSeq}`, row.note, row.createdAt]);
  if (!wrote.ok) {
    rollbackTransaction(db);
    // The unique key on (artifact, version) did its job: a second writer that
    // computed the same number was refused rather than allowed to replace a
    // body. That is the right outcome for the log and the wrong one for the
    // caller, who wrote a perfectly good artifact and is owed a version number
    // — so the caller retries rather than being handed a lost write.
    //
    // The database's own sentence never reaches them. It names the table, the
    // constraint and the colliding key, which tells someone probing this API
    // more about its shape than the answer to their question should.
    if (attempt < WRITE_ATTEMPTS) {
      return putAttempt(db, write, attempt + 1);
    }
    return refusal("this artifact is being written to to too quickly; try again");
  }

  // The pointer follows the body, and upserting it is the intent: title, kind
  // and mime are metadata about the path, where the last writer wins.
  let pointer: ArtifactRow = {
    id: id,
    threadId: write.threadId,
    slot: slot,
    path: path,
    title: write.title,
    kind: kind,
    mime: mimeOf(kind),
    currentVersion: version,
    previewToken: token,
    createdAt: createdAt,
    updatedAt: write.now,
  };
  let moved = persist(db, artifactsMapping(), JSON.stringify(pointer));
  if (!moved.ok) {
    rollbackTransaction(db);
    // Same story as the version insert: two creates in one thread can pick the
    // same slot, and the unique index refuses the loser. Re-reading the
    // maximum and trying again is what that caller wants; the constraint's own
    // wording is not something to hand back.
    if (attempt < WRITE_ATTEMPTS) {
      return putAttempt(db, write, attempt + 1);
    }
    return refusal("this thread is being written to too quickly; try again");
  }

  let done = commitTransaction(db);
  if (!done.ok) {
    rollbackTransaction(db);
    if (attempt < WRITE_ATTEMPTS) {
      return putAttempt(db, write, attempt + 1);
    }
    return refusal("the artifact could not be saved; try again");
  }
  let out: ArtifactWritten = {
    ok: true, id: id, slot: slot, version: version, previewToken: token, problem: "",
  };
  return out;
}

// One past the highest version this artifact has, or 0 when the log cannot be
// read. 1 for an artifact with no versions yet — MAX over no rows is NULL,
// which parses as nothing and counts as zero.
// The highest slot a thread has ever handed out, or -1 for a thread with
// none. Deleted rows are gone, so a thread whose only artifact was deleted
// starts again at 0 — that is the one case where reuse is safe, because there
// is nothing left to collide with.
function maxSlot(db: Db, threadId: string): int {
  let sql = "SELECT MAX(slot) FROM artifacts WHERE thread_id = " + placeholderAt(db, 1);
  if (!db.query(sql, [threadId])) { return -2; }
  if (db.rows() == 0) { return -1; }
  let top = db.value(0, 0);
  if (top == "") { return -1; }
  return parseInt(top) ?? -1;
}

// Every byte the thread's artifacts hold, across every version — versions are
// append-only, so old bodies stay on disk and must stay under the budget too.
// -1 when the log cannot be read, 0 for a thread with none: SUM over no rows
// is NULL, which reads as empty text.
function threadBytes(db: Db, threadId: string): int {
  let sql = "SELECT SUM(artifact_versions.bytes) FROM artifact_versions"
    + " JOIN artifacts ON artifacts.id = artifact_versions.artifact_id"
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1);
  if (!db.query(sql, [threadId])) { return -1; }
  if (db.rows() == 0) { return 0; }
  let held = db.value(0, 0);
  if (held == "") { return 0; }
  return parseInt(held) ?? -1;
}

function nextVersion(db: Db, artifactId: string): int {
  let sql = "SELECT MAX(version) FROM artifact_versions WHERE artifact_id = " + placeholderAt(db, 1);
  if (!db.query(sql, [artifactId])) { return 0; }
  if (db.rows() == 0) { return 1; }
  return (parseInt(db.value(0, 0)) ?? 0) + 1;
}

// --- reading --------------------------------------------------------------------

function noArtifact(): ArtifactRow {
  let absent: ArtifactRow = {
    id: "", threadId: "", slot: -1, path: "", title: "", kind: "", mime: "",
    currentVersion: 0, previewToken: "", createdAt: "", updatedAt: "",
  };
  return absent;
}

// The artifact at a path, or a row whose id is "". Callers test `id == ""`.
export function getArtifact(db: Db, threadId: string, path: string): ArtifactRow {
  let document = findById(db, artifactsMapping(), threadId + ":" + normalScope(path));
  if (document == "") { return noArtifact(); }
  return JSON.parse<ArtifactRow>(document);
}

// The thread's artifacts as a paragraph for the model.
//
// References, not bodies: the model is told what exists — path, title, how
// many versions — and chooses what to read_artifact or overwrite. Without
// this it is blind to everything it did not write inside the current context
// window: reopen a conversation, or compact past the turn that made
// /index.html, and the model cannot know the file exists — so it invents a
// new path and the reader gets two dashboards where they wanted version 2.
// The listing costs a line per file; the bodies would cost the window.
// How many artifacts the briefing lists. The listing is a line per file in
// the system prompt of every later turn, and the cap is what keeps that from
// growing without bound — by legitimate use or by anything that learned to
// mint files.
export const BRIEFING_LINES: int = 50;

export function artifactBriefing(db: Db, threadId: string): string {
  // Newest-touched first: the files the conversation is working on now are
  // the ones a revision must land on, and the ones past the cap are the ones
  // least likely to be meant. Slot breaks ties so two writes in one stamp
  // still list in a stable order.
  let keys: DbOrder[] = [desc("updated_at"), desc("slot")];
  let listed = listOrdered(db, artifactsMapping(), { where: "thread_id = " + placeholderAt(db, 1), args: [threadId], order: keys });
  if (listed == "" || listed == "[]") { return ""; }
  let rows = JSON.parse<ArtifactRow[]>(listed);
  if (rows.length == 0) { return ""; }
  let shown = rows.length < BRIEFING_LINES ? rows.length : BRIEFING_LINES;
  let out = "This conversation already has these artifacts:";
  let i: int = 0;
  while (i < shown) {
    let each = rows[i];
    let named = each.title == "" ? "" : " — " + each.title;
    out = out + "\n- " + each.path + " (" + each.kind + ", v" + `${each.currentVersion}` + ")" + named;
    i = i + 1;
  }
  if (rows.length > shown) {
    out = out + "\n…and " + `${rows.length - shown}` + " more; list with read_artifact";
  }
  // Directly under the list, because it is about the list: the one mistake a
  // model reliably makes here is a near-miss respelling of a path it can see.
  out = out + "\nAny change to one of the files above must be written to its exact path, "
    + "character for character including capitalization — a near-miss path creates a duplicate file, not a new version.";
  // Door-agnostic on purpose: true whether a file arrives through
  // write_artifact or through a fenced reply, because promising that "saving
  // a path appends a version" is false at the fence door, which only creates.
  out = out + "\nRead one with read_artifact before changing it. Updating an existing path appends a new version, "
    + "and only the write_artifact tool can do that; a new path always creates a new file.";
  return out;
}

// A thread's artifacts in slot order, which is creation order — the order a
// tab strip should show and the only one that does not move under a reader
// when something is renamed.
export function listArtifacts(db: Db, threadId: string): ArtifactRow[] {
  let none: ArtifactRow[] = [];
  let keys: DbOrder[] = [asc("slot")];
  let listed = listOrdered(db, artifactsMapping(), { where: "thread_id = " + placeholderAt(db, 1), args: [threadId], order: keys });
  if (listed == "" || listed == "[]") { return none; }
  return JSON.parse<ArtifactRow[]>(listed);
}

// One round's mark on an artifact: which slot and version a turn produced,
// and where it lives. What the by-turn route serves and what a chat card
// resolves against — identity only, never a body.
export type TurnArtifact = {
  turnSeq: int,
  slot: int,
  path: string,
  title: string,
  kind: string,
  version: int,
};

// One row of the join, read field by field from db.value rather than through
// a mapping: the shape is a join's, and no repository owns it.
function turnArtifactAt(db: Db, i: int): TurnArtifact {
  let row: TurnArtifact = {
    turnSeq: parseInt(db.value(i, 0)) ?? TURN_SEQ_NONE,
    slot: parseInt(db.value(i, 1)) ?? -1,
    path: db.value(i, 2),
    title: db.value(i, 3),
    kind: db.value(i, 4),
    version: parseInt(db.value(i, 5)) ?? 0,
  };
  return row;
}

// The columns both turn-scoped reads select, spelled once so the field-by-field
// reader above can never drift from the SELECT it reads.
function turnArtifactSql(): string {
  return "SELECT artifact_versions.turn_seq, artifacts.slot, artifacts.path,"
    + " artifacts.title, artifacts.kind, artifact_versions.version"
    + " FROM artifact_versions"
    + " JOIN artifacts ON artifacts.id = artifact_versions.artifact_id";
}

// What one round produced, whichever door and whichever agent wrote it — a
// delegated child's write_artifact carries the parent's seq and appears here.
//
// The `turn_seq >= 0` guard is belted on beside the equality check:
// TURN_SEQ_NONE marks writes no round made, and a turn-scoped read that could
// match it would credit console uploads to a conversation round.
export function artifactsForTurn(db: Db, threadId: string, turnSeq: int): TurnArtifact[] {
  let out: TurnArtifact[] = [];
  if (turnSeq < 0) { return out; }
  let sql = turnArtifactSql()
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1)
    + " AND artifact_versions.turn_seq = " + placeholderAt(db, 2)
    + " AND artifact_versions.turn_seq >= 0"
    + " ORDER BY artifacts.slot, artifact_versions.version";
  if (!db.query(sql, [threadId, `${turnSeq}`])) { return out; }
  let i: int = 0;
  while (i < db.rows()) {
    out.push(turnArtifactAt(db, i));
    i = i + 1;
  }
  return out;
}

// Every turn-scoped version in the thread, in round order — the transcript's
// join, answered in one query for the whole conversation rather than one per
// message. Console uploads (TURN_SEQ_NONE) are deliberately absent: no round
// made them, so no message should wear their card.
export function artifactsByTurn(db: Db, threadId: string): TurnArtifact[] {
  let out: TurnArtifact[] = [];
  let sql = turnArtifactSql()
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1)
    + " AND artifact_versions.turn_seq >= 0"
    + " ORDER BY artifact_versions.turn_seq, artifacts.slot, artifact_versions.version";
  if (!db.query(sql, [threadId])) { return out; }
  let i: int = 0;
  while (i < db.rows()) {
    out.push(turnArtifactAt(db, i));
    i = i + 1;
  }
  return out;
}

// The artifact a preview token names.
//
// The token is the whole of the authorisation — there is no thread id on a
// preview request to check it against — which is why it is a UUID minted per
// artifact and not the path, the slot, or anything a reader could guess from a
// link they were legitimately given.
export function findByToken(db: Db, token: string): ArtifactRow {
  if (token == "") { return noArtifact(); }
  let listed = listWhere(db, artifactsMapping(), "preview_token = " + placeholderAt(db, 1), [token]);
  if (listed == "" || listed == "[]") { return noArtifact(); }
  let rows: ArtifactRow[] = JSON.parse<ArtifactRow[]>(listed);
  if (rows.length == 0) { return noArtifact(); }
  return rows[0];
}

// One version's body. `version` is the number the pointer or a listing gave;
// there is no "latest" spelling here because the pointer already carries it,
// and a reader that wants the newest should say which number that was, so the
// body it renders and the number it shows cannot come from different writes.
export function getVersion(db: Db, artifactId: string, version: int): ArtifactVersionRow {
  let absent: ArtifactVersionRow = {
    id: "", artifactId: artifactId, version: 0, body: "", bytes: 0,
    origin: "", turnSeq: TURN_SEQ_NONE, note: "", createdAt: "",
  };
  let document = findById(db, artifactVersionsMapping(), artifactId + ":" + `${version}`);
  if (document == "") { return absent; }
  return JSON.parse<ArtifactVersionRow>(document);
}

// Drop an artifact and everything it ever was.
//
// Bodies first, pointer last, in one transaction: the other order leaves the
// versions unreachable if the second statement fails, since the pointer is the
// only thing that knows the artifact id. Returns "" on success, and a sentence
// otherwise.
export function deleteArtifact(db: Db, threadId: string, path: string): string {
  let artifact = getArtifact(db, threadId, path);
  if (artifact.id == "") { return "no artifact at \"" + normalScope(path) + "\" in this thread"; }

  let opened = beginTransaction(db);
  if (!opened.ok) { return opened.error; }

  let bodies = executeWith(db, "DELETE FROM artifact_versions WHERE artifact_id = " + placeholderAt(db, 1),
    [artifact.id]);
  if (!bodies.ok) {
    rollbackTransaction(db);
    return bodies.error;
  }
  let pointer = executeWith(db, "DELETE FROM artifacts WHERE id = " + placeholderAt(db, 1),
    [artifact.id]);
  if (!pointer.ok) {
    rollbackTransaction(db);
    return pointer.error;
  }

  let done = commitTransaction(db);
  if (!done.ok) {
    rollbackTransaction(db);
    return done.error;
  }
  return "";
}
