// Calling a model whose name came out of the database.
//
// The provider, the wire name and the knobs are all rows, so pointing an agent
// at a different model — or a different provider — is an UPDATE. This file
// names no model.

import { ModelRow, ModelConfigRow } from "./schema.ts";

export type Completion = {
  ok: bool,
  text: string,
  status: int,
  error: string,
};

// Where a provider's chat endpoint lives. A column would be better still —
// this is the one thing here that is not a row — but a provider's URL shape is
// closer to code than to configuration, and there are three of them.
export function chatEndpoint(provider: string): string {
  if (provider == "mistral") { return "https://api.mistral.ai/v1/chat/completions"; }
  if (provider == "anthropic") { return "https://api.anthropic.com/v1/messages"; }
  if (provider == "openai") { return "https://api.openai.com/v1/chat/completions"; }
  return "";
}

// Providers disagree about where the key goes and what the body is called, and
// nothing about that is worth abstracting away — it is two `if`s.
function authHeaders(provider: string, apiKey: string): Map<string, string> {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  if (provider == "anthropic") {
    headers.set("x-api-key", apiKey);
    headers.set("anthropic-version", "2023-06-01");
  } else {
    headers.set("authorization", "Bearer " + apiKey);
  }
  return headers;
}

function requestBody(model: ModelRow, config: ModelConfigRow, systemPrompt: string, userText: string): string {
  let messages = "[";
  if (model.provider != "anthropic" && systemPrompt != "") {
    messages = messages + "{\"role\":\"system\",\"content\":" + JSON.stringify(systemPrompt) + "},";
  }
  messages = messages + "{\"role\":\"user\",\"content\":" + JSON.stringify(userText) + "}]";

  let body = "{\"model\":" + JSON.stringify(model.apiName)
    + ",\"messages\":" + messages
    + ",\"max_tokens\":" + `${config.maxTokens}`
    + ",\"temperature\":" + `${config.temperature}`;
  if (model.provider == "anthropic" && systemPrompt != "") {
    body = body + ",\"system\":" + JSON.stringify(systemPrompt);
  }
  return body + "}";
}

// One completion. Every value comes from the rows passed in; the key comes
// from the environment, because a credential is the one thing that does not
// belong in the database.
export function complete(model: ModelRow, config: ModelConfigRow, systemPrompt: string, userText: string, apiKey: string): Completion {
  let endpoint = chatEndpoint(model.provider);
  if (endpoint == "") {
    let unknown: Completion = { ok: false, text: "", status: 0, error: "no endpoint for provider \"" + model.provider + "\"" };
    return unknown;
  }
  if (!model.enabled) {
    let off: Completion = { ok: false, text: "", status: 0, error: model.label + " is disabled" };
    return off;
  }
  if (apiKey == "") {
    let keyless: Completion = { ok: false, text: "", status: 0, error: "no API key for " + model.provider };
    return keyless;
  }

  let res = http.request(endpoint, "POST", requestBody(model, config, systemPrompt, userText), authHeaders(model.provider, apiKey));
  if (!res.ok) {
    let dead: Completion = { ok: false, text: "", status: 0, error: "no answer from " + endpoint };
    return dead;
  }
  if (res.status != 200) {
    let refused: Completion = { ok: false, text: res.body, status: res.status, error: "HTTP " + `${res.status}` };
    return refused;
  }
  let answered: Completion = { ok: true, text: res.body, status: 200, error: "" };
  return answered;
}
