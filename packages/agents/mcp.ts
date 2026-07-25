// Talking to an MCP server whose address came out of the database.
//
// A server is a row: transport, endpoint, enabled. Mounting one is reading the
// row and calling it — so adding a server to an agent is an INSERT, and no
// part of this file changes.
//
// HTTP transport only. MCP's other transport is stdio, which needs to spawn a
// process, and Lumen has no subprocess API; a stdio server has to be fronted
// by something that speaks HTTP.

import { McpServerRow } from "./schema.ts";
import { jsonRaw, jsonText, jsonList } from "./scan.ts";

// A tool as its server describes it. `schema` is the tool's own JSON Schema,
// kept as text: it is written by whoever wrote the tool, no record type can
// declare its shape, and it is passed to the model unchanged.
export type McpTool = {
  name: string,
  description: string,
  schema: string,
};

export type McpCall = {
  ok: bool,
  text: string,
  error: string,
};

// JSON-RPC over HTTP. The id is supplied by the caller rather than counted
// here, because a record cannot hold a counter and a global would be shared
// across the server's worker threads.
function rpc(endpoint: string, id: int, method: string, params: string): McpCall {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  let body = "{\"jsonrpc\":\"2.0\",\"id\":" + `${id}` + ",\"method\":" + JSON.stringify(method);
  if (params != "") { body = body + ",\"params\":" + params; }
  body = body + "}";

  let res = http.request(endpoint, "POST", body, headers);
  if (!res.ok) {
    let failed: McpCall = { ok: false, text: "", error: "no answer from " + endpoint };
    return failed;
  }
  if (res.status != 200) {
    let bad: McpCall = { ok: false, text: res.body, error: "HTTP " + `${res.status}` };
    return bad;
  }
  if (res.body.indexOf("\"error\"") >= 0) {
    let rpcErr: McpCall = { ok: false, text: res.body, error: "the server refused the call" };
    return rpcErr;
  }
  let good: McpCall = { ok: true, text: res.body, error: "" };
  return good;
}

// The handshake. A server that will not initialise is not mounted, and saying
// so beats discovering it on the first tool call.
export function initialize(server: McpServerRow): McpCall {
  if (server.transport != "http") {
    let unsupported: McpCall = { ok: false, text: "", error: "transport \"" + server.transport + "\" needs a subprocess, which this cannot spawn" };
    return unsupported;
  }
  if (!server.enabled) {
    let off: McpCall = { ok: false, text: "", error: server.serverName + " is disabled" };
    return off;
  }
  return rpc(server.endpoint, 1, "initialize", "{}");
}

// What the server offers, in the order it listed them.
//
// Read by scanning rather than with JSON.parse: a tool's input schema is an
// arbitrary shape by design, and a strict parse would refuse the whole reply
// over a key it had never been told about.
export function listTools(server: McpServerRow): McpTool[] {
  let out: McpTool[] = [];
  if (server.transport != "http" || !server.enabled) { return out; }
  let listed = rpc(server.endpoint, 2, "tools/list", "");
  if (!listed.ok) { return out; }

  let items = jsonList(jsonRaw(listed.text, "tools"));
  let i: int = 0;
  while (i < items.length) {
    let name = jsonText(items[i], "name");
    if (name != "") {
      // A tool that declares no schema still takes an argument object; saying
      // so explicitly is what every provider's tool format requires, and an
      // absent `parameters` is rejected by some of them.
      let schema = jsonRaw(items[i], "inputSchema");
      if (schema == "" || !schema.startsWith("{")) {
        schema = "{\"type\":\"object\",\"properties\":{}}";
      }
      let tool: McpTool = {
        name: name,
        description: jsonText(items[i], "description"),
        schema: schema,
      };
      out.push(tool);
    }
    i = i + 1;
  }
  return out;
}

// Just the names, for a caller that only wants to know what is there.
export function toolNames(server: McpServerRow): string[] {
  let out: string[] = [];
  let tools = listTools(server);
  let i: int = 0;
  while (i < tools.length) {
    out.push(tools[i].name);
    i = i + 1;
  }
  return out;
}

// The text blocks of a tool's result, joined.
//
// A result is `content: [{"type":"text","text":"..."}, ...]` and may hold more
// than one block. Taking only the first would quietly drop the rest of an
// answer, so they are joined in order; blocks of any other type — an image,
// say — have no text and are left out.
export function resultText(document: string): string {
  let out = "";
  let blocks = jsonList(jsonRaw(document, "content"));
  let i: int = 0;
  while (i < blocks.length) {
    if (jsonText(blocks[i], "type") == "text") {
      let piece = jsonText(blocks[i], "text");
      if (out != "") { out = out + "\n"; }
      out = out + piece;
    }
    i = i + 1;
  }
  return out;
}

// Call a tool. `args` is a JSON object as text, because its shape is the
// tool's and not something this file can know.
export function callTool(server: McpServerRow, toolName: string, args: string): McpCall {
  let body = args;
  if (body == "") { body = "{}"; }
  let params = "{\"name\":" + JSON.stringify(toolName) + ",\"arguments\":" + body + "}";
  let answered = rpc(server.endpoint, 3, "tools/call", params);
  if (!answered.ok) { return answered; }
  // A tool that reports failure says so in the result rather than in a JSON-RPC
  // error, and the model is the one that has to recover from it — so the text
  // is handed back either way, with `ok` saying which happened.
  let failed = jsonRaw(answered.text, "isError") == "true";
  let value = resultText(answered.text);
  if (value == "") { value = answered.text; }
  let text: McpCall = { ok: !failed, text: value, error: "" };
  if (failed) { text = { ok: false, text: value, error: "the tool reported an error" }; }
  return text;
}
