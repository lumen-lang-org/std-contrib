import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { BadRequest, Created, Ok, Reply } from "../../../../rest/server.ts";
import { PromptService } from "./prompt.service.ts";

@controller("/prompts")
@bindings
export class PromptApi {
  prompts: PromptService;

  constructor(database: Db) {
    this.prompts = new PromptService(database);
  }

  @Get("/")
  list(@RequestParam("name", "") name: string): Reply {
    return Ok(this.prompts.listing(name));
  }

  @Post("/")
  create(@RequestBody sent: string): Reply {
    let made = this.prompts.create(sent);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }
}
