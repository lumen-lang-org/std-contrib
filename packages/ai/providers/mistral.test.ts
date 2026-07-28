// Reading a real Mistral reply. Mistral speaks the OpenAI wire format, so the
// same hazards apply: unmodelled fields, spaced-out JSON from a gateway, and
// escaped non-ASCII text.

import { readMistralContent, readMistralResult, readMistralError, readMistralTokenUsage, mistralCallResult } from "./mistral.ts";

const LIVE = "{\"id\":\"cmpl-9f\",\"object\":\"chat.completion\",\"created\":1753000000,\"model\":\"mistral-small-latest\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"tool_calls\":null,\"content\":\"lumen ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":3,\"total_tokens\":15}}";

test("a live reply's unmodelled fields do not empty the answer", () => {
  expect(readMistralContent(LIVE) == "lumen ok");
  let r = readMistralResult(200, true, LIVE);
  expect(r.ok);
  expect(r.content == "lumen ok");
});

test("a space after the colon does not empty the answer", () => {
  let spaced = "{\"id\": \"a\", \"choices\": [{\"index\": 0, \"message\": {\"role\": \"assistant\", \"content\": \"lumen ok\"}, \"finish_reason\": \"stop\"}], \"usage\": {\"total_tokens\": 15}}";
  expect(readMistralContent(spaced) == "lumen ok");
});

test("the answer is choices[0].message.content, not the first content anywhere", () => {
  let echoed = "{\"id\":\"a\",\"request\":{\"messages\":[{\"role\":\"user\",\"content\":\"what is 2+2\"}]},\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"4\"},\"finish_reason\":\"stop\"}]}";
  expect(readMistralContent(echoed) == "4");
});

test("a second choice does not answer for the first", () => {
  let two = "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"first\"}},{\"index\":1,\"message\":{\"role\":\"assistant\",\"content\":\"second\"}}]}";
  expect(readMistralContent(two) == "first");
});

test("unicode escapes are decoded", () => {
  let body = "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"caf\\u00e9 \\ud83d\\ude00\"}}]}";
  expect(readMistralContent(body) == "café 😀");
});

test("an HTML-escaping gateway's output reads back as written", () => {
  let body = "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"a \\u003c b \\u0026\\u0026 c\"}}]}";
  expect(readMistralContent(body) == "a < b && c");
});

test("a null content is not the text null", () => {
  let body = "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":null}}]}";
  expect(readMistralContent(body) == "");
});

test("token usage survives the live body", () => {
  let u = readMistralTokenUsage(LIVE);
  expect(u.prompt_tokens == 12);
  expect(u.completion_tokens == 3);
  expect(u.total_tokens == 15);
});

test("a refused connection names the provider, the URL and the reason", () => {
  let r = mistralCallResult("https://api.mistral.ai/v1/chat/completions", -1, false, "");
  expect(!r.ok);
  expect(r.status == -1);
  expect(r.content == "");
  expect(r.raw.includes("mistral"));
  expect(r.raw.includes("https://api.mistral.ai/v1/chat/completions"));
  expect(r.raw.includes("no response"));
});

test("an HTTP error carries the provider's own words", () => {
  let body = "{\"object\":\"error\",\"message\":\"Unauthorized\",\"type\":\"invalid_request_error\",\"code\":401}";
  let r = mistralCallResult("https://api.mistral.ai/v1/chat/completions", 401, false, body);
  expect(!r.ok);
  expect(r.raw.includes("Unauthorized"));
  expect(r.raw.includes("401"));
});

test("the error reader keeps working on its own", () => {
  let err = readMistralError(422, "{\"detail\":[{\"msg\":\"field required\"}],\"message\":\"bad request\"}");
  expect(err.provider == "mistral");
  expect(err.status == 422);
});
