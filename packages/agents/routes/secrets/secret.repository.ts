import { Db } from "../../../plume/driver.ts";
import { findById } from "../../../plume/plume.ts";
import { SecretMade, SecretWrite, createSecret, forgetSecret, secretsOf } from "../../secrets.ts";
import { secretRepository } from "./entities/secret.entity.ts";

export class SecretRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  listing(owner: string): string {
    return secretsOf(this.database, owner);
  }

  one(id: string): string {
    return findById(this.database, secretRepository(), id);
  }

  create(write: SecretWrite): SecretMade {
    return createSecret(this.database, write);
  }

  forget(id: string, owner: string): bool {
    return forgetSecret(this.database, id, owner);
  }
}
