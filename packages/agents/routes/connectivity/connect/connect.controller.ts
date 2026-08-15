import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, NoContent, NotFound, Respond } from "../../../../rest/server.ts";
import { owningCaller } from "../../../api-core.ts";
import { connectorExists } from "./connect.guard.ts";
import { ConnectService } from "./connect.service.ts";
import { callbackUri } from "./connect.utils.ts";
import { connectPageHtml } from "./page.ts";

function connectPage(worked: bool, detail: string): Reply {
  return Respond(200, connectPageHtml(worked, detail), "text/html; charset=utf-8");
}

@controller("/connect")
@bindings
export class ConnectApi {
  connections: ConnectService;

  constructor(database: Db, master: string) {
    this.connections = new ConnectService(database, master);
  }

  theConnector(request: Request): Guarded {
    return connectorExists(this.connections, request);
  }

  @Post("/:id/start")
  @Guard(theConnector)
  start(@PathVariable("id") id: string, @From(owningCaller) owner: string): Reply {
    return answered(this.connections.openFlow(id, owner, callbackUri()));
  }

  @Get("/callback")
  callback(@RequestParam("error", "") oauthError: string, @RequestParam("error_description", "") errorDescription: string,
           @RequestParam("state", "") state: string, @RequestParam("code", "") code: string): Reply {
    if (oauthError != "") {
      return connectPage(false, errorDescription == "" ? oauthError : errorDescription);
    }
    let done = this.connections.callback(state, code);
    if (done.fault != "") {
      return connectPage(false, done.fault);
    }
    return connectPage(true, done.serverName);
  }

  @Put("/:id/client")
  @Guard(theConnector)
  setClient(@PathVariable("id") id: string, @RequestBody document: string): Reply {
    return answered(this.connections.setClient(id, document));
  }

  @Delete("/:id/client")
  @Guard(theConnector)
  dropClient(@PathVariable("id") id: string): Reply {
    let dropped = this.connections.dropClient(id);
    if (dropped != "") {
      return BadRequest(dropped);
    }
    return NoContent();
  }

  @Delete("/:id")
  @Guard(theConnector)
  drop(@PathVariable("id") id: string, @From(owningCaller) owner: string): Reply {
    if (!this.connections.dropConnection(id, owner)) {
      return NotFound("connection to " + id);
    }
    return NoContent();
  }
}
