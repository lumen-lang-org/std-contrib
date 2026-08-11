import { Db } from "../../../plume/driver.ts";
import { existsById, findById } from "../../../plume/plume.ts";
import { EnvKeyMade, EnvKeyWrite, createEnvKey, envKeysOwnedBy, forgetEnvKey } from "../../env-keys.ts";
import { userEnvById } from "../../user-environments.ts";
import { scriptImageRepository } from "../script-images/entities/script-image.entity.ts";
import { envKeyRepository } from "./entities/env-key.entity.ts";

export class EnvKeyRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  listing(owner: string): string {
    return envKeysOwnedBy(this.database, owner);
  }

  one(id: string): string {
    return findById(this.database, envKeyRepository(), id);
  }

  imageKnown(imageId: string, owner: string): bool {
    if (imageId == "default") {
      return true;
    }
    if (existsById(this.database, scriptImageRepository(), imageId)) {
      return true;
    }
    return userEnvById(this.database, imageId, owner).id != "";
  }

  create(write: EnvKeyWrite): EnvKeyMade {
    return createEnvKey(this.database, write);
  }

  forget(id: string, owner: string): bool {
    return forgetEnvKey(this.database, id, owner);
  }
}
