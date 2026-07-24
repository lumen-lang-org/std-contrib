// MCP over SSE / streamable HTTP on a raw TCP socket. `http.request` returns one
// complete body and cannot read an event-by-event reply, so HTTP/1.1 request
// framing, chunked-transfer decoding, and SSE frame parsing are hand-rolled over
// net.connect here. all JSON-RPC framing and parsing is reused from ./client.ts.
//
// http:// ONLY: net.connect speaks plain TCP with no TLS handshake, so an
// https:// URL connects to the wrong wire protocol. use a localhost server or
// one behind a terminating proxy.

import { mcpListToolsRequest, mcpCallToolRequest, parseMcpTools, parseMcpToolResult, mcpResponseId } from "./client.ts";
import { makeTool } from "../agent/tools.ts";

// declared without `export` (an exported type is rejected); a caller pulls it
// into scope by importing parseUrl.
type UrlParts = {
  host: string,
  port: int,
  path: string,
};

function noStrings(): string[] {
  let e: string[] = [];
  return e;
}

function sseHexDigit(c: string): int {
  let code = c.charCodeAt(0);
  if (code >= "0".charCodeAt(0) && code <= "9".charCodeAt(0)) { return code - "0".charCodeAt(0); }
  if (code >= "a".charCodeAt(0) && code <= "f".charCodeAt(0)) { return code - "a".charCodeAt(0) + 10; }
  if (code >= "A".charCodeAt(0) && code <= "F".charCodeAt(0)) { return code - "A".charCodeAt(0) + 10; }
  return -1;
}

// the chunk-size line is `<hex>[;chunk-ext]`; the extension is dropped. returns
// -1 for an empty or non-hex line, which is how decodeChunked recognizes a body
// that is not chunked at all.
function sseParseHexLine(line: string): int {
  let s = line;
  let semi = s.indexOf(";");
  if (semi >= 0) { s = s.slice(0, semi); }
  s = s.trim();
  if (s.length == 0) { return -1; }
  let value: int = 0;
  let i: int = 0;
  while (i < s.length) {
    let d = sseHexDigit(s.charAt(i));
    if (d < 0) { return -1; }
    value = value * 16 + d;
    i = i + 1;
  }
  return value;
}

// --- chunked transfer-encoding ----------------------------------------------

// each chunk is `<hexlen>\r\n<data>\r\n`, ending at the `0\r\n` terminator.
// exactly hexlen bytes are copied regardless of content, so a `\r\n` inside a
// chunk's data is never mistaken for a frame boundary. a body not beginning with
// a valid hex length line is assumed NOT chunked and returned unchanged, so a
// plain Content-Length response works through the same path.
export function decodeChunked(raw: string): string {
  let firstCrlf = raw.indexOf("\r\n");
  if (firstCrlf < 0) { return raw; }
  if (sseParseHexLine(raw.slice(0, firstCrlf)) < 0) { return raw; }
  let out = "";
  let i: int = 0;
  while (i < raw.length) {
    let crlf = raw.indexOf("\r\n", i);
    if (crlf < 0) { break; }
    let len = sseParseHexLine(raw.slice(i, crlf));
    if (len <= 0) { break; }
    let dataStart = crlf + 2;
    let dataEnd = dataStart + len;
    if (dataEnd > raw.length) {
      out = out + raw.slice(dataStart, raw.length);
      break;
    }
    out = out + raw.slice(dataStart, dataEnd);
    i = dataEnd + 2;
  }
  return out;
}

// --- SSE frame parsing ------------------------------------------------------

// drops a trailing `\r` so a `\r\n`-delimited stream reads like an `\n` one.
function sseSplitLines(body: string): string[] {
  let raw = body.split("\n");
  let out: string[] = [];
  let i: int = 0;
  while (i < raw.length) {
    let line = raw[i];
    if (line.length > 0 && line.charAt(line.length - 1) == "\r") {
      line = line.slice(0, line.length - 1);
    }
    out = [...out, line];
    i = i + 1;
  }
  return out;
}

