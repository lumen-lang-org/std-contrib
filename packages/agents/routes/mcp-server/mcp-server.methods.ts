import { rpc } from "../../../jsonrpc/decorator.ts";
import { METHOD_NOT_FOUND, RpcReply, jsonArrayOf, jsonObjectOf, rpcFailed, rpcOk, rpcRaw } from "../../../jsonrpc/rpc.ts";
import { Db } from "../../../plume/driver.ts";
import { callAgentTool } from "../../agent-tools.ts";
import { callKnowledgeTool } from "../../knowledge-tools.ts";
import { callProjectTool } from "../../project-tools.ts";
import { jsonRaw, jsonText } from "../../scan.ts";
import { callTaskTool } from "../../task-tools.ts";
import { callTriggerTool } from "../../trigger-tools.ts";
import { callWorkflowTool } from "../../workflow-tools.ts";
import { FileToolResult } from "../../workspace.ts";
import { McpAcknowledged } from "./dtos/mcp-acknowledged.dto.ts";
import { McpCallResult } from "./dtos/mcp-call-result.dto.ts";
import { McpInitializeResult } from "./dtos/mcp-initialize-result.dto.ts";
import { mcpExportedTools } from "./mcp-server.utils.ts";

export function mcpDispatch(database: Db, owner: string, name: string, args: string): FileToolResult {
  let nowMs = Date.now() as number;
  let scheduled = callTaskTool(database, {
    owner: owner,
    agentId: "",
    modelChoiceId: "",
    name: name,
    args: args,
    nowMs: nowMs,
  });
  if (scheduled.handled) {
    return scheduled;
  }
  let flowed = callWorkflowTool(database, {
    owner: owner,
    agentId: "",
    name: name,
    args: args,
    nowMs: nowMs,
  });
  if (flowed.handled) {
    return flowed;
  }
  let botted = callTriggerTool(database, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (botted.handled) {
    return botted;
  }
  let selfed = callAgentTool(database, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (selfed.handled) {
    return selfed;
  }
  if (name == "set_banner") {
    let barred: FileToolResult = {
      handled: true,
      ok: false,
      text: "the site banner is set from the console's own chat, not over MCP.",
      line: 0,
      changed: "",
    };
    return barred;
  }
  let known = callKnowledgeTool(database, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (known.handled) {
    return known;
  }
  let grouped = callProjectTool(database, {
    owner: owner,
    threadId: "",
    name: name,
    args: args,
    nowMs: nowMs,
  });
  if (grouped.handled) {
    return grouped;
  }
  let none: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  return none;
}

@rpc
export class McpMethods {
  database: Db;
  owner: string;

  constructor(database: Db, owner: string) {
    this.database = database;
    this.owner = owner;
  }

  @method("initialize")
  initialize(params: string): RpcReply {
    let hello: McpInitializeResult = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "joule", version: "1" },
    };
    return rpcOk(hello);
  }

  @method("ping")
  @method("notifications/initialized")
  ping(params: string): RpcReply {
    let noted: McpAcknowledged = {};
    return rpcOk(noted);
  }

  @method("tools/list")
  list(params: string): RpcReply {
    let specs = mcpExportedTools();
    let listed: string[] = [];
    let i: int = 0;
    while (i < specs.length) {
      listed.push(jsonObjectOf([
        { key: "name", json: JSON.stringify(specs[i].name) },
        { key: "description", json: JSON.stringify(specs[i].description) },
        { key: "inputSchema", json: specs[i].schema },
      ]));
      i = i + 1;
    }
    return rpcRaw(jsonObjectOf([{ key: "tools", json: jsonArrayOf(listed) }]));
  }

  @method("tools/call")
  call(params: string): RpcReply {
    let name = jsonText(params, "name");
    let args = jsonRaw(params, "arguments");
    if (args == "") {
      args = "{}";
    }
    let done = mcpDispatch(this.database, this.owner, name, args);
    if (!done.handled) {
      return rpcFailed(METHOD_NOT_FOUND, "no tool named " + name);
    }
    let said: McpCallResult = {
      content: [{ type: "text", text: done.text }],
      isError: !done.ok,
    };
    return rpcOk(said);
  }
}
