import { Db } from "../../../plume/driver.ts";
import { DbRepository, findById, listWhere, placeholderAt } from "../../../plume/plume.ts";
import { EnvKeyRow, envKeysOf, forgetEnvKey } from "../../env-keys.ts";
import { EnvTemplateRow, emptyEnvTemplate } from "../../env-templates.ts";
import { EnvEnsure, EnvEnsured, EnvOwnedRow, envDrop, envEnsure, envImagePresent, envOwned } from "../../environments.ts";
import { EnvGranted, EnvRedeem, EnvRedeemed, EnvReached, envGrantMint, envGrantRedeem, envHostFor, envReach, envTouch } from "../../env-grants.ts";
import { EnvSynced, envMaterialise } from "../../env-sync.ts";
import { scriptImage } from "../../run-script.ts";
import { threadOwner } from "../../threads.ts";
import { UserEnvMade, UserEnvRow, UserEnvWrite, createUserEnv, forgetUserEnv, userEnvById, userEnvsOf } from "../../user-environments.ts";
import { ScriptImageView } from "./dtos/script-image-view.dto.ts";
import { scriptImageRepository } from "../script-images/entities/script-image.entity.ts";
import { envTemplateRepository } from "../env-templates/entities/env-template.entity.ts";
import { userEnvironmentRepository } from "./entities/user-environment.entity.ts";

export class EnvironmentRepository {
  database: Db;
  scriptImages: DbRepository;
  envTemplates: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.scriptImages = scriptImageRepository();
    this.envTemplates = envTemplateRepository();
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
    let doc = findById(this.database, this.envTemplates, id);
    if (doc == "") {
      return emptyEnvTemplate();
    }
    return JSON.parse<EnvTemplateRow>(doc);
  }

  create(ask: UserEnvWrite): UserEnvMade {
    return createUserEnv(this.database, ask);
  }

  one(id: string): string {
    return findById(this.database, userEnvironmentRepository(), id);
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

  grant(threadId: string, name: string, owner: string, now: string): EnvGranted {
    return envGrantMint(this.database,
      { threadId: threadId, name: name, owner: owner, now: now });
  }

  redeem(token: string, slug: string, now: string): EnvRedeemed {
    let r: EnvRedeem = { token: token, slug: slug, now: now };
    return envGrantRedeem(this.database, r);
  }

  reach(slug: string): EnvReached {
    return envReach(this.database, slug);
  }

  hostFor(slug: string): string {
    return envHostFor(slug);
  }

  serve(threadId: string, name: string, image: string, command: string, start: bool, now: string): EnvEnsured {
    let e: EnvEnsure = {
      threadId: threadId, name: name, image: image,
      network: true, serve: true, command: command, start: start, now: now,
    };
    return envEnsure(this.database, e);
  }

  /** Write the conversation's artifacts into the workspace, then record the
   *  container's clock — after the copy, so the next sweep does not read this
   *  one's own writes back as changes. */
  materialise(slug: string, stageDir: string): EnvSynced {
    return envMaterialise(this.database, slug, stageDir);
  }

  touch(slug: string, now: string): bool {
    return envTouch(this.database, slug, now);
  }
}
