import { Db } from "../../../../plume/driver.ts";
import { ApiKeyAuth } from "../../identity/api-keys/api-key.utils.ts";
import { ApiKeyService } from "../../identity/api-keys/api-key.service.ts";

export class V1Repository {
  database: Db;
  apiKeys: ApiKeyService;

  constructor(database: Db) {
    this.database = database;
    this.apiKeys = new ApiKeyService(database);
  }

  authorize(secret: string): ApiKeyAuth {
    return this.apiKeys.verify(secret);
  }

  touch(keyId: string, now: string): void {
    this.apiKeys.touch(keyId, now);
  }
}
