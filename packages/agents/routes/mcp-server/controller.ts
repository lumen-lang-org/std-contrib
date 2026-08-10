import { INVALID_REQUEST, METHOD_NOT_FOUND, answered, envelopeOf, jsonArrayOf, jsonObjectOf, refused, rpcOk, rpcRaw } from "../../../jsonrpc/rpc.ts";
import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, ok } from "../../../rest/server.ts";
import { agentTools, callAgentTool } from "../../agent-tools.ts";
import { callerTags } from "../../api-core.ts";
import { callKnowledgeTool, knowledgeTools } from "../../knowledge-tools.ts";
import { owningTag } from "../../owner.ts";
import { callProjectTool, projectTools } from "../../project-tools.ts";
import { ToolSpec } from "../../provider.ts";
import { jsonRaw, jsonText } from "../../scan.ts";
import { callTaskTool, taskTools } from "../../task-tools.ts";
import { callTriggerTool, triggerTools } from "../../trigger-tools.ts";
import { callWorkflowTool, workflowTools } from "../../workflow-tools.ts";
import { FileToolResult } from "../../workspace.ts";
import { McpAcknowledged, McpCallResult, McpInitializeResult } from "./types.ts";

function mcpExportedTools(): ToolSpec[] {
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
      if (one[i].name != "set_banner") { out.push(one[i]); }
      i = i + 1;
    }
    f = f + 1;
  }
  return out;
}

function mcpDispatch(db: Db, owner: string, name: string, args: string): FileToolResult {
  let nowMs = Date.now() as number;
  let scheduled = callTaskTool(db, { owner: owner, agentId: "", modelChoiceId: "", name: name, args: args, nowMs: nowMs });
  if (scheduled.handled) { return scheduled; }
  let flowed = callWorkflowTool(db, { owner: owner, agentId: "", name: name, args: args, nowMs: nowMs });
  if (flowed.handled) { return flowed; }
  let botted = callTriggerTool(db, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (botted.handled) { return botted; }
  let selfed = callAgentTool(db, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (selfed.handled) { return selfed; }
  if (name == "set_banner") {
    let barred: FileToolResult = { handled: true, ok: false, text: "the site banner is set from the console's own chat, not over MCP.", line: 0, changed: "" };
    return barred;
  }
  let known = callKnowledgeTool(db, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (known.handled) { return known; }
  let grouped = callProjectTool(db, { owner: owner, threadId: "", name: name, args: args, nowMs: nowMs });
  if (grouped.handled) { return grouped; }
  let none: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  return none;
}

@controller("/mcp-server")
export class McpServerApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @post("/")
  rpc(req: Request): Reply {
    let asked = envelopeOf(req.body);
    if (asked.fault != "") {
      return ok(refused(asked.id, INVALID_REQUEST, asked.fault));
    }

    if (asked.method == "initialize") {
      let hello: McpInitializeResult = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "joule", version: "1" },
      };
      return ok(answered(asked.id, rpcOk(hello)));
    }

    if (asked.method == "notifications/initialized" || asked.method == "ping") {
      let noted: McpAcknowledged = {};
      return ok(answered(asked.id, rpcOk(noted)));
    }

    if (asked.method == "tools/list") {
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
      let roster = jsonObjectOf([{ key: "tools", json: jsonArrayOf(listed) }]);
      return ok(answered(asked.id, rpcRaw(roster)));
    }

    if (asked.method == "tools/call") {
      let name = jsonText(asked.params, "name");
      let args = jsonRaw(asked.params, "arguments");
      if (args == "") { args = "{}"; }
      let owner = owningTag(callerTags(req));
      let done = mcpDispatch(this.db, owner, name, args);
      if (!done.handled) {
        return ok(refused(asked.id, METHOD_NOT_FOUND, "no tool named " + name));
      }
      let said: McpCallResult = {
        content: [{ type: "text", text: done.text }],
        isError: !done.ok,
      };
      return ok(answered(asked.id, rpcOk(said)));
    }

    return ok(refused(asked.id, METHOD_NOT_FOUND, "unknown method"));
  }
}
