export const PARSE_ERROR: int = -32700;
export const INVALID_REQUEST: int = -32600;
export const METHOD_NOT_FOUND: int = -32601;
export const INVALID_PARAMS: int = -32602;
export const INTERNAL_ERROR: int = -32603;

export type Envelope = { id: string, method: string, params: string, fault: string };

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

export type RpcReply = { json: string };

export function rpcOk<T>(value: T): RpcReply {
  return { json: JSON.stringify(value) };
}

export function rpcRaw(json: string): RpcReply {
  return { json: json };
}

export function answered(id: string, result: RpcReply): string {
  return "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":" + result.json + "}";
}

export function refused(id: string, code: int, said: string): string {
  return "{\"jsonrpc\":\"2.0\",\"id\":" + id
    + ",\"error\":{\"code\":" + `${code}` + ",\"message\":" + JSON.stringify(said) + "}}";
}
