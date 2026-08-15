import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok } from "../../../../rest/server.ts";
import { configExists } from "./model-config.guard.ts";
import { ModelConfigService } from "./model-config.service.ts";

@controller("/model-configs")
@bindings
export class ConfigApi {
  configs: ModelConfigService;

  constructor(database: Db) {
    this.configs = new ModelConfigService(database);
  }

  theConfig(request: Request): Guarded {
    return configExists(this.configs, request);
  }

  @Get("/")
  list(): Reply {
    return Ok(this.configs.listing());
  }

  @Post("/")
  create(@RequestBody document: string): Reply {
    let made = this.configs.create(document);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id")
  @Guard(theConfig)
  update(@PathVariable("id") id: string, @RequestBody document: string): Reply {
    return answered(this.configs.update(id, document));
  }

  @Delete("/:id")
  @Guard(theConfig)
  remove(@PathVariable("id") id: string): Reply {
    let gone = this.configs.forget(id);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}
