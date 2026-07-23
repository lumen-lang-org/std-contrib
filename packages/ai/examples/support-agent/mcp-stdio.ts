// Driving an MCP server over stdio, in the same agent loop.
//
// Unlike the HTTP/SSE example, this one RUNS with no external service: it spawns
// a tiny mock MCP server as a subprocess (a python3 one-liner that speaks
// newline-delimited JSON-RPC), lists its tools, adapts them, and hands them to
// the same runAgent used everywhere else.
//
// Run:
//   lumen compile packages/ai/examples/support-agent/mcp-stdio.ts
//   ./mcp-stdio
//
// A real deployment replaces the mock command/args with an actual MCP server,
// e.g. mcpStdioConnect("npx", ["-y", "@modelcontextprotocol/server-everything"]).

import { mcpStdioConnect, mcpStdioTools, mcpStdioAsTools, mcpStdioClose, runAgent, fakeModel, fakeToolCall, agentTrace, agentSystemPrompt, system, user, appendMessage } from "../../ai.ts";

function mockServerScript(): string {
  // Reads JSON-RPC request lines, answers tools/list with one `greet` tool and
  // tools/call by greeting the input. Echoes the request id so the transport's
  // id matching stays aligned. Logs go nowhere (stdout is MCP-only).
  return "import sys,json\n"
    + "for line in sys.stdin:\n"
    + "    line=line.strip()\n"
    + "    if not line: continue\n"
    + "    req=json.loads(line); rid=req.get('id',0); m=req.get('method','')\n"
    + "    if m=='tools/list':\n"
    + "        r={'tools':[{'name':'greet','description':'Greet someone by name.','inputSchema':{'type':'object','properties':{'input':{'type':'string'}}}}]}\n"
    + "    elif m=='tools/call':\n"
    + "        name=req.get('params',{}).get('arguments',{}).get('input','')\n"
    + "        r={'content':[{'type':'text','text':'Hello, '+name+'!'}]}\n"
    + "    else:\n"
    + "        r={'capabilities':{}}\n"
    + "    print(json.dumps({'jsonrpc':'2.0','id':rid,'result':r}), flush=True)\n";
}

function main(): void {
  let args: string[] = ["-c", mockServerScript()];
  let session = mcpStdioConnect("python3", args);

  // 1. discover the server's tools over the pipe
  let remote = mcpStdioTools(session);
  console.log(`stdio MCP server offers ${remote.length} tools:`);
  for (const t of remote) { console.log(`  - ${t.name}: ${t.description}`); }

  // 2. adapt them and drive the same agent loop
  let tools = mcpStdioAsTools(session, remote);
  let history = appendMessage([], system(agentSystemPrompt(tools, "You greet people using MCP tools.")));
  history = appendMessage(history, user("Greet Aymen."));
  let run = runAgent(fakeModel([fakeToolCall("greet", "Aymen")]), tools, history, 5);

  console.log("");
  console.log(agentTrace(run));

  mcpStdioClose(session);
}

main();
