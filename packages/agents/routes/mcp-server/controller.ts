import { INVALID_REQUEST, METHOD_NOT_FOUND, answered, envelopeOf, handlerFor, refused } from "../../../jsonrpc/rpc.ts";
import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, Ok } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { owningTag } from "../../owner.ts";
import { McpMethods } from "./methods.ts";

@controller("/mcp-server")
@bindings
export class McpServerApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Post("/")
  rpc(req: Request): Reply {
    let asked = envelopeOf(req.body);
    if (asked.fault != "") {
      return Ok(refused(asked.id, INVALID_REQUEST, asked.fault));
    }
    let methods = new McpMethods(this.db, owningTag(callerTags(req)));
    let handler = handlerFor(Class.decorator(methods, "rpc"), asked.method);
    if (handler == "") {
      return Ok(refused(asked.id, METHOD_NOT_FOUND, "unknown method"));
    }
    return Ok(answered(asked.id, Class.invoke(methods, handler, asked.params)));
  }
}
