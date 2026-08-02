// Calling a model whose name came out of the database.
//
// The provider, the wire name and the knobs are all rows, so pointing an agent
// at a different model — or a different provider — is an UPDATE. This file
// names no model.

import { ModelRow, ModelConfigRow } from "./schema.ts";
import { JsonText, jsonFind, jsonRaw, jsonText, jsonList, jsonStringMember, jsonComplete } from "./scan.ts";
import { vertexBearer } from "./vertex.ts";

export type Completion = {
  ok: bool,
  text: string,
  status: int,
  error: string,
  // What the provider said this cost. Zero when it did not say — which is not
  // the same as zero tokens, and `counted` is how a caller tells them apart.
  inputTokens: int,
  outputTokens: int,
  counted: bool,
};

// The token counts a reply reports.
//
// Read here because this is the only place that sees the provider's reply. A
// collector can price tokens and chart them; it cannot invent them, and a model
// whose tokenizer it does not know is charted at zero forever.
export type Usage = {
  inputTokens: int,
  outputTokens: int,
  counted: bool,
};

// The counts out of a reply. Two spellings, because the providers disagree:
// OpenAI and Mistral say prompt_tokens and completion_tokens, Anthropic says
// input_tokens and output_tokens.
export function usageFrom(provider: string, body: string): Usage {
  let none: Usage = { inputTokens: 0, outputTokens: 0, counted: false };
  let usage = jsonRaw(body, "usage");
  if (usage == "") { return none; }

  let inKey = "prompt_tokens";
  let outKey = "completion_tokens";
  if (provider == "anthropic") { inKey = "input_tokens"; outKey = "output_tokens"; }

  let inRaw = jsonRaw(usage, inKey);
  let outRaw = jsonRaw(usage, outKey);
  if (inRaw == "" && outRaw == "") { return none; }

  let out: Usage = {
    inputTokens: parseInt(inRaw) ?? 0,
    outputTokens: parseInt(outRaw) ?? 0,
    counted: true,
  };
  return out;
}

// Where a provider's embedding endpoint lives. Empty when this does not know
// of one, which is not the same as the provider having none.
export function embeddingEndpoint(provider: string): string {
  if (provider == "mistral") { return "https://api.mistral.ai/v1/embeddings"; }
  if (provider == "openai") { return "https://api.openai.com/v1/embeddings"; }
  return "";
}

// The address a model row actually calls. A base URL on the row wins: an
// OpenAI-compatible gateway is the same wire format at a different host, so
// it is an override rather than a provider of its own.
//
// The path is appended, because a gateway publishes a root — "/v1" — and not
// the whole endpoint. A row that already names the full path keeps it.
export function endpointFor(model: ModelRow, path: string): string {
  if (model.baseUrl == "") {
    if (path == "embeddings") { return embeddingEndpoint(model.provider); }
    return chatEndpoint(model.provider);
  }
  let root = model.baseUrl;
  while (root.endsWith("/")) { root = root.slice(0, root.length - 1); }
  if (root.endsWith("/" + path)) { return root; }
  return root + "/" + path;
}

export type Embedding = {
  ok: bool,
  // The vector in pgvector's own literal form, "[0.1,-0.2,...]", so it can be
  // bound straight into a statement without a second conversion.
  vector: string,
  dimensions: int,
  error: string,
};

// The key a request actually carries. For every provider but one this is the
// stored credential itself. Vertex is the exception: its stored credential is
// a service-account JSON, and the wire wants an OAuth2 access token minted
// from it — vertex.ts mints and caches those. Empty key answers empty, so the
// callers' own no-key refusals keep firing first.
export type WireKey = {
  ok: bool,
  key: string,
  error: string,
};

export function wireKey(provider: string, apiKey: string): WireKey {
  if (provider != "vertex" || apiKey == "") {
    let plain: WireKey = { ok: true, key: apiKey, error: "" };
    return plain;
  }
  let bearer = vertexBearer(apiKey, Date.now());
  if (!bearer.ok) {
    let refused: WireKey = { ok: false, key: "", error: bearer.error };
    return refused;
  }
  let minted: WireKey = { ok: true, key: bearer.token, error: "" };
  return minted;
}


