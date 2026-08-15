import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok } from "../../../../rest/server.ts";
import { choiceExists } from "./model-choice.guard.ts";
import { ModelChoiceService } from "./model-choice.service.ts";

@controller("/model-choices")
@bindings
export class ChoiceApi {
  choices: ModelChoiceService;

  constructor(database: Db) {
    this.choices = new ModelChoiceService(database);
  }

  theChoice(request: Request): Guarded {
    return choiceExists(this.choices, request);
  }

  @Get("/")
  list(): Reply {
    return Ok(this.choices.listing());
  }

  @Post("/")
  create(@RequestBody document: string): Reply {
    let made = this.choices.create(document);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id")
  @Guard(theChoice)
  update(@PathVariable("id") id: string, @RequestBody document: string): Reply {
    return answered(this.choices.update(id, document));
  }

  @Delete("/:id")
  @Guard(theChoice)
  remove(@PathVariable("id") id: string): Reply {
    let gone = this.choices.forget(id);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}
