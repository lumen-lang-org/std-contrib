import { Db } from "../../../plume/driver.ts";
import { ApiKeyAuth, touchApiKey, verifyApiKey } from "../../api-keys.ts";

export class V1Repository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  authorize(secret: string): ApiKeyAuth {
    return verifyApiKey(this.database, secret);
  }

  touch(keyId: string, now: string): void {
    touchApiKey(this.database, keyId, now);
  }
}
