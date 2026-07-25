// What goes on the wire when an agent has tools, and what comes back.
//
// Every provider disagrees about where a tool goes, what a call looks like and
// how a result is returned. None of it is guesswork — these are the shapes the
// three of them document — so the tests are the record of which shape belongs
// to whom.
//
//   cd packages/agents && lumen test wire.test.ts

import { ToolSpec, Turn, ToolCall, toolSpec, toolCall, userTurn, assistantTurn, toolTurn, toolsJson, messagesJson, toolCallsFrom, assistantText, replyText } from "./provider.ts";

function tools(): ToolSpec[] {
  let out: ToolSpec[] = [
    toolSpec("read_file", "Read a file", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}}"),
  ];
  return out;
}

// --- describing the tools -----------------------------------------------------

test("no tools is no tool list, not an empty one", () => {
  // An empty `tools` array is rejected by more than one provider, so the key
  // has to be absent rather than present and empty.
  let none: ToolSpec[] = [];
  expect(toolsJson("mistral", none) == "");
  expect(toolsJson("anthropic", none) == "");
});

test("openai and mistral wrap a tool in a function object", () => {
  let json = toolsJson("mistral", tools());
  expect(json.indexOf("\"type\":\"function\"") >= 0);
  expect(json.indexOf("\"parameters\":{\"type\":\"object\"") >= 0);
  expect(json.indexOf("\"name\":\"read_file\"") >= 0);
});

test("anthropic names the schema input_schema and does not wrap", () => {
  let json = toolsJson("anthropic", tools());
  expect(json.indexOf("\"input_schema\":{\"type\":\"object\"") >= 0);
  expect(json.indexOf("\"type\":\"function\"") < 0);
});

test("a tool with no schema still declares an argument object", () => {
  let bare: ToolSpec[] = [toolSpec("now", "The time", "")];
  expect(toolsJson("mistral", bare).indexOf("\"parameters\":{\"type\":\"object\",\"properties\":{}}") >= 0);
});

// --- the context as messages --------------------------------------------------

function conversation(): Turn[] {
  let calls: ToolCall[] = [toolCall("call_1", "read_file", "{\"path\":\"/etc/hosts\"}")];
  let turns: Turn[] = [
    userTurn("what is in /etc/hosts?"),
    assistantTurn("", calls),
    toolTurn("call_1", "read_file", "127.0.0.1 localhost"),
  ];
  return turns;
}

test("the system prompt is a message for openai and a field for anthropic", () => {
  let one: Turn[] = [userTurn("hi")];
  expect(messagesJson("mistral", "Be brief.", one).indexOf("\"role\":\"system\"") >= 0);
  // Anthropic takes the system prompt outside the message list; putting it in
  // as a message is an error rather than a stylistic difference.
  expect(messagesJson("anthropic", "Be brief.", one).indexOf("\"role\":\"system\"") < 0);
});

test("a turn that is only calls sends content null, not an empty string", () => {
  let json = messagesJson("mistral", "", conversation());
  expect(json.indexOf("\"role\":\"assistant\",\"content\":null") >= 0);
  expect(json.indexOf("\"tool_calls\":[{\"id\":\"call_1\"") >= 0);
});

test("openai sends the arguments as a string holding json", () => {
  // Not as an object: `"arguments":{"path":...}` is refused.
  let json = messagesJson("mistral", "", conversation());
  expect(json.indexOf("\"arguments\":\"{\\\"path\\\":\\\"/etc/hosts\\\"}\"") >= 0);
});

test("a tool result is its own message for openai", () => {
  let json = messagesJson("openai", "", conversation());
  expect(json.indexOf("\"role\":\"tool\",\"tool_call_id\":\"call_1\"") >= 0);
});

test("anthropic carries calls and results as content blocks", () => {
  let json = messagesJson("anthropic", "", conversation());
  expect(json.indexOf("\"type\":\"tool_use\"") >= 0);
  expect(json.indexOf("\"input\":{\"path\":\"/etc/hosts\"}") >= 0);
  expect(json.indexOf("\"type\":\"tool_result\"") >= 0);
  expect(json.indexOf("\"tool_use_id\":\"call_1\"") >= 0);
  // The result rides on a user message; there is no "tool" role.
  expect(json.indexOf("\"role\":\"tool\"") < 0);
});

