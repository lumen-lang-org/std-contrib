import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply, Ok } from "../../../../rest/server.ts";
import { owningCaller } from "../../../api-core.ts";
import { McpServerService } from "./mcp-server.service.ts";

@controller("/mcp-server")
@bindings
export class McpServerApi {
  mcp: McpServerService;

  constructor(database: Db) {
    this.mcp = new McpServerService(database);
  }

  @Post("/")
  rpc(@RequestBody sent: string, @From(owningCaller) owner: string): Reply {
    return Ok(this.mcp.respond(sent, owner));
  }
}
