// Tests for sse.

import { buildHttpPost, decodeChunked, httpRequestLine, httpResponseBody, parseSseEvents, parseUrl, sseJsonRpcResponses, sseParseResult, sseParseTools, sseToolsToRegistry } from "./sse.ts";

function sseCallResultJson(): string {
  return "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":["
    + "{\"type\":\"text\",\"text\":\"line one\"},{\"type\":\"text\",\"text\":\"\\nline two\"}]}}";
}

function sseChunkify(body: string): string {
  return sseToHex(body.length) + "\r\n" + body + "\r\n0\r\n\r\n";
}

function sseToolsListJson(): string {
  return "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":["
    + "{\"name\":\"weather\",\"description\":\"Current weather for a city.\","
    + "\"inputSchema\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}},"
    + "{\"name\":\"add\",\"description\":\"Add two numbers.\",\"inputSchema\":{\"type\":\"object\"}}"
    + "]}}";
}

test("decodeChunked: a single chunk", () => {
  expect(decodeChunked("5\r\nhello\r\n0\r\n\r\n") == "hello");
});

test("decodeChunked: multiple chunks reassemble in order", () => {
  expect(decodeChunked("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n") == "hello world");
});

test("decodeChunked: a hex length above 9 is parsed", () => {
  expect(decodeChunked("10\r\n0123456789abcdef\r\n0\r\n\r\n") == "0123456789abcdef");
});

test("decodeChunked: data containing CRLF is copied verbatim, not split", () => {
  // "ab\r\ncd" is 6 bytes; the inner \r\n must not read as a frame boundary.
  expect(decodeChunked("6\r\nab\r\ncd\r\n0\r\n\r\n") == "ab\r\ncd");
});

test("decodeChunked: the bare terminator decodes to an empty body", () => {
  expect(decodeChunked("0\r\n\r\n") == "");
});

test("decodeChunked: a chunk-extension on the size line is ignored", () => {
  expect(decodeChunked("5;foo=bar\r\nhello\r\n0\r\n\r\n") == "hello");
});

test("decodeChunked: a non-chunked body is returned unchanged", () => {
  let plain = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}";
  expect(decodeChunked(plain) == plain);
  expect(decodeChunked("data: hi\r\n\r\n") == "data: hi\r\n\r\n");
});

test("parseSseEvents: one event yields one payload", () => {
  let ev = parseSseEvents("data: hello\n\n");
  expect(ev.length == 1);
  expect(ev[0] == "hello");
});

test("parseSseEvents: multiple events keep order", () => {
  let ev = parseSseEvents("data: one\n\ndata: two\n\n");
  expect(ev.length == 2);
  expect(ev[0] == "one");
  expect(ev[1] == "two");
});

test("parseSseEvents: multi-line data joins with a newline", () => {
  let ev = parseSseEvents("data: a\ndata: b\n\n");
  expect(ev.length == 1);
  expect(ev[0] == "a\nb");
});

test("parseSseEvents: comments, blank padding, and other fields are ignored", () => {
  let ev = parseSseEvents(":a keep-alive comment\nevent: message\nid: 42\nretry: 100\ndata: payload\n\n");
  expect(ev.length == 1);
  expect(ev[0] == "payload");
});

test("parseSseEvents: CRLF line endings and a missing leading space both work", () => {
  let ev = parseSseEvents("data:{\"k\":1}\r\n\r\n");
  expect(ev.length == 1);
  expect(ev[0] == "{\"k\":1}");
});

test("parseSseEvents: a final event with no trailing blank line is flushed", () => {
  let ev = parseSseEvents("data: last");
  expect(ev.length == 1);
  expect(ev[0] == "last");
});

test("parseSseEvents: a data payload that is a full JSON-RPC object survives intact", () => {
  let ev = parseSseEvents("event: message\ndata: " + sseCallResultJson() + "\n\n");
  expect(ev.length == 1);
  let res = parseMcpToolResult(ev[0]);
  expect(res.ok);
  expect(res.content == "line one\nline two");
});

test("sseJsonRpcResponses: a plain (non-SSE) JSON body is returned as one response", () => {
  let responses = sseJsonRpcResponses(sseToolsListJson());
  expect(responses.length == 1);
  expect(parseMcpTools(responses[0]).length == 2);
});

test("sseJsonRpcResponses: a chunked SSE body decodes then splits into events", () => {
  let frame = "event: message\ndata: " + sseToolsListJson() + "\n\n";
  let responses = sseJsonRpcResponses(sseChunkify(frame));
  expect(responses.length == 1);
  expect(mcpResponseId(responses[0]) == 1);
});

test("end to end: a chunked+SSE tools/list buffer parses into McpTools", () => {
  let raw = sseChunkify("event: message\ndata: " + sseToolsListJson() + "\n\n");
  let tools = sseParseTools(raw);
  expect(tools.length == 2);
  expect(tools[0].name == "weather");
  expect(tools[0].description == "Current weather for a city.");
  expect(tools[0].schema == "{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}");
  expect(tools[1].name == "add");
});

test("end to end: a plain-JSON tools/list body (no SSE) also parses", () => {
  let tools = sseParseTools(sseToolsListJson());
  expect(tools.length == 2);
  expect(tools[1].name == "add");
});

test("end to end: a chunked+SSE tools/call buffer parses into a McpResult", () => {
  let raw = sseChunkify("event: message\ndata: " + sseCallResultJson() + "\n\n");
  let res = sseParseResult(raw);
  expect(res.ok);
  expect(res.content == "line one\nline two");
  expect(res.error == "");
});

test("end to end: a JSON-RPC error carried over SSE surfaces as an error result", () => {
  let err = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}";
  let res = sseParseResult(sseChunkify("event: message\ndata: " + err + "\n\n"));
  expect(!res.ok);
  expect(res.error == "Method not found");
});