test("anthropic puts every result of one turn in a single user message", () => {
  // Two calls answered by two separate user messages is an error there, so
  // consecutive tool turns have to merge.
  let calls: ToolCall[] = [toolCall("c1", "a", "{}"), toolCall("c2", "b", "{}")];
  let turns: Turn[] = [
    userTurn("go"),
    assistantTurn("", calls),
    toolTurn("c1", "a", "first"),
    toolTurn("c2", "b", "second"),
  ];
  let json = messagesJson("anthropic", "", turns);
  let first = json.indexOf("\"role\":\"user\"");
  let second = json.indexOf("\"role\":\"user\"", first + 1);
  // Two user messages in total: the question, and the pair of results.
  expect(second >= 0);
  expect(json.indexOf("\"role\":\"user\"", second + 1) < 0);
  expect(json.indexOf("\"tool_use_id\":\"c1\"") >= 0);
  expect(json.indexOf("\"tool_use_id\":\"c2\"") >= 0);
});

// --- reading the calls back ---------------------------------------------------

test("a reply with no calls has none", () => {
  let plain = "{\"choices\":[{\"message\":{\"content\":\"42\"}}]}";
  expect(toolCallsFrom("mistral", plain).length == 0);
  expect(toolCallsFrom("anthropic", "{\"content\":[{\"type\":\"text\",\"text\":\"42\"}]}").length == 0);
});

test("openai's calls come back with their ids and arguments", () => {
  let reply = "{\"choices\":[{\"message\":{\"content\":null,\"tool_calls\":["
    + "{\"id\":\"call_abc\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"/tmp/x\\\"}\"}}"
    + "]}}]}";
  let calls = toolCallsFrom("openai", reply);
  expect(calls.length == 1);
  expect(calls[0].id == "call_abc");
  expect(calls[0].name == "read_file");
  // The arguments arrive as an escaped string and must come out as JSON.
  expect(calls[0].args == "{\"path\":\"/tmp/x\"}");
});

test("arguments sent as an object rather than a string are read too", () => {
  // Documented as a string; sent as an object often enough to be worth reading
  // either way.
  let reply = "{\"choices\":[{\"message\":{\"tool_calls\":["
    + "{\"id\":\"c1\",\"function\":{\"name\":\"now\",\"arguments\":{\"tz\":\"UTC\"}}}]}}]}";
  let calls = toolCallsFrom("mistral", reply);
  expect(calls.length == 1);
  expect(calls[0].args == "{\"tz\":\"UTC\"}");
});

test("a call with no arguments becomes an empty object, not an empty string", () => {
  let reply = "{\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"c1\",\"function\":{\"name\":\"now\"}}]}}]}";
  expect(toolCallsFrom("mistral", reply)[0].args == "{}");
});

test("anthropic's calls are tool_use blocks, and text blocks are not calls", () => {
  let reply = "{\"content\":[{\"type\":\"text\",\"text\":\"Let me look.\"},"
    + "{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"read_file\",\"input\":{\"path\":\"/tmp/x\"}}]}";
  let calls = toolCallsFrom("anthropic", reply);
  expect(calls.length == 1);
  expect(calls[0].id == "toolu_1");
  expect(calls[0].args == "{\"path\":\"/tmp/x\"}");
  // And the text alongside them is still readable.
  expect(assistantText("anthropic", reply).text == "Let me look.");
});

test("two calls in one reply are both read, in order", () => {
  let reply = "{\"choices\":[{\"message\":{\"tool_calls\":["
    + "{\"id\":\"c1\",\"function\":{\"name\":\"first\",\"arguments\":\"{}\"}},"
    + "{\"id\":\"c2\",\"function\":{\"name\":\"second\",\"arguments\":\"{}\"}}]}}]}";
  let calls = toolCallsFrom("mistral", reply);
  expect(calls.length == 2);
  expect(calls[0].name == "first");
  expect(calls[1].name == "second");
});

test("a call-only reply has no text, which is not the same as empty text", () => {
  let reply = "{\"choices\":[{\"message\":{\"content\":null,\"tool_calls\":[{\"id\":\"c1\",\"function\":{\"name\":\"x\",\"arguments\":\"{}\"}}]}}]}";
  expect(!assistantText("mistral", reply).found);
  expect(assistantText("mistral", reply).text == "");
});

test("reading a reply still works as it did before tools existed", () => {
  // The old behaviour is load-bearing: an unrecognised shape comes back whole
  // rather than as an empty answer.
  expect(replyText("mistral", "{\"choices\":[{\"message\":{\"content\":\"42\"}}]}") == "42");
  expect(replyText("anthropic", "{\"content\":[{\"type\":\"text\",\"text\":\"42\"}]}") == "42");
  expect(replyText("mistral", "{\"unexpected\":true}") == "{\"unexpected\":true}");
});
