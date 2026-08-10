// The /env-keys routes.

import { Db } from "../plume/driver.ts";
import { existsById, findById } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem } from "../rest/server.ts";
import { callerTags, guestTag, stamp } from "./api-core.ts";
import { createEnvKey, envKeysMapping, envKeysOwnedBy, forgetEnvKey } from "./env-keys.ts";
import { owningTag } from "./owner.ts";
import { jsonText } from "./scan.ts";
import { scriptImagesMapping } from "./schema.ts";
import { userEnvById } from "./user-environments.ts";

// The variables a person's scripts run with (env-keys.ts).
//
// A sibling of /secrets and deliberately so: same ownership rule, same
// write-only value, same refusal to tell an unsigned caller anything. What
// differs is where the value goes — a secret rides a workflow's HTTP step to
// one pinned origin, an environment key is put in the process environment of a
// container the person's own conversation runs.
//
// There is no route here that answers with a value, and there is no route that
// updates one. Changing a key is deleting it and storing it again, which is
// the same shape credentials.ts gives a provider key and for the same reason:
// a value that can be read back is a value that leaks through whoever can call
// this API, and an update path is a second way in to get it wrong.
@controller("/env-keys")
export class EnvKeyApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  // Every key of this person's, across environments; the settings screen
  // groups them by image. Names, never values.
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
    // The secrets rule, for the secrets reason: a standing key has to belong
    // to somebody, and a guest is nobody the next session will recognise.
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes an environment key yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"imageId\":\"...\",\"name\":\"OPENAI_API_KEY\",\"value\":\"...\"}");
    }
    // Refused here rather than stored and never read: a key against an image
    // this deployment does not offer would sit in the list looking configured
    // while no script could ever see it. "default" is the deployment's own
    // image, which has no row by definition.
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
    // The row, never the value — the table has no column for one.
    return created(findById(this.db, envKeysMapping(), made.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    // Owner-scoped inside forgetEnvKey: somebody else's key is absent, not
    // forbidden.
    if (!forgetEnvKey(this.db, param(req, "id"), owningTag(callerTags(req)))) {
      return notFound("environment key " + param(req, "id"));
    }
    return noContent();
  }
}
