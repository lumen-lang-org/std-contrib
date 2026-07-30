// Reading a real OpenAI reply. The bodies here are the shape a live
// `/chat/completions` call returns, not a hand-trimmed fixture: a production
// reply carries fields the package does not model, arrives from some gateways
// with spaces after the colons, and escapes non-ASCII text.

import { readOpenAIContent, readOpenAIResult, readOpenAIError, readOpenAITokenUsage, openAICallResult } from "./openai.ts";

// Verbatim gpt-4o-mini reply. `usage`, `service_tier` and `system_fingerprint`
// sit beside the modelled members; `logprobs`, `refusal` and `annotations` sit
// inside the choice.
const LIVE = "{\"id\":\"chatcmpl-BqX\",\"object\":\"chat.completion\",\"created\":1753000000,\"model\":\"gpt-4o-mini-2024-07-18\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"lumen ok\",\"refusal\":null,\"annotations\":[]},\"logprobs\":null,\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":18,\"completion_tokens\":3,\"total_tokens\":21},\"service_tier\":\"default\",\"system_fingerprint\":\"fp_34a54ae93c\"}";

test("a live reply's unmodelled fields do not empty the answer", () => {
  expect(readOpenAIContent(LIVE) == "lumen ok");
  let r = readOpenAIResult(200, true, LIVE);
  expect(r.ok);
  expect(r.status == 200);
  expect(r.content == "lumen ok");
});

test("a space after the colon does not empty the answer", () => {
  // Any gateway or proxy that re-serializes the JSON spaces it out.
  let spaced = "{\"id\": \"a\", \"choices\": [{\"index\": 0, \"message\": {\"role\": \"assistant\", \"content\": \"lumen ok\"}, \"finish_reason\": \"stop\"}], \"usage\": {\"total_tokens\": 21}}";
  expect(readOpenAIContent(spaced) == "lumen ok");
});

test("the answer is choices[0].message.content, not the first content anywhere", () => {
  // A gateway that echoes the request alongside the reply puts the user's own
  // question in an earlier `content`.
  let echoed = "{\"id\":\"a\",\"request\":{\"messages\":[{\"role\":\"user\",\"content\":\"what is 2+2\"}]},\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"4\"},\"finish_reason\":\"stop\"}]}";
  expect(readOpenAIContent(echoed) == "4");
});

test("a second choice does not answer for the first", () => {
  let two = "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"first\"}},{\"index\":1,\"message\":{\"role\":\"assistant\",\"content\":\"second\"}}]}";
  expect(readOpenAIContent(two) == "first");
});

test("a nested content inside the message does not shadow the real one", () => {
  let nested = "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"meta\":{\"content\":\"NESTED\"},\"content\":\"REAL\"}}]}";
  expect(readOpenAIContent(nested) == "REAL");
});

test("unicode escapes are decoded", () => {
  let body = "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"caf\\u00e9 \\ud83d\\ude00\"}}]}";
  expect(readOpenAIContent(body) == "café 😀");
});

test("an HTML-escaping gateway's output reads back as written", () => {
  // Go's encoding/json escapes <, > and & by default, so an OpenAI-compatible
  // server written in Go sends this for `a < b && c`.
  let body = "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"a \\u003c b \\u0026\\u0026 c\"}}]}";
  expect(readOpenAIContent(body) == "a < b && c");
});

test("backspace and form feed escapes are not mangled", () => {
  let body = "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"a\\bb\\fc\\/d\"}}]}";
  expect(readOpenAIContent(body) == "a\u{08}b\u{0C}c/d");
});

test("a null content is not the text null", () => {
  let body = "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":null,\"refusal\":\"I cannot help with that.\"}}]}";
  expect(readOpenAIContent(body) == "");
});

test("an empty choices array yields no answer", () => {
  expect(readOpenAIContent("{\"id\":\"a\",\"choices\":[]}") == "");
  expect(readOpenAIContent("not json at all") == "");
});

test("token usage survives the live body", () => {
  let u = readOpenAITokenUsage(LIVE);
  expect(u.prompt_tokens == 18);
  expect(u.completion_tokens == 3);
  expect(u.total_tokens == 21);
});

test("a refused connection names the provider, the URL and the reason", () => {
  // http.request reports a transport failure as status -1 with an empty body;
  // a bare zero value cannot be told apart from a model that said nothing.
  let r = openAICallResult("https://api.openai.com/v1/chat/completions", -1, false, "");
  expect(!r.ok);
  expect(r.status == -1);
  expect(r.content == "");
  expect(r.raw.includes("openai"));
  expect(r.raw.includes("https://api.openai.com/v1/chat/completions"));
  expect(r.raw.includes("no response"));
});

test("an HTTP error carries the provider's own words", () => {
  let body = "{\"error\":{\"message\":\"Invalid API key\",\"type\":\"invalid_request_error\",\"code\":\"invalid_api_key\"}}";
  let r = openAICallResult("https://api.openai.com/v1/chat/completions", 401, false, body);
  expect(!r.ok);
  expect(r.status == 401);
  expect(r.raw.includes("Invalid API key"));
  expect(r.raw.includes("401"));
});

test("a successful call still parses normally", () => {
  let r = openAICallResult("https://api.openai.com/v1/chat/completions", 200, true, LIVE);
  expect(r.ok);
  expect(r.content == "lumen ok");
  expect(r.raw == LIVE);
});

test("the error reader keeps working on its own", () => {
  let err = readOpenAIError(401, "{\"error\":{\"message\":\"Invalid API key\",\"type\":\"auth_error\"}}");
  expect(err.provider == "openai");
  expect(err.status == 401);
  expect(err.message == "Invalid API key");
});
