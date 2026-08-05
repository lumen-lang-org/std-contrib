// Reading a member out of a document nobody can declare a type for.
//
//   cd packages/agents && lumen test scan.test.ts

import { jsonFind, jsonRaw, jsonText, jsonList, jsonValueAt, jsonUnescape, jsonStringMember, jsonComplete, jsonFlag } from "./scan.ts";

test("a member holding null is stepped over, not mistaken for the text", () => {
  // What a tool-calling reply looks like: the text is null and the answer is
  // in the calls. Taking the first "content" would report `null` as an answer.
  let reply = "{\"choices\":[{\"message\":{\"content\":null,\"tool_calls\":[{\"id\":\"c1\"}]}}]}";
  expect(!jsonStringMember(reply, "content").found);

  let mixed = "{\"a\":{\"content\":null},\"b\":{\"content\":\"here\"}}";
  let got = jsonStringMember(mixed, "content");
  expect(got.found);
  expect(got.text == "here");
});

test("empty text and no text are different answers", () => {
  let empty = jsonStringMember("{\"content\":\"\"}", "content");
  expect(empty.found);
  expect(empty.text == "");
  expect(!jsonStringMember("{\"other\":1}", "content").found);
});

test("a member several levels down is found", () => {
  let reply = "{\"id\":\"x\",\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"42\"}}]}";
  expect(jsonText(reply, "content") == "42");
  expect(jsonText(reply, "role") == "assistant");
});

test("a member that is not there reads as nothing, not as a guess", () => {
  expect(jsonRaw("{\"a\":1}", "b") == "");
  expect(jsonText("{\"a\":1}", "b") == "");
  expect(jsonFind("{\"a\":1}", "b") < 0);
});

test("the same spelling inside a string is not a key", () => {
  // The model quoted the key back at us. Only the real one is a key.
  let reply = "{\"content\":\"I would call \\\"tool_calls\\\": but I cannot\",\"tool_calls\":[]}";
  expect(jsonRaw(reply, "tool_calls") == "[]");
});

test("a value's own braces do not end it early", () => {
  let doc = "{\"schema\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}},\"after\":1}";
  let schema = jsonRaw(doc, "schema");
  expect(schema.startsWith("{\"type\":\"object\""));
  expect(schema.endsWith("}}}"));
  expect(schema.indexOf("after") < 0);
});

test("a brace inside a string does not end an object", () => {
  let doc = "{\"a\":{\"text\":\"} not the end {\"},\"b\":2}";
  expect(jsonRaw(doc, "a") == "{\"text\":\"} not the end {\"}");
});

test("an array's elements come back whole", () => {
  let items = jsonList("[{\"name\":\"read\"},{\"name\":\"write\"},{\"name\":\"list\"}]");
  expect(items.length == 3);
  expect(jsonText(items[1], "name") == "write");
});

test("an array of scalars and an empty array", () => {
  let nums = jsonList("[1, 2, 30]");
  expect(nums.length == 3);
  expect(nums[2] == "30");
  expect(jsonList("[]").length == 0);
  expect(jsonList("   [ ]  ").length == 0);
});

test("something that is not an array has no elements", () => {
  expect(jsonList("{\"a\":1}").length == 0);
  expect(jsonList("").length == 0);
});

test("nested arrays are one element each, not flattened", () => {
  let outer = jsonList("[[1,2],[3]]");
  expect(outer.length == 2);
  expect(outer[0] == "[1,2]");
});

test("a member that is not a string is not handed back as text", () => {
  // Asking for text and receiving `{"a":1}` would read as an answer.
  expect(jsonText("{\"n\":42}", "n") == "");
  expect(jsonRaw("{\"n\":42}", "n") == "42");
  expect(jsonRaw("{\"n\":true,\"m\":0}", "n") == "true");
});

test("escapes are resolved", () => {
  expect(jsonUnescape("one\\ntwo") == "one\ntwo");
  expect(jsonUnescape("say \\\"hi\\\"") == "say \"hi\"");
  expect(jsonUnescape("a\\\\b") == "a\\b");
  expect(jsonUnescape("a\\/b") == "a/b");
});

test("a unicode escape is a character, not the letters that spell it", () => {
  expect(jsonUnescape("caf\\u00e9") == "café");
  // A surrogate pair is one character, not two halves.
  expect(jsonUnescape("\\ud83d\\ude80").length == 4);
  expect(jsonUnescape("\\u0041") == "A");
  // Not four hex digits: left as written rather than swallowed.
  expect(jsonUnescape("\\uZZZZ").indexOf("u") >= 0);
});

