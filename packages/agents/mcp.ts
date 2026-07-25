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

export type McpTool = {
  name: string,
  description: string,
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

// Tool names, in the order the server listed them. Parsed by scanning for
// `"name"` inside the tools array rather than with JSON.parse, because the
// input schemas are arbitrary shapes and a strict parse would refuse them.
export function toolNames(server: McpServerRow): string[] {
  let out: string[] = [];
  let listed = rpc(server.endpoint, 2, "tools/list", "");
  if (!listed.ok) { return out; }
  let rest = listed.text;
  let at = rest.indexOf("\"tools\"");
  if (at < 0) { return out; }
  rest = rest.substring(at, rest.length);
  while (true) {
    let n = rest.indexOf("\"name\"");
    if (n < 0) { return out; }
    rest = rest.substring(n + 6, rest.length);
    let open = rest.indexOf("\"");
    if (open < 0) { return out; }
    rest = rest.substring(open + 1, rest.length);
    let close = rest.indexOf("\"");
    if (close < 0) { return out; }
    out.push(rest.substring(0, close));
    rest = rest.substring(close + 1, rest.length);
  }
  return out;
}

// The string value of the first `"<key>":` in a document. Written by hand
// rather than with JSON.parse because a tool's result carries whatever shape
// the tool defines, and a strict parse would refuse it.
function memberAfter(document: string, key: string): string {
  let marker = "\"" + key + "\"";
  let rest = document;
  while (true) {
    let at = rest.indexOf(marker);
    if (at < 0) { return ""; }
    rest = rest.substring(at + marker.length, rest.length);
    // A key is followed by a colon; the same spelling as a value is not.
    let after = rest.trimStart();
    if (after.startsWith(":")) {
      let value = after.substring(1, after.length).trimStart();
      if (!value.startsWith("\"")) { return ""; }
      value = value.substring(1, value.length);
      let close = value.indexOf("\"");
      if (close < 0) { return ""; }
      return value.substring(0, close);
    }
  }
  return "";
}

// Call a tool. `args` is a JSON object as text, because its shape is the
// tool's and not something this file can know.
export function callTool(server: McpServerRow, toolName: string, args: string): McpCall {
  let params = "{\"name\":" + JSON.stringify(toolName) + ",\"arguments\":" + args + "}";
  let answered = rpc(server.endpoint, 3, "tools/call", params);
  if (!answered.ok) { return answered; }
  // The result is `content: [{"type":"text","text":"..."}]`, so `"text"` occurs
  // twice: once as the value of "type" and once as the key holding the answer.
  // Only the one followed by a colon is the key.
  let value = memberAfter(answered.text, "text");
  if (value == "") { return answered; }
  let text: McpCall = { ok: true, text: value, error: "" };
  return text;
}
