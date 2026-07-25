// Calling a model whose name came out of the database.
//
// The provider, the wire name and the knobs are all rows, so pointing an agent
// at a different model — or a different provider — is an UPDATE. This file
// names no model.

import { ModelRow, ModelConfigRow } from "./schema.ts";
import { JsonText, jsonRaw, jsonText, jsonList, jsonStringMember } from "./scan.ts";

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

// --- what the model is told it can call ---------------------------------------

// A tool, as the model needs it described. `schema` is JSON Schema as text,
// because it belongs to whoever wrote the tool.
export type ToolSpec = {
  name: string,
  description: string,
  schema: string,
};

export function toolSpec(name: string, description: string, schema: string): ToolSpec {
  let s: ToolSpec = { name: name, description: description, schema: schema };
  return s;
}

// The tool list in a provider's own shape. Two shapes, not one abstraction:
// OpenAI and Mistral wrap each tool in a `function` object, Anthropic does not,
// and pretending otherwise would cost more than the two branches.
export function toolsJson(provider: string, tools: ToolSpec[]): string {
  if (tools.length == 0) { return ""; }
  let out = "[";
  let i: int = 0;
  while (i < tools.length) {
    if (i > 0) { out = out + ","; }
    let schema = tools[i].schema;
    if (schema == "") { schema = "{\"type\":\"object\",\"properties\":{}}"; }
    if (provider == "anthropic") {
      out = out + "{\"name\":" + JSON.stringify(tools[i].name)
        + ",\"description\":" + JSON.stringify(tools[i].description)
        + ",\"input_schema\":" + schema + "}";
    } else {
      out = out + "{\"type\":\"function\",\"function\":{\"name\":" + JSON.stringify(tools[i].name)
        + ",\"description\":" + JSON.stringify(tools[i].description)
        + ",\"parameters\":" + schema + "}}";
    }
    i = i + 1;
  }
  return out + "]";
}

// --- the model's context, which is not the conversation -----------------------

// One thing the model is shown. A run's context holds every one of these; the
// conversation a user reads holds only the text of some of them. They are
// deliberately different types, because they are different things: a tool call,
// its result, and a retrieved passage all belong in the context and none of
// them belongs in a transcript.

export type ToolCall = {
  // The provider's id for this call. A tool result has to name the call it
  // answers, and within one request the ids must agree.
  id: string,
  name: string,
  // The arguments as a JSON object in text, the tool's own shape.
  args: string,
};

export type Turn = {
  // "user", "assistant" or "tool".
  role: string,
  text: string,
  // What an assistant turn asked to call; empty for the others.
  calls: ToolCall[],
  // Which call a tool turn answers, and which tool ran.
  callId: string,
  toolName: string,
};

export function toolCall(id: string, name: string, args: string): ToolCall {
  let c: ToolCall = { id: id, name: name, args: args };
  return c;
}

export function userTurn(text: string): Turn {
  let none: ToolCall[] = [];
  let t: Turn = { role: "user", text: text, calls: none, callId: "", toolName: "" };
  return t;
}

export function assistantTurn(text: string, calls: ToolCall[]): Turn {
  let t: Turn = { role: "assistant", text: text, calls: calls, callId: "", toolName: "" };
  return t;
}

export function toolTurn(callId: string, toolName: string, text: string): Turn {
  let none: ToolCall[] = [];
  let t: Turn = { role: "tool", text: text, calls: none, callId: callId, toolName: toolName };
  return t;
}