test("a truncated document reports nothing rather than half a value", () => {
  expect(jsonRaw("{\"a\":{\"b\":1", "a") == "");
  expect(jsonRaw("{\"a\":\"unterminated", "a") == "");
});

test("a value can be read from a position", () => {
  let doc = "  {\"a\":1}  ";
  expect(jsonValueAt(doc, 0) == "{\"a\":1}");
});

// --- is this one whole JSON object? --------------------------------------------
//
// What jsonComplete answers decides whether a tool call is dispatched and
// whether its arguments are spliced raw into the stored `calls` column and
// back out to the provider. "The brackets balance" is not that question.

test("one complete object is complete", () => {
  expect(jsonComplete("{}"));
  expect(jsonComplete("{\"path\":\"/a.css\",\"content\":\"body { color: red }\"}"));
  expect(jsonComplete("  {\"a\":1}\n"));
  // A brace or bracket inside a string is text, not structure.
  expect(jsonComplete("{\"a\":[1,2,{\"b\":\"}]\"}]}"));
  // An escaped quote does not end the string, and an escaped backslash before
  // a quote does.
  expect(jsonComplete("{\"a\":\"say \\\"hi\\\"\"}"));
  expect(jsonComplete("{\"a\":\"ends with a backslash \\\\\"}"));
});

test("every shape a cut-off model leaves behind is refused", () => {
  // The whole reason this exists: a model that hits its output cap partway
  // through a tool call's arguments produces a prefix.
  expect(!jsonComplete("{\"path\": \"/a.css\", \"content\": \"body {"));
  expect(!jsonComplete("{\"a\":1"));
  expect(!jsonComplete("{\"a\":[1,2"));
  expect(!jsonComplete("{\"a\":{\"b\":1}"));
  expect(!jsonComplete("{\"a\":\"unterminated"));
  expect(!jsonComplete("{\"a\":\"trailing escape\\"));
  // A raw control character inside a string is not legal JSON and is exactly
  // what a cut stream leaves behind.
  expect(!jsonComplete("{\"a\":\"one\ntwo\"}"));
});

test("something that is not a JSON object is not a complete one", () => {
  // Every one of these balanced, so the old answer was yes.
  expect(!jsonComplete(""));
  expect(!jsonComplete("   "));
  expect(!jsonComplete("not json at all"));
  expect(!jsonComplete("[1,2]"));
  expect(!jsonComplete("\"a string\""));
  expect(!jsonComplete("42"));
  expect(!jsonComplete("null"));
});

test("one document, not two and not one with a tail", () => {
  // `{"a":1}{"b":2}` is two documents, and the caller splices what it is
  // given straight into a row and into a provider's `input`.
  expect(!jsonComplete("{\"a\":1}{\"b\":2}"));
  expect(!jsonComplete("{\"a\":1} junk"));
  expect(!jsonComplete("{\"a\":1},"));
});

test("a closing bracket has to match what it opened", () => {
  expect(!jsonComplete("{\"a\":[1}"));
  expect(!jsonComplete("{\"a\":{\"b\":1]}"));
  expect(!jsonComplete("}{"));
  expect(!jsonComplete("{\"a\":1}}"));
});

// --- flags ---------------------------------------------------------------

test("a flag reads whether it was written as a boolean or as a string", () => {
  // Both spellings arrive in practice: a console does JSON.stringify and
  // sends a boolean; a settings row this API writes itself quotes it.
  expect(jsonFlag("{\"enabled\":true}", "enabled", false));
  expect(jsonFlag("{\"enabled\":\"true\"}", "enabled", false));
  expect(!jsonFlag("{\"enabled\":false}", "enabled", true));
  expect(!jsonFlag("{\"enabled\":\"false\"}", "enabled", true));
});

test("an absent flag is the caller's default, not false", () => {
  // The difference between "turn it off" and "I did not mention it" — a merge
  // that cannot tell them apart switches things off nobody touched.
  expect(jsonFlag("{\"other\":1}", "enabled", true));
  expect(!jsonFlag("{\"other\":1}", "enabled", false));
  expect(jsonFlag("", "enabled", true));
});

test("a flag that is neither true nor false is not true", () => {
  // null, a number, a string of something else: none of them is consent.
  expect(!jsonFlag("{\"enabled\":null}", "enabled", true));
  expect(!jsonFlag("{\"enabled\":1}", "enabled", true));
  expect(!jsonFlag("{\"enabled\":\"yes\"}", "enabled", true));
});
