import { Db } from "../../../plume/driver.ts";
import { ApiKeyMade, apiKeysOf, forgetApiKey, mintApiKey } from "../../api-keys.ts";

export class ApiKeyRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  listing(owner: string): string {
    return apiKeysOf(this.database, owner);
  }

  mint(owner: string, name: string, scopes: string, now: string): ApiKeyMade {
    return mintApiKey(this.database, owner, name, scopes, now);
  }

  forget(id: string, owner: string): bool {
    return forgetApiKey(this.database, id, owner);
  }
}
