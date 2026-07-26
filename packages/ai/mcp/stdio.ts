// MCP client over STDIO: a long-lived child process spoken to with
// newline-delimited JSON, one JSON-RPC object per line in each direction. all
// framing/parsing is reused from client.ts; only the transport is new here.
//
// spawn's write/writeLine/readLine/close never throw, so a session handle and a
// captured-session tool run() both stay total. readLine blocks until a line or
// EOF.
//
// importing the value builders from client.ts also pulls its McpTool/McpResult
// types into scope, and makeTool pulls in Tool — the types need no export.

import { mcpInitializeRequest, mcpListToolsRequest, mcpCallToolRequest, parseMcpTools, parseMcpToolResult, mcpResponseId } from "./client.ts";
import { makeTool } from "../agent/tools.ts";

// a live stdio session: the child stays alive across calls so one spawned server
// answers many requests. `nextId` is a single-entry Map used as a mutable
// counter — records and arrays are immutable (no `s.nextId = ...` or `a[i] =
// ...` assignment), but a Map is a shared reference whose `.set` is visible
// through every by-value copy of the session.
export type McpStdioSession = {
  child: ChildProcess,
  nextId: Map<string, int>,
};

function stdioNextId(session: McpStdioSession): int {
  let cur = session.nextId.get("v");
  let n: int = 1;
  if (cur != null) { n = cur; }
  session.nextId.set("v", n + 1);
  return n;
}

// read lines until one is the JSON-RPC response carrying `expectedId`, skipping
// anything else on stdout — blank lines, startup banners, log chatter, id-less
// notifications, stale replies — none of which may be mistaken for this
// request's answer. readLine keeps the trailing newline and returns "" only at
// EOF, so a blank line ("\n") is skipped while "" ends the scan. the skip budget
// guards against a server that never sends the id.
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

// writeLine appends the "\n" that frames the JSON-RPC object; the reply is
// matched by id, so unsolicited stdout lines cannot desync the stream.
function stdioExchange(session: McpStdioSession, requestJson: string, expectedId: int): string {
  session.child.writeLine(requestJson);
  return stdioReadReply(session, expectedId);
}

// spawn the server and hand back a session. the initialize reply is drained by
// id 1 (the id mcpInitializeRequest carries) so a startup banner or blank line
// is skipped rather than mistaken for it; its body is not otherwise needed. the
// counter starts at 2 so no later request collides with the handshake.
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

// a malformed or error reply degrades to an empty list inside parseMcpTools.
export function mcpStdioListTools(session: McpStdioSession): McpTool[] {
  let id = stdioNextId(session);
  let reply = stdioExchange(session, mcpListToolsRequest(id), id);
  return parseMcpTools(reply);
}

// `argumentsJson` is embedded verbatim under "arguments". an error reply comes
// back ok:false with its message; parseMcpToolResult never throws.
export function mcpStdioCall(session: McpStdioSession, name: string, argumentsJson: string): McpResult {
  let id = stdioNextId(session);
  let reply = stdioExchange(session, mcpCallToolRequest(id, name, argumentsJson), id);
  return parseMcpToolResult(reply);
}

// closes stdin and waits for the child to exit; the session is dead afterwards.
export function mcpStdioClose(session: McpStdioSession): void {
  session.child.close();
}

// run drives the captured session, wrapping its single string input as
// {"input": <input>} — this package's one-string-arg convention. it never
// throws: neither writeLine/readLine nor parseMcpToolResult throws, so trouble
// comes back as text.
export function mcpStdioToolToLumen(session: McpStdioSession, entry: McpTool): Tool {
  let toolName = entry.name;
  return makeTool(entry.name, entry.description, entry.schema, (input: string) => {
    let args = "{\"input\":" + JSON.stringify(input) + "}";
    let id = stdioNextId(session);
    let reply = stdioExchange(session, mcpCallToolRequest(id, toolName, args), id);
    let result = parseMcpToolResult(reply);
    if (result.ok) { return result.content; }
    return "error: " + result.error;
  });
}

// every tool in the registry is bound to the same live session.
export function mcpStdioToolsToRegistry(session: McpStdioSession, tools: McpTool[]): Tool[] {
  let out: Tool[] = [];
  let i: int = 0;
  while (i < tools.length) {
    out.push(mcpStdioToolToLumen(session, tools[i]));
    i = i + 1;
  }
  return out;
}

// --- inline mock MCP servers, used by stdio.test.ts --------------------------

// a line-oriented MCP server as an embedded python3 script, so the tests need no
// extra files. it echoes each request's id (as a compliant server does), which
// the transport matches replies against. tools/list yields two tools;
// tools/call yields one text part; anything else (e.g. initialize) yields an
// empty result so the handshake drains cleanly.
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

// emits its correct reply and THEN a stray blank line on stdout after every
// response — the shape of a server that prints an extra newline.
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

// prints an unsolicited "server ready" banner on stdout before its JSON-RPC
// loop, then behaves like the noisy server minus the trailing blank line.
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
