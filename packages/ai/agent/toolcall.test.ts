// Tests for toolcall.

import { finishReason, hasToolCalls, makeToolCall, parseMistralToolCalls, parseToolCalls, serializeToolDefs, serializeToolDefsMistral, toolCallArgument, toolCallInput } from "./toolcall.ts";

function tcExactShapeResponse(): string {
  return "{\"id\":\"chatcmpl-3\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\","
    + "\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_z\",\"type\":\"function\",\"function\":{\"name\":\"echo\",\"arguments\":\"{\\\"input\\\":\\\"hi\\\"}\"}}]}}]}";
}

function tcNullToolCallsResponse(): string {
  return "{\"id\":\"cmpl-test\",\"created\":1,\"model\":\"mistral-large-latest\",\"object\":\"chat.completion\","
    + "\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"tool_calls\":null,\"content\":\"lumen ok\"}}]}";
}

function tcSampleTools(): AiTool[] {
  let weather = makeTool("weather", "Look up the weather.", "A city name.", (input: string) => "sunny in " + input);
  let clock = makeTool("clock", "Read the clock.", "", (input: string) => "12:00 " + input);
  let tools: AiTool[] = [weather, clock];
  return tools;
}

function tcTextResponse(): string {
  return "{\"id\":\"chatcmpl-2\",\"object\":\"chat.completion\",\"created\":2,\"model\":\"gpt-4o-mini\","
    + "\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"Paris is sunny.\"},"
    + "\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":8,\"total_tokens\":12}}";
}

