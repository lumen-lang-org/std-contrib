import { Guarded } from "../../../rest/server.ts";
import { pgOnly } from "../../guards.ts";
import { DocumentService } from "./document.service.ts";

export function corpusIsPostgres(documents: DocumentService): Guarded {
  let database = documents.repository.database;
  return pgOnly(database, "documents need PostgreSQL (pgvector); this runs on " + database.name);
}
