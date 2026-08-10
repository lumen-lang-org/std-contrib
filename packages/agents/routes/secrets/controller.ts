import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, header, noContent, ok } from "../../../rest/server.ts";
import { callerTags, guestTag } from "../../api-core.ts";
import { owningTag } from "../../owner.ts";
import { secretsOf } from "../../secrets.ts";
import { SecretCreateAsk } from "./types.ts";
import { ownedOrEmpty, roleAtLeast } from "../../guards.ts";

@controller("/secrets")
@bindings
export class SecretApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  @Guard(ownedOrEmpty)
  list(req: Request): Reply {
    let tags = callerTags(req);
    return ok(secretsOf(this.db, owningTag(tags)));
  }

  @post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a secret yours to keep"))
  create(req: Request, @RequestBody body: string): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"value\":\"...\",\"destination\":\"https://api.example.com\",\"header\":\"Authorization\",\"category\":\"Payments\"}");
    }
    let ask: SecretCreateAsk = JSON.parse<SecretCreateAsk>(body);
    let made = createSecret(this.db, {
      owner: owner,
      name: ask.name ?? "",
      value: ask.value ?? "",
      destination: ask.destination ?? "",
      header: ask.header ?? "",
      category: ask.category ?? "",
      master: this.master,
      now: stamp(),
    });
    if (made.problem != "") { return badRequest(made.problem); }
    return created(findById(this.db, secretsMapping(), made.id));
  }

  @del("/:id")
  remove(req: Request, @PathVariable("id") id: string): Reply {
    if (!forgetSecret(this.db, id, owningTag(callerTags(req)))) {
      return notFound("secret " + id);
    }
    return noContent();
  }
}
