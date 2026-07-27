// What the MCP client refuses before it opens a connection.
//
// The live half — initialize, tools/list, tools/call — is exercised by
// examples/mount-mcp.ts against a real server, because a test that needs a
// listening port is a test that gets skipped.
//
//   cd packages/agents && lumen test mcp.test.ts

import { McpServerRow } from "./schema.ts";
import { McpCall, initialize } from "./mcp.ts";

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
