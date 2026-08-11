import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Ok, OkJson } from "../../../rest/server.ts";
import { ToolCardDeleted } from "./dtos/tool-card-deleted.dto.ts";
import { toolCardExists } from "./tool-card.guard.ts";
import { ToolCardService } from "./tool-card.service.ts";

@controller("/tool-cards")
@bindings
export class ToolCardApi {
  cards: ToolCardService;

  constructor(database: Db) {
    this.cards = new ToolCardService(database);
  }

  theCard(request: Request): Guarded {
    return toolCardExists(this.cards, request);
  }

  @Get("/")
  list(): Reply {
    return Ok(this.cards.listing());
  }

  @Post("/")
  add(@RequestBody body: string): Reply {
    return answered(this.cards.add(body));
  }

  @Put("/:id")
  @Guard(theCard)
  change(@PathVariable("id") id: string, @RequestBody body: string): Reply {
    return answered(this.cards.change(id, body));
  }

  @Delete("/:id")
  @Guard(theCard)
  remove(@PathVariable("id") id: string): Reply {
    let gone = this.cards.forget(id);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    let deleted: ToolCardDeleted = { deleted: id };
    return OkJson(deleted);
  }
}
