export const PARSE_ERROR: int = -32700;
export const INVALID_REQUEST: int = -32600;
export const METHOD_NOT_FOUND: int = -32601;
export const INVALID_PARAMS: int = -32602;
export const INTERNAL_ERROR: int = -32603;

export type Envelope = { id: string, method: string, params: string, fault: string };

export type RpcRoute = { method: string, handler: string };

export function tableFault(routes: RpcRoute[]): string {
  if (routes.length == 0) { return "a class carrying @rpc must name at least one @method"; }
  let i: int = 0;
  while (i < routes.length) {
    if (routes[i].method == "") { return "a @method needs a name"; }
    let j: int = i + 1;
    while (j < routes.length) {
      if (routes[j].method == routes[i].method) {
        return "two methods answer \"" + routes[i].method + "\": " + routes[i].handler + " and " + routes[j].handler;
      }
      j = j + 1;
    }
    i = i + 1;
  }
  return "";
}

export function handlerFor(routes: RpcRoute[], method: string): string {
  let i: int = 0;
  while (i < routes.length) {
    if (routes[i].method == method) { return routes[i].handler; }
    i = i + 1;
  }
  return "";
}

function member(body: string, key: string, raw: bool): string {
  let mark = "\"" + key + "\"";
  let at = body.indexOf(mark);
  if (at < 0) { return ""; }
  let colon = body.indexOf(":", at + mark.length);
  if (colon < 0) { return ""; }
  let i = colon + 1;
  while (i < body.length && (body.slice(i, i + 1) == " " || body.slice(i, i + 1) == "\n")) { i = i + 1; }
  if (i >= body.length) { return ""; }
  let head = body.slice(i, i + 1);
  if (head == "\"" && !raw) {
    let out = "";
    let j = i + 1;
    while (j < body.length) {
      let c = body.slice(j, j + 1);
      if (c == "\\") { out = out + body.slice(j + 1, j + 2); j = j + 2; continue; }
      if (c == "\"") { return out; }
      out = out + c;
      j = j + 1;
    }
    return out;
  }
  if (head == "{" || head == "[") {
    let depth: int = 0;
    let j = i;
    let instr = false;
    while (j < body.length) {
      let c = body.slice(j, j + 1);
      if (instr) {
        if (c == "\\") { j = j + 2; continue; }
        if (c == "\"") { instr = false; }
        j = j + 1;
        continue;
      }
      if (c == "\"") { instr = true; j = j + 1; continue; }
      if (c == "{" || c == "[") { depth = depth + 1; }
      if (c == "}" || c == "]") {
        depth = depth - 1;
        if (depth == 0) { return body.slice(i, j + 1); }
      }
      j = j + 1;
    }
    return "";
  }
  let end = i;
  while (end < body.length) {
    let c = body.slice(end, end + 1);
    if (c == "," || c == "}" || c == "\n") { break; }
    end = end + 1;
  }
  return body.slice(i, end).trim();
}

export function envelopeOf(body: string): Envelope {
  if (body.trim() == "") {
    return { id: "null", method: "", params: "", fault: "the request body is empty" };
  }
  let method = member(body, "method", false);
  let id = member(body, "id", true);
  if (id == "") { id = "null"; }
  if (method == "") {
    return { id: id, method: "", params: "", fault: "a request names a method" };
  }
  let params = member(body, "params", true);
  if (params == "") { params = "{}"; }
  return { id: id, method: method, params: params, fault: "" };
}

export type JsonField = { key: string, json: string };

export function jsonObjectOf(fields: JsonField[]): string {
  let out = "{";
  let i: int = 0;
  while (i < fields.length) {
    if (i > 0) { out = out + ","; }
    out = out + JSON.stringify(fields[i].key) + ":" + fields[i].json;
    i = i + 1;
  }
  return out + "}";
}

export function jsonArrayOf(items: string[]): string {
  let out = "[";
  let i: int = 0;
  while (i < items.length) {
    if (i > 0) { out = out + ","; }
    out = out + items[i];
    i = i + 1;
  }
  return out + "]";
}

export type RpcReply = { json: string, code: int, fault: string };

export function rpcOk<T>(value: T): RpcReply {
  return { json: JSON.stringify(value), code: 0, fault: "" };
}

export function rpcRaw(json: string): RpcReply {
  return { json: json, code: 0, fault: "" };
}

export function rpcFailed(code: int, said: string): RpcReply {
  return { json: "", code: code, fault: said };
}

export function refused(id: string, code: int, said: string): string {
  return "{\"jsonrpc\":\"2.0\",\"id\":" + id
    + ",\"error\":{\"code\":" + `${code}` + ",\"message\":" + JSON.stringify(said) + "}}";
}

export function answered(id: string, result: RpcReply): string {
  if (result.fault != "") { return refused(id, result.code, result.fault); }
  return "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":" + result.json + "}";
}
