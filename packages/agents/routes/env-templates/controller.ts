import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Bound } from "../../../rest/plan.ts";
import { Reply, Request, badRequest, noContent, notFound, ok } from "../../../rest/server.ts";
import { callerTags, stamp } from "../../api-core.ts";
import { EnvTemplateWrite, envTemplatesAll, forgetEnvTemplate, saveEnvTemplate } from "../../env-templates.ts";
import { owningTag } from "../../owner.ts";
import { EnvTemplateAsk } from "./types.ts";

@controller("/env-templates")
@bindings
export class EnvTemplateApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(JSON.stringify(envTemplatesAll(this.db)));
  }

  @post("/")
  save(@Valid @RequestBody ask: EnvTemplateAsk): Reply {
    let t: EnvTemplateWrite = {
      id: ask.id,
      name: ask.name,
      summary: ask.summary,
      tags: ask.tags,
      image: ask.image,
      dockerfile: ask.dockerfile,
      featuredRank: ask.featuredRank,
      now: stamp(),
    };
    let problem = saveEnvTemplate(this.db, t);
    if (problem != "") { return badRequest(problem); }
    return ok(JSON.stringify(envTemplatesAll(this.db)));
  }

  @del("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!forgetEnvTemplate(this.db, id)) {
      return notFound("template " + id);
    }
    return noContent();
  }
}