test("end to end: an interleaved notification is skipped for the id-1 answer", () => {
  let note = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"progress\",\"params\":{}}\n\n";
  let answer = "event: message\ndata: " + sseCallResultJson() + "\n\n";
  let res = sseParseResult(sseChunkify(note + answer));
  expect(res.ok);
  expect(res.content == "line one\nline two");
});

test("httpResponseBody: the body is everything past the header separator", () => {
  let response = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: hi\n\n";
  expect(httpResponseBody(response) == "data: hi\n\n");
  expect(httpResponseBody("no-separator-here") == "no-separator-here");
});

test("httpRequestLine names the method, path, and version", () => {
  expect(httpRequestLine("/mcp") == "POST /mcp HTTP/1.1");
  expect(httpRequestLine("") == "POST / HTTP/1.1");
});

test("buildHttpPost emits the request line, required headers, and the body", () => {
  let headers = new Map<string, string>();
  let req = buildHttpPost("example.com", "/mcp", headers, "{\"a\":1}");
  expect(req.startsWith("POST /mcp HTTP/1.1\r\n"));
  expect(req.includes("Host: example.com\r\n"));
  expect(req.includes("Content-Type: application/json\r\n"));
  expect(req.includes("Accept: application/json, text/event-stream\r\n"));
  expect(req.includes("Content-Length: 7\r\n"));
  expect(req.includes("Connection: close\r\n"));
  expect(req.endsWith("\r\n\r\n{\"a\":1}"));
});

test("buildHttpPost carries a caller header but never duplicates a managed one", () => {
  let headers = new Map<string, string>();
  headers.set("Authorization", "Bearer t0ken");
  headers.set("Content-Type", "text/plain");
  let req = buildHttpPost("h", "/", headers, "x");
  expect(req.includes("Authorization: Bearer t0ken\r\n"));
  expect(req.includes("Content-Type: application/json\r\n"));
  expect(!req.includes("Content-Type: text/plain\r\n"));
});

test("buildHttpPost Content-Length is the UTF-8 byte length, not code-point count", () => {
  let headers = new Map<string, string>();
  // "São" is 4 bytes (the ã is 2), so the byte-correct length is 4, not 3.
  let req = buildHttpPost("h", "/", headers, "São");
  expect(req.includes("Content-Length: 4\r\n"));
});

test("parseUrl splits host, port, and path with an explicit port", () => {
  let u = parseUrl("http://127.0.0.1:8080/mcp");
  expect(u.host == "127.0.0.1");
  expect(u.port == 8080);
  expect(u.path == "/mcp");
});

test("parseUrl defaults the port to 80 and the path to /", () => {
  let u = parseUrl("http://example.com");
  expect(u.host == "example.com");
  expect(u.port == 80);
  expect(u.path == "/");
});

test("parseUrl keeps a full path and query, and reads an https default port", () => {
  let u = parseUrl("http://host:9/a/b?x=1");
  expect(u.host == "host");
  expect(u.port == 9);
  expect(u.path == "/a/b?x=1");
  let s = parseUrl("https://secure.example.com/mcp");
  expect(s.host == "secure.example.com");
  expect(s.port == 443);
  expect(s.path == "/mcp");
});

test("a tools/list discovered over SSE adapts into runnable AiTools", () => {
  let tools = sseParseTools(sseChunkify("data: " + sseToolsListJson() + "\n\n"));
  let headers = new Map<string, string>();
  let registry = sseToolsToRegistry("http://127.0.0.1:9/mcp", headers, tools);
  expect(registry.length == 2);
  expect(registry[0].name == "weather");
  expect(registry[0].description == "Current weather for a city.");
  expect(registry[0].params == tools[0].schema);
});
