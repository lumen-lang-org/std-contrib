import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, createTableSql, field, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { secretRepository } from "./routes/identity/secrets/entities/secret.entity.ts";

export function secretsMapping(): DbRepository {
  return secretRepository();
}

export function secretsPlan(db: Db): Migration[] {
  return [
    migration("109", "secrets: a value a step may send but never hold",
      createTableSqlV1(db)),
    migration("109.1", "and what it is filed under",
      "ALTER TABLE secrets ADD COLUMN category " + db.textType + " NOT NULL DEFAULT ''"),
  ];
}

function createTableSqlV1(db: Db): string {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("name", "name", "text"),
    field("header", "header", "text"),
    field("destination", "destination", "text"),
    field("createdAt", "created_at", "text"),
    field("lastUsedAt", "last_used_at", "text"),
  ];
  return createTableSql(db, repository({
    table: "secrets",
    idField: "id",
    idColumn: "id",
    fields: fs,
  }));
}