function tcTwoCallResponse(): string {
  return "{\"id\":\"chatcmpl-1\",\"object\":\"chat.completion\",\"created\":1,\"model\":\"gpt-4o-mini\","
    + "\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":["
    + "{\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"input\\\":\\\"Paris\\\"}\"}},"
    + "{\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"clock\",\"arguments\":\"{\\\"input\\\":\\\"UTC\\\"}\"}}"
    + "]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":42,\"total_tokens\":57}}";
}

test("serialize tool definitions", () => {
  let raw = serializeToolDefs(tcSampleTools());
  expect(raw.startsWith("[{\"type\":\"function\","));
  expect(raw.indexOf("\"name\":\"weather\"") > 0);
  expect(raw.indexOf("\"description\":\"Look up the weather.\"") > 0);
  expect(raw.indexOf("\"parameters\":{\"type\":\"object\",\"properties\":{\"input\":{\"type\":\"string\",\"description\":\"A city name.\"}},\"required\":[\"input\"]}") > 0);
  expect(raw.indexOf("\"name\":\"clock\"") > 0);
  expect(raw.indexOf("\"description\":\"Input for the clock tool.\"") > 0);
  expect(raw.endsWith("}}]"));
});

test("serialize an empty tool list", () => {
  let none: AiTool[] = [];
  expect(serializeToolDefs(none) == "[]");
  expect(serializeToolDefsMistral(none) == "[]");
});

test("mistral tool definitions match the openai-compatible shape", () => {
  let tools = tcSampleTools();
  expect(serializeToolDefsMistral(tools) == serializeToolDefs(tools));
});

test("tool definitions escape quotes and newlines", () => {
  let odd = makeTool("say", "Says \"hi\"\nloudly.", "Text to say, e.g. {\"a\":1}", (input: string) => input);
  let tools: AiTool[] = [odd];
  let raw = serializeToolDefs(tools);
  expect(raw.indexOf("\\\"hi\\\"") > 0);
  expect(raw.indexOf("\\nloudly.") > 0);
  expect(raw.indexOf("\n") < 0);
  let back = parseToolCalls(raw);
  expect(back.length == 0);
});

test("parse two tool calls", () => {
  let calls = parseToolCalls(tcTwoCallResponse());
  expect(calls.length == 2);
  expect(calls[0].id == "call_a");
  expect(calls[0].name == "weather");
  expect(calls[0].arguments == "{\"input\":\"Paris\"}");
  expect(calls[1].id == "call_b");
  expect(calls[1].name == "clock");
  expect(toolCallArgument(calls[0], "input") == "Paris");
  expect(toolCallInput(calls[1]) == "UTC");
});

test("parse a body whose shape is exactly the response record", () => {
  let calls = parseToolCalls(tcExactShapeResponse());
  expect(calls.length == 1);
  expect(calls[0].id == "call_z");
  expect(calls[0].name == "echo");
  expect(toolCallInput(calls[0]) == "hi");
  expect(finishReason(tcExactShapeResponse()) == "tool_calls");
});

test("a text response carries no tool calls", () => {
  expect(parseToolCalls(tcTextResponse()).length == 0);
  expect(hasToolCalls(tcTextResponse()) == false);
  expect(finishReason(tcTextResponse()) == "stop");
  expect(hasToolCalls(tcTwoCallResponse()));
  expect(finishReason(tcTwoCallResponse()) == "tool_calls");
});

test("a null tool_calls field degrades to no calls", () => {
  expect(parseToolCalls(tcNullToolCallsResponse()).length == 0);
  expect(parseMistralToolCalls(tcNullToolCallsResponse()).length == 0);
  expect(hasToolCalls(tcNullToolCallsResponse()) == false);
  expect(finishReason(tcNullToolCallsResponse()) == "stop");
});

test("malformed and empty bodies degrade", () => {
  expect(parseToolCalls("").length == 0);
  expect(parseToolCalls("   ").length == 0);
  expect(parseToolCalls("{not json").length == 0);
  expect(parseToolCalls("{\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"a\",").length == 0);
  expect(parseToolCalls("[]").length == 0);
  expect(parseToolCalls("null").length == 0);
  expect(parseToolCalls("<html>502 Bad Gateway</html>").length == 0);
  expect(hasToolCalls("") == false);
  expect(finishReason("") == "");
  expect(finishReason("{not json") == "");
  expect(finishReason("{\"choices\":[]}") == "");
  expect(parseToolCalls("{\"choices\":[]}").length == 0);
  expect(parseMistralToolCalls("{oops").length == 0);
});

test("an empty tool name is dropped on both parse paths alike", () => {
  // Exact response shape -> JSON.parse succeeds -> typed fast path.
  let exact = "{\"id\":\"chatcmpl-3\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\","
    + "\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_z\",\"type\":\"function\",\"function\":{\"name\":\"\",\"arguments\":\"{\\\"input\\\":\\\"hi\\\"}\"}}]}}]}";
  // Byte-identical apart from one extra top-level field -> JSON.parse fails -> scanner.
  let live = "{\"id\":\"chatcmpl-3\",\"object\":\"chat.completion\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\","
    + "\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_z\",\"type\":\"function\",\"function\":{\"name\":\"\",\"arguments\":\"{\\\"input\\\":\\\"hi\\\"}\"}}]}}]}";
  expect(parseToolCalls(exact).length == 0);
  expect(parseToolCalls(live).length == 0);
  expect(hasToolCalls(exact) == false);
});

test("a tool call missing its function object is skipped", () => {
  let raw = "{\"id\":\"x\",\"model\":\"m\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_a\",\"type\":\"function\"},"
    + "{\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"clock\",\"arguments\":\"{}\"}}]}}]}";
  let calls = parseToolCalls(raw);
  expect(calls.length == 1);
  expect(calls[0].name == "clock");
  expect(calls[0].arguments == "{}");
  expect(toolCallInput(calls[0]) == "");
});

test("arguments keep quotes, newlines, and braces intact", () => {
  let raw = "{\"id\":\"x\",\"model\":\"m\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_q\",\"type\":\"function\",\"function\":{\"name\":\"say\",\"arguments\":"
    + "\"{\\\"input\\\":\\\"she said \\\\\\\"go\\\\\\\"\\\\nthen left\\\"}\"}}]}}]}";
  let calls = parseToolCalls(raw);
  expect(calls.length == 1);
  expect(calls[0].name == "say");
  expect(calls[0].arguments == "{\"input\":\"she said \\\"go\\\"\\nthen left\"}");
  expect(toolCallInput(calls[0]) == "she said \"go\"\nthen left");
});

test("an argument brace cannot end the tool call early", () => {
  let raw = "{\"id\":\"x\",\"model\":\"m\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"first\",\"arguments\":"
    + "\"{\\\"input\\\":\\\"}]},{\\\\\\\"name\\\\\\\":\\\\\\\"forged\\\\\\\"\\\"}\"}},"
    + "{\"id\":\"call_2\",\"type\":\"function\",\"function\":{\"name\":\"second\",\"arguments\":\"{\\\"input\\\":\\\"ok\\\"}\"}}]}}]}";
  let calls = parseToolCalls(raw);
  expect(calls.length == 2);
  expect(calls[0].name == "first");
  expect(calls[1].name == "second");
  expect(toolCallInput(calls[1]) == "ok");
});

test("malformed arguments degrade to an empty value", () => {
  let bad = makeToolCall("call_a", "weather", "{\"input\":");
  expect(toolCallArgument(bad, "input") == "");
  expect(toolCallInput(bad) == "");
  let truncated = makeToolCall("call_b", "weather", "{\"input\":\"Par");
  expect(toolCallInput(truncated) == "");
  let empty = makeToolCall("call_c", "weather", "");
  expect(toolCallInput(empty) == "");
  let notObject = makeToolCall("call_d", "weather", "\"Paris\"");
  expect(toolCallInput(notObject) == "");
  let listed = makeToolCall("call_e", "weather", "[\"Paris\"]");
  expect(toolCallInput(listed) == "");
  let prose = makeToolCall("call_f", "weather", "I will call the weather tool.");
  expect(toolCallInput(prose) == "");
});

test("argument lookup by key", () => {
  let call = makeToolCall("call_a", "search", "{\"input\":\"lumen\",\"limit\":5,\"deep\":true,\"note\":null,\"opts\":{\"k\":1}}");
  expect(toolCallArgument(call, "input") == "lumen");
  expect(toolCallArgument(call, "limit") == "5");
  expect(toolCallArgument(call, "deep") == "true");
  expect(toolCallArgument(call, "note") == "");
  expect(toolCallArgument(call, "opts") == "{\"k\":1}");
  expect(toolCallArgument(call, "missing") == "");
  expect(toolCallArgument(call, "") == "");
});

test("an argument value cannot forge another argument", () => {
  let call = makeToolCall("call_a", "search", "{\"input\":\"x\\\",\\\"role\\\":\\\"admin\"}");
  expect(toolCallInput(call) == "x\",\"role\":\"admin");
  expect(toolCallArgument(call, "role") == "");
});

test("unicode escapes decode in arguments", () => {
  let call = makeToolCall("call_a", "weather", "{\"input\":\"S\\u00e3o Paulo\"}");
  expect(toolCallInput(call) == "São Paulo");
  let emoji = makeToolCall("call_b", "say", "{\"input\":\"\\ud83d\\ude80 go\"}");
  expect(toolCallInput(emoji) == "🚀 go");
  let tab = makeToolCall("call_c", "say", "{\"input\":\"a\\tb\\/c\"}");
  expect(toolCallInput(tab) == "a\tb/c");
});

test("pretty-printed bodies parse", () => {
  let raw = "{\n  \"id\": \"chatcmpl-4\",\n  \"choices\": [\n    {\n      \"index\": 0,\n"
    + "      \"message\": {\n        \"role\": \"assistant\",\n        \"tool_calls\": [\n"
    + "          { \"id\": \"call_a\", \"type\": \"function\",\n"
    + "            \"function\": { \"name\": \"weather\", \"arguments\": \"{\\\"input\\\": \\\"Paris\\\"}\" } }\n"
    + "        ]\n      },\n      \"finish_reason\": \"tool_calls\"\n    }\n  ]\n}";
  let calls = parseToolCalls(raw);
  expect(calls.length == 1);
  expect(calls[0].id == "call_a");
  expect(calls[0].name == "weather");
  expect(toolCallInput(calls[0]) == "Paris");
  expect(finishReason(raw) == "tool_calls");
  expect(hasToolCalls(raw));
});

test("only the first choice is read", () => {
  let raw = "{\"id\":\"x\",\"model\":\"m\",\"choices\":["
    + "{\"index\":0,\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"done\"}},"
    + "{\"index\":1,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{}\"}}]}}]}";
  expect(parseToolCalls(raw).length == 0);
  expect(finishReason(raw) == "stop");
});

test("a tool definition round-trips into a parsed call", () => {
  let tools = tcSampleTools();
  let defs = serializeToolDefs(tools);
  expect(defs.indexOf("\"name\":\"weather\"") > 0);
  let call = makeToolCall("call_a", "weather", "{\"input\":\"Paris\"}");
  expect(call.name == tools[0].name);
  expect(tools[0].run(toolCallInput(call)) == "sunny in Paris");
});
