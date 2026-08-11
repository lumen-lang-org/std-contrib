import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, field, repository, persist, findById, listOrdered, listWhere, executeWith, placeholderAt, createTableSql, countWhere, beginTransaction, commitTransaction, rollbackTransaction } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { artifactBytesMax, threadBytesMax } from "./caps.ts";
import { normalScope } from "./knowledge.ts";
import { ownerClause } from "./owner.ts";
import { artifactRepository } from "./routes/threads-artifacts/entities/artifact.entity.ts";

export const ARTIFACT_MAX: int = artifactBytesMax();

export const ARTIFACT_MAX_SEGMENTS: int = 8;
export const ARTIFACT_MAX_PATH: int = 200;

export const ARTIFACT_TITLE_MAX: int = 120;
export const ARTIFACT_NOTE_MAX: int = 400;

export const THREAD_ARTIFACTS_MAX: int = 200;
export const THREAD_BYTES_MAX: int = threadBytesMax();

export const TURN_SEQ_NONE: int = -1;

export type ArtifactRow = {
  id: string,
  threadId: string,
  slot: int,
  path: string,
  title: string,
  kind: string,
  mime: string,
  currentVersion: int,
  previewToken: string,
  createdAt: string,
  updatedAt: string,
};

export type ArtifactVersionRow = {
  id: string,
  artifactId: string,
  version: int,
  body: string,
  bytes: int,
  origin: string,
  turnSeq: int,
  note: string,
  createdAt: string,
};

export function artifactsMapping(): DbRepository {
  return artifactRepository();
}

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
    migration("48", "artifacts by thread",
      "CREATE INDEX IF NOT EXISTS artifacts_by_thread ON artifacts (thread_id, path)"),
    migration("49", "artifacts by token",
      "CREATE UNIQUE INDEX IF NOT EXISTS artifacts_by_token ON artifacts (preview_token)"),
    migration("50", "versions by artifact",
      "CREATE INDEX IF NOT EXISTS artifact_versions_by_artifact ON artifact_versions (artifact_id, version)"),
    migration("51", "one artifact per path",
      "CREATE UNIQUE INDEX IF NOT EXISTS artifacts_one_per_path ON artifacts (thread_id, path)"),
    migration("52", "one artifact per slot",
      "CREATE UNIQUE INDEX IF NOT EXISTS artifacts_one_per_slot ON artifacts (thread_id, slot)"),
    migration("53", "one body per version",
      "CREATE UNIQUE INDEX IF NOT EXISTS artifact_versions_one_per_version ON artifact_versions (artifact_id, version)"),
  ];
  return plan;
}

export function artifactPathOk(path: string): bool {
  return pathFault(path) == "";
}

function pathFault(path: string): string {
  let normal = normalScope(path);
  if (normal.length > ARTIFACT_MAX_PATH) {
    return "an artifact path is at most " + `${ARTIFACT_MAX_PATH}` + " characters; \"" + normal + "\" is " + `${normal.length}`;
  }
  let parts = normal.split("/");
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
    if (seg == "." || seg == "..") {
      return "an artifact path segment cannot be \"" + seg + "\"";
    }
    if (!segmentCharsOk(seg)) {
      return "an artifact path segment is letters, digits, dot and dash — not \"" + seg + "\"";
    }
    i = i + 1;
  }
  return "";
}

function segmentCharsOk(seg: string): bool {
  let i: int = 0;
  while (i < seg.length) {
    let c = seg.charCodeAt(i);
    let ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      || c == 46 || c == 45;
    if (!ok) {
      return false;
    }
    i = i + 1;
  }
  return true;
}

