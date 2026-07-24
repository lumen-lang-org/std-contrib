// Tests for stdio.

import { mcpStdioCall, mcpStdioClose, mcpStdioListTools, mcpStdioSpawn, mcpStdioToolsToRegistry } from "./stdio.ts";

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
  // A second call proves the child outlived the first exchange rather than
  // being a one-shot process.
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
  // run() wraps its input as {"input": <input>}, drives the captured child, and
  // returns the result text — the full transport round trip.
  expect(registry[0].run("Paris") == "sunny in Paris");
  // A second run on the same adapted tool reuses the same live session.
  expect(registry[1].run("hi there") == "sunny in Paris");
  mcpStdioClose(session);
});

test("a fresh session initializes, serves, and closes cleanly", () => {
  // mcpStdioSpawn already sent and drained the initialize handshake; the session
  // is immediately usable and close() is clean.
  let session = spawnMockSession();
  expect(mcpStdioListTools(session).length == 2);
  mcpStdioClose(session);
});

test("a stray blank line per response never desyncs the request/reply stream", () => {
  // Regression: the server prints its correct reply and then a stray blank line
  // after every response. With a single readLine per request the leftover blank
  // was picked up by the next call, so reply #1 arrived at call #2, reply #2 at
  // call #3, and so on — call #1 returned "" with ok still true, undetectably.
  // The id-matching read loop skips the blank and keeps each reply aligned with
  // its own request.
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
  // Regression: the server prints a "server ready" banner on stdout before its
  // JSON-RPC loop. With a single readLine, mcpStdioSpawn drained the banner
  // instead of the initialize reply, shifting every later reply by one — so
  // tools/list came back empty and the following call returned "" with ok:true,
  // a dead session reporting success. Draining the handshake by id skips the
  // banner (id 0) and locks onto the initialize reply (id 1).
  let session = spawnBannerSession();
  let tools = mcpStdioListTools(session);
  expect(tools.length == 1);
  expect(tools[0].name == "echo");
  let r = mcpStdioCall(session, "echo", "{}");
  expect(r.ok);
  expect(r.content == "OK");
  mcpStdioClose(session);
});