// One assistant turn in OpenAI's and Mistral's shape. `content` is null rather
// than absent when the turn is only calls, which is what they send back and
// what they expect to be given.
function openAiAssistant(turn: Turn): string {
  let out = "{\"role\":\"assistant\",\"content\":";
  if (turn.text == "") { out = out + "null"; } else { out = out + JSON.stringify(turn.text); }
  if (turn.calls.length == 0) { return out + "}"; }
  out = out + ",\"tool_calls\":[";
  let i: int = 0;
  while (i < turn.calls.length) {
    if (i > 0) { out = out + ","; }
    // `arguments` is a *string* holding JSON, not an object. Both of these
    // providers send it that way and reject it sent any other way.
    out = out + "{\"id\":" + JSON.stringify(turn.calls[i].id)
      + ",\"type\":\"function\",\"function\":{\"name\":" + JSON.stringify(turn.calls[i].name)
      + ",\"arguments\":" + JSON.stringify(turn.calls[i].args) + "}}";
    i = i + 1;
  }
  return out + "]}";
}

// The same turn in Anthropic's shape: content is a list of blocks, and a call
// is a block beside the text rather than a field next to it.
function anthropicAssistant(turn: Turn): string {
  let out = "{\"role\":\"assistant\",\"content\":[";
  let written: int = 0;
  if (turn.text != "") {
    out = out + "{\"type\":\"text\",\"text\":" + JSON.stringify(turn.text) + "}";
    written = written + 1;
  }
  let i: int = 0;
  while (i < turn.calls.length) {
    if (written > 0) { out = out + ","; }
    let input = turn.calls[i].args;
    if (input == "") { input = "{}"; }
    out = out + "{\"type\":\"tool_use\",\"id\":" + JSON.stringify(turn.calls[i].id)
      + ",\"name\":" + JSON.stringify(turn.calls[i].name)
      + ",\"input\":" + input + "}";
    written = written + 1;
    i = i + 1;
  }
  return out + "]}";
}

// The context as a provider's `messages` array.
//
// Anthropic needs every tool result for one assistant turn inside a single
// user message, so consecutive tool turns are merged; OpenAI and Mistral want
// one message each. That is the whole of the difference between them here.
export function messagesJson(provider: string, systemPrompt: string, turns: Turn[]): string {
  let out = "[";
  let written: int = 0;
  if (provider != "anthropic" && systemPrompt != "") {
    out = out + "{\"role\":\"system\",\"content\":" + JSON.stringify(systemPrompt) + "}";
    written = written + 1;
  }

  let i: int = 0;
  while (i < turns.length) {
    let turn = turns[i];
    if (written > 0) { out = out + ","; }

    if (turn.role == "assistant") {
      if (provider == "anthropic") { out = out + anthropicAssistant(turn); }
      else { out = out + openAiAssistant(turn); }
      written = written + 1;
      i = i + 1;
      continue;
    }

    if (turn.role == "tool") {
      if (provider == "anthropic") {
        out = out + "{\"role\":\"user\",\"content\":[";
        let first: bool = true;
        while (i < turns.length && turns[i].role == "tool") {
          if (!first) { out = out + ","; }
          out = out + "{\"type\":\"tool_result\",\"tool_use_id\":" + JSON.stringify(turns[i].callId)
            + ",\"content\":" + JSON.stringify(turns[i].text) + "}";
          first = false;
          i = i + 1;
        }
        out = out + "]}";
        written = written + 1;
        continue;
      }
      out = out + "{\"role\":\"tool\",\"tool_call_id\":" + JSON.stringify(turn.callId)
        + ",\"name\":" + JSON.stringify(turn.toolName)
        + ",\"content\":" + JSON.stringify(turn.text) + "}";
      written = written + 1;
      i = i + 1;
      continue;
    }

    out = out + "{\"role\":\"user\",\"content\":" + JSON.stringify(turn.text) + "}";
    written = written + 1;
    i = i + 1;
  }
  return out + "]";
}

function requestBody(model: ModelRow, config: ModelConfigRow, systemPrompt: string, turns: Turn[], tools: ToolSpec[]): string {
  let body = "{\"model\":" + JSON.stringify(model.apiName)
    + ",\"messages\":" + messagesJson(model.provider, systemPrompt, turns)
    + ",\"max_tokens\":" + `${config.maxTokens}`
    + ",\"temperature\":" + `${config.temperature}`;
  if (model.provider == "anthropic" && systemPrompt != "") {
    body = body + ",\"system\":" + JSON.stringify(systemPrompt);
  }
  let declared = toolsJson(model.provider, tools);
  if (declared != "") { body = body + ",\"tools\":" + declared; }
  return body + "}";
}

