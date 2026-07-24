// MCP (Model Context Protocol) client over STDIO. The JSON-RPC framing, request
// builders, and response parsers are the transport-agnostic core that ships in
// mcp.ts; the only new thing here is the transport — a long-lived child process
// spoken to with newline-delimited JSON instead of one HTTP round trip per call.
//
// STDIO framing is exactly writeLine(requestJson) then readLine(): MCP over
// stdio is one JSON-RPC object per line in each direction. child_process.spawn
// (spec 450) returns a ChildProcess whose write/writeLine/readLine/close never
// throw, so a session handle and a captured-session tool run() both stay total.
//
// Importing the value builders from mcp.ts also pulls that module's McpTool
// and McpResult types into scope, and importing makeTool from tools.ts
// pulls in AiTool — the same trick mcp.ts uses so the types need no export.

import { mcpInitializeRequest, mcpListToolsRequest, mcpCallToolRequest, parseMcpTools, parseMcpToolResult, mcpResponseId } from "./client.ts";
import { makeTool } from "../agent/tools.ts";

// A live stdio session: the child stays alive across every call so one spawned
// server answers many requests. A record field of type ChildProcess compiles
// (verified), so the child is held directly. `nextId` is a single-entry Map used
// as a mutable counter: records and arrays are immutable (verified — both an
// `s.nextId = ...` write and an `a[i] = ...` write are rejected), but a Map is a
// shared reference whose `.set` mutation is visible through every copy of the
// session, so the JSON-RPC id can advance across calls without rebuilding the
// handle. Each request carries a fresh id and every reply is matched to it, so a
// stray/unsolicited stdout line can no longer shift the request/reply stream.
type McpStdioSession = {
  child: ChildProcess,
  nextId: Map<string, int>,
};

// Hand out this session's next JSON-RPC id and advance the shared counter. The
// counter lives in a Map so the mutation survives the by-value session copy.
function stdioNextId(session: McpStdioSession): int {
  let cur = session.nextId.get("v");
  let n: int = 1;
  if (cur != null) { n = cur; }
  session.nextId.set("v", n + 1);
  return n;
}

// Read reply lines until one is the JSON-RPC response carrying `expectedId`,
// skipping anything else the server emits on stdout — blank lines, startup
// banners, log chatter, id-less notifications, or a stale reply — none of which
// may be mistaken for this request's answer. readLine returns the whole line
// with its trailing newline, and "" only at EOF; a blank line is "\n" (non-empty
// after readLine, empty after trim) so it is skipped, while a true "" ends the
// scan. The skip budget guards against a server that never sends the id.
function stdioReadReply(session: McpStdioSession, expectedId: int): string {
  let skips: int = 0;
  while (skips < 100000) {
    let line = session.child.readLine();
    if (line == "") { return ""; }
    if (line.trim() != "" && mcpResponseId(line) == expectedId) { return line; }
    skips = skips + 1;
  }
  return "";
}

// One request/one reply against the live child. writeLine appends the "\n" that
// frames the JSON-RPC object; the read loop returns the reply line whose id
// matches `expectedId`, so unsolicited stdout lines cannot desync the stream.
function stdioExchange(session: McpStdioSession, requestJson: string, expectedId: int): string {
  session.child.writeLine(requestJson);
  return stdioReadReply(session, expectedId);
}

// Spawn the server and hand back a session. The initialize handshake is sent and
// its reply (id 1, the id mcpInitializeRequest carries) is drained by id so a
// startup banner or blank line on stdout is skipped rather than mistaken for the
// handshake reply; the reply body is not otherwise needed. The id counter starts
// at 2 so the first tools/list or tools/call cannot collide with the handshake.
export function mcpStdioSpawn(command: string, args: string[]): McpStdioSession {
  let child = child_process.spawn(command, args);
  let counter = new Map<string, int>();
  counter.set("v", 2);
  let session: McpStdioSession = {
    child: child,
    nextId: counter,
  };
  session.child.writeLine(mcpInitializeRequest());
  stdioReadReply(session, 1);
  return session;
}

// tools/list over the live child: send the reused builder's request under a
// fresh id, read the reply that echoes that id, parse with the reused parser. A
// malformed or error reply degrades to an empty list inside parseMcpTools.
export function mcpStdioListTools(session: McpStdioSession): McpTool[] {
  let id = stdioNextId(session);
  let reply = stdioExchange(session, mcpListToolsRequest(id), id);
  return parseMcpTools(reply);
}

// tools/call over the live child. `argumentsJson` is embedded verbatim under
// "arguments" by the reused builder. The reply is matched to the fresh request
// id. A JSON-RPC error reply comes back ok:false with its message;
// parseMcpToolResult never throws.
export function mcpStdioCall(session: McpStdioSession, name: string, argumentsJson: string): McpResult {
  let id = stdioNextId(session);
  let reply = stdioExchange(session, mcpCallToolRequest(id, name, argumentsJson), id);
  return parseMcpToolResult(reply);
}

// Close stdin and wait for the child to exit. The session must not be used after.
export function mcpStdioClose(session: McpStdioSession): void {
  session.child.close();
}

// A McpTool becomes a first-class AiTool whose run drives the captured
// session: it wraps its single string input as {"input": <input>} — this
// package's one-string-arg convention — writes the tools/call request, reads the
// reply, and returns the result text. run never throws: writeLine/readLine do
// not throw and parseMcpToolResult does not throw, so trouble comes back as text.
export function mcpStdioToolToLumen(session: McpStdioSession, tool: McpTool): AiTool {
  let toolName = tool.name;
  return makeTool(tool.name, tool.description, tool.schema, (input: string) => {
    let args = "{\"input\":" + JSON.stringify(input) + "}";
    let id = stdioNextId(session);
    let reply = stdioExchange(session, mcpCallToolRequest(id, toolName, args), id);
    let result = parseMcpToolResult(reply);
    if (result.ok) { return result.content; }
    return "error: " + result.error;
  });
}

