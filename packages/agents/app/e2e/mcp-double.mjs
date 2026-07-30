// A stand-in MCP server, so the graph has tools to draw.
//
// The console asks a server what it offers and draws the answer; without a
// server that answers, the tool nodes can only ever be tested as "absent".
// This speaks the two JSON-RPC methods that question needs — initialize and
// tools/list — and nothing else, because nothing else is being tested here.
//
// It is a double, not a fixture: it holds no state and every run gets the
// same three tools.
import { createServer } from "node:http";

const TOOLS = [
  {
    name: "read_file",
    description: "Read a file from the workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "write_file",
    description: "Write a file to the workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, body: { type: "string" } },
    },
  },
  {
    // Deliberately slow. A step row that opens and closes inside one tick of a
    // 400ms poll cannot be observed in flight, so the liveness half of the
    // steps feature would be untestable without a tool that takes its time.
    name: "slow_read",
    description: "Read a file, slowly, so a running call can be seen running.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "list_dir",
    description: "List a directory.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

const port = Number(process.env.MCP_DOUBLE_PORT ?? 8931);

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let id = 0;
    let method = "";
    let call = null;
    try {
      call = JSON.parse(body || "{}");
      id = call.id ?? 0;
      method = call.method ?? "";
    } catch { /* answered below as an unknown method */ }

    // The one call that answers late. Everything else here is immediate, which
    // is what the other suites want; this one exists so a test can catch a step
    // while it is still open.
    if (method === "tools/call" && (call?.params?.name ?? "") === "slow_read") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: "the ledger, read slowly" }] },
        }));
      }, 1500);
      return;
    }

    const result =
      method === "initialize"
        ? { protocolVersion: "2024-11-05", serverInfo: { name: "double", version: "0" } }
        : method === "tools/list"
          ? { tools: TOOLS }
          : null;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(
      result === null
        ? { jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${method}` } }
        : { jsonrpc: "2.0", id, result },
    ));
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`mcp double on http://127.0.0.1:${port}/mcp`);
});