export function labelFault(what: string, text: string, cap: int): string {
  if (text.length > cap) {
    return "a " + what + " is at most " + `${cap}` + " bytes of UTF-8; this one is " + `${text.length}`;
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

function extensionOf(path: string): string {
  let dot = path.lastIndexOf(".");
  let slash = path.lastIndexOf("/");
  if (dot < 0 || dot < slash) {
    return "";
  }
  if (dot == path.length - 1) {
    return "";
  }
  return path.slice(dot + 1).toLowerCase();
}

export function kindOf(path: string): string {
  let ext = extensionOf(path);
  if (ext == "html" || ext == "htm") {
    return "html";
  }
  if (ext == "svg") {
    return "svg";
  }
  if (ext == "md" || ext == "markdown") {
    return "markdown";
  }
  if (ext == "json") {
    return "json";
  }
  if (ext == "css") {
    return "css";
  }
  if (ext == "js" || ext == "mjs") {
    return "javascript";
  }
  if (ext == "ts" || ext == "tsx" || ext == "jsx"
    || ext == "py" || ext == "sql" || ext == "sh"
    || ext == "yaml" || ext == "yml" || ext == "toml") {
      return "code";
    }
  if (ext == "txt" || ext == "csv" || ext == "log") {
    return "text";
  }
  if (ext == "png" || ext == "jpg" || ext == "jpeg" || ext == "gif" || ext == "webp") {
    return "image";
  }
  if (ext == "docx" || ext == "xlsx" || ext == "xls" || ext == "pptx") {
    return "office";
  }
  if (ext == "pdf") {
    return "pdf";
  }
  return "file";
}

export function binaryKind(kind: string): bool {
  return kind == "image" || kind == "office" || kind == "pdf" || kind == "file";
}

export function imageMediaType(path: string): string {
  let ext = extensionOf(path);
  if (ext == "png") {
    return "image/png";
  }
  if (ext == "jpg" || ext == "jpeg") {
    return "image/jpeg";
  }
  if (ext == "gif") {
    return "image/gif";
  }
  if (ext == "webp") {
    return "image/webp";
  }
  return "";
}

export function mimeOf(kind: string): string {
  if (kind == "html") {
    return "text/html; charset=utf-8";
  }
  if (kind == "svg") {
    return "image/svg+xml; charset=utf-8";
  }
  if (kind == "markdown") {
    return "text/markdown; charset=utf-8";
  }
  if (kind == "json") {
    return "application/json; charset=utf-8";
  }
  if (kind == "css") {
    return "text/css; charset=utf-8";
  }
  if (kind == "javascript") {
    return "text/javascript; charset=utf-8";
  }
  if (kind == "image") {
    return "text/plain; charset=utf-8";
  }
  if (kind == "pdf") {
    return "application/pdf";
  }
  return "text/plain; charset=utf-8";
}

export function utf8Length(text: string): int {
  return text.length;
}

export type ArtifactWrite = {
  threadId: string,
  path: string,
  title: string,
  content: string,
  note: string,
  origin: string,
  mustCreate: bool,
  turnSeq: int,
  now: string,
};

export type ArtifactWritten = {
  ok: bool,
  id: string,
  slot: int,
  version: int,
  previewToken: string,
  fault: string,
};

function refusal(why: string): ArtifactWritten {
  let out: ArtifactWritten = {
    ok: false, id: "", slot: -1, version: 0, previewToken: "", fault: why,
  };
  return out;
}

const WRITE_ATTEMPTS: int = 4;

export function putArtifact(db: Db, write: ArtifactWrite): ArtifactWritten {
  return putAttempt(db, write, 1);
}


function binaryBodyFault(path: string, content: string): string {
  let kind = kindOf(path);
  if (kind != "office" && kind != "pdf") {
    return "";
  }
  if (content == "") {
    return "";
  }
  if (kind == "office" && content.startsWith("UEs")) {
    return "";
  }
  if (kind == "pdf" && content.startsWith("JVBER")) {
    return "";
  }
  let want = kind == "pdf" ? "a PDF" : "an Office document (a ZIP, as every .docx, .xlsx and .pptx is)";
  return "the body of " + path + " is not " + want
    + ": this artifact's content is base64 of the file's own bytes, and what arrived is not."
    + " Build the file with a script and let the run land it, rather than writing the content here.";
}

function putAttempt(db: Db, write: ArtifactWrite, attempt: int): ArtifactWritten {
  if (write.threadId == "") {
    return refusal("an artifact belongs to a thread");
  }
  let fault = pathFault(write.path);
  if (fault != "") {
    return refusal(fault);
  }
  if (write.origin != "uploaded" && write.origin != "generated") {
    return refusal("origin must be uploaded or generated");
  }
  let badTitle = labelFault("title", write.title, ARTIFACT_TITLE_MAX);
  if (badTitle != "") {
    return refusal(badTitle);
  }
  let badNote = labelFault("note", write.note, ARTIFACT_NOTE_MAX);
  if (badNote != "") {
    return refusal(badNote);
  }
  let badBinary = binaryBodyFault(write.path, write.content);
  if (badBinary != "") {
    return refusal(badBinary);
  }
  let bytes = utf8Length(write.content);
  if (bytes > ARTIFACT_MAX) {
    return refusal("an artifact is at most " + `${ARTIFACT_MAX}` + " bytes; this one is " + `${bytes}`);
  }
  let path = normalScope(write.path);
  let kind = kindOf(path);
  let id = write.threadId + ":" + path;

  let opened = beginTransaction(db);
  if (!opened.ok) {
    return refusal("the artifact could not be saved; try again");
  }

  let existing = getArtifact(db, write.threadId, path);
  let slot = existing.slot;
  let token = existing.previewToken;
  let createdAt = existing.createdAt;

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
    if (attempt < WRITE_ATTEMPTS) {
      return putAttempt(db, write, attempt + 1);
    }
    return refusal("this artifact is being written to to too quickly; try again");
  }

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
    ok: true, id: id, slot: slot, version: version, previewToken: token, fault: "",
  };
  return out;
}

