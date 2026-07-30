// MCP over SSE / streamable HTTP.
//
// Built on `http.stream`, which hands back a response while it is still
// arriving and decodes chunked transfer-encoding itself. What remains here is
// SSE framing — reading `data:` lines off the stream — and the JSON-RPC
// framing and parsing reused from ./client.ts.
//
// https:// works: the stream owns a real TLS connection. This replaced a
// hand-rolled HTTP/1.1 client over net.connect, which had no TLS and so could
// only reach a localhost server or one behind a terminating proxy.

import { mcpListToolsRequest, mcpCallToolRequest, parseMcpTools, parseMcpToolResult, mcpResponseId } from "./client.ts";
import { makeTool } from "../agent/tools.ts";

function noStrings(): string[] {
  let e: string[] = [];
  return e;
}

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

// the JSON-RPC object strings a response body carries. MCP streamable HTTP may
// answer one request as either an SSE stream (each response the data of a
// `message` event) or a lone plain JSON object; a non-SSE body is returned whole
// as the single response.
//
// The body arrives already decoded — `http.stream` handles chunked
// transfer-encoding — so this only has to tell the two framings apart.
export function sseJsonRpcResponses(body: string): string[] {
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

// --- transport ---------------------------------------------------------------

// POST the request and collect the reply's `data:` lines as they arrive.
//
// The stream is read to exhaustion because a JSON-RPC reply is what is wanted,
// not a running feed; the point of streaming here is that the server may frame
// its answer as events, and that a slow server does not have to be buffered
// whole before the first line can be seen.
function sseFetch(url: string, headers: Map<string, string>, requestBody: string): string[] {
  let sendHeaders = new Map<string, string>();
  for (const key of headers.keys()) {
    sendHeaders.set(key, headers.get(key) ?? "");
  }
  sendHeaders.set("Content-Type", "application/json");
  sendHeaders.set("Accept", "text/event-stream");

  let s = http.stream(url, "POST", requestBody, sendHeaders);
  if (s.status() < 200 || s.status() >= 300) {
    s.close();
    return noStrings();
  }
  let body = "";
  while (!s.done()) {
    let line = s.readLine();
    if (s.done()) { break; }
    body = body + line + "\n";
  }
  s.close();
  return sseJsonRpcResponses(body);
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
export function sseToolToLumen(url: string, headers: Map<string, string>, entry: McpTool): Tool {
  let toolName = entry.name;
  return makeTool(entry.name, entry.description, entry.schema, (input: string) => {
    let args = "{\"input\":" + JSON.stringify(input) + "}";
    let result = sseCall(url, headers, toolName, args);
    if (result.ok) { return result.content; }
    return "error: " + result.error;
  });
}

export function sseToolsToRegistry(url: string, headers: Map<string, string>, tools: McpTool[]): Tool[] {
  let out: Tool[] = [];
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
//
// A chunked-transfer length prefix is the size in lowercase hex, which is what
// `toString(radix)` produces — no leading zeros and no minimum width, exactly as
// RFC 9112 asks.
function sseToHex(n: int): string {
  return n.toString(16);
}
