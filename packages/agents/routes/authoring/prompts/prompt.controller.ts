import { Db } from "../../../../plume/driver.ts";
import { filingAs } from "../../../api-core.ts";
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
  list(@RequestParam("name", "") name: string,
       @RequestParam("mine", "") mine: string,
       @From(filingAs) owner: string): Reply {
    return Ok(this.prompts.listing(owner, name, mine == "true"));
  }

  @Post("/")
  create(@RequestBody sent: string, @From(filingAs) owner: string): Reply {
    let made = this.prompts.create(owner, sent);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }
}
