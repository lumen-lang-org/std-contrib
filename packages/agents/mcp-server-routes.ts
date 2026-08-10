// The /mcp-server routes.

import { Db } from "../plume/driver.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, ok } from "../rest/server.ts";
import { agentTools, callAgentTool } from "./agent-tools.ts";
import { callerTags } from "./api-core.ts";
import { callKnowledgeTool, knowledgeTools } from "./knowledge-tools.ts";
import { owningTag } from "./owner.ts";
import { callProjectTool, projectTools } from "./project-tools.ts";
import { ToolSpec } from "./provider.ts";
import { jsonRaw, jsonText } from "./scan.ts";
import { callTaskTool, taskTools } from "./task-tools.ts";
import { callTriggerTool, triggerTools } from "./trigger-tools.ts";
import { callWorkflowTool, workflowTools } from "./workflow-tools.ts";
import { FileToolResult } from "./workspace.ts";

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
      // The banner is the deployment's voice above every visitor's page,
      // not one owner's noun — console chat only, never a foreign agent.
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
    // Unlisted above, and barred here too — an unlisted name is a hint, a
    // refusal is a wall.
    let barred: FileToolResult = { handled: true, ok: false, text: "the site banner is set from the console's own chat, not over MCP.", line: 0, changed: "" };
    return barred;
  }
  let known = callKnowledgeTool(db, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (known.handled) { return known; }
  // Projects, threadless: list and create work anywhere; move_to_project
  // refuses with its own sentence, since an MCP caller holds no conversation.
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
    let id = jsonRaw(req.body, "id");
    if (id == "") { id = "null"; }
    let method = jsonText(req.body, "method");

    if (method == "initialize") {
      return ok("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{"
        + "\"protocolVersion\":\"2024-11-05\","
        + "\"capabilities\":{\"tools\":{}},"
        + "\"serverInfo\":{\"name\":\"joule\",\"version\":\"1\"}}}");
    }
    if (method == "notifications/initialized" || method == "ping") {
      return ok("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{}}");
    }

    if (method == "tools/list") {
      let specs = mcpExportedTools();
      let out = "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{\"tools\":[";
      let i: int = 0;
      while (i < specs.length) {
        if (i > 0) { out = out + ","; }
        out = out + "{\"name\":" + JSON.stringify(specs[i].name)
          + ",\"description\":" + JSON.stringify(specs[i].description)
          + ",\"inputSchema\":" + specs[i].schema + "}";
        i = i + 1;
      }
      return ok(out + "]}}");
    }

    if (method == "tools/call") {
      let params = jsonRaw(req.body, "params");
      let name = jsonText(params, "name");
      let args = jsonRaw(params, "arguments");
      if (args == "") { args = "{}"; }
      let owner = owningTag(callerTags(req));
      let answered = mcpDispatch(this.db, owner, name, args);
      if (!answered.handled) {
        return ok("{\"jsonrpc\":\"2.0\",\"id\":" + id
          + ",\"error\":{\"code\":-32601,\"message\":" + JSON.stringify("no tool named " + name) + "}}");
      }
      // The protocol's own failure shape: a result with isError, so the
      // calling agent reads the sentence instead of a transport fault.
      return ok("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{"
        + "\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(answered.text) + "}],"
        + "\"isError\":" + (answered.ok ? "false" : "true") + "}}");
    }

    return ok("{\"jsonrpc\":\"2.0\",\"id\":" + id
      + ",\"error\":{\"code\":-32601,\"message\":\"unknown method\"}}");
  }
}
