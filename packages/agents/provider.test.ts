// Provider selection and refusals, without touching the network.
//
// Every path that decides *not* to call is tested here; the call itself is
// exercised by examples/call-model.ts against a live provider, because a test
// that needs a credential is a test that gets skipped.
//
//   cd packages/agents && lumen test provider.test.ts

import { ModelRow, ModelConfigRow } from "./schema.ts";
import { Completion, complete, chatEndpoint } from "./provider.ts";

function model(provider: string, apiName: string, enabled: bool): ModelRow {
  let m: ModelRow = { id: "m", label: "L", apiName: apiName, provider: provider, kind: "chat", dimensions: 0, enabled: enabled };
  return m;
}

function config(): ModelConfigRow {
  let c: ModelConfigRow = { id: "c", modelId: "m", temperature: 0.2, maxTokens: 64, topP: 1.0, extra: "{}" };
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

test("no key means no request, not a failed one", () => {
  let r = complete(model("mistral", "mistral-small-latest", true), config(), "", "hi", "");
  expect(!r.ok);
  expect(r.status == 0);
  expect(r.error.indexOf("no API key") >= 0);
  expect(r.error.indexOf("mistral") >= 0);
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
