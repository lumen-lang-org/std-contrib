import { Db } from "../../../plume/driver.ts";
import { findById, listWhere, placeholderAt } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { EnvKeyRow, envKeysOf, forgetEnvKey } from "../../env-keys.ts";
import { envTemplateById } from "../../env-templates.ts";
import { envDrop, envOwned } from "../../environments.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { jsonText } from "../../scan.ts";
import { ScriptImageRow, scriptImagesMapping } from "../../schema.ts";
import { threadOwner } from "../../threads.ts";
import { createUserEnv, forgetUserEnv, userEnvsMapping, userEnvsOf } from "../../user-environments.ts";

// The /environments routes.

// The environments themselves, as their users see them.
//
// /script-images is the operator's table: image references, admin-tier,
// where rows are made. This is the same catalog read from the other side —
// what a signed-in person may run scripts IN, plus the containers their own
// conversations already hold. Two doors to one table, because "curate the
// deployment" and "manage my environments" are different permissions that
// happen to meet at the same rows.
@controller("/environments")
export class EnvironmentApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  // The choosable environments: the caller's own first, then the
  // deployment's. Label and summary, which is what choosing needs — never
  // the image reference for curated rows, which is how the operator spells
  // it; a person's own row shows its source, because they wrote it.
  // `present` is whether the daemon holds the image already; a person's own
  // are present by construction — created means built or pulled.
  @get("/")
  catalog(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    let out = "[";
    let mine = userEnvsOf(this.db, owningTag(tags));
    let m: int = 0;
    while (m < mine.length) {
      if (m > 0) { out = out + ","; }
      out = out + "{\"id\":" + JSON.stringify(mine[m].id)
        + ",\"label\":" + JSON.stringify(mine[m].name)
        + ",\"summary\":" + JSON.stringify(mine[m].source == "dockerfile" ? "built from your Dockerfile" : mine[m].image)
        + ",\"mine\":true,\"present\":" + `${envImagePresent(mine[m].image)}` + "}";
      m = m + 1;
    }
    let rows = JSON.parse<ScriptImageRow[]>(listWhere(this.db, scriptImagesMapping(), "enabled = " + placeholderAt(this.db, 1), ["1"]));
    let i: int = 0;
    while (i < rows.length) {
      if (m + i > 0) { out = out + ","; }
      out = out + "{\"id\":" + JSON.stringify(rows[i].id)
        + ",\"label\":" + JSON.stringify(rows[i].label)
        + ",\"summary\":" + JSON.stringify(rows[i].summary)
        + ",\"mine\":false,\"present\":" + `${envImagePresent(rows[i].image)}` + "}";
      i = i + 1;
    }
    // The deployment default rides along under the id the env-keys door
    // already uses for it, so the two screens name one thing one way.
    if (m + i > 0) { out = out + ","; }
    out = out + "{\"id\":\"default\",\"label\":\"Default\",\"summary\":"
      + "\"the image an agent gets when nobody chose one\""
      + ",\"mine\":false,\"present\":" + `${envImagePresent(scriptImage())}` + "}";
    return ok(out + "]");
  }

  // Make an environment: a name and an image to pull, a name and a Dockerfile
  // to build, or a name and a `templateId` from the catalog — in which case
  // the image or Dockerfile is the operator's, copied from the template. The
  // reply is the row or the build's own last lines; a create that returns is
  // an environment that starts.
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
    // From a catalog template: the recipe is the operator's, so the model on
    // the model's side of the wire still never names an image — it named a
    // template id, and the image or Dockerfile behind it was written here.
    // A name defaults to the template's when the person did not give one.
    let image = jsonText(req.body, "image");
    let dockerfile = jsonText(req.body, "dockerfile");
    let name = jsonText(req.body, "name");
    let templateId = jsonText(req.body, "templateId");
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

  // Forget one of mine: the row, the image when we built it, and every key
  // stored against it — a key scoped to an environment that no longer exists
  // is unreachable by construction, so keeping its envelope keeps nothing.
  @del("/:id")
  remove(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    let id = param(req, "id");
    if (!forgetUserEnv(this.db, id, owner)) {
      return notFound("environment " + id);
    }
    let keys = JSON.parse<EnvKeyRow[]>(envKeysOf(this.db, owner, id));
    let k: int = 0;
    while (k < keys.length) { forgetEnvKey(this.db, keys[k].id, owner); k = k + 1; }
    return noContent();
  }

  // The containers this person's conversations hold, joined to the titles
  // that make them recognisable. Names and states, never anybody else's.
  @get("/mine")
  mine(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(JSON.stringify(envOwned(this.db, owningTag(tags))));
  }

  // Drop one: the container, its row, and — when it was the conversation's
  // last — the shared workspace volume. The next run_script naming this
  // environment rebuilds it fresh, so this is "start me over", never "break
  // the conversation". Owner-checked the way every thread route is: somebody
  // else's is absent, not forbidden.
  @del("/mine/:threadId/:name")
  drop(req: Request): Reply {
    let tags = callerTags(req);
    let threadId = param(req, "threadId");
    if (!holdsOwner(tags, threadOwner(this.db, threadId))) {
      return notFound("environment " + param(req, "name"));
    }
    if (!envDrop(this.db, threadId, param(req, "name"))) {
      return notFound("environment " + param(req, "name"));
    }
    return noContent();
  }
}
