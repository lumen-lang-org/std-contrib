import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok, OkJson } from "../../../rest/server.ts";
import { owningCaller } from "../../api-core.ts";
import { serverExists, serverListed } from "./server.guard.ts";
import { ServerService } from "./server.service.ts";

@controller("/servers")
@bindings
export class ServerApi {
  servers: ServerService;

  constructor(database: Db, master: string) {
    this.servers = new ServerService(database, master);
  }

  theServer(request: Request): Guarded {
    return serverExists(this.servers, request);
  }

  theListedServer(request: Request): Guarded {
    return serverListed(this.servers, request);
  }

  @Get("/")
  list(): Reply {
    return Ok(this.servers.listing());
  }

  @Get("/:id/tools")
  @Guard(theListedServer)
  tools(@PathVariable("id") id: string, @From(owningCaller) owner: string): Reply {
    return Ok(this.servers.tools(id, owner));
  }

  @Post("/")
  create(@RequestBody document: string): Reply {
    let made = this.servers.create(document);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id/auth")
  @Guard(theServer)
  setAuth(@PathVariable("id") id: string, @RequestBody document: string): Reply {
    return answered(this.servers.setAuth(id, document));
  }

  @Put("/:id/tools/:tool")
  @Guard(theServer)
  setTool(@PathVariable("id") id: string, @PathVariable("tool") tool: string,
          @RequestBody document: string): Reply {
    let switched = this.servers.setTool(id, tool, document);
    if (switched.fault != "") {
      return BadRequest(switched.fault);
    }
    return NoContent();
  }

  @Put("/:id/mine")
  @Guard(theServer)
  setMine(@PathVariable("id") id: string, @From(owningCaller) owner: string,
          @RequestBody document: string): Reply {
    return answered(this.servers.setMine(id, owner, document));
  }

  @Get("/:id/mine")
  @Guard(theServer)
  mine(@PathVariable("id") id: string, @From(owningCaller) owner: string): Reply {
    return OkJson(this.servers.mine(id, owner));
  }

  @Delete("/:id/mine")
  @Guard(theServer)
  forgetMine(@PathVariable("id") id: string, @From(owningCaller) owner: string): Reply {
    let gone = this.servers.forgetMine(id, owner);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }

  @Put("/:id")
  @Guard(theServer)
  update(@PathVariable("id") id: string, @RequestBody document: string): Reply {
    return answered(this.servers.update(id, document));
  }

  @Delete("/:id")
  @Guard(theServer)
  remove(@PathVariable("id") id: string): Reply {
    this.servers.forget(id);
    return NoContent();
  }

  @Get("/connections")
  connections(@From(owningCaller) owner: string): Reply {
    return OkJson(this.servers.connections(owner));
  }
}
