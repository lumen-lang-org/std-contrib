import { INVALID_REQUEST, METHOD_NOT_FOUND, answered, envelopeOf, handlerFor, refused } from "../../../../jsonrpc/rpc.ts";
import { Db } from "../../../../plume/driver.ts";
import { McpMethods } from "./mcp-server.methods.ts";

export class McpServerService {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  respond(sent: string, owner: string): string {
    let asked = envelopeOf(sent);
    if (asked.fault != "") {
      return refused(asked.id, INVALID_REQUEST, asked.fault);
    }
    let methods = new McpMethods(this.database, owner);
    let handler = handlerFor(Class.decorator(methods, "rpc"), asked.method);
    if (handler == "") {
      return refused(asked.id, METHOD_NOT_FOUND, "unknown method");
    }
    return answered(asked.id, Class.invoke(methods, handler, asked.params));
  }
}
