// Tests for sse.

import { parseSseEvents, sseJsonRpcResponses, sseParseResult, sseParseTools, sseToolsToRegistry } from "./sse.ts";

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

test("a tools/list discovered over SSE adapts into runnable AiTools", () => {
  let tools = sseParseTools(sseChunkify("data: " + sseToolsListJson() + "\n\n"));
  let headers = new Map<string, string>();
  let registry = sseToolsToRegistry("http://127.0.0.1:9/mcp", headers, tools);
  expect(registry.length == 2);
  expect(registry[0].name == "weather");
  expect(registry[0].description == "Current weather for a city.");
  expect(registry[0].params == tools[0].schema);
});