function maxSlot(db: Db, threadId: string): int {
  let sql = "SELECT MAX(slot) FROM artifacts WHERE thread_id = " + placeholderAt(db, 1);
  if (!db.query(sql, [threadId])) {
    return -2;
  }
  if (db.rows() == 0) {
    return -1;
  }
  let top = db.value(0, 0);
  if (top == "") {
    return -1;
  }
  return parseInt(top) ?? -1;
}

export function threadBytes(db: Db, threadId: string): int {
  let sql = "SELECT SUM(artifact_versions.bytes) FROM artifact_versions"
    + " JOIN artifacts ON artifacts.id = artifact_versions.artifact_id"
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1);
  if (!db.query(sql, [threadId])) {
    return -1;
  }
  if (db.rows() == 0) {
    return 0;
  }
  let held = db.value(0, 0);
  if (held == "") {
    return 0;
  }
  return parseInt(held) ?? -1;
}

export function nextVersion(db: Db, artifactId: string): int {
  let sql = "SELECT MAX(version) FROM artifact_versions WHERE artifact_id = " + placeholderAt(db, 1);
  if (!db.query(sql, [artifactId])) {
    return 0;
  }
  if (db.rows() == 0) {
    return 1;
  }
  return (parseInt(db.value(0, 0)) ?? 0) + 1;
}

function noArtifact(): ArtifactRow {
  let absent: ArtifactRow = {
    id: "", threadId: "", slot: -1, path: "", title: "", kind: "", mime: "",
    currentVersion: 0, previewToken: "", createdAt: "", updatedAt: "",
  };
  return absent;
}

export function getArtifact(db: Db, threadId: string, path: string): ArtifactRow {
  let document = findById(db, artifactsMapping(), threadId + ":" + normalScope(path));
  if (document == "") {
    return noArtifact();
  }
  return JSON.parse<ArtifactRow>(document);
}

export const BRIEFING_LINES: int = 50;

export function artifactBriefing(db: Db, threadId: string): string {
  let keys: DbOrder[] = [{
    column: "updated_at",
    direction: "desc",
  }, {
    column: "slot",
    direction: "desc",
  }];
  let listed = listOrdered(db, artifactsMapping(), {
    where: "thread_id = " + placeholderAt(db, 1),
    args: [threadId],
    order: keys,
  });
  if (listed == "" || listed == "[]") {
    return "";
  }
  let rows = JSON.parse<ArtifactRow[]>(listed);
  if (rows.length == 0) {
    return "";
  }
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
    out = out + "\n…and " + `${rows.length - shown}` + " more; search with search_artifacts";
  }
  out = out + "\nAny change to one of the files above must be written to its exact path, "
    + "character for character including capitalization — a near-miss path creates a duplicate file, not a new version.";
  out = out + "\nRead one with read_artifact before changing it. Updating an existing path appends a new version, "
    + "and only the write_artifact tool can do that; a new path always creates a new file.";
  return out;
}

export function listArtifacts(db: Db, threadId: string): ArtifactRow[] {
  let none: ArtifactRow[] = [];
  let keys: DbOrder[] = [{ column: "slot" }];
  let listed = listOrdered(db, artifactsMapping(), {
    where: "thread_id = " + placeholderAt(db, 1),
    args: [threadId],
    order: keys,
  });
  if (listed == "" || listed == "[]") {
    return none;
  }
  return JSON.parse<ArtifactRow[]>(listed);
}

export type ArtifactCard = {
  id: string,
  threadId: string,
  threadTitle: string,
  slot: int,
  path: string,
  title: string,
  kind: string,
  currentVersion: int,
  updatedAt: string,
  excerpt: string,
};

const EXCERPT = 400;

