import { McpServerRow } from "./schema.ts";
import { jsonBlank, jsonValueAt, jsonRaw, jsonText, jsonList, jsonUnescape } from "./scan.ts";

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

function envelopeMember(document: string, key: string): string {
  let i: int = 0;
  while (i < document.length && jsonBlank(document.charAt(i))) {
    i = i + 1;
  }
  if (i >= document.length || document.charAt(i) != "{") {
    return "";
  }
  i = i + 1;
  while (i < document.length) {
    while (i < document.length) {
      let ch = document.charAt(i);
      if (!jsonBlank(ch) && ch != ",") {
        break;
      }
      i = i + 1;
    }
    if (i >= document.length || document.charAt(i) == "}") {
      return "";
    }
    if (document.charAt(i) != "\"") {
      return "";
    }
    let name = jsonValueAt(document, i);
    if (name.length < 2) {
      return "";
    }
    i = i + name.length;
    while (i < document.length && jsonBlank(document.charAt(i))) {
      i = i + 1;
    }
    if (i >= document.length || document.charAt(i) != ":") {
      return "";
    }
    i = i + 1;
    let value = jsonValueAt(document, i);
    if (value == "") {
      return "";
    }
    if (jsonUnescape(name.slice(1, name.length - 1)) == key) {
      return value;
    }
    i = i + value.length;
  }
  return "";
}

export type RpcFailure = {
  failed: bool,
  message: string,
};

export function rpcFailure(document: string): RpcFailure {
  let none: RpcFailure = { failed: false, message: "" };
  let raw = envelopeMember(document, "error");
  if (raw == "" || raw == "null") {
    return none;
  }
  let said = jsonText(raw, "message");
  let sentence = "the server refused the call";
  if (said != "") {
    sentence = sentence + ": " + said;
  }
  let refused: RpcFailure = { failed: true, message: sentence };
  return refused;
}

function rpc(endpoint: string, id: int, method: string, params: string): McpCall {
  let none = new Map<string, string>();
  return rpcWith(endpoint, none, id, method, params);
}

function rpcWith(endpoint: string, extra: Map<string, string>, id: int, method: string, params: string): McpCall {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  for (const name of extra.keys()) {
    headers.set(name, extra.get(name) ?? "");
  }
  let body = "{\"jsonrpc\":\"2.0\",\"id\":" + `${id}` + ",\"method\":" + JSON.stringify(method);
  if (params != "") {
    body = body + ",\"params\":" + params;
  }
  body = body + "}";

  let res = http.request(endpoint, "POST", body, headers);
  if (res.status == 0) {
    let failed: McpCall = { ok: false, text: "", error: "no answer from " + endpoint };
    return failed;
  }
  if (res.status != 200) {
    let said = res.body.length > 200 ? res.body.slice(0, 200) : res.body;
    let bad: McpCall = { ok: false, text: res.body,
      error: "HTTP " + `${res.status}` + (said == "" ? "" : ": " + said) };
    return bad;
  }
  let envelope = JsonOf(res.body);
  let refused = rpcFailure(envelope);
  if (refused.failed) {
    let rpcErr: McpCall = { ok: false, text: envelope, error: refused.message };
    return rpcErr;
  }
  let good: McpCall = { ok: true, text: envelope, error: "" };
  return good;
}

export function JsonOf(body: string): string {
  let text = body.trim();
  if (text == "" || text.startsWith("{") || text.startsWith("[")) {
    return text;
  }
  let found = "";
  let rest = text;
  while (true) {
    let at = rest.indexOf("data:");
    if (at < 0) {
      break;
    }
    rest = rest.slice(at + 5, rest.length);
    let end = rest.indexOf("\n");
    let line = (end < 0 ? rest : rest.slice(0, end)).trim();
    if (line.startsWith("{")) {
      found = line;
    }
    if (end < 0) {
      break;
    }
    rest = rest.slice(end + 1, rest.length);
  }
  if (found != "") {
    return found;
  }
  return text;
}

export function authHeaders(server: McpServerRow, token: string): Map<string, string> {
  let out = new Map<string, string>();
  if (token == "" || server.authKind == "none" || server.authKind == "") {
    return out;
  }
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

export type ToolListing = {
  tools: McpTool[],
  problem: string,
};

export function toolListing(server: McpServerRow, token: string): ToolListing {
  let out: McpTool[] = [];
  if (!server.enabled) {
    return { tools: out, problem: "this server is switched off" };
  }
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

export function listTools(server: McpServerRow, token: string): McpTool[] {
  return toolListing(server, token).tools;
}

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

export function resultText(document: string): string {
  let out = "";
  let blocks = jsonList(jsonRaw(document, "content"));
  let i: int = 0;
  while (i < blocks.length) {
    if (jsonText(blocks[i], "type") == "text") {
      let piece = jsonText(blocks[i], "text");
      if (out != "") {
        out = out + "\n";
      }
      out = out + piece;
    }
    i = i + 1;
  }
  return out;
}

export function callTool(server: McpServerRow, toolName: string, args: string, token: string): McpCall {
  let body = args;
  if (body == "") {
    body = "{}";
  }
  let params = "{\"name\":" + JSON.stringify(toolName) + ",\"arguments\":" + body + "}";
  let answered = rpcWith(server.endpoint, authHeaders(server, token), 3, "tools/call", params);
  if (!answered.ok) {
    return answered;
  }
  let failed = jsonRaw(answered.text, "isError") == "true";
  let value = resultText(answered.text);
  if (value == "") {
    value = answered.text;
  }
  let text: McpCall = { ok: !failed, text: value, error: "" };
  if (failed) {
    text = { ok: false, text: value, error: "the tool reported an error" };
  }
  return text;
}
