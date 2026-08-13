import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { EnvOwnedRow } from "../../environments.ts";
import { holdsOwner } from "../../owner.ts";
import { UserEnvWrite } from "../../user-environments.ts";
import { EnvCatalogItem } from "./dtos/env-catalog-item.dto.ts";
import { EnvCreateAsk } from "./dtos/env-create-ask.dto.ts";
import { EnvGrantView } from "./dtos/env-grant-view.dto.ts";
import { EnvServeAsk } from "./dtos/env-serve-ask.dto.ts";
import { EnvServedView } from "./dtos/env-served-view.dto.ts";
import { EnvReachView } from "./dtos/env-reach-view.dto.ts";
import { EnvRedeemedView } from "./dtos/env-redeemed-view.dto.ts";
import { EnvRedeemAsk } from "./dtos/env-redeem-ask.dto.ts";
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

  /** A way in for the person whose conversation this is. What comes back is a
   *  link, not a credential to keep: it is good for a minute and one visit. */
  grant(threadId: string, name: string, owner: string): Outcome {
    let made = this.repository.grant(threadId, name, owner, stamp());
    if (!made.ok) {
      return refusing(made.fault);
    }
    let view: EnvGrantView = { url: made.url, host: this.repository.hostFor(made.slug) };
    return produced(JSON.stringify(view));
  }

  /** Spent by the gateway, once, on behalf of a browser that has just arrived
   *  at the environment's hostname carrying the link. */
  redeem(body: string): EnvRedeemedView {
    let refused: EnvRedeemedView = { ok: false, upstream: "", owner: "", fault: "this is not a grant" };
    if (body == "") {
      return refused;
    }
    let ask: EnvRedeemAsk = JSON.parse<EnvRedeemAsk>(body);
    let done = this.repository.redeem(ask.token ?? "", ask.slug ?? "", stamp());
    let view: EnvRedeemedView = {
      ok: done.ok, upstream: done.upstream, owner: done.owner, fault: done.fault,
    };
    return view;
  }

  /** Where a hostname's traffic goes now. Deliberately says nothing about whose
   *  conversation it is: the gateway needs an address, not an identity. */
  reach(slug: string): EnvReachView {
    // Asked by the gateway for every request it cannot answer from its cache,
    // which makes it the one honest signal that somebody is still watching.
    this.repository.touch(slug, stamp());
    let there = this.repository.reach(slug);
    let view: EnvReachView = { ok: there.ok, upstream: there.upstream, fault: there.fault };
    return view;
  }

  /** Start an environment that serves, so the gateway has something to reach.
   *  A conversation gets one of these when somebody wants to look at what it
   *  is building, rather than only at what it printed. */
  serve(threadId: string, name: string, body: string): Outcome {
    let ask: EnvServeAsk = body == "" ? { image: "" } : JSON.parse<EnvServeAsk>(body);
    // Twice, always: the first ask makes the container and starts nothing, the
    // workspace is filled from the artifacts, and the second ask starts what
    // serves it. One order, whether the container was new or already there.
    let up = this.repository.serve(threadId, name, ask.image ?? "", ask.command ?? "", false, stamp());
    if (!up.ok) {
      return refusing(up.fault);
    }
    // A fresh container starts its command against an empty workspace, so the
    // files go in and then it is asked again: the second ask finds the port
    // unanswered and runs the command, this time with the project present.
    if (up.created) {
      this.repository.materialise(up.slug, "/tmp/agents-env-" + up.slug);
    }
    up = this.repository.serve(threadId, name, ask.image ?? "", ask.command ?? "", true, stamp());
    if (!up.ok) {
      return refusing(up.fault);
    }
    let view: EnvServedView = {
      slug: up.slug,
      host: this.repository.hostFor(up.slug),
      created: up.created,
      answering: up.answering,
    };
    return produced(JSON.stringify(view));
  }
}
