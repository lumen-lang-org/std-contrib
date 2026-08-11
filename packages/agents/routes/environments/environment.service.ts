import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { EnvOwnedRow } from "../../environments.ts";
import { holdsOwner } from "../../owner.ts";
import { UserEnvWrite } from "../../user-environments.ts";
import { EnvCatalogItem } from "./dtos/env-catalog-item.dto.ts";
import { EnvCreateAsk } from "./dtos/env-create-ask.dto.ts";
import { EnvironmentRepository } from "./environment.repository.ts";
import { defaultCatalogItem, ownCatalogItemOf, sharedCatalogItemOf } from "./environment.utils.ts";

export class EnvironmentService {
  repository: EnvironmentRepository;

  constructor(database: Db) {
    this.repository = new EnvironmentRepository(database);
  }

  catalog(owner: string): EnvCatalogItem[] {
    let items: EnvCatalogItem[] = [];
    let mine = this.repository.own(owner);
    let m: int = 0;
    while (m < mine.length) {
      items.push(ownCatalogItemOf(mine[m], this.repository.imagePresent(mine[m].image)));
      m = m + 1;
    }
    let shared = this.repository.shared();
    let i: int = 0;
    while (i < shared.length) {
      items.push(sharedCatalogItemOf(shared[i], this.repository.imagePresent(shared[i].image)));
      i = i + 1;
    }
    items.push(defaultCatalogItem(this.repository.defaultImagePresent()));
    return items;
  }

  create(owner: string, body: string): Outcome {
    if (body == "") {
      return refusing("a body is required: {\"name\":\"...\",\"image\":\"...\"}, {\"name\":\"...\",\"dockerfile\":\"FROM ...\"}, or {\"name\":\"...\",\"templateId\":\"...\"}");
    }
    let ask: EnvCreateAsk = JSON.parse<EnvCreateAsk>(body);
    let image = ask.image ?? "";
    let dockerfile = ask.dockerfile ?? "";
    let name = ask.name ?? "";
    let templateId = ask.templateId ?? "";
    if (templateId != "") {
      let t = this.repository.template(templateId);
      if (t.id == "") {
        return refusing("no template has the id \"" + templateId + "\" — the catalog says which exist");
      }
      image = t.image;
      dockerfile = t.dockerfile;
      if (name.trim() == "") {
        name = t.name;
      }
    }
    let write: UserEnvWrite = {
      owner: owner, name: name, image: image, dockerfile: dockerfile, now: stamp(),
    };
    let made = this.repository.create(write);
    if (made.fault != "") {
      return refusing(made.fault);
    }
    return produced(this.repository.one(made.id));
  }

  owns(id: string, owner: string): bool {
    return this.repository.ownedRow(id, owner).id != "";
  }

  remove(id: string, owner: string): void {
    this.repository.forget(id, owner);
    let keys = this.repository.keysOf(owner, id);
    let k: int = 0;
    while (k < keys.length) {
      this.repository.forgetKey(keys[k].id, owner);
      k = k + 1;
    }
  }

  mine(owner: string): EnvOwnedRow[] {
    return this.repository.ownedByThread(owner);
  }

  threadOwnedBy(threadId: string, tags: string[]): bool {
    return holdsOwner(tags, this.repository.ownerOfThread(threadId));
  }

  drop(threadId: string, name: string): bool {
    return this.repository.drop(threadId, name);
  }
}
