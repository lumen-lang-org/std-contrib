import { Db } from "../../../plume/driver.ts";
import { DbRepository, findById, listWhere, placeholderAt } from "../../../plume/plume.ts";
import { EnvKeyRow, envKeysOf, forgetEnvKey } from "../../env-keys.ts";
import { EnvTemplateRow, envTemplateById } from "../../env-templates.ts";
import { EnvOwnedRow, envDrop, envImagePresent, envOwned } from "../../environments.ts";
import { scriptImage } from "../../run-script.ts";
import { threadOwner } from "../../threads.ts";
import { UserEnvMade, UserEnvRow, UserEnvWrite, createUserEnv, forgetUserEnv, userEnvById, userEnvsMapping, userEnvsOf } from "../../user-environments.ts";
import { ScriptImageView } from "./dtos/script-image-view.dto.ts";
import { scriptImageRepository } from "../script-images/entities/script-image.entity.ts";

export class EnvironmentRepository {
  database: Db;
  scriptImages: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.scriptImages = scriptImageRepository();
  }

  own(owner: string): UserEnvRow[] {
    return userEnvsOf(this.database, owner);
  }

  shared(): ScriptImageView[] {
    let listed = listWhere(this.database, this.scriptImages, "enabled = " + placeholderAt(this.database, 1), ["1"]);
    return JSON.parse<ScriptImageView[]>(listed);
  }

  imagePresent(image: string): bool {
    return envImagePresent(image);
  }

  defaultImagePresent(): bool {
    return envImagePresent(scriptImage());
  }

  template(id: string): EnvTemplateRow {
    return envTemplateById(this.database, id);
  }

  create(ask: UserEnvWrite): UserEnvMade {
    return createUserEnv(this.database, ask);
  }

  one(id: string): string {
    return findById(this.database, userEnvsMapping(), id);
  }

  ownedRow(id: string, owner: string): UserEnvRow {
    return userEnvById(this.database, id, owner);
  }

  forget(id: string, owner: string): bool {
    return forgetUserEnv(this.database, id, owner);
  }

  keysOf(owner: string, imageId: string): EnvKeyRow[] {
    return JSON.parse<EnvKeyRow[]>(envKeysOf(this.database, owner, imageId));
  }

  forgetKey(id: string, owner: string): bool {
    return forgetEnvKey(this.database, id, owner);
  }

  ownedByThread(owner: string): EnvOwnedRow[] {
    return envOwned(this.database, owner);
  }

  ownerOfThread(threadId: string): string {
    return threadOwner(this.database, threadId);
  }

  drop(threadId: string, name: string): bool {
    return envDrop(this.database, threadId, name);
  }
}
