// Tests for client.

import { mcFieldValue, mcIntField, mcStringField, mcValueText, mcpCallToolRequest, mcpErrorMessage, mcpInitializeRequest, mcpIsError, mcpListToolsRequest, mcpRequest, mcpResponseId, mcpResultField, mcpToolsToRegistry, parseMcpToolResult, parseMcpTools } from "./client.ts";

function mcCallResultResponse(): string {
  return "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"content\":["
    + "{\"type\":\"text\",\"text\":\"line one\"},"
    + "{\"type\":\"text\",\"text\":\"\\nline two\"}"
    + "],\"isError\":false}}";
}

function mcErrorResponse(): string {
  return "{\"jsonrpc\":\"2.0\",\"id\":9,\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}";
}

function mcToolsListResponse(): string {
  return "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":["
    + "{\"name\":\"weather\",\"description\":\"Current weather for a city.\","
    + "\"inputSchema\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}},"
    + "{\"name\":\"add\",\"description\":\"Add two numbers.\","
    + "\"inputSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"number\"},\"b\":{\"type\":\"number\"}}}},"
    + "{\"name\":\"echo\",\"description\":\"Echo the input.\","
    + "\"inputSchema\":{\"type\":\"object\"}}"
    + "]}}";
}

// one complete JSON value with nothing but whitespace after it.
function mcValidJson(raw: string): bool {
  let end = mcSkipValue(raw, 0);
  if (end < 0) { return false; }
  return mcSkipWhitespace(raw, end) == raw.length;
}

test("mcpRequest builds a well-formed JSON-RPC request", () => {
  let body = mcpRequest(5, "ping", "{\"beat\":1}");
  expect(mcValidJson(body));
  expect(mcpResponseId(body) == 5);
  expect(mcStringField(body, 0, "jsonrpc") == "2.0");
  expect(mcStringField(body, 0, "method") == "ping");
  let paramsAt = mcFieldValue(body, 0, "params");
  expect(paramsAt >= 0);
  expect(mcIntField(body, paramsAt, "beat") == 1);
});

test("initialize request carries the protocol version and client info", () => {
  let body = mcpInitializeRequest();
  expect(mcValidJson(body));
  expect(mcStringField(body, 0, "method") == "initialize");
  expect(mcpResponseId(body) == 1);
  let paramsAt = mcFieldValue(body, 0, "params");
  expect(mcStringField(body, paramsAt, "protocolVersion") == "2024-11-05");
  let clientAt = mcFieldValue(body, paramsAt, "clientInfo");
  expect(clientAt >= 0);
  expect(mcStringField(body, clientAt, "name") == "lumen-ai");
});

test("tools/list request names the method and round-trips its id", () => {
  let body = mcpListToolsRequest(42);
  expect(mcValidJson(body));
  expect(mcStringField(body, 0, "method") == "tools/list");
  expect(mcpResponseId(body) == 42);
  let paramsAt = mcFieldValue(body, 0, "params");
  expect(paramsAt >= 0);
  expect(mcValueText(body, paramsAt) == "{}");
});

test("tools/call request nests name and arguments under params", () => {
  let body = mcpCallToolRequest(7, "weather", "{\"input\":\"Paris\"}");
  expect(mcValidJson(body));
  expect(mcStringField(body, 0, "method") == "tools/call");
  expect(mcpResponseId(body) == 7);
  let paramsAt = mcFieldValue(body, 0, "params");
  expect(mcStringField(body, paramsAt, "name") == "weather");
  let argsAt = mcFieldValue(body, paramsAt, "arguments");
  expect(argsAt >= 0);
  expect(mcStringField(body, argsAt, "input") == "Paris");
});

test("tools/call escapes a name and arguments with quotes, newlines, unicode", () => {
  let name = "say \"hi\"\nnow";
  let args = "{\"input\":\"she said \\\"go\\\"\\nin S\\u00e3o Paulo\"}";
  let body = mcpCallToolRequest(11, name, args);
  expect(mcValidJson(body));
  expect(body.indexOf("\n") < 0);
  let paramsAt = mcFieldValue(body, 0, "params");
  expect(mcStringField(body, paramsAt, "name") == "say \"hi\"\nnow");
  let argsAt = mcFieldValue(body, paramsAt, "arguments");
  expect(mcStringField(body, argsAt, "input") == "she said \"go\"\nin São Paulo");
});

test("a negative response id round-trips", () => {
  let body = mcpListToolsRequest(-4);
  expect(mcpResponseId(body) == -4);
});

test("parseMcpTools extracts name, description, and raw schema", () => {
  let tools = parseMcpTools(mcToolsListResponse());
  expect(tools.length == 3);
  expect(tools[0].name == "weather");
  expect(tools[0].description == "Current weather for a city.");
  expect(tools[0].schema == "{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}");
  expect(tools[1].name == "add");
  expect(tools[1].description == "Add two numbers.");
  expect(tools[2].name == "echo");
  expect(tools[2].schema == "{\"type\":\"object\"}");
});

test("parseMcpTools degrades on error, malformed, and tool-less bodies", () => {
  expect(parseMcpTools(mcErrorResponse()).length == 0);
  expect(parseMcpTools("{not json").length == 0);
  expect(parseMcpTools("").length == 0);
  expect(parseMcpTools("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}").length == 0);
  expect(parseMcpTools("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}").length == 0);
  expect(parseMcpTools("<html>502 Bad Gateway</html>").length == 0);
});

test("parseMcpToolResult concatenates every text part", () => {
  let res = parseMcpToolResult(mcCallResultResponse());
  expect(res.ok);
  expect(res.content == "line one\nline two");
  expect(res.error == "");
});

test("parseMcpToolResult reports a JSON-RPC error", () => {
  let res = parseMcpToolResult(mcErrorResponse());
  expect(!res.ok);
  expect(res.content == "");
  expect(res.error == "Method not found");
  expect(mcpIsError(mcErrorResponse()));
  expect(mcpErrorMessage(mcErrorResponse()) == "Method not found");
});

test("parseMcpToolResult handles empty content and never throws on garbage", () => {
  let empty = parseMcpToolResult("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[]}}");
  expect(empty.ok);
  expect(empty.content == "");
  let garbage = parseMcpToolResult("<html>oops</html>");
  expect(garbage.ok);
  expect(garbage.content == "");
  let truncated = parseMcpToolResult("{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"hi");
  expect(truncated.content == "");
  let bare = parseMcpToolResult("");
  expect(bare.ok);
  expect(bare.content == "");
});

test("mcpResultField and mcpIsError separate success from failure", () => {
  expect(mcpResultField(mcCallResultResponse()).startsWith("{\"content\":"));
  expect(!mcpIsError(mcCallResultResponse()));
  expect(mcpResultField(mcErrorResponse()) == "");
  expect(mcpErrorMessage(mcCallResultResponse()) == "");
  expect(mcpResponseId(mcErrorResponse()) == 9);
});

test("a tools/list reply adapts into runnable AiTools", () => {
  let tools = parseMcpTools(mcToolsListResponse());
  let headers = new Map<string, string>();
  let registry = mcpToolsToRegistry("http://127.0.0.1:9/mcp", headers, tools);
  expect(registry.length == 3);
  expect(registry[0].name == "weather");
  expect(registry[0].description == "Current weather for a city.");
  expect(registry[0].params == tools[0].schema);
  // check the request run() would POST, without doing any I/O.
  let call = mcpCallToolRequest(1, registry[1].name, "{\"input\":" + JSON.stringify("2 and 3") + "}");
  expect(mcValidJson(call));
  let paramsAt = mcFieldValue(call, 0, "params");
  expect(mcStringField(call, paramsAt, "name") == "add");
  let argsAt = mcFieldValue(call, paramsAt, "arguments");
  expect(mcStringField(call, argsAt, "input") == "2 and 3");
});

test("a falsy error field alongside a result is not treated as an error", () => {
  let okFalse = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":false,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"payload\"}]}}";
  expect(!mcpIsError(okFalse));
  expect(parseMcpToolResult(okFalse).ok);
  expect(parseMcpToolResult(okFalse).content == "payload");
  let okNull = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":null,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}";
  expect(!mcpIsError(okNull));
  let okZero = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":0,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}";
  expect(!mcpIsError(okZero));
});

test("a string-form error yields its message, not an empty string", () => {
  let strErr = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":\"database offline\"}";
  expect(mcpIsError(strErr));
  expect(mcpErrorMessage(strErr) == "database offline");
  expect(parseMcpToolResult(strErr).error == "database offline");
  let objErr = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"bad request\"}}";
  expect(mcpErrorMessage(objErr) == "bad request");
});

test("an empty argumentsJson defaults to an empty object, not invalid JSON", () => {
  let body = mcpCallToolRequest(1, "ping", "");
  expect(body.includes("\"arguments\":{}"));
  let paramsAt = mcFieldValue(body, 0, "params");
  expect(mcStringField(body, paramsAt, "name") == "ping");
});
