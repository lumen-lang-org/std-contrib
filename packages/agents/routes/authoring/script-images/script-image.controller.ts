import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok } from "../../../../rest/server.ts";
import { scriptImageExists } from "./script-image.guard.ts";
import { ScriptImageService } from "./script-image.service.ts";

@controller("/script-images")
@bindings
export class ScriptImageApi {
  images: ScriptImageService;

  constructor(database: Db) {
    this.images = new ScriptImageService(database);
  }

  theImage(request: Request): Guarded {
    return scriptImageExists(this.images, request);
  }

  @Get("/")
  list(): Reply {
    return Ok(this.images.listing());
  }

  @Post("/")
  create(@RequestBody body: string): Reply {
    let made = this.images.create(body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id")
  @Guard(theImage)
  update(@PathVariable("id") id: string, @RequestBody body: string): Reply {
    return answered(this.images.update(id, body));
  }

  @Delete("/:id")
  @Guard(theImage)
  remove(@PathVariable("id") id: string): Reply {
    let gone = this.images.forget(id);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}
