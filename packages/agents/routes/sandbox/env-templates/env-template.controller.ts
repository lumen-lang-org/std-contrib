import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply, answered, NoContent, NotFound, Ok } from "../../../../rest/server.ts";
import { ownedOrEmpty } from "../../../guards.ts";
import { EnvTemplateAsk } from "./dtos/env-template-ask.dto.ts";
import { EnvTemplateService } from "./env-template.service.ts";

@controller("/env-templates")
@bindings
export class EnvTemplateApi {
  envTemplates: EnvTemplateService;

  constructor(database: Db) {
    this.envTemplates = new EnvTemplateService(database);
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(): Reply {
    return Ok(this.envTemplates.listing());
  }

  @Post("/")
  save(@Valid @RequestBody ask: EnvTemplateAsk): Reply {
    return answered(this.envTemplates.save(ask));
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!this.envTemplates.forget(id)) {
      return NotFound("template " + id);
    }
    return NoContent();
  }
}
