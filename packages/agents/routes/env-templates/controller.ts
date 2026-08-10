import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, noContent, notFound, ok, param, problem } from "../../../rest/server.ts";
import { callerTags, stamp } from "../../api-core.ts";
import { EnvTemplateWrite, envTemplatesAll, forgetEnvTemplate, saveEnvTemplate } from "../../env-templates.ts";
import { owningTag } from "../../owner.ts";
import { jsonRaw, jsonText } from "../../scan.ts";

// The /env-templates routes.

// The operator's catalog of environment recipes (env-templates.ts).
//
// Two audiences, one table. Anyone signed in reads it — that is browsing the
// catalog, and the console proxy tiers a GET here as user. Only an operator
// writes it, because a template carries a Dockerfile that builds as root, and
// the proxy default-denies the writes to admin the same way it does the
// script_images table. The engine keeps no auth of its own here for the same
// reason every admin route does not: :8100 is never directly reachable, which
// is the launch gate that makes the proxy's tiering the boundary.
@controller("/env-templates")
export class EnvTemplateApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  // The whole catalog, featured first. Read by anyone signed in, to browse.
  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(JSON.stringify(envTemplatesAll(this.db)));
  }

  // Create or update, keyed by id — an empty id mints one. Operator only.
  @post("/")
  save(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required: {\"name\":\"...\",\"summary\":\"...\",\"image\":\"...\"} or a dockerfile instead of image"); }
    // featuredRank is a number token, hand-parsed: parseInt answers i32|null
    // here, and a bare digit walk is the codebase's habit for reading one off
    // a request. Anything non-numeric reads as 0 — not featured.
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