// Adapt a whole tools/list reply into a registry, every tool bound to the same
// live session.
export function mcpStdioToolsToRegistry(session: McpStdioSession, tools: McpTool[]): AiTool[] {
  let out: AiTool[] = [];
  let i: int = 0;
  while (i < tools.length) {
    out.push(mcpStdioToolToLumen(session, tools[i]));
    i = i + 1;
  }
  return out;
}

// --- Tests: full round trip against an inline mock MCP server ----------------

// A tiny line-oriented MCP server as a python3 one-liner, embedded so the test
// needs no extra files. It loops: read a request line from stdin, print a
// JSON-RPC response line to stdout, flush. Blank input lines are ignored. The
// response echoes the request's id (a compliant server always does), which the
// transport now matches replies against. tools/list yields two tools;
// tools/call yields one text part; anything else (e.g. initialize) yields an
// empty result so the handshake drains cleanly. Double quotes are escaped for
// the Lumen string; the JSON sits inside python single-quoted literals with the
// echoed id spliced in as str(rid).
function mockMcpServerScript(): string {
  return "import sys, json\n"
    + "for line in sys.stdin:\n"
    + "    if line.strip() == \"\":\n"
    + "        continue\n"
    + "    try:\n"
    + "        rid = json.loads(line).get(\"id\", 0)\n"
    + "    except Exception:\n"
    + "        rid = 0\n"
    + "    if \"tools/list\" in line:\n"
    + "        print('{\"jsonrpc\":\"2.0\",\"id\":' + str(rid) + ',\"result\":{\"tools\":["
    + "{\"name\":\"weather\",\"description\":\"Current weather for a city.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}},"
    + "{\"name\":\"echo\",\"description\":\"Echo the input.\",\"inputSchema\":{\"type\":\"object\"}}"
    + "]}}')\n"
    + "    elif \"tools/call\" in line:\n"
    + "        print('{\"jsonrpc\":\"2.0\",\"id\":' + str(rid) + ',\"result\":{\"content\":["
    + "{\"type\":\"text\",\"text\":\"sunny in Paris\"}]}}')\n"
    + "    else:\n"
    + "        print('{\"jsonrpc\":\"2.0\",\"id\":' + str(rid) + ',\"result\":{}}')\n"
    + "    sys.stdout.flush()\n";
}

// A server that emits its correct JSON-RPC reply and THEN a stray blank line on
// stdout after every response — the shape of a real server that logs an empty
// line or prints an extra newline. It echoes the request id and answers
// tools/list with one tool and tools/call with text "OK".
function mockNoisyServerScript(): string {
  return "import sys, json\n"
    + "for line in sys.stdin:\n"
    + "    if line.strip() == \"\":\n"
    + "        continue\n"
    + "    try:\n"
    + "        rid = json.loads(line).get(\"id\", 0)\n"
    + "    except Exception:\n"
    + "        rid = 0\n"
    + "    if \"tools/list\" in line:\n"
    + "        print('{\"jsonrpc\":\"2.0\",\"id\":' + str(rid) + ',\"result\":{\"tools\":["
    + "{\"name\":\"echo\",\"description\":\"Echo.\",\"inputSchema\":{\"type\":\"object\"}}"
    + "]}}')\n"
    + "    elif \"tools/call\" in line:\n"
    + "        print('{\"jsonrpc\":\"2.0\",\"id\":' + str(rid) + ',\"result\":{\"content\":["
    + "{\"type\":\"text\",\"text\":\"OK\"}]}}')\n"
    + "    else:\n"
    + "        print('{\"jsonrpc\":\"2.0\",\"id\":' + str(rid) + ',\"result\":{}}')\n"
    + "    print(\"\")\n"
    + "    sys.stdout.flush()\n";
}

// A server that prints an unsolicited "server ready" banner line on stdout at
// startup, before its JSON-RPC loop — the shape of a real server that greets on
// stdout. It then behaves like the noisy server minus the trailing blank line.
function mockBannerServerScript(): string {
  return "import sys, json\n"
    + "print(\"server ready\")\n"
    + "sys.stdout.flush()\n"
    + "for line in sys.stdin:\n"
    + "    if line.strip() == \"\":\n"
    + "        continue\n"
    + "    try:\n"
    + "        rid = json.loads(line).get(\"id\", 0)\n"
    + "    except Exception:\n"
    + "        rid = 0\n"
    + "    if \"tools/list\" in line:\n"
    + "        print('{\"jsonrpc\":\"2.0\",\"id\":' + str(rid) + ',\"result\":{\"tools\":["
    + "{\"name\":\"echo\",\"description\":\"Echo.\",\"inputSchema\":{\"type\":\"object\"}}"
    + "]}}')\n"
    + "    elif \"tools/call\" in line:\n"
    + "        print('{\"jsonrpc\":\"2.0\",\"id\":' + str(rid) + ',\"result\":{\"content\":["
    + "{\"type\":\"text\",\"text\":\"OK\"}]}}')\n"
    + "    else:\n"
    + "        print('{\"jsonrpc\":\"2.0\",\"id\":' + str(rid) + ',\"result\":{}}')\n"
    + "    sys.stdout.flush()\n";
}
