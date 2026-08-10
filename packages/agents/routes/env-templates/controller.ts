import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, NoContent, NotFound, Ok } from "../../../rest/server.ts";
import { callerTags, stamp } from "../../api-core.ts";
import { EnvTemplateWrite, envTemplatesAll, forgetEnvTemplate, saveEnvTemplate } from "../../env-templates.ts";
import { owningTag } from "../../owner.ts";
import { EnvTemplateAsk } from "./types.ts";
import { ownedOrEmpty } from "../../guards.ts";

@controller("/env-templates")
@bindings
export class EnvTemplateApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(): Reply {
    return Ok(JSON.stringify(envTemplatesAll(this.db)));
  }

  @Post("/")
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
    if (problem != "") {
      return BadRequest(problem);
    }
    return Ok(JSON.stringify(envTemplatesAll(this.db)));
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!forgetEnvTemplate(this.db, id)) {
      return NotFound("template " + id);
    }
    return NoContent();
  }
}
