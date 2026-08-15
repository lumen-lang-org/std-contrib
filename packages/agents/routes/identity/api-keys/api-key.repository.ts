import { Db } from "../../../../plume/driver.ts";
import { DbAssignment, DbOrder, DbRepository, DbResult, deleteById, findById, listOrdered, listWhere, persist, setOn } from "../../../../plume/plume.ts";
import { apiKeyRepository } from "./entities/api-key.entity.ts";
import { ApiKeyRow, emptyApiKey } from "./api-key.utils.ts";

export class ApiKeyRepository {
  database: Db;
  keys: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.keys = apiKeyRepository();
  }

  listing(owner: string): ApiKeyRow[] {
    let order: DbOrder[] = [{ column: "created_at" }];
    let listed = listOrdered(this.database, this.keys, {
      where: "owner = " + this.database.placeholder,
      args: [owner],
      order: order,
    });
    let none: ApiKeyRow[] = [];
    if (listed == "" || listed == "[]") {
      return none;
    }
    return JSON.parse<ApiKeyRow[]>(listed);
  }

  one(id: string): ApiKeyRow {
    let doc = findById(this.database, this.keys, id);
    if (doc == "") {
      return emptyApiKey();
    }
    return JSON.parse<ApiKeyRow>(doc);
  }

  byHash(hash: string): ApiKeyRow {
    let listed = listWhere(this.database, this.keys, "key_hash = " + this.database.placeholder, [hash]);
    if (listed == "" || listed == "[]") {
      return emptyApiKey();
    }
    let rows = JSON.parse<ApiKeyRow[]>(listed);
    if (rows.length == 0) {
      return emptyApiKey();
    }
    return rows[0];
  }

  save(row: ApiKeyRow): DbResult {
    return persist(this.database, this.keys, JSON.stringify(row));
  }

  remove(id: string): DbResult {
    return deleteById(this.database, this.keys, id);
  }

  touch(id: string, now: string): void {
    let values: DbAssignment[] = [{ column: "last_used_at", value: now }];
    setOn(this.database, this.keys, { id: id, values: values });
  }
}
