import { rpc } from "../../../jsonrpc/decorator.ts";
import { METHOD_NOT_FOUND, RpcReply, jsonArrayOf, jsonObjectOf, rpcFailed, rpcOk, rpcRaw } from "../../../jsonrpc/rpc.ts";
import { Db } from "../../../plume/driver.ts";
import { agentTools, callAgentTool } from "../../agent-tools.ts";
import { callKnowledgeTool, knowledgeTools } from "../../knowledge-tools.ts";
import { callProjectTool, projectTools } from "../../project-tools.ts";
import { ToolSpec } from "../../provider.ts";
import { jsonRaw, jsonText } from "../../scan.ts";
import { callTaskTool, taskTools } from "../../task-tools.ts";
import { callTriggerTool, triggerTools } from "../../trigger-tools.ts";
import { callWorkflowTool, workflowTools } from "../../workflow-tools.ts";
import { FileToolResult } from "../../workspace.ts";
import { McpAcknowledged, McpCallResult, McpInitializeResult } from "./types.ts";

export function mcpExportedTools(): ToolSpec[] {
  let out: ToolSpec[] = [];
  let families: ToolSpec[][] = [
    taskTools(), workflowTools(), triggerTools(), agentTools(),
    knowledgeTools(), projectTools(),
  ];
  let f: int = 0;
  while (f < families.length) {
    let one = families[f];
    let i: int = 0;
    while (i < one.length) {
      if (one[i].name != "set_banner") {
        out.push(one[i]);
      }
      i = i + 1;
    }
    f = f + 1;
  }
  return out;
}

export function mcpDispatch(db: Db, owner: string, name: string, args: string): FileToolResult {
  let nowMs = Date.now() as number;
  let scheduled = callTaskTool(db, { owner: owner, agentId: "", modelChoiceId: "", name: name, args: args, nowMs: nowMs });
  if (scheduled.handled) {
    return scheduled;
  }
  let flowed = callWorkflowTool(db, { owner: owner, agentId: "", name: name, args: args, nowMs: nowMs });
  if (flowed.handled) {
    return flowed;
  }
  let botted = callTriggerTool(db, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (botted.handled) {
    return botted;
  }
  let selfed = callAgentTool(db, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (selfed.handled) {
    return selfed;
  }
  if (name == "set_banner") {
    let barred: FileToolResult = { handled: true, ok: false, text: "the site banner is set from the console's own chat, not over MCP.", line: 0, changed: "" };
    return barred;
  }
  let known = callKnowledgeTool(db, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (known.handled) {
    return known;
  }
  let grouped = callProjectTool(db, { owner: owner, threadId: "", name: name, args: args, nowMs: nowMs });
  if (grouped.handled) {
    return grouped;
  }
  let none: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  return none;
}

@rpc
export class McpMethods {
  db: Db;
  owner: string;

  constructor(db: Db, owner: string) {
    this.db = db;
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
    let done = mcpDispatch(this.db, this.owner, name, args);
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
