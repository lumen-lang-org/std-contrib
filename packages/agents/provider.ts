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

// Where a provider's embedding endpoint lives. Empty when this does not know
// of one, which is not the same as the provider having none.
export function embeddingEndpoint(provider: string): string {
  if (provider == "mistral") { return "https://api.mistral.ai/v1/embeddings"; }
  if (provider == "openai") { return "https://api.openai.com/v1/embeddings"; }
  return "";
}

export type Embedding = {
  ok: bool,
  // The vector in pgvector's own literal form, "[0.1,-0.2,...]", so it can be
  // bound straight into a statement without a second conversion.
  vector: string,
  dimensions: int,
  error: string,
};

// One embedding. The model is named by its row like any other, so which model
// embeds is a column and changing it does not touch this file.
export function embedText(model: ModelRow, text: string, apiKey: string): Embedding {
  let endpoint = embeddingEndpoint(model.provider);
  if (endpoint == "") {
    let unknown: Embedding = { ok: false, vector: "", dimensions: 0, error: "no embedding endpoint for \"" + model.provider + "\"" };
    return unknown;
  }
  if (!model.enabled) {
    let off: Embedding = { ok: false, vector: "", dimensions: 0, error: model.label + " is disabled" };
    return off;
  }
  if (apiKey == "") {
    let keyless: Embedding = { ok: false, vector: "", dimensions: 0, error: "no API key for " + model.provider };
    return keyless;
  }

  let body = "{\"model\":" + JSON.stringify(model.apiName) + ",\"input\":[" + JSON.stringify(text) + "]}";
  let res = http.request(endpoint, "POST", body, authHeaders(model.provider, apiKey));
  if (!res.ok) {
    let dead: Embedding = { ok: false, vector: "", dimensions: 0, error: "no answer from " + endpoint };
    return dead;
  }
  if (res.status != 200) {
    let refused: Embedding = { ok: false, vector: "", dimensions: 0, error: "HTTP " + `${res.status}` + " " + res.body.substring(0, 120) };
    return refused;
  }
  return vectorFrom(res.body);
}

// The first `"embedding":[...]` array, as a pgvector literal.
//
// Read by scanning rather than with JSON.parse: the reply carries usage
// counts and provider-specific keys that a strict parse would refuse, and the
// numbers are wanted verbatim — reformatting them through a float would change
// the values that get stored.
export function vectorFrom(body: string): Embedding {
  let at = body.indexOf("\"embedding\"");
  if (at < 0) {
    let missing: Embedding = { ok: false, vector: "", dimensions: 0, error: "no embedding in the reply" };
    return missing;
  }
  let rest = body.substring(at, body.length);
  let open = rest.indexOf("[");
  let close = rest.indexOf("]");
  if (open < 0 || close < 0 || close < open) {
    let malformed: Embedding = { ok: false, vector: "", dimensions: 0, error: "the embedding is not an array" };
    return malformed;
  }
  let literal = rest.substring(open, close + 1);
  // One more comma than numbers, unless the array is empty.
  let commas: int = 0;
  let i: int = 0;
  while (i < literal.length) {
    if (literal.substring(i, i + 1) == ",") { commas = commas + 1; }
    i = i + 1;
  }
  let dims = commas + 1;
  if (literal == "[]") { dims = 0; }
  let out: Embedding = { ok: dims > 0, vector: literal, dimensions: dims, error: "" };
  if (dims == 0) { out = { ok: false, vector: "", dimensions: 0, error: "the embedding is empty" }; }
  return out;
}

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

// The assistant's text out of a provider's reply.
//
// Scanned rather than parsed: the reply carries usage counts, tool-call slots
// and provider-specific keys, and a strict parse would refuse the lot. The
// shapes differ — `choices[0].message.content` for Mistral and OpenAI,
// `content[0].text` for Anthropic — so the provider decides which key to look
// for, and an unknown one gets the whole body rather than a guess.
export function replyText(provider: string, body: string): string {
  let key = "content";
  if (provider == "anthropic") { key = "text"; }
  let marker = "\"" + key + "\"";
  let rest = body;
  while (true) {
    let at = rest.indexOf(marker);
    if (at < 0) { return body; }
    rest = rest.substring(at + marker.length, rest.length);
    let after = rest.trimStart();
    if (!after.startsWith(":")) { continue; }
    let value = after.substring(1, after.length).trimStart();
    if (!value.startsWith("\"")) { continue; }
    value = value.substring(1, value.length);
    // Stop at the first unescaped quote.
    let out = "";
    let i: int = 0;
    while (i < value.length) {
      let ch = value.substring(i, i + 1);
      if (ch == "\\" && i + 1 < value.length) {
        let next = value.substring(i + 1, i + 2);
        if (next == "n") { out = out + "\n"; } else if (next == "t") { out = out + "\t"; } else { out = out + next; }
        i = i + 2;
        continue;
      }
      if (ch == "\"") { return out; }
      out = out + ch;
      i = i + 1;
    }
    return out;
  }
  return body;
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