// One embedding. The model is named by its row like any other, so which model
// embeds is a column and changing it does not touch this file.
export function embedText(model: ModelRow, text: string, apiKey: string): Embedding {
  let endpoint = endpointFor(model, "embeddings");
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

  let carried = wireKey(model.provider, apiKey);
  if (!carried.ok) {
    let unminted: Embedding = { ok: false, vector: "", dimensions: 0, error: carried.error };
    return unminted;
  }
  // Vertex embeds through its native :predict shape, not the OpenAI-compatible
  // one: the compat surface answers chat but 500s on /embeddings (verified
  // against a live project, both with and without the dimensions member).
  // The row's baseUrl names the :predict URL whole, and the reply is asked
  // for the row's own width — Gemini defaults to 3072 and truncates on
  // request (MRL), the vector column was sized by the row, and cosine `<=>`
  // is scale-invariant so the un-normalised truncated vector ranks the same.
  if (model.provider == "vertex") {
    if (!model.baseUrl.endsWith(":predict")) {
      let misaimed: Embedding = { ok: false, vector: "", dimensions: 0,
        error: "a vertex embedding model's base URL is the native predict endpoint — "
          + "https://<region>-aiplatform.googleapis.com/v1/projects/<project>/locations/<region>/publishers/google/models/<model>:predict" };
      return misaimed;
    }
    let ask = "{\"instances\":[{\"content\":" + JSON.stringify(text) + "}]"
      + ",\"parameters\":{\"outputDimensionality\":" + `${model.dimensions}` + "}}";
    let answered = http.request(model.baseUrl, "POST", ask, authHeaders(model.provider, carried.key));
    if (!answered.ok) {
      let dead: Embedding = { ok: false, vector: "", dimensions: 0, error: "no answer from " + model.baseUrl };
      return dead;
    }
    if (answered.status != 200) {
      let refused: Embedding = { ok: false, vector: "", dimensions: 0, error: "HTTP " + `${answered.status}` + " " + answered.body.substring(0, 120) };
      return refused;
    }
    return vertexVectorFrom(answered.body);
  }

  let body = "{\"model\":" + JSON.stringify(model.apiName)
    + ",\"input\":[" + JSON.stringify(text) + "]}";
  let res = http.request(endpoint, "POST", body, authHeaders(model.provider, carried.key));
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

// The vector out of a native :predict reply: predictions[0].embeddings.values.
// Its own scan rather than vectorFrom's, which looks for "embedding" with the
// closing quote — the native reply says "embeddings", and its first array is
// the statistics block, so the anchor here is the "values" member.
function vertexVectorFrom(body: string): Embedding {
  let at = body.indexOf("\"values\"");
  if (at < 0) {
    let missing: Embedding = { ok: false, vector: "", dimensions: 0, error: "no values in the predict reply" };
    return missing;
  }
  let rest = body.substring(at, body.length);
  let open = rest.indexOf("[");
  let close = rest.indexOf("]");
  if (open < 0 || close < 0 || close < open) {
    let malformed: Embedding = { ok: false, vector: "", dimensions: 0, error: "the embedding is not an array" };
    return malformed;
  }
  let pretty = rest.substring(open, close + 1);
  // The predict reply is pretty-printed — newlines and indentation between
  // every number — and the literal becomes a pgvector parameter, whose parser
  // is owed digits and commas, not a transcript of Google's formatter.
  let literal = "";
  let dims: int = 0;
  let i: int = 0;
  while (i < pretty.length) {
    let c = pretty.charAt(i);
    if (c == ",") { dims = dims + 1; }
    if (c != " " && c != "\n" && c != "\r" && c != "\t") { literal = literal + c; }
    i = i + 1;
  }
  if (dims > 0) { dims = dims + 1; }
  let out: Embedding = { ok: dims > 0, vector: literal, dimensions: dims, error: "" };
  if (dims == 0) { out = { ok: false, vector: "", dimensions: 0, error: "the embedding is empty" }; }
  return out;
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
/* Why a call failed, said to the person in the conversation.
 *
 * Two audiences, and this is the wrong place for one of them. A reader of a
 * chat needs to know that the answer did not happen, whether waiting or
 * switching models helps, and nothing else. An operator needs the address,
 * the status and the provider's own words — and those belong in the log,
 * where `streamDetail` sends them, not in a transcript that a person may
 * screenshot, paste or share. An internal hostname in a chat bubble is an
 * infrastructure leak with a plausible excuse.
 *
 * So: no addresses, no model ids, no provider bodies here. The model's LABEL
 * only, because a person picked it from a menu by that name and needs to know
 * which choice failed.
 */
export function streamProblem(model: ModelRow, status: int, body: string): string {
  let who = model.label == "" ? "This model" : model.label;
  // Below 100 is not an HTTP status at all — nothing answered.
  if (status < 100) {
    return who + " is not responding. If it runs on your own machine, check it is"
      + " still up; otherwise pick another model from the menu beside the composer.";
  }
  if (status == 400) {
    return who + " would not take this request. The usual cause is a conversation"
      + " that has grown longer than the model can hold — start a new one, or pick"
      + " a model with more room.";
  }
  if (status == 401 || status == 403) {
    return who + " is not configured correctly: its credential was rejected."
      + " An operator needs to set it up.";
  }
  if (status == 404) {
    return who + " is not configured correctly: the deployment is asking for a model"
      + " that host does not have. An operator needs to correct it.";
  }
  if (status == 429) {
    return who + " is busy right now. Wait a moment and retry, or pick another"
      + " model from the menu beside the composer.";
  }
  if (status >= 500) {
    return who + " failed on its own side — nothing to do with this conversation."
      + " Retry, or pick another model.";
  }
  return who + " could not answer this one. Retry, or pick another model.";
}

/* The same failure for the log: everything the sentence above deliberately
 * withholds. One line, so an operator greps it out of the engine log with the
 * status, the address it used and what the provider actually said. */
export function streamDetail(model: ModelRow, status: int, body: string): string {
  let cut = body.length > 300 ? body.slice(0, 300) + "…" : body;
  return "provider failure: model=" + model.id + " (" + model.apiName + ")"
    + " provider=" + model.provider + " status=" + `${status}`
    + " endpoint=" + chatEndpointFor(model) + " said=" + cut;
}

export function chatEndpoint(provider: string): string {
  if (provider == "mistral") { return "https://api.mistral.ai/v1/chat/completions"; }
  if (provider == "anthropic") { return "https://api.anthropic.com/v1/messages"; }
  if (provider == "openai") { return "https://api.openai.com/v1/chat/completions"; }
  return "";
}

// The path a provider's chat endpoint hangs off a root.
//
// Behind a gateway this is the whole of the address, and the wire format
// belongs to the provider rather than to the gateway: Anthropic speaks
// `/messages` wherever it is hosted. Asking for `chat/completions` regardless —
// which is what the one call site used to hardcode — 404s every Anthropic row
// that has a baseUrl, and only the empty-baseUrl path ever worked.
export function chatPath(provider: string): string {
  if (provider == "anthropic") { return "messages"; }
  return "chat/completions";
}

// The address a model row's completions are actually sent to.
export function chatEndpointFor(model: ModelRow): string {
  return endpointFor(model, chatPath(model.provider));
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

// Asking the model to think, in whatever way its provider spells that.
//
// Nothing happens by default. Anthropic answers with a thinking block only when
// the request enables one and gives it a token budget; OpenAI's reasoning
// models take an effort instead. So the config carries text, and what the text
// means is decided here, per provider, rather than by pretending the two are
// the same knob.
//
// Anthropic also insists on a temperature of exactly 1 while thinking, and on a
// budget below `max_tokens`. Both are enforced here rather than left for the
// provider to refuse: a 400 at the first conversation is a bad way to learn it.
export function thinkingJson(provider: string, config: ModelConfigRow): string {
  if (config.thinking == "") { return ""; }
  if (provider == "anthropic") {
    let budget = parseInt(config.thinking, 10) ?? 0;
    if (budget <= 0) { return ""; }
    if (budget >= config.maxTokens) { budget = config.maxTokens - 1; }
    if (budget <= 0) { return ""; }
    return ",\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":" + `${budget}` + "}";
  }
  // An effort, for the models that take one. A number here is not an effort and
  // is not sent: a provider that receives one answers 400, and a config written
  // for Anthropic should not quietly change what an OpenAI model does.
  if (config.thinking == "low" || config.thinking == "medium" || config.thinking == "high") {
    return ",\"reasoning_effort\":" + JSON.stringify(config.thinking);
  }
  return "";
}

function requestBody(model: ModelRow, config: ModelConfigRow, systemPrompt: string, turns: Turn[], tools: ToolSpec[]): string {
  let asked = thinkingJson(model.provider, config);
  // Anthropic refuses any temperature but 1 while thinking is enabled.
  let temperature = config.temperature;
  if (asked != "" && model.provider == "anthropic") { temperature = 1; }
  let body = "{\"model\":" + JSON.stringify(model.apiName)
    + ",\"messages\":" + messagesJson(model.provider, systemPrompt, turns)
    + ",\"max_tokens\":" + `${config.maxTokens}`
    + ",\"temperature\":" + `${temperature}`
    + asked;
  if (model.provider == "anthropic" && systemPrompt != "") {
    body = body + ",\"system\":" + JSON.stringify(systemPrompt);
  }
  let declared = toolsJson(model.provider, tools);
  if (declared != "") { body = body + ",\"tools\":" + declared; }
  return body + "}";
}

// --- what came back -----------------------------------------------------------

// Why the model stopped writing, in the provider's own word, or "" when it did
// not say.
//
// Two spellings and two homes: OpenAI and Mistral put `finish_reason` on the
// choice, Anthropic puts `stop_reason` on the reply. Each is looked for under
// its own provider only — finding the other's would report a finished reply as
// a cut-off one.
export function stopReasonOf(provider: string, body: string): string {
  if (provider == "anthropic") { return jsonText(body, "stop_reason"); }
  return jsonText(body, "finish_reason");
}

// The sentence to fail a round with when the model ran out of output space, or
// "" when it did not.
//
// This is the only thing that says a reply was cut short. A reply truncated
// mid-tool-call loses that call to `jsonComplete` and arrives with no calls at
// all, which is indistinguishable from a model that has finished — so the
// round stored the provider's raw JSON as the assistant's answer where
// `content` was null, and stored the question with no answer at all where it
// was "". A reply cut mid-*text* nothing noticed in any shape.
//
// Emptiness is not the test, then: the reason is, which `wasTruncated` reads.
// Whether a reply stopped because it hit the output ceiling.
//
// The three spellings live here and only here: `max_tokens` is Anthropic's
// word, `length` OpenAI's and vertex's, `model_length` Mistral's. Separate from
// the sentence below because two callers want the fact and only one wants the
// advice — router.ts has its own thing to say about a routing call that ran out
// of room, and a second copy of this list is a list that drifts.
export function wasTruncated(provider: string, body: string): bool {
  let reason = stopReasonOf(provider, body);
  return reason == "length" || reason == "max_tokens" || reason == "model_length";
}

export function truncationProblem(provider: string, body: string, maxTokens: int): string {
  let reason = stopReasonOf(provider, body);
  if (!wasTruncated(provider, body)) { return ""; }
  return "the model ran out of room before it finished this reply (it stopped on \"" + reason
    + "\"), so nothing was kept: ask for less at a time, or raise this model config's max_tokens, currently "
    + `${maxTokens}` + ".";
}

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
        // No `input` member at all is a tool that takes no arguments. An
        // `input` that is there and reads as nothing is a value jsonValueAt
        // refused to hand back half of — a different thing entirely, and
        // turning it into "{}" is how write_artifact came to be called with
        // an empty path.
        if (input == "" && jsonFind(blocks[b], "input") < 0) { input = "{}"; }
        // The same check the OpenAI branch below makes, and for the same
        // reason: what is stored here is replayed to the provider verbatim,
        // and a tool_use whose input is not one JSON object is refused —
        // along with every later message in that conversation.
        if (jsonComplete(input)) {
          out.push(toolCall(jsonText(blocks[b], "id"), jsonText(blocks[b], "name"), input));
        }
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
      // A call whose arguments do not close is a call the model did not
      // finish writing — it ran out of output space partway through, which
      // happens the moment a model is asked for a file bigger than its
      // maxTokens. Dropping it here keeps the round consistent: the assistant
      // turn announces exactly the calls that will be answered. Keeping it
      // stored a turn whose own JSON could not be parsed back, and every
      // later message in that conversation was refused by the provider.
      if (jsonComplete(args)) {
        out.push(toolCall(jsonText(calls[i], "id"), jsonText(fn, "name"), args));
      }
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

// What the model thought before it answered, when it says so.
//
// Three shapes, because three providers disagree: Anthropic puts a block of
// `type: "thinking"` in `content`, and the OpenAI-compatible ones that expose
// it at all put a `reasoning_content` (Mistral's magistral, DeepSeek) or a
// `reasoning` string on the message. A provider that returns none — most of
// them, most of the time — answers "", which is not a failure and is not
// reported as one.
//
// Never parsed into a record: a reply carries keys nobody declared, and this is
// read out of the same body the answer came from.
export function assistantThinking(provider: string, body: string): string {
  if (provider == "anthropic") {
    let blocks = jsonList(jsonRaw(body, "content"));
    let i: int = 0;
    while (i < blocks.length) {
      if (jsonText(blocks[i], "type") == "thinking") {
        return jsonText(blocks[i], "thinking");
      }
      i = i + 1;
    }
    return "";
  }
  let reasoned = jsonStringMember(body, "reasoning_content");
  if (reasoned.found && reasoned.text != "") { return reasoned.text; }
  let plain = jsonStringMember(body, "reasoning");
  if (plain.found) { return plain.text; }
  return "";
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


// --- streaming ------------------------------------------------------------------------

// A reply, fetched as it is written.
//
// The point is not speed: it is that a rotation's *thinking* is readable while
// the model is still producing it, instead of arriving whole when the rotation
// ends. Everything else about the run is unchanged, and that is deliberate —
// the deltas are reassembled here into exactly the body the buffered path
// returns, so `toolCallsFrom`, `assistantText`, `truncationProblem` and every
// storage rule downstream see what they have always seen. Streaming is how the
// reply is fetched, not a second shape for the rest of the package to learn.
//
// `onThinking` is called with the reasoning accumulated so far, each time it
// grows. It must not throw: a throw does not cross a function value here, so it
// would escape every `try` between this and the handler.
export type Thinking = (soFar: string) => void;

// One tool call, assembled from the fragments a stream delivers. OpenAI sends
// `tool_calls[i]` in pieces — an id on one chunk, a name on the next, the
// arguments a character at a time — keyed only by `index`.
type CallFragment = {
  index: int,
  id: string,
  name: string,
  args: string,
};

function withFragment(frags: CallFragment[], index: int, id: string, name: string, args: string): CallFragment[] {
  let out: CallFragment[] = [];
  let found = false;
  let i: int = 0;
  while (i < frags.length) {
    if (frags[i].index == index) {
      found = true;
      let merged: CallFragment = {
        index: index,
        id: frags[i].id + id,
        name: frags[i].name + name,
        args: frags[i].args + args,
      };
      out.push(merged);
    } else {
      out.push(frags[i]);
    }
    i = i + 1;
  }
  if (!found) {
    let fresh: CallFragment = { index: index, id: id, name: name, args: args };
    out.push(fresh);
  }
  return out;
}

// The assembled reply, in the shape the buffered path produces.
function assembledBody(content: string, reasoning: string, frags: CallFragment[], finish: string): string {
  let calls = "";
  let i: int = 0;
  while (i < frags.length) {
    if (i > 0) { calls = calls + ","; }
    calls = calls + "{\"id\":" + JSON.stringify(frags[i].id)
      + ",\"type\":\"function\",\"function\":{\"name\":" + JSON.stringify(frags[i].name)
      + ",\"arguments\":" + JSON.stringify(frags[i].args) + "}}";
    i = i + 1;
  }
  let message = "{\"role\":\"assistant\",\"content\":" + JSON.stringify(content)
    + ",\"reasoning_content\":" + JSON.stringify(reasoning);
  if (frags.length > 0) { message = message + ",\"tool_calls\":[" + calls + "]"; }
  return "{\"choices\":[{\"finish_reason\":" + JSON.stringify(finish)
    + ",\"message\":" + message + "}}]}";
}

// The text after `data: ` on an SSE line, or "" for anything else — a comment,
// a blank keep-alive, an event name.
export function sseData(line: string): string {
  if (!line.startsWith("data:")) { return ""; }
  let rest = line.slice(5, line.length);
  while (rest.startsWith(" ")) { rest = rest.slice(1, rest.length); }
  return rest;
}

// One completion, streamed. Falls back to nothing: a caller that wants the
// buffered path calls `completeTurns` instead.
export function streamTurns(model: ModelRow, config: ModelConfigRow, systemPrompt: string, turns: Turn[], tools: ToolSpec[], apiKey: string, onThinking: Thinking): Completion {
  let endpoint = chatEndpointFor(model);
  if (endpoint == "") {
    let nowhere: Completion = { ok: false, text: "", status: 0, error: "no chat endpoint for \"" + model.provider + "\"", inputTokens: 0, outputTokens: 0, counted: false };
    return nowhere;
  }
  // The same refusal `completeTurns` makes, because a switched-off row means
  // switched off on every transport — without it, which door a run takes
  // decides whether the model's own enabled column is honoured.
  if (!model.enabled) {
    let off: Completion = { ok: false, text: "", status: 0, error: model.label + " is disabled", inputTokens: 0, outputTokens: 0, counted: false };
    return off;
  }
  if (apiKey == "") {
    let keyless: Completion = { ok: false, text: "", status: 0, error: "no API key for " + model.provider, inputTokens: 0, outputTokens: 0, counted: false };
    return keyless;
  }

  let carried = wireKey(model.provider, apiKey);
  if (!carried.ok) {
    let unminted: Completion = { ok: false, text: "", status: 0, error: carried.error, inputTokens: 0, outputTokens: 0, counted: false };
    return unminted;
  }
  let body = requestBody(model, config, systemPrompt, turns, tools);
  // The one difference from the buffered request: ask for the stream.
  let streamed = body.slice(0, body.length - 1) + ",\"stream\":true}";
  let s = http.stream(endpoint, "POST", streamed, authHeaders(model.provider, carried.key));

  let status = s.status();
  if (status < 200 || status >= 300) {
    let drained = "";
    while (!s.done()) {
      let line = s.readLine();
      if (s.done()) { break; }
      drained = drained + line;
    }
    s.close();
    // The operator's half goes to the log; the person's half goes back as the
    // error. Both derived from the same failure, neither leaking into the
    // other's audience.
    console.error(streamDetail(model, status, drained));
    let refused: Completion = { ok: false, text: drained, status: status, error: streamProblem(model, status, drained), inputTokens: 0, outputTokens: 0, counted: false };
    return refused;
  }

  let content = "";
  let reasoning = "";
  let finish = "";
  let frags: CallFragment[] = [];
  let inTokens: int = 0;
  let outTokens: int = 0;

  while (!s.done()) {
    let line = s.readLine();
    if (s.done()) { break; }
    let data = sseData(line);
    if (data == "" || data == "[DONE]") { continue; }

    let delta = jsonRaw(data, "delta");
    if (delta != "") {
      let piece = jsonText(delta, "content");
      if (piece != "") { content = content + piece; }
      let thought = jsonText(delta, "reasoning_content");
      if (thought == "") { thought = jsonText(delta, "reasoning"); }
      if (thought != "") {
        reasoning = reasoning + thought;
        // Told as it grows, so the console can draw it growing.
        onThinking(reasoning);
      }
      let calls = jsonList(jsonRaw(delta, "tool_calls"));
      let c: int = 0;
      while (c < calls.length) {
        // `jsonRaw`, not `jsonText`: the index is a number, and jsonText reads
        // string members only — it answered "" for every fragment, so each one
        // fell back to its position in *this* event's array, which is always 0
        // when a provider sends one call per event. Three writes merged into a
        // single call whose name was the three names concatenated and whose
        // arguments were three documents spliced together; `jsonComplete` then
        // dropped the lot and the round answered with nothing.
        let at = parseInt(jsonRaw(calls[c], "index"), 10) ?? c;
        let fn = jsonRaw(calls[c], "function");
        frags = withFragment(frags, at, jsonText(calls[c], "id"),
          jsonText(fn, "name"), jsonText(fn, "arguments"));
        c = c + 1;
      }
    }
    let reason = jsonText(data, "finish_reason");
    if (reason != "") { finish = reason; }
    let usage = jsonRaw(data, "usage");
    if (usage != "") {
      inTokens = parseInt(jsonText(usage, "prompt_tokens"), 10) ?? inTokens;
      outTokens = parseInt(jsonText(usage, "completion_tokens"), 10) ?? outTokens;
    }
  }
  s.close();

  let whole: Completion = {
    ok: true, text: assembledBody(content, reasoning, frags, finish), status: status,
    error: "", inputTokens: inTokens, outputTokens: outTokens, counted: inTokens > 0,
  };
  return whole;
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
  let endpoint = chatEndpointFor(model);
  if (endpoint == "") {
    let unknown: Completion = { ok: false, text: "", status: 0, error: "no endpoint for provider \"" + model.provider + "\"", inputTokens: 0, outputTokens: 0, counted: false };
    return unknown;
  }
  if (!model.enabled) {
    let off: Completion = { ok: false, text: "", status: 0, error: model.label + " is disabled", inputTokens: 0, outputTokens: 0, counted: false };
    return off;
  }
  if (apiKey == "") {
    let keyless: Completion = { ok: false, text: "", status: 0, error: "no API key for " + model.provider, inputTokens: 0, outputTokens: 0, counted: false };
    return keyless;
  }

  let carried = wireKey(model.provider, apiKey);
  if (!carried.ok) {
    let unminted: Completion = { ok: false, text: "", status: 0, error: carried.error, inputTokens: 0, outputTokens: 0, counted: false };
    return unminted;
  }
  let res = http.request(endpoint, "POST", requestBody(model, config, systemPrompt, turns, tools), authHeaders(model.provider, carried.key));
  if (!res.ok) {
    let dead: Completion = { ok: false, text: "", status: 0, error: "no answer from " + endpoint, inputTokens: 0, outputTokens: 0, counted: false };
    return dead;
  }
  if (res.status != 200) {
    let refused: Completion = { ok: false, text: res.body, status: res.status, error: "HTTP " + `${res.status}`, inputTokens: 0, outputTokens: 0, counted: false };
    return refused;
  }
  let counts = usageFrom(model.provider, res.body);
  let answered: Completion = {
    ok: true, text: res.body, status: 200, error: "",
    inputTokens: counts.inputTokens, outputTokens: counts.outputTokens, counted: counts.counted,
  };
  return answered;
}
