import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, noContent, notFound, ok, param, problem } from "../../../rest/server.ts";
import { callerTags, stamp } from "../../api-core.ts";
import { EnvTemplateWrite, envTemplatesAll, forgetEnvTemplate, saveEnvTemplate } from "../../env-templates.ts";
import { owningTag } from "../../owner.ts";
import { jsonRaw, jsonText } from "../../scan.ts";

@controller("/env-templates")
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
  save(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required: {\"name\":\"...\",\"summary\":\"...\",\"image\":\"...\"} or a dockerfile instead of image"); }
    let rankRaw = jsonRaw(req.body, "featuredRank");
    let rank: int = 0;
    let ri: int = 0;
    while (ri < rankRaw.length) {
      let c = rankRaw.charCodeAt(ri);
      if (c < 48 || c > 57) { rank = 0; break; }
      rank = rank * 10 + (c - 48);
      ri = ri + 1;
    }
    let t: EnvTemplateWrite = {
      id: jsonText(req.body, "id"),
      name: jsonText(req.body, "name"),
      summary: jsonText(req.body, "summary"),
      tags: jsonText(req.body, "tags"),
      image: jsonText(req.body, "image"),
      dockerfile: jsonText(req.body, "dockerfile"),
      featuredRank: rank,
      now: stamp(),
    };
    let problem = saveEnvTemplate(this.db, t);
    if (problem != "") { return badRequest(problem); }
    return ok(JSON.stringify(envTemplatesAll(this.db)));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!forgetEnvTemplate(this.db, param(req, "id"))) {
      return notFound("template " + param(req, "id"));
    }
    return noContent();
  }
}
