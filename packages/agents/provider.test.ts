// Provider selection and refusals, without touching the network.
//
// Every path that decides *not* to call is tested here; the call itself is
// exercised by examples/call-model.ts against a live provider, because a test
// that needs a credential is a test that gets skipped.
//
//   cd packages/agents && lumen test provider.test.ts

import { ModelRow, ModelConfigRow } from "./schema.ts";
import { Completion, Turn, ToolSpec, complete, streamTurns, userTurn, chatEndpoint, chatEndpointFor, toolCallsFrom, stopReasonOf, truncationProblem, streamProblem, streamDetail } from "./provider.ts";

function model(provider: string, apiName: string, enabled: bool): ModelRow {
  let m: ModelRow = { id: "m", label: "L", apiName: apiName, provider: provider, kind: "chat", dimensions: 0, baseUrl: "", enabled: enabled };
  return m;
}

function gateway(provider: string, baseUrl: string): ModelRow {
  let m: ModelRow = { id: "m", label: "L", apiName: "x", provider: provider, kind: "chat", dimensions: 0, baseUrl: baseUrl, enabled: true };
  return m;
}

function config(): ModelConfigRow {
  let c: ModelConfigRow = { id: "c", modelId: "m", temperature: 0.2, maxTokens: 64, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  return c;
}

test("each provider has its own endpoint", () => {
  expect(chatEndpoint("mistral") == "https://api.mistral.ai/v1/chat/completions");
  expect(chatEndpoint("anthropic") == "https://api.anthropic.com/v1/messages");
  expect(chatEndpoint("openai") == "https://api.openai.com/v1/chat/completions");
});

test("an unknown provider is refused rather than guessed at", () => {
  expect(chatEndpoint("nobody") == "");
  let r = complete(model("nobody", "x", true), config(), "", "hi", "k");
  expect(!r.ok);
  expect(r.error.indexOf("no endpoint") >= 0);
  expect(r.error.indexOf("nobody") >= 0);
});

test("a disabled model is not called", () => {
  let r = complete(model("mistral", "mistral-small-latest", false), config(), "", "hi", "k");
  expect(!r.ok);
  expect(r.error.indexOf("disabled") >= 0);
});

// The streamed door is a second door onto the same row, and every non-anthropic
// run goes through it — a refusal the buffered path makes and this one does not
// is a switched-off model that still gets called.
test("a disabled model is not called on the streamed path either", () => {
  let turns: Turn[] = [userTurn("hi")];
  let none: ToolSpec[] = [];
  let r = streamTurns(model("mistral", "mistral-small-latest", false), config(), "", turns, none, "k", (soFar: string) => {});
  expect(!r.ok);
  expect(r.error.indexOf("disabled") >= 0);
});

test("no key means no request, not a failed one", () => {
  let r = complete(model("mistral", "mistral-small-latest", true), config(), "", "hi", "");
  expect(!r.ok);
  expect(r.status == 0);
  expect(r.error.indexOf("no API key") >= 0);
  expect(r.error.indexOf("mistral") >= 0);
});

// --- where a model behind a gateway is actually called ---------------------------

test("an anthropic model behind a gateway is called at /messages", () => {
  // The wire format belongs to the provider, not to the gateway. An anthropic
  // row with a baseUrl was asked for chat/completions, so every call 404d and
  // only the empty-baseUrl path ever worked.
  expect(chatEndpointFor(gateway("anthropic", "https://gw.example/v1")) == "https://gw.example/v1/messages");
  expect(chatEndpointFor(gateway("openai", "https://gw.example/v1")) == "https://gw.example/v1/chat/completions");
  expect(chatEndpointFor(gateway("mistral", "https://gw.example/v1/")) == "https://gw.example/v1/chat/completions");
  // A row that already names the whole path keeps it.
  expect(chatEndpointFor(gateway("anthropic", "https://gw.example/v1/messages")) == "https://gw.example/v1/messages");
});

test("without a base url every provider keeps its own address", () => {
  expect(chatEndpointFor(model("anthropic", "x", true)) == "https://api.anthropic.com/v1/messages");
  expect(chatEndpointFor(model("openai", "x", true)) == "https://api.openai.com/v1/chat/completions");
  expect(chatEndpointFor(model("mistral", "x", true)) == "https://api.mistral.ai/v1/chat/completions");
  expect(chatEndpointFor(model("nobody", "x", true)) == "");
});

// --- a reply the model did not finish writing -------------------------------------

test("a reply that stopped on length is a truncated reply", () => {
  // A reply cut mid-tool-call loses that call to jsonComplete and arrives with
  // none, which reads exactly like a model that has finished. The reason is
  // the only thing that says otherwise — and it catches a reply cut mid-text
  // too, which nothing else does.
  let openai = "{\"choices\":[{\"finish_reason\":\"length\",\"message\":{\"content\":null}}]}";
  expect(truncationProblem("openai", openai, 512) != "");
  let mistral = "{\"choices\":[{\"finish_reason\":\"model_length\",\"message\":{\"content\":\"\"}}]}";
  expect(truncationProblem("mistral", mistral, 512) != "");
  let anthropic = "{\"stop_reason\":\"max_tokens\",\"content\":[{\"type\":\"text\",\"text\":\"half a sen\"}]}";
  expect(truncationProblem("anthropic", anthropic, 512) != "");
  // And it says what to change, with the number to change.
  expect(truncationProblem("openai", openai, 512).indexOf("512") >= 0);
});

test("a reply that finished is not called truncated", () => {
  expect(truncationProblem("openai", "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"42\"}}]}", 512) == "");
  expect(truncationProblem("mistral", "{\"choices\":[{\"finish_reason\":\"tool_calls\"}]}", 512) == "");
  expect(truncationProblem("anthropic", "{\"stop_reason\":\"end_turn\"}", 512) == "");
  expect(truncationProblem("anthropic", "{\"stop_reason\":\"tool_use\"}", 512) == "");
  // A provider that said nothing is not accused of anything.
  expect(truncationProblem("openai", "{\"choices\":[{\"message\":{\"content\":\"42\"}}]}", 512) == "");
});

test("each provider's own word for stopping is read, not the other's", () => {
  expect(stopReasonOf("openai", "{\"choices\":[{\"finish_reason\":\"length\"}]}") == "length");
  expect(stopReasonOf("anthropic", "{\"stop_reason\":\"max_tokens\"}") == "max_tokens");
  // The other provider's key is not this one's, or a finished reply would be
  // reported as cut off.
  expect(stopReasonOf("anthropic", "{\"choices\":[{\"finish_reason\":\"length\"}]}") == "");
  expect(stopReasonOf("openai", "{\"stop_reason\":\"max_tokens\"}") == "");
});

// --- what an anthropic block is allowed to become a call ------------------------

test("an anthropic input that is not an object is not dispatched", () => {
  // The OpenAI branch checks its arguments before it makes a call out of them
  // and this one never did: whatever sat in `input` went into the stored call
  // and back out to the provider, which refuses a tool_use whose input is not
  // an object — and every later message in that conversation with it.
  let reply = "{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"write_artifact\","
    + "\"input\":\"{\\\"path\\\":\\\"/a.css\\\"\"}]}";
  expect(toolCallsFrom("anthropic", reply).length == 0);
});

test("an anthropic call that takes no input at all is still a call", () => {
  // No `input` member is a tool with no arguments, which is not the same as an
  // input that arrived unreadable.
  let reply = "{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"now\"}]}";
  let calls = toolCallsFrom("anthropic", reply);
  expect(calls.length == 1);
  expect(calls[0].args == "{}");
});

test("a refusal tells the reader what to do and leaks nothing about the deployment", () => {
  let m: ModelRow = { id: "m1", label: "Qwen local", apiName: "qwen2.5-7b", provider: "vllm",
    kind: "chat", dimensions: 0, baseUrl: "http://10.0.0.9:8000/v1", enabled: true };

  // The model's LABEL, because that is what a person picked from the menu —
  // and NOT the address, the model id or the provider's own words. A chat
  // bubble gets screenshot and pasted; an internal hostname in one is a leak
  // with a plausible excuse.
  let dead = streamProblem(m, -1, "");
  expect(dead.indexOf("Qwen local") >= 0);
  expect(dead.indexOf("10.0.0.9") < 0);
  expect(dead.indexOf("qwen2.5-7b") < 0);

  let long = streamProblem(m, 400, "context length exceeded");
  expect(long.indexOf("longer than the model can hold") >= 0);
  expect(long.indexOf("context length exceeded") < 0);

  // A misconfiguration is named as one, without saying which knob — the
  // person reading cannot turn it anyway.
  let auth = streamProblem(m, 401, "");
  expect(auth.indexOf("not configured correctly") >= 0);
  expect(auth.indexOf("vllm") < 0);

  let theirs = streamProblem(m, 503, "");
  expect(theirs.indexOf("its own side") >= 0);

  // Everything withheld above is in the log line instead, where the operator
  // is the reader.
  let detail = streamDetail(m, 404, "no such model");
  expect(detail.indexOf("10.0.0.9") >= 0);
  expect(detail.indexOf("qwen2.5-7b") >= 0);
  expect(detail.indexOf("no such model") >= 0);
});

test("a refusal never carries the key", () => {
  // Whatever goes wrong, the credential must not reach a log.
  let secret = "sk-should-never-appear";
  let disabled = complete(model("mistral", "x", false), config(), "", "hi", secret);
  expect(disabled.error.indexOf(secret) < 0);
  expect(disabled.text.indexOf(secret) < 0);
  let unknown = complete(model("nobody", "x", true), config(), "", "hi", secret);
  expect(unknown.error.indexOf(secret) < 0);
  expect(unknown.text.indexOf(secret) < 0);
});
