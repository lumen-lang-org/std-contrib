// The /secrets routes.

import { Db } from "../plume/driver.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, header, noContent, ok } from "../rest/server.ts";
import { callerTags, guestTag } from "./api-core.ts";
import { owningTag } from "./owner.ts";
import { secretsOf } from "./secrets.ts";

@controller("/secrets")
export class SecretApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(secretsOf(this.db, owningTag(tags)));
  }

  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    // The workflow rule, for the workflow reason: a secret is a standing key
    // somebody else's API honours, and it has to belong to somebody.
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes a secret yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"value\":\"...\",\"destination\":\"https://api.example.com\",\"header\":\"Authorization\",\"category\":\"Payments\"}");
    }
    let made = createSecret(this.db, {
      owner: owner,
      name: jsonText(req.body, "name"),
      value: jsonText(req.body, "value"),
      destination: jsonText(req.body, "destination"),
      header: jsonText(req.body, "header"),
      category: jsonText(req.body, "category"),
      master: this.master,
      now: stamp(),
    });
    if (made.problem != "") { return badRequest(made.problem); }
    // The row, never the value — the secrets table has no value column to
    // leak; the envelope lives with the credentials and no route reads it.
    return created(findById(this.db, secretsMapping(), made.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    // Owner-scoped inside forgetSecret: somebody else's secret is absent,
    // not forbidden.
    if (!forgetSecret(this.db, param(req, "id"), owningTag(callerTags(req)))) {
      return notFound("secret " + param(req, "id"));
    }
    return noContent();
  }
}
