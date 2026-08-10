import { Db } from "../../../plume/driver.ts";
import { existsById, findById } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, Created, NoContent, NotFound, Ok, Refused } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { createEnvKey, envKeysMapping, envKeysOwnedBy, forgetEnvKey } from "../../env-keys.ts";
import { owningTag } from "../../owner.ts";
import { jsonText } from "../../scan.ts";
import { scriptImagesMapping } from "../../schema.ts";
import { userEnvById } from "../../user-environments.ts";
import { ownedOrEmpty, roleAtLeast } from "../../guards.ts";

@controller("/env-keys")
@bindings
export class EnvKeyApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(req: Request): Reply {
    let tags = callerTags(req);
    return Ok(envKeysOwnedBy(this.db, owningTag(tags)));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes an environment key yours to keep"))
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (req.body == "") {
      return BadRequest("a body is required: {\"imageId\":\"...\",\"name\":\"OPENAI_API_KEY\",\"value\":\"...\"}");
    }
    let imageId = jsonText(req.body, "imageId");
    if (imageId != "default"
        && !existsById(this.db, scriptImagesMapping(), imageId)
        && userEnvById(this.db, imageId, owner).id == "") {
      return BadRequest("no environment has the id \"" + imageId + "\" — one of yours, one this deployment offers, or \"default\" for the one an agent gets when nobody chose");
    }
    let made = createEnvKey(this.db, {
      owner: owner,
      imageId: imageId,
      name: jsonText(req.body, "name"),
      value: jsonText(req.body, "value"),
      master: this.master,
      now: stamp(),
    });
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(findById(this.db, envKeysMapping(), made.id));
  }

  @Delete("/:id")
  remove(req: Request, @PathVariable("id") id: string): Reply {
    if (!forgetEnvKey(this.db, id, owningTag(callerTags(req)))) {
      return NotFound("environment key " + id);
    }
    return NoContent();
  }
}
