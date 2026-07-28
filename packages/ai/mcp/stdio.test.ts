// Tests for stdio.

import { mcpStdioCall, mcpStdioClose, mcpStdioListTools, mcpStdioRegisterTools, mcpStdioSpawn, mcpStdioToolsToRegistry } from "./stdio.ts";
import { makeTool, registerTool, runToolWithPolicy, toolRegistry } from "../agent/tools.ts";

function spawnBannerSession(): McpStdioSession {
  let args: string[] = ["-c", mockBannerServerScript()];
  return mcpStdioSpawn("python3", args);
}

function spawnMockSession(): McpStdioSession {
  let args: string[] = ["-c", mockMcpServerScript()];
  return mcpStdioSpawn("python3", args);
}

function spawnNoisySession(): McpStdioSession {
  let args: string[] = ["-c", mockNoisyServerScript()];
  return mcpStdioSpawn("python3", args);
}

function spawnStrictSession(): McpStdioSession {
  let args: string[] = ["-c", mockStrictServerScript(false)];
  return mcpStdioSpawn("python3", args);
}

function spawnStringIdSession(): McpStdioSession {
  let args: string[] = ["-c", mockStrictServerScript(true)];
  return mcpStdioSpawn("python3", args);
}

// A server that validates `arguments` against the inputSchema it advertised —
// which is what every real MCP server does — answers -32602 to {"input": ...}.
test("a tool call sends the arguments the server's own schema declares", () => {
  let session = spawnStrictSession();
  let tools = mcpStdioListTools(session);
  expect(tools.length == 2);
  expect(tools[0].name == "echo");
  let registry = mcpStdioToolsToRegistry(session, tools);
  expect(registry.length == 2);
  expect(registry[0].run("hello there") == "hello there");
  expect(registry[1].run("2, 3") == "5");
  // a model that emits the whole arguments object is passed through.
  expect(registry[1].run("{\"a\": 10, \"b\": 32}") == "42");
  mcpStdioClose(session);
});

// A refusal has to reach the model as a sentence. It used to arrive as
// "error: " with nothing after it, or as an empty successful result.
test("a refused call reports why, not an empty success", () => {
  let session = spawnStrictSession();
  let refused = mcpStdioCall(session, "echo", "{\"input\":\"hello\"}");
  expect(!refused.ok);
  expect(refused.error != "");
  expect(refused.error.indexOf("Invalid arguments") >= 0);
  let unknown = mcpStdioCall(session, "no_such_tool", "{}");
  expect(!unknown.ok);
  expect(unknown.error.indexOf("Unknown tool") >= 0);
  mcpStdioClose(session);
});

// JSON-RPC 2.0 permits a string id. Matching ids by a decimal scan of the raw
// line reads `"id":"1"` as 0, so every reply is discarded: the initialize
// drain in mcpStdioSpawn reads until EOF or blocks on a line that never comes,
// and tools/list comes back empty.
test("a server that answers with string ids is spoken to, not ignored", () => {
  let session = spawnStringIdSession();
  let tools = mcpStdioListTools(session);
  expect(tools.length == 2);
  expect(tools[0].name == "echo");
  expect(tools[1].name == "add");
  let res = mcpStdioCall(session, "echo", "{\"message\":\"still here\"}");
  expect(res.ok);
  expect(res.content == "still here");
  let registry = mcpStdioToolsToRegistry(session, tools);
  expect(registry[0].run("round trip") == "round trip");
  mcpStdioClose(session);
});

test("a stdio server cannot displace a local tool of the same name", () => {
  let session = spawnStrictSession();
  let local = registerTool(toolRegistry(),
    makeTool("echo", "The local echo.", "any text", (input: string) => { return "LOCAL:" + input; }));
  let merged = mcpStdioRegisterTools(local, session, mcpStdioListTools(session));
  expect(merged.length == 2);
  let allow: string[] = ["echo"];
  let deny: string[] = [];
  let ran = runToolWithPolicy(merged, { allow: allow, deny: deny }, "echo", "hi");
  expect(ran.ok);
  expect(ran.output == "LOCAL:hi");
  mcpStdioClose(session);
});

test("tools/list over stdio parses into the mock's tools", () => {
  let session = spawnMockSession();
  let tools = mcpStdioListTools(session);
  expect(tools.length == 2);
  expect(tools[0].name == "weather");
  expect(tools[0].description == "Current weather for a city.");
  expect(tools[0].schema == "{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}");
  expect(tools[1].name == "echo");
  expect(tools[1].schema == "{\"type\":\"object\"}");
  mcpStdioClose(session);
});

test("tools/call over stdio returns the mock's result text", () => {
  let session = spawnMockSession();
  let res = mcpStdioCall(session, "weather", "{\"city\":\"Paris\"}");
  expect(res.ok);
  expect(res.content == "sunny in Paris");
  expect(res.error == "");
  mcpStdioClose(session);
});

test("two calls share one long-lived stdio session", () => {
  let session = spawnMockSession();
  let tools = mcpStdioListTools(session);
  expect(tools.length == 2);
  let first = mcpStdioCall(session, "weather", "{\"city\":\"Paris\"}");
  expect(first.ok);
  expect(first.content == "sunny in Paris");
  // a second call proves the child outlived the first exchange.
  let second = mcpStdioCall(session, "weather", "{\"city\":\"Lyon\"}");
  expect(second.ok);
  expect(second.content == "sunny in Paris");
  mcpStdioClose(session);
});

test("an adapted stdio tool's run() round-trips through the session", () => {
  let session = spawnMockSession();
  let tools = mcpStdioListTools(session);
  let registry = mcpStdioToolsToRegistry(session, tools);
  expect(registry.length == 2);
  expect(registry[0].name == "weather");
  expect(registry[0].description == "Current weather for a city.");
  expect(registry[0].params == tools[0].schema);
  // full transport round trip through the captured child.
  expect(registry[0].run("Paris") == "sunny in Paris");
  // a second run reuses the same live session.
  expect(registry[1].run("hi there") == "sunny in Paris");
  mcpStdioClose(session);
});

test("a fresh session initializes, serves, and closes cleanly", () => {
  // mcpStdioSpawn already drained the initialize handshake.
  let session = spawnMockSession();
  expect(mcpStdioListTools(session).length == 2);
  mcpStdioClose(session);
});

test("a stray blank line per response never desyncs the request/reply stream", () => {
  // a stray blank line after every reply would, with a single readLine per
  // request, shift every reply onto the next call — silently, with ok:true.
  let session = spawnNoisySession();
  let r1 = mcpStdioCall(session, "echo", "{}");
  expect(r1.ok);
  expect(r1.content == "OK");
  let r2 = mcpStdioCall(session, "echo", "{}");
  expect(r2.ok);
  expect(r2.content == "OK");
  let r3 = mcpStdioCall(session, "echo", "{}");
  expect(r3.ok);
  expect(r3.content == "OK");
  mcpStdioClose(session);
});

test("an unsolicited startup banner does not silently kill the session", () => {
  // a startup banner on stdout would be drained instead of the initialize reply,
  // shifting every later reply by one — a dead session reporting ok:true.
  // draining by id skips the banner (id 0) and locks onto the reply (id 1).
  let session = spawnBannerSession();
  let tools = mcpStdioListTools(session);
  expect(tools.length == 1);
  expect(tools[0].name == "echo");
  let r = mcpStdioCall(session, "echo", "{}");
  expect(r.ok);
  expect(r.content == "OK");
  mcpStdioClose(session);
});