// a blank line ends an event; its `data:` values join with `\n` (the EventSource
// rule). one leading space after the field colon is stripped; `event:`, `id:`,
// `retry:` and `:comment` lines are ignored. a final event with no trailing
// blank line is still flushed.
export function parseSseEvents(body: string): string[] {
  let lines = sseSplitLines(body);
  let out: string[] = [];
  let dataParts: string[] = noStrings();
  let hasData: bool = false;
  let i: int = 0;
  while (i < lines.length) {
    let line = lines[i];
    i = i + 1;
    if (line.length == 0) {
      if (hasData) {
        out = [...out, dataParts.join("\n")];
        dataParts = noStrings();
        hasData = false;
      }
      continue;
    }
    if (line.charAt(0) == ":") { continue; }
    let field = line;
    let value = "";
    let colon = line.indexOf(":");
    if (colon >= 0) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1, line.length);
      if (value.length > 0 && value.charAt(0) == " ") { value = value.slice(1, value.length); }
    }
    if (field == "data") {
      dataParts = [...dataParts, value];
      hasData = true;
    }
  }
  if (hasData) { out = [...out, dataParts.join("\n")]; }
  return out;
}

// the JSON-RPC object strings a raw response body carries. MCP streamable HTTP
// may answer one request as either an SSE stream (each response the data of a
// `message` event) or a lone plain JSON object; a non-SSE body is returned whole
// as the single response.
export function sseJsonRpcResponses(raw: string): string[] {
  let body = decodeChunked(raw);
  let events = parseSseEvents(body);
  if (events.length > 0) { return events; }
  let trimmed = body.trim();
  let out: string[] = noStrings();
  if (trimmed.length > 0) { out = [...out, trimmed]; }
  return out;
}

// the response whose JSON-RPC `id` matches, else the last one seen, else "".
// requests here always use id 1, so an interleaved server notification (no id,
// reading as 0) is skipped.
function pickJsonRpcResponse(responses: string[], id: int): string {
  let last = "";
  let i: int = 0;
  while (i < responses.length) {
    last = responses[i];
    if (mcpResponseId(responses[i]) == id) { return responses[i]; }
    i = i + 1;
  }
  return last;
}

// a full raw response body (chunked+SSE, or plain JSON) into parsed tools / call
// result; both degrade to an empty list / ok-empty result on a malformed body.
export function sseParseTools(raw: string): McpTool[] {
  return parseMcpTools(pickJsonRpcResponse(sseJsonRpcResponses(raw), 1));
}

export function sseParseResult(raw: string): McpResult {
  return parseMcpToolResult(pickJsonRpcResponse(sseJsonRpcResponses(raw), 1));
}

// --- HTTP/1.1 request framing -----------------------------------------------

export function httpRequestLine(path: string): string {
  let p = path;
  if (p.length == 0) { p = "/"; }
  return "POST " + p + " HTTP/1.1";
}

// Accept admits both a plain JSON reply and an SSE stream. Content-Length is
// .length because strings are byte-indexed, so that is already the byte count.
// caller headers colliding with the managed ones are skipped, never emitted twice.
export function buildHttpPost(host: string, path: string, headersMap: Map<string, string>, body: string): string {
  let out = httpRequestLine(path) + "\r\n";
  out = out + "Host: " + host + "\r\n";
  out = out + "Content-Type: application/json\r\n";
  out = out + "Accept: application/json, text/event-stream\r\n";
  for (const [name, value] of headersMap) {
    let lname = name.toLowerCase();
    if (lname == "host" || lname == "content-type" || lname == "accept" || lname == "content-length" || lname == "connection") { continue; }
    out = out + name + ": " + value + "\r\n";
  }
  out = out + "Content-Length: " + `${body.length}` + "\r\n";
  out = out + "Connection: close\r\n";
  out = out + "\r\n";
  out = out + body;
  return out;
}

// everything past the header/body separator; a bare `\n\n` is tolerated, and
// with neither separator the whole text is the body.
export function httpResponseBody(response: string): string {
  let sep = response.indexOf("\r\n\r\n");
  if (sep >= 0) { return response.slice(sep + 4, response.length); }
  let sep2 = response.indexOf("\n\n");
  if (sep2 >= 0) { return response.slice(sep2 + 2, response.length); }
  return response;
}

