import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok } from "../../../rest/server.ts";
import { ModelAsk } from "./dtos/model-ask.dto.ts";
import { modelExists } from "./model.guard.ts";
import { ModelService } from "./model.service.ts";

@controller("/models")
@bindings
export class ModelApi {
  models: ModelService;

  constructor(database: Db, master: string) {
    this.models = new ModelService(database, master);
  }

  theModel(request: Request): Guarded {
    return modelExists(this.models, request);
  }

  @Get("/")
  list(): Reply {
    return Ok(this.models.listing());
  }

  @Get("/choices")
  choices(): Reply {
    return Ok(this.models.choices());
  }

  @Post("/")
  create(@Valid @RequestBody ask: ModelAsk): Reply {
    let made = this.models.create(ask);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Post("/:id/test")
  @Guard(theModel)
  test(@PathVariable("id") id: string): Reply {
    return answered(this.models.test(id));
  }

  @Put("/:id")
  @Guard(theModel)
  update(@PathVariable("id") id: string, @Valid @RequestBody ask: ModelAsk): Reply {
    return answered(this.models.update(id, ask));
  }

  @Delete("/:id")
  @Guard(theModel)
  remove(@PathVariable("id") id: string): Reply {
    let gone = this.models.forget(id);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}
