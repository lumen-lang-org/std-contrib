import { Guarded } from "../../../rest/server.ts";
import { pgOnly } from "../../guards.ts";
import { ScopeService } from "./scope.service.ts";

export function scopesNeedPostgres(scopes: ScopeService): Guarded {
  let database = scopes.repository.database;
  return pgOnly(database, "documents need PostgreSQL (pgvector); this runs on " + database.name);
}
