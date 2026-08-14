import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, createTableSql, field, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { documentFileRepository } from "./routes/documents/entities/document-file.entity.ts";

export function documentFilesMapping(): DbRepository {
  return documentFileRepository();
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
  return repository({ table: "document_files", idField: "id", idColumn: "id", fields: fs });
}

export function documentFilesPlan(db: Db): Migration[] {
  return [
    migration("104", "document_files: the original upload kept beside its text",
      createTableSql(db, documentFilesMappingV1())),
  ];
}