// default port 80, or 443 for an https:// URL the raw-TCP transport cannot
// actually serve (see the file header). a missing path reads as "/"; a
// non-numeric port falls back to the default.
export function parseUrl(url: string): UrlParts {
  let rest = url;
  let defPort: int = 80;
  if (rest.startsWith("https://")) { rest = rest.slice(8, rest.length); defPort = 443; }
  else if (rest.startsWith("http://")) { rest = rest.slice(7, rest.length); }
  let path = "/";
  let authority = rest;
  let slash = rest.indexOf("/");
  if (slash >= 0) {
    authority = rest.slice(0, slash);
    path = rest.slice(slash, rest.length);
  }
  let host = authority;
  let port = defPort;
  let colon = authority.indexOf(":");
  if (colon >= 0) {
    host = authority.slice(0, colon);
    let portStr = authority.slice(colon + 1, authority.length);
    let parsed: int = 0;
    let ok: bool = false;
    let i: int = 0;
    while (i < portStr.length) {
      let code = portStr.charAt(i).charCodeAt(0);
      if (code < "0".charCodeAt(0) || code > "9".charCodeAt(0)) { ok = false; break; }
      parsed = parsed * 10 + (code - "0".charCodeAt(0));
      ok = true;
      i = i + 1;
    }
    if (ok) { port = parsed; }
  }
  let parts: UrlParts = {
    host: host,
    port: port,
    path: path,
  };
  return parts;
}

// bare host, plus `:port` when the port is not the default 80.
function hostHeader(parts: UrlParts): string {
  if (parts.port == 80) { return parts.host; }
  return parts.host + ":" + `${parts.port}`;
}

// --- socket layer (the only I/O here) ---------------------------------------

// read() until EOF (an "" chunk), reassembling the full raw response. net's
// socket methods do not throw, so no guard is needed.
function readAll(host: string, port: int, request: string): string {
  let sock = net.connect(host, port);
  sock.write(request);
  let out = "";
  while (true) {
    let chunk = sock.read();
    if (chunk == "") { break; }
    out = out + chunk;
  }
  sock.close();
  return out;
}

function sseFetch(url: string, headers: Map<string, string>, requestBody: string): string[] {
  let parts = parseUrl(url);
  let request = buildHttpPost(hostHeader(parts), parts.path, headers, requestBody);
  let response = readAll(parts.host, parts.port, request);
  return sseJsonRpcResponses(httpResponseBody(response));
}

export function sseListTools(url: string, headers: Map<string, string>): McpTool[] {
  return parseMcpTools(pickJsonRpcResponse(sseFetch(url, headers, mcpListToolsRequest(1)), 1));
}

export function sseCall(url: string, headers: Map<string, string>, name: string, argumentsJson: string): McpResult {
  return parseMcpToolResult(pickJsonRpcResponse(sseFetch(url, headers, mcpCallToolRequest(1, name, argumentsJson)), 1));
}

// run wraps its single string input as {"input": <input>} — this package's
// one-string-arg convention — and never throws: neither net's methods nor
// parseMcpToolResult throws, so trouble comes back as text.
export function sseToolToLumen(url: string, headers: Map<string, string>, tool: McpTool): AiTool {
  let toolName = tool.name;
  return makeTool(tool.name, tool.description, tool.schema, (input: string) => {
    let args = "{\"input\":" + JSON.stringify(input) + "}";
    let result = sseCall(url, headers, toolName, args);
    if (result.ok) { return result.content; }
    return "error: " + result.error;
  });
}

export function sseToolsToRegistry(url: string, headers: Map<string, string>, tools: McpTool[]): AiTool[] {
  let out: AiTool[] = [];
  let i: int = 0;
  while (i < tools.length) {
    out.push(sseToolToLumen(url, headers, tools[i]));
    i = i + 1;
  }
  return out;
}

// trusted chunk encoder used by sse.test.ts: the decoder is validated directly
// against hand-written literals there, so feeding it encoder output exercises
// the compose path, not the decoder itself.
function sseToHex(n: int): string {
  if (n == 0) { return "0"; }
  let digits = "0123456789abcdef";
  let out = "";
  let v = n;
  while (v > 0) {
    out = digits.charAt(v % 16) + out;
    v = v / 16;
  }
  return out;
}
