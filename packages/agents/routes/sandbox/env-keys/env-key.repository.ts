import { Db } from "../../../../plume/driver.ts";
import { countWhere, existsById, findById, placeholderAt } from "../../../../plume/plume.ts";
import { EnvKeyMade, EnvKeyWrite, createEnvKey, envKeysOwnedBy, forgetEnvKey } from "../../../env-keys.ts";
import { scriptImageRepository } from "../../authoring/script-images/entities/script-image.entity.ts";
import { userEnvironmentRepository } from "../environments/entities/user-environment.entity.ts";
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
    let owned = countWhere(this.database, userEnvironmentRepository(),
      "id = " + this.database.placeholder + " AND owner = " + placeholderAt(this.database, 2),
      [imageId, owner]);
    return owned > 0;
  }

  create(write: EnvKeyWrite): EnvKeyMade {
    return createEnvKey(this.database, write);
  }

  forget(id: string, owner: string): bool {
    return forgetEnvKey(this.database, id, owner);
  }
}