export function libraryFor(db: Db, tags: string[], cap: int): ArtifactCard[] {
  let none: ArtifactCard[] = [];
  let where = "thread_id IN (SELECT id FROM threads";
  let args: string[] = [];
  let scope = ownerClause(db, tags, 1);
  if (scope != "") {
    where = where + " WHERE " + scope;
    let t: int = 0;
    while (t < tags.length) {
      args.push(tags[t]);
      t = t + 1;
    }
  }
  where = where + ")";

  let keys: DbOrder[] = [{ column: "updated_at", direction: "desc" }];
  let listed = listOrdered(db, artifactsMapping(), { where: where, args: args, order: keys });
  if (listed == "" || listed == "[]") {
    return none;
  }
  let rows = JSON.parse<ArtifactRow[]>(listed);

  let out: ArtifactCard[] = [];
  let i: int = 0;
  while (i < rows.length && out.length < cap) {
    let row = rows[i];
    let excerpt = "";
    if (!binaryKind(row.kind)) {
      let held = getVersion(db, row.id, row.currentVersion);
      let body = held.body;
      excerpt = body.length > EXCERPT ? body.slice(0, EXCERPT) : body;
    }
    let card: ArtifactCard = {
      id: row.id, threadId: row.threadId, threadTitle: "",
      slot: row.slot, path: row.path, title: row.title, kind: row.kind,
      currentVersion: row.currentVersion, updatedAt: row.updatedAt,
      excerpt: excerpt,
    };
    out.push(card);
    i = i + 1;
  }
  return out;
}

export type TurnArtifact = {
  turnSeq: int,
  slot: int,
  path: string,
  title: string,
  kind: string,
  version: int,
};

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

function turnArtifactSql(): string {
  return "SELECT artifact_versions.turn_seq, artifacts.slot, artifacts.path,"
    + " artifacts.title, artifacts.kind, artifact_versions.version"
    + " FROM artifact_versions"
    + " JOIN artifacts ON artifacts.id = artifact_versions.artifact_id";
}

export function artifactsForTurn(db: Db, threadId: string, turnSeq: int): TurnArtifact[] {
  let out: TurnArtifact[] = [];
  if (turnSeq < 0) {
    return out;
  }
  let sql = turnArtifactSql()
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1)
    + " AND artifact_versions.turn_seq = " + placeholderAt(db, 2)
    + " AND artifact_versions.turn_seq >= 0"
    + " ORDER BY artifacts.slot, artifact_versions.version";
  if (!db.query(sql, [threadId, `${turnSeq}`])) {
    return out;
  }
  let i: int = 0;
  while (i < db.rows()) {
    out.push(turnArtifactAt(db, i));
    i = i + 1;
  }
  return out;
}

export function artifactsByTurn(db: Db, threadId: string): TurnArtifact[] {
  let out: TurnArtifact[] = [];
  let sql = turnArtifactSql()
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1)
    + " AND artifact_versions.turn_seq >= 0"
    + " ORDER BY artifact_versions.turn_seq, artifacts.slot, artifact_versions.version";
  if (!db.query(sql, [threadId])) {
    return out;
  }
  let i: int = 0;
  while (i < db.rows()) {
    out.push(turnArtifactAt(db, i));
    i = i + 1;
  }
  return out;
}

export function findByToken(db: Db, token: string): ArtifactRow {
  if (token == "") {
    return noArtifact();
  }
  let listed = listWhere(db, artifactsMapping(), "preview_token = " + placeholderAt(db, 1), [token]);
  if (listed == "" || listed == "[]") {
    return noArtifact();
  }
  let rows: ArtifactRow[] = JSON.parse<ArtifactRow[]>(listed);
  if (rows.length == 0) {
    return noArtifact();
  }
  return rows[0];
}

export function getVersion(db: Db, artifactId: string, version: int): ArtifactVersionRow {
  let absent: ArtifactVersionRow = {
    id: "", artifactId: artifactId, version: 0, body: "", bytes: 0,
    origin: "", turnSeq: TURN_SEQ_NONE, note: "", createdAt: "",
  };
  let document = findById(db, artifactVersionsMapping(), artifactId + ":" + `${version}`);
  if (document == "") {
    return absent;
  }
  return JSON.parse<ArtifactVersionRow>(document);
}

export function deleteArtifact(db: Db, threadId: string, path: string): string {
  let artifact = getArtifact(db, threadId, path);
  if (artifact.id == "") {
    return "no artifact at \"" + normalScope(path) + "\" in this thread";
  }

  let opened = beginTransaction(db);
  if (!opened.ok) {
    return opened.error;
  }

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
