import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../../../plume/plume.ts";
import { createFault } from "../../payload.ts";
import { authProviderRepository } from "./entities/auth-provider.entity.ts";

export class AuthProviderRepository {
  database: Db;
  authProviders: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.authProviders = authProviderRepository();
  }

  listing(): string {
    let keys: DbOrder[] = [{ column: "label" }];
    return listOrdered(this.database, this.authProviders, { order: keys });
  }

  enabledListing(): string {
    return listWhere(this.database, this.authProviders,
      "enabled = " + placeholderAt(this.database, 1), ["1"]);
  }

  one(id: string): string {
    return findById(this.database, this.authProviders, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.authProviders, id);
  }

  creationFault(document: string): string {
    return createFault(this.database, this.authProviders, document);
  }

  save(document: string): DbResult {
    return persist(this.database, this.authProviders, document);
  }

  remove(id: string): DbResult {
    return deleteById(this.database, this.authProviders, id);
  }
}
