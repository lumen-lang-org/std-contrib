// What the MCP client refuses before it opens a connection.
//
// The live half — initialize, tools/list, tools/call — is exercised by
// examples/mount-mcp.ts against a real server, because a test that needs a
// listening port is a test that gets skipped.
//
//   cd packages/agents && lumen test mcp.test.ts

import { McpServerRow } from "./schema.ts";
import { McpCall, RpcFailure, initialize, rpcFailure } from "./mcp.ts";

function server(transport: string, endpoint: string, enabled: bool): McpServerRow {
  let s: McpServerRow = { id: "s", serverName: "demo", transport: transport, endpoint: endpoint, authKind: "none", authHeader: "", enabled: enabled };
  return s;
}

test("a stdio server is refused with the reason, not a connection error", () => {
  let r = initialize(server("stdio", "mcp-fs", true), "");
  expect(!r.ok);
  // The reason is that nothing here can spawn a process — worth saying, since
  // the endpoint looks perfectly valid.
  expect(r.error.indexOf("subprocess") >= 0);
  expect(r.error.indexOf("stdio") >= 0);
});

test("a disabled server is not contacted", () => {
  let r = initialize(server("http", "http://127.0.0.1:1", false), "");
  expect(!r.ok);
  expect(r.error.indexOf("disabled") >= 0);
  expect(r.error.indexOf("demo") >= 0);
});

test("an unreachable server is a refusal, not a crash", () => {
  // Port 1 is not listening; the call must come back rather than fail.
  let r = initialize(server("http", "http://127.0.0.1:1", true), "");
  expect(!r.ok);
  expect(r.error != "");
});

// --- what counts as the server refusing ---------------------------------------
//
// The JSON-RPC envelope has exactly one place that says a call failed: its own
// top-level `error`. Everything else in the document belongs to the tool.

test("a reply that spells out a null error is a success", () => {
  // Legal, and common: a server that always writes both members. Judged by
  // whether the text contains "error" anywhere, every tool it offers is
  // reported broken and its tool list never reaches the console.
  let listed = rpcFailure("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"read_file\"}]},\"error\":null}");
  expect(!listed.failed);
});

test("an error inside the tool's own result is not the server refusing", () => {
  // The result is the tool's to shape. A search tool reporting that it found
  // nothing is a call that worked.
  let answered = rpcFailure("{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"isError\":false,\"error\":\"none\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}");
  expect(!answered.failed);
});

test("a reply with no error member at all is a success", () => {
  let plain = rpcFailure("{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"content\":[]}}");
  expect(!plain.failed);
});

test("a real JSON-RPC error is a refusal, and repeats what the server said", () => {
  let bad = rpcFailure("{\"jsonrpc\":\"2.0\",\"id\":5,\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}");
  expect(bad.failed);
  expect(bad.message.indexOf("Method not found") >= 0);
});

test("an error with no message still reads as a refusal", () => {
  let bare = rpcFailure("{\"jsonrpc\":\"2.0\",\"id\":6,\"error\":{\"code\":-32000}}");
  expect(bare.failed);
  expect(bare.message != "");
});
