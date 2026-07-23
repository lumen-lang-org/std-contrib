// Using an MCP server's tools in the same agent loop.
//
// This shows the shape; it needs a running MCP server reachable over HTTP
// (JSON-RPC), so unlike main.ts it is a compile-and-read example rather than a
// no-setup one. Point MCP_URL at a Streamable-HTTP MCP endpoint to run it.
//
// Transport note: this client speaks MCP over HTTP JSON-RPC only. stdio and SSE
// transports are tracked separately (see the package spec's M17).
//
// Run (against a live server):
//   MCP_URL=http://localhost:3000/mcp lumen compile packages/ai/examples/support-agent/mcp-tools.ts
//   ./mcp-tools

import { mcpTools, mcpAsTools, runAgent, fakeModel, fakeToolCall, agentTrace, agentSystemPrompt, system, user, appendMessage } from "../../ai.ts";

function main(): void {
  let url = process.env.MCP_URL ?? "";
  if (url == "") {
    console.log("Set MCP_URL to a running MCP HTTP endpoint to try this example.");
    console.log("It lists the server's tools, adapts them into agent tools, and");
    console.log("hands them to the same runAgent used in main.ts.");
    return;
  }

  let headers = new Map<string, string>();

  // 1. Ask the MCP server what tools it offers.
  let remote = mcpTools(url, headers);
  console.log(`MCP server advertises ${remote.length} tools:`);
  for (const t of remote) {
    console.log(`  - ${t.name}: ${t.description}`);
  }

  // 2. Adapt every MCP tool into a LumenAiTool the agent loop can call.
  let tools = mcpAsTools(url, headers, remote);

  // 3. Drive the loop exactly as main.ts does — MCP tools and local tools are
  //    the same LumenAiTool type. (Scripted here; swap in a real provider model.)
  let history = appendMessage([], system(agentSystemPrompt(tools, "You are an assistant with access to MCP tools.")));
  history = appendMessage(history, user("Use a tool to help me."));
  let firstTool = remote.length > 0 ? remote[0].name : "noop";
  let result = runAgent(fakeModel([fakeToolCall(firstTool, "hello")]), tools, history, 5);

  console.log("");
  console.log(agentTrace(result));
}

main();
