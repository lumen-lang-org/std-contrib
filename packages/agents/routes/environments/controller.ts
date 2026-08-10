import { Db } from "../../../plume/driver.ts";
import { findById, listWhere, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Bound } from "../../../rest/plan.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, okJson } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { EnvKeyRow, envKeysOf, forgetEnvKey } from "../../env-keys.ts";
import { envTemplateById } from "../../env-templates.ts";
import { envDrop, envOwned } from "../../environments.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { ScriptImageRow, scriptImagesMapping } from "../../schema.ts";
import { threadOwner } from "../../threads.ts";
import { createUserEnv, forgetUserEnv, userEnvsMapping, userEnvsOf } from "../../user-environments.ts";
import { EnvCatalogItem, EnvCreateAsk } from "./types.ts";

@controller("/environments")
@bindings
export class EnvironmentApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  catalog(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    let items: EnvCatalogItem[] = [];
    let mine = userEnvsOf(this.db, owningTag(tags));
    let m: int = 0;
    while (m < mine.length) {
      let own: EnvCatalogItem = {
        id: mine[m].id,
        label: mine[m].name,
        summary: mine[m].source == "dockerfile" ? "built from your Dockerfile" : mine[m].image,
        mine: true,
        present: envImagePresent(mine[m].image),
      };
      items.push(own);
      m = m + 1;
    }
    let rows = JSON.parse<ScriptImageRow[]>(listWhere(this.db, scriptImagesMapping(), "enabled = " + placeholderAt(this.db, 1), ["1"]));
    let i: int = 0;
    while (i < rows.length) {
      let shared: EnvCatalogItem = {
        id: rows[i].id,
        label: rows[i].label,
        summary: rows[i].summary,
        mine: false,
        present: envImagePresent(rows[i].image),
      };
      items.push(shared);
      i = i + 1;
    }
    let fallback: EnvCatalogItem = {
      id: "default",
      label: "Default",
      summary: "the image an agent gets when nobody chose one",
      mine: false,
      present: envImagePresent(scriptImage()),
    };
    items.push(fallback);
    return okJson(items);
  }

  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes an environment yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"image\":\"...\"}, {\"name\":\"...\",\"dockerfile\":\"FROM ...\"}, or {\"name\":\"...\",\"templateId\":\"...\"}");
    }
    let ask: EnvCreateAsk = JSON.parse<EnvCreateAsk>(req.body);
    let image = ask.image ?? "";
    let dockerfile = ask.dockerfile ?? "";
    let name = ask.name ?? "";
    let templateId = ask.templateId ?? "";
    if (templateId != "") {
      let t = envTemplateById(this.db, templateId);
      if (t.id == "") { return badRequest("no template has the id \"" + templateId + "\" — the catalog says which exist"); }
      image = t.image;
      dockerfile = t.dockerfile;
      if (name.trim() == "") { name = t.name; }
    }
    let made = createUserEnv(this.db, {
      owner: owner, name: name, image: image, dockerfile: dockerfile, now: stamp(),
    });
    if (made.problem != "") { return badRequest(made.problem); }
    return created(findById(this.db, userEnvsMapping(), made.id));
  }

  @del("/:id")
  remove(req: Request, @PathVariable("id") id: string): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (!forgetUserEnv(this.db, id, owner)) {
      return notFound("environment " + id);
    }
    let keys = JSON.parse<EnvKeyRow[]>(envKeysOf(this.db, owner, id));
    let k: int = 0;
    while (k < keys.length) { forgetEnvKey(this.db, keys[k].id, owner); k = k + 1; }
    return noContent();
  }

  @get("/mine")
  mine(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    let rows = envOwned(this.db, owningTag(tags));
    return okJson(rows);
  }

  @del("/mine/:threadId/:name")
  drop(req: Request,
       @PathVariable("threadId") threadId: string,
       @PathVariable("name") name: string): Reply {
    let tags = callerTags(req);
    if (!holdsOwner(tags, threadOwner(this.db, threadId))) {
      return notFound("environment " + name);
    }
    if (!envDrop(this.db, threadId, name)) {
      return notFound("environment " + name);
    }
    return noContent();
  }
}
