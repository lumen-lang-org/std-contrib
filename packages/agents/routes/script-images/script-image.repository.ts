import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, existsById, findById, listOrdered, persist } from "../../../plume/plume.ts";
import { scriptImageRepository } from "./entities/script-image.entity.ts";

export class ScriptImageRepository {
  database: Db;
  images: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.images = scriptImageRepository();
  }

  listing(): string {
    let keys: DbOrder[] = [{ column: "label" }];
    return listOrdered(this.database, this.images, { order: keys });
  }

  one(id: string): string {
    return findById(this.database, this.images, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.images, id);
  }

  save(document: string): DbResult {
    return persist(this.database, this.images, document);
  }

  forget(id: string): string {
    let gone = deleteById(this.database, this.images, id);
    if (!gone.ok) {
      return gone.error;
    }
    return "";
  }
}
