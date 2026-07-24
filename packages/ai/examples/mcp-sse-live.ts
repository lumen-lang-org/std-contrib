import { mcpSseTools, mcpSseCall, mcpSseAsTools, runTool } from "../ai.ts";
let url = "http://127.0.0.1:8791/mcp";
let headers = new Map<string, string>();
let tools = mcpSseTools(url, headers);
console.log("tools: " + tools.length);
let i: int = 0;
while (i < tools.length) { console.log("  " + tools[i].name + " — " + tools[i].description); i = i + 1; }
let r = mcpSseCall(url, headers, "add", "{\"input\":\"12 30 5\"}");
console.log("add(12,30,5) ok=" + r.ok + " text=" + r.content);
let adapted = mcpSseAsTools(url, headers, tools);
console.log("adapted: " + adapted.length);
let out = runTool(adapted, "echo", "hello over sse");
console.log("via registry: " + out.output);
