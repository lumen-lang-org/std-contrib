import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply, Ok, BadRequest, NoContent } from "../../../../rest/server.ts";
import { owningCaller } from "../../../api-core.ts";
import { FeedbackService } from "./feedback.service.ts";

@controller("/feedback")
@bindings
export class FeedbackApi {
  feedback: FeedbackService;

  constructor(database: Db) {
    this.feedback = new FeedbackService(database);
  }

  /* What is left of today, so the button can say so before somebody types a
   * paragraph they cannot send. */
  @Get("/mine")
  mine(@From(owningCaller) owner: string): Reply {
    return Ok(this.feedback.mine(owner));
  }

  @Post("/")
  send(@RequestBody body: string, @From(owningCaller) owner: string): Reply {
    let out = this.feedback.send(owner, body);
    if (out.fault != "") {
      return BadRequest(out.fault);
    }
    return Ok(out.document);
  }

  /* The operator's screen. Guarded by the console, which keeps /api/feedback
   * to an operator for everything but the two above. */
  @Get("/")
  list(): Reply {
    return Ok(this.feedback.listing());
  }

  @Delete("/:id")
  forget(@PathVariable("id") id: string): Reply {
    let fault = this.feedback.forget(id);
    if (fault != "") {
      return BadRequest(fault);
    }
    return NoContent();
  }
}
