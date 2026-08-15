import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok } from "../../../../rest/server.ts";
import { routerExists } from "./model-router.guard.ts";
import { ModelRouterService } from "./model-router.service.ts";

@controller("/model-routers")
@bindings
export class RouterApi {
  routers: ModelRouterService;

  constructor(database: Db) {
    this.routers = new ModelRouterService(database);
  }

  theRouter(request: Request): Guarded {
    return routerExists(this.routers, request);
  }

  @Get("/")
  list(): Reply {
    return Ok(this.routers.listing());
  }

  @Get("/:id")
  @Guard(theRouter)
  find(@PathVariable("id") id: string): Reply {
    return Ok(this.routers.one(id));
  }

  @Post("/")
  create(@RequestBody document: string): Reply {
    let made = this.routers.create(document);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id")
  @Guard(theRouter)
  update(@PathVariable("id") id: string, @RequestBody document: string): Reply {
    return answered(this.routers.update(id, document));
  }

  @Delete("/:id")
  @Guard(theRouter)
  remove(@PathVariable("id") id: string): Reply {
    let gone = this.routers.forget(id);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}
