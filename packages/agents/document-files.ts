// The original bytes of an uploaded knowledge document, kept beside its text.
//
// Indexing a document keeps only what retrieval needs: the extracted text, cut
// into chunks and embedded (`documents`), plus a row saying the work happened
// (`index_jobs`). The file itself was read once and thrown away. That is right
// for retrieval and wrong for a reader — the console can list a .pdf it has no
// way to show, and the person who uploaded it has no way to get it back. The
// only copy of their own file was the one they no longer have.
//
// So the bytes live here, in their own table, and nothing else changes. The
// corpus is untouched: `documents` still holds text, the indexer still reads
// text, and retrieval never looks at this table. A row here is a keepsake, not
// an input — losing one costs a preview and not an answer, which is why this is
// a separate table rather than a column on `documents` (where it would ride
// every chunk, every retrieval and every rewrite of the corpus).
//
// Base64 in a text column rather than a binary column: every driver in
// `packages/plume` moves values as text, and `persist` writes a row by handing
// the database one JSON document. A bytea column would mean a second write path
// for one table. The cost is a third more storage and it is worth not having
// two ways to store a row.

import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, createTableSql, deleteWhere, field, findById, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
// The one spelling of a folder path, shared with the corpus: an id built from
// "/specs" and one built from "/specs/" must be the same id, or a re-upload
// writes a second row instead of replacing the first.
import { normalScope } from "./knowledge.ts";

// The kept original, as stored.
//
// `createdAt` is epoch-millis digit text, which is what `stamp()` writes on
// every other row in this package — see tasks.ts on why the stamps are text.
export type DocumentFileRow = {
  // scope + "/" + source, normalised. See `documentFileId`.
  id: string,
  // The document this belongs to, spelled exactly as `documents.source` spells
  // it, so the listing can match the two without a translation step.
  source: string,
  scope: string,
  // What to call the file when it is handed back — "notes.pdf". Distinct from
  // `source`, which is a plain name the corpus files chunks under and may have
  // had its dots and spaces taken out.
  filename: string,
  mime: string,
  // The file, base64. The column is text; see the note at the top of the file.
  bytes: string,
  // The DECODED length, so a caller can show a size without decoding megabytes
  // of base64 to count them. `int` is 32 bits here, which the cap below keeps
  // this well inside.
  size: int,
  createdAt: string,
};

/** The id a (scope, source) pair maps to: the normalised scope, a slash, and
 *  the source.
 *
 *  Deterministic and readable, on purpose. Deterministic because the whole
 *  point of the upsert is that re-uploading the same document REPLACES its
 *  kept copy rather than accumulating one row per attempt — a random id would
 *  make every re-upload a leak of the previous bytes. Readable because the
 *  alternative is a hash, and a hash means an operator looking at a stray row
 *  in psql cannot tell which document it belongs to.
 *
 *  Not hashed for length, unlike the chunk ids in knowledge.ts: those must
 *  pass `safeIdentifier`'s 63 bytes because they are built into names, and
 *  this one is only ever a value in a text column. */
export function documentFileId(scope: string, source: string): string {
  return normalScope(scope) + "/" + source;
}

export function documentFilesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("source", "source", "text"),
    field("scope", "scope", "text"),
    field("filename", "filename", "text"),
    field("mime", "mime", "text"),
    field("bytes", "bytes", "text"),
    field("size", "size", "int"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("document_files", "id", "id", fs);
}

// The shape migration 104 recorded, frozen — the `projectsMappingV1` precedent
// in projects.ts, for the same reason: 104 generates its CREATE from this, a
// migration's text is checksummed, and a column added to the live mapping above
// would rewrite 104 so that every database which has already run it refuses the
// whole plan. A new column is an ALTER at a new version, never an edit here.
function documentFilesMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("source", "source", "text"),
    field("scope", "scope", "text"),
    field("filename", "filename", "text"),
    field("mime", "mime", "text"),
    field("bytes", "bytes", "text"),
    field("size", "size", "int"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("document_files", "id", "id", fs);
}

export function documentFilesPlan(db: Db): Migration[] {
  // 104: projects.ts owns 102 through 103, and a migration that sorts below one
  // already applied refuses the whole plan — which means the engine does not
  // serve at all. Checked against the live history — `SELECT version FROM
  // plume_schema_history ORDER BY installed_rank DESC` answered 103 as the high
  // water — before choosing the number, not after.
  return [
    migration("104", "document_files: the original upload kept beside its text",
      createTableSql(db, documentFilesMappingV1())),
  ];
}

/** How much base64 a kept file may be. Roughly 24 MB of text, so roughly an
 *  18 MB file once decoded.
 *
 *  A cap and not a policy about formats: the file belongs to the person who
 *  uploaded it and this is their own corpus, so there is nothing to allowlist.
 *  What there is to protect is the request — the body arrives as one string,
 *  the row is written as one JSON document, and both are held whole in memory.
 *  A refusal at the door is a sentence the uploader can act on; the same file
 *  accepted is a request that gets slower and heavier until something fails
 *  somewhere with nothing to say. */
export const FILE_BASE64_MAX: int = 24 * 1024 * 1024;

/** A row with every field empty — what a miss answers, so a caller tests
 *  `id == ""` the way it does for a project or a task. */
export function emptyDocumentFile(): DocumentFileRow {
  let none: DocumentFileRow = { id: "", source: "", scope: "", filename: "", mime: "", bytes: "", size: 0, createdAt: "" };
  return none;
}

/** The kept original for one document, or an empty row. */
export function findDocumentFile(db: Db, scope: string, source: string): DocumentFileRow {
  let document = findById(db, documentFilesMapping(), documentFileId(scope, source));
  if (document == "") { return emptyDocumentFile(); }
  let row: DocumentFileRow = JSON.parse<DocumentFileRow>(document);
  return row;
}

/** The sources in one folder that have a kept original.
 *
 *  One query for the whole listing rather than one per row: the folder view
 *  already costs a GROUP BY over the corpus and a scan of the job queue, and a
 *  third query per file would make a folder of two hundred documents two
 *  hundred round trips to answer a boolean. The `bytes` column is deliberately
 *  not selected — the answer is which sources, not how big they are. */
export function sourcesWithFiles(db: Db, scope: string): string[] {
  let out: string[] = [];
  let sql = "SELECT source FROM document_files WHERE scope = " + placeholderAt(db, 1);
  if (!db.query(sql, [normalScope(scope)])) { return out; }
  let i: int = 0;
  while (i < db.rows()) {
    out.push(db.value(i, 0));
    i = i + 1;
  }
  return out;
}

/** Whether `source` is in a list `sourcesWithFiles` answered. */
export function holdsSource(names: string[], source: string): bool {
  let i: int = 0;
  while (i < names.length) {
    if (names[i] == source) { return true; }
    i = i + 1;
  }
  return false;
}

/** Drop the kept original of a deleted document.
 *
 *  By source and not by id, which means scope-blind — deliberately, because
 *  that is exactly how the corpus deletes: `DELETE FROM documents WHERE
 *  source = ?` takes every chunk of that source in every folder. Deleting by
 *  the composed id instead would leave the file of a document whose text is
 *  gone, and a file nothing can ever reach is a file nothing will ever
 *  delete. */
export function forgetDocumentFiles(db: Db, source: string): void {
  deleteWhere(db, documentFilesMapping(), "source = " + placeholderAt(db, 1), [source]);
}
