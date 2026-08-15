import { Db } from "../plume/driver.ts";
import { DbRepository, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { apiKeyRepository } from "./routes/identity/api-keys/entities/api-key.entity.ts";

export function apiKeysMapping(): DbRepository {
  return apiKeyRepository();
}

export function apiKeysPlan(db: Db): Migration[] {
  return [
    migration("115", "api keys: a standing credential for the public /v1 products",
      createTableSql(db, apiKeysMapping())),
  ];
}
