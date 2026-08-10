import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, createTableSql, deleteWhere, field, findById, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { normalScope } from "./knowledge.ts";

export type DocumentFileRow = {
  id: string,
  source: string,
  scope: string,
  filename: string,
  mime: string,
  bytes: string,
  size: int,
  createdAt: string,
};

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
  return [
    migration("104", "document_files: the original upload kept beside its text",
      createTableSql(db, documentFilesMappingV1())),
  ];
}

export const FILE_BASE64_MAX: int = 24 * 1024 * 1024;

export function emptyDocumentFile(): DocumentFileRow {
  let none: DocumentFileRow = { id: "", source: "", scope: "", filename: "", mime: "", bytes: "", size: 0, createdAt: "" };
  return none;
}

export function findDocumentFile(db: Db, scope: string, source: string): DocumentFileRow {
  let document = findById(db, documentFilesMapping(), documentFileId(scope, source));
  if (document == "") { return emptyDocumentFile(); }
  let row: DocumentFileRow = JSON.parse<DocumentFileRow>(document);
  return row;
}

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

export function holdsSource(names: string[], source: string): bool {
  let i: int = 0;
  while (i < names.length) {
    if (names[i] == source) { return true; }
    i = i + 1;
  }
  return false;
}

export function forgetDocumentFiles(db: Db, source: string): void {
  deleteWhere(db, documentFilesMapping(), "source = " + placeholderAt(db, 1), [source]);
}
