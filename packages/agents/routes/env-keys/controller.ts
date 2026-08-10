import { Db } from "../../../plume/driver.ts";
import { existsById, findById } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { createEnvKey, envKeysMapping, envKeysOwnedBy, forgetEnvKey } from "../../env-keys.ts";
import { owningTag } from "../../owner.ts";
import { jsonText } from "../../scan.ts";
import { scriptImagesMapping } from "../../schema.ts";
import { userEnvById } from "../../user-environments.ts";

@controller("/env-keys")
export class EnvKeyApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(envKeysOwnedBy(this.db, owningTag(tags)));
  }

  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes an environment key yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"imageId\":\"...\",\"name\":\"OPENAI_API_KEY\",\"value\":\"...\"}");
    }
    let imageId = jsonText(req.body, "imageId");
    if (imageId != "default"
        && !existsById(this.db, scriptImagesMapping(), imageId)
        && userEnvById(this.db, imageId, owner).id == "") {
      return badRequest("no environment has the id \"" + imageId + "\" — one of yours, one this deployment offers, or \"default\" for the one an agent gets when nobody chose");
    }
    let made = createEnvKey(this.db, {
      owner: owner,
      imageId: imageId,
      name: jsonText(req.body, "name"),
      value: jsonText(req.body, "value"),
      master: this.master,
      now: stamp(),
    });
    if (made.problem != "") { return badRequest(made.problem); }
    return created(findById(this.db, envKeysMapping(), made.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!forgetEnvKey(this.db, param(req, "id"), owningTag(callerTags(req)))) {
      return notFound("environment key " + param(req, "id"));
    }
    return noContent();
  }
}