// --- what came back -----------------------------------------------------------

// The calls a reply asked for, in order. None is the ordinary case: it is how
// a model says it has finished.
export function toolCallsFrom(provider: string, body: string): ToolCall[] {
  let out: ToolCall[] = [];

  if (provider == "anthropic") {
    let blocks = jsonList(jsonRaw(body, "content"));
    let b: int = 0;
    while (b < blocks.length) {
      if (jsonText(blocks[b], "type") == "tool_use") {
        let input = jsonRaw(blocks[b], "input");
        if (input == "") { input = "{}"; }
        out.push(toolCall(jsonText(blocks[b], "id"), jsonText(blocks[b], "name"), input));
      }
      b = b + 1;
    }
    return out;
  }

  let calls = jsonList(jsonRaw(body, "tool_calls"));
  let i: int = 0;
  while (i < calls.length) {
    let fn = jsonRaw(calls[i], "function");
    if (fn != "") {
      // `arguments` is documented as a JSON string, and arrives as an object
      // often enough that reading it either way is cheaper than deciding which
      // providers can be trusted about it.
      let raw = jsonRaw(fn, "arguments");
      let args = raw;
      if (raw.startsWith("\"")) { args = jsonText(fn, "arguments"); }
      if (args == "") { args = "{}"; }
      out.push(toolCall(jsonText(calls[i], "id"), jsonText(fn, "name"), args));
    }
    i = i + 1;
  }
  return out;
}

// Whether a reply carries any assistant text at all, and what it is.
//
// Separate from `replyText` because a turn that is only tool calls has no
// text, and "" and "there is none" are different things to a caller deciding
// what to record.
export function assistantText(provider: string, body: string): JsonText {
  if (provider == "anthropic") {
    let blocks = jsonList(jsonRaw(body, "content"));
    let i: int = 0;
    while (i < blocks.length) {
      if (jsonText(blocks[i], "type") == "text") {
        let found: JsonText = { found: true, text: jsonText(blocks[i], "text") };
        return found;
      }
      i = i + 1;
    }
    // A reply in some other shape still gets read the old way rather than
    // reported as textless.
    return jsonStringMember(body, "text");
  }
  return jsonStringMember(body, "content");
}

// The assistant's text out of a provider's reply.
//
// Scanned rather than parsed: the reply carries usage counts, tool-call slots
// and provider-specific keys, and a strict parse would refuse the lot. The
// shapes differ — `choices[0].message.content` for Mistral and OpenAI,
// `content[0].text` for Anthropic — so the provider decides which key to look
// for, and an unknown one gets the whole body rather than a guess.
export function replyText(provider: string, body: string): string {
  let found = assistantText(provider, body);
  if (!found.found) { return body; }
  return found.text;
}

// One completion. Every value comes from the rows passed in; the key comes
// from the environment, because a credential is the one thing that does not
// belong in the database.
export function complete(model: ModelRow, config: ModelConfigRow, systemPrompt: string, userText: string, apiKey: string): Completion {
  let turns: Turn[] = [userTurn(userText)];
  let none: ToolSpec[] = [];
  return completeTurns(model, config, systemPrompt, turns, none, apiKey);
}

// One completion over a whole context, with the tools the model may call.
// `complete` above is this with one turn and no tools.
export function completeTurns(model: ModelRow, config: ModelConfigRow, systemPrompt: string, turns: Turn[], tools: ToolSpec[], apiKey: string): Completion {
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

  let res = http.request(endpoint, "POST", requestBody(model, config, systemPrompt, turns, tools), authHeaders(model.provider, apiKey));
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
