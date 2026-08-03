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
import { jsonBlank, jsonValueAt, jsonRaw, jsonText, jsonList, jsonUnescape } from "./scan.ts";

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

// The raw text of one of the envelope's own members, or "" when it has none.
//
// Top level only, which is the whole reason it is not `jsonRaw`: that searches
// at any depth and takes the first match, and everything below the envelope
// belongs to the tool. A tool that returns `{"error":"not found"}` as its
// answer has answered.
function envelopeMember(document: string, key: string): string {
  let i: int = 0;
  while (i < document.length && jsonBlank(document.charAt(i))) { i = i + 1; }
  if (i >= document.length || document.charAt(i) != "{") { return ""; }
  i = i + 1;
  while (i < document.length) {
    while (i < document.length) {
      let ch = document.charAt(i);
      if (!jsonBlank(ch) && ch != ",") { break; }
      i = i + 1;
    }
    if (i >= document.length || document.charAt(i) == "}") { return ""; }
    if (document.charAt(i) != "\"") { return ""; }
    let name = jsonValueAt(document, i);
    if (name.length < 2) { return ""; }
    i = i + name.length;
    while (i < document.length && jsonBlank(document.charAt(i))) { i = i + 1; }
    if (i >= document.length || document.charAt(i) != ":") { return ""; }
    i = i + 1;
    let value = jsonValueAt(document, i);
    if (value == "") { return ""; }
    if (jsonUnescape(name.slice(1, name.length - 1)) == key) { return value; }
    i = i + value.length;
  }
  return "";
}

// Whether a JSON-RPC reply carries an error, and what it says.
export type RpcFailure = {
  failed: bool,
  message: string,
};

// Whether the server refused the call.
//
// The envelope's own `error`, absent or null meaning success — which is what
// the protocol says and was not what this asked. It asked whether the text of
// the reply contained `"error"` anywhere, so a server that writes
// `"error":null` beside a perfectly good result — legal, and common enough to
// be the default in more than one MCP framework — had every tool it offers
// reported broken, and the raw envelope was handed to the model as the tool's
// answer.
export function rpcFailure(document: string): RpcFailure {
  let none: RpcFailure = { failed: false, message: "" };
  let raw = envelopeMember(document, "error");
  if (raw == "" || raw == "null") { return none; }
  let said = jsonText(raw, "message");
  let sentence = "the server refused the call";
  if (said != "") { sentence = sentence + ": " + said; }
  let refused: RpcFailure = { failed: true, message: sentence };
  return refused;
}

// JSON-RPC over HTTP. The id is supplied by the caller rather than counted
// here, because a record cannot hold a counter and a global would be shared
// across the server's worker threads.
function rpc(endpoint: string, id: int, method: string, params: string): McpCall {
  let none = new Map<string, string>();
  return rpcWith(endpoint, none, id, method, params);
}

// The same, carrying whatever the server needs to let us in. The token is
// passed by the caller because it comes out of the encrypted store and this
// file has no business reading credentials.
function rpcWith(endpoint: string, extra: Map<string, string>, id: int, method: string, params: string): McpCall {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  for (const name of extra.keys()) {
    headers.set(name, extra.get(name) ?? "");
  }
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
  let refused = rpcFailure(res.body);
  if (refused.failed) {
    let rpcErr: McpCall = { ok: false, text: res.body, error: refused.message };
    return rpcErr;
  }
  let good: McpCall = { ok: true, text: res.body, error: "" };
  return good;
}

// The handshake. A server that will not initialise is not mounted, and saying
// so beats discovering it on the first tool call.

// What a server's auth setting means on the wire. "none" sends nothing;
// "bearer" is the usual Authorization header; "header" is whatever name the
// row carries, for a server that wants its own.
//
// "oauth" is on the wire exactly what "bearer" is — the difference is entirely
// in where the token came from and who keeps it fresh, which is `connect.ts`'s
// business and not this file's. That is the whole reason OAuth needed no new
// transport code: RFC 9728 says the token goes in `Authorization: Bearer`, the
// same header a pasted key goes in.
export function authHeaders(server: McpServerRow, token: string): Map<string, string> {
  let out = new Map<string, string>();
  if (token == "" || server.authKind == "none" || server.authKind == "") { return out; }
  if (server.authKind == "bearer" || server.authKind == "oauth") {
    out.set("authorization", "Bearer " + token);
    return out;
  }
  if (server.authKind == "header" && server.authHeader != "") {
    out.set(server.authHeader.toLowerCase(), token);
  }
  return out;
}

export function initialize(server: McpServerRow, token: string): McpCall {
  if (server.transport != "http") {
    let unsupported: McpCall = { ok: false, text: "", error: "transport \"" + server.transport + "\" needs a subprocess, which this cannot spawn" };
    return unsupported;
  }
  if (!server.enabled) {
    let off: McpCall = { ok: false, text: "", error: server.serverName + " is disabled" };
    return off;
  }
  return rpcWith(server.endpoint, authHeaders(server, token), 1, "initialize", "{}");
}

// What the server offers, and — when the answer is nothing — why.
//
// A caller mounting tools for a run only needs the list, and an empty one is
// an answer it can act on. A console drawing the server needs the difference
// between "offers no tools" and "could not be asked": the two look identical
// on screen and mean opposite things about whether anything is wrong.
export type ToolListing = {
  tools: McpTool[],
  // Empty when the server answered. Otherwise a sentence a reader can act on.
  problem: string,
};

// Read by scanning rather than with JSON.parse: a tool's input schema is an
// arbitrary shape by design, and a strict parse would refuse the whole reply
// over a key it had never been told about.
export function toolListing(server: McpServerRow, token: string): ToolListing {
  let out: McpTool[] = [];
  if (!server.enabled) { return { tools: out, problem: "this server is switched off" }; }
  if (server.transport != "http") {
    return { tools: out, problem: "this speaks http; \"" + server.transport + "\" needs a subprocess it cannot spawn" };
  }
  let listed = rpcWith(server.endpoint, authHeaders(server, token), 2, "tools/list", "");
  if (!listed.ok) {
    return { tools: out, problem: "could not reach " + server.endpoint + ": " + listed.error };
  }

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
  return { tools: out, problem: "" };
}

// The list alone, for a caller that has nowhere to put the reason.
export function listTools(server: McpServerRow, token: string): McpTool[] {
  return toolListing(server, token).tools;
}

// Just the names, for a caller that only wants to know what is there.
export function toolNames(server: McpServerRow, token: string): string[] {
  let out: string[] = [];
  let tools = listTools(server, token);
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
export function callTool(server: McpServerRow, toolName: string, args: string, token: string): McpCall {
  let body = args;
  if (body == "") { body = "{}"; }
  let params = "{\"name\":" + JSON.stringify(toolName) + ",\"arguments\":" + body + "}";
  let answered = rpcWith(server.endpoint, authHeaders(server, token), 3, "tools/call", params);
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
