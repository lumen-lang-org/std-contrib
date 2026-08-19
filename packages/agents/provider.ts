import { ModelRow, ModelConfigRow } from "./schema.ts";
import { JsonText, jsonFind, jsonRaw, jsonText, jsonList, jsonStringMember, jsonComplete } from "./scan.ts";
import { vertexBearer } from "./vertex.ts";

export type Completion = {
  ok: bool,
  text: string,
  status: int,
  error: string,
  inputTokens: int,
  outputTokens: int,
  counted: bool,
};

export type Usage = {
  inputTokens: int,
  outputTokens: int,
  counted: bool,
};

export function usageFrom(provider: string, body: string): Usage {
  let none: Usage = { inputTokens: 0, outputTokens: 0, counted: false };
  let usage = jsonRaw(body, "usage");
  if (usage == "") {
    return none;
  }

  let inKey = "prompt_tokens";
  let outKey = "completion_tokens";
  if (provider == "anthropic") {
    inKey = "input_tokens";
    outKey = "output_tokens";
  }

  let inRaw = jsonRaw(usage, inKey);
  let outRaw = jsonRaw(usage, outKey);
  if (inRaw == "" && outRaw == "") {
    return none;
  }

  let out: Usage = {
    inputTokens: parseInt(inRaw) ?? 0,
    outputTokens: parseInt(outRaw) ?? 0,
    counted: true,
  };
  return out;
}

export function embeddingEndpoint(provider: string): string {
  if (provider == "mistral") {
    return "https://api.mistral.ai/v1/embeddings";
  }
  if (provider == "openai") {
    return "https://api.openai.com/v1/embeddings";
  }
  return "";
}

export function endpointFor(model: ModelRow, path: string): string {
  if (model.baseUrl == "") {
    if (path == "embeddings") {
      return embeddingEndpoint(model.provider);
    }
    return chatEndpoint(model.provider);
  }
  let root = model.baseUrl;
  while (root.endsWith("/")) {
    root = root.slice(0, root.length - 1);
  }
  if (root.endsWith("/" + path)) {
    return root;
  }
  return root + "/" + path;
}

export type Embedding = {
  ok: bool,
  vector: string,
  dimensions: int,
  error: string,
};

/** Several vectors from one request.
 *
 *  The wire shape always took a list — `input` is an array and always was —
 *  but every caller sent one string and paid a round trip per chunk. A
 *  document of eight chunks measured 1.8s that way against vLLM and 0.37s
 *  batched, because the server batches internally and the cost was almost all
 *  handshake. `vectors` is in request order, which is what `index` in the
 *  reply says and what every provider here returns. */
export type Embeddings = {
  ok: bool,
  vectors: string[],
  dimensions: int,
  error: string,
};

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


type EmbedInstance = {
  content: string,
};

type EmbedParameters = {
  outputDimensionality: int,
};

type PredictAsk = {
  instances: EmbedInstance[],
  parameters: EmbedParameters,
};

type EmbedAsk = {
  model: string,
  input: string[],
};

/** One request for many chunks.
 *
 *  Vertex is left on the one-at-a-time path: its predict body is a different
 *  shape, and it is not what any deployment here embeds with. */
export function embedTexts(model: ModelRow, texts: string[], apiKey: string): Embeddings {
  if (texts.length == 0) {
    let none: Embeddings = { ok: true, vectors: [], dimensions: model.dimensions, error: "" };
    return none;
  }
  if (model.provider == "vertex") {
    let one: string[] = [];
    let width: int = 0;
    let v: int = 0;
    while (v < texts.length) {
      let got = embedText(model, texts[v], apiKey);
      if (!got.ok) {
        let stopped: Embeddings = { ok: false, vectors: [], dimensions: 0, error: got.error };
        return stopped;
      }
      one.push(got.vector);
      width = got.dimensions;
      v = v + 1;
    }
    let looped: Embeddings = { ok: true, vectors: one, dimensions: width, error: "" };
    return looped;
  }

  let endpoint = endpointFor(model, "embeddings");
  if (endpoint == "") {
    let unknown: Embeddings = { ok: false, vectors: [], dimensions: 0,
      error: "no embedding endpoint for \"" + model.provider + "\"" };
    return unknown;
  }
  if (!model.enabled) {
    let off: Embeddings = { ok: false, vectors: [], dimensions: 0,
      error: model.label + " is disabled" };
    return off;
  }
  if (apiKey == "") {
    let keyless: Embeddings = { ok: false, vectors: [], dimensions: 0,
      error: "no API key for " + model.provider };
    return keyless;
  }
  let carried = wireKey(model.provider, apiKey);
  if (!carried.ok) {
    let unminted: Embeddings = { ok: false, vectors: [], dimensions: 0, error: carried.error };
    return unminted;
  }

  let ask: EmbedAsk = { model: model.apiName, input: texts };
  let res = http.request(endpoint, "POST", JSON.stringify(ask), authHeaders(model.provider, carried.key));
  if (!res.ok) {
    let dead: Embeddings = { ok: false, vectors: [], dimensions: 0,
      error: "no answer from " + endpoint };
    return dead;
  }
  if (res.status != 200) {
    let refused: Embeddings = { ok: false, vectors: [], dimensions: 0,
      error: "HTTP " + `${res.status}` + " " + res.body.substring(0, 120) };
    return refused;
  }
  return vectorsFrom(res.body, texts.length);
}

export function embedText(model: ModelRow, text: string, apiKey: string): Embedding {
  let endpoint = endpointFor(model, "embeddings");
  if (endpoint == "") {
    let unknown: Embedding = {
      ok: false,
      vector: "",
      dimensions: 0,
      error: "no embedding endpoint for \"" + model.provider + "\"",
    };
    return unknown;
  }
  if (!model.enabled) {
    let off: Embedding = {
      ok: false,
      vector: "",
      dimensions: 0,
      error: model.label + " is disabled",
    };
    return off;
  }
  if (apiKey == "") {
    let keyless: Embedding = {
      ok: false,
      vector: "",
      dimensions: 0,
      error: "no API key for " + model.provider,
    };
    return keyless;
  }

  let carried = wireKey(model.provider, apiKey);
  if (!carried.ok) {
    let unminted: Embedding = { ok: false, vector: "", dimensions: 0, error: carried.error };
    return unminted;
  }
  if (model.provider == "vertex") {
    if (!model.baseUrl.endsWith(":predict")) {
      let misaimed: Embedding = { ok: false, vector: "", dimensions: 0,
        error: "a vertex embedding model's base URL is the native predict endpoint — "
          + "https://<region>-aiplatform.googleapis.com/v1/projects/<project>/locations/<region>/publishers/google/models/<model>:predict" };
      return misaimed;
    }
    let instance: EmbedInstance = { content: text };
    let instances: EmbedInstance[] = [instance];
    let parameters: EmbedParameters = { outputDimensionality: model.dimensions };
    let predict: PredictAsk = { instances: instances, parameters: parameters };
    let answered = http.request(model.baseUrl, "POST", JSON.stringify(predict), authHeaders(model.provider, carried.key));
    if (!answered.ok) {
      let dead: Embedding = {
        ok: false,
        vector: "",
        dimensions: 0,
        error: "no answer from " + model.baseUrl,
      };
      return dead;
    }
    if (answered.status != 200) {
      let refused: Embedding = {
        ok: false,
        vector: "",
        dimensions: 0,
        error: "HTTP " + `${answered.status}` + " " + answered.body.substring(0, 120),
      };
      return refused;
    }
    return vertexVectorFrom(answered.body);
  }

  let input: string[] = [text];
  let ask: EmbedAsk = { model: model.apiName, input: input };
  let res = http.request(endpoint, "POST", JSON.stringify(ask), authHeaders(model.provider, carried.key));
  if (!res.ok) {
    let dead: Embedding = {
      ok: false,
      vector: "",
      dimensions: 0,
      error: "no answer from " + endpoint,
    };
    return dead;
  }
  if (res.status != 200) {
    let refused: Embedding = {
      ok: false,
      vector: "",
      dimensions: 0,
      error: "HTTP " + `${res.status}` + " " + res.body.substring(0, 120),
    };
    return refused;
  }
  return vectorFrom(res.body);
}

function vertexVectorFrom(body: string): Embedding {
  let at = body.indexOf("\"values\"");
  if (at < 0) {
    let missing: Embedding = {
      ok: false,
      vector: "",
      dimensions: 0,
      error: "no values in the predict reply",
    };
    return missing;
  }
  let rest = body.substring(at, body.length);
  let open = rest.indexOf("[");
  let close = rest.indexOf("]");
  if (open < 0 || close < 0 || close < open) {
    let malformed: Embedding = {
      ok: false,
      vector: "",
      dimensions: 0,
      error: "the embedding is not an array",
    };
    return malformed;
  }
  let pretty = rest.substring(open, close + 1);
  let literal = "";
  let commas: int = 0;
  let i: int = 0;
  while (i < pretty.length) {
    let c = pretty.charAt(i);
    if (c == ",") {
      commas = commas + 1;
    }
    if (c != " " && c != "\n" && c != "\r" && c != "\t") {
      literal = literal + c;
    }
    i = i + 1;
  }
  let dims = commas + 1;
  if (literal == "[]") {
    dims = 0;
  }
  let out: Embedding = { ok: dims > 0, vector: literal, dimensions: dims, error: "" };
  if (dims == 0) {
    out = { ok: false, vector: "", dimensions: 0, error: "the embedding is empty" };
  }
  return out;
}

/** Every embedding in a reply, in the order they appear.
 *
 *  `vectorFrom` reads the first one and stops; this walks all of them. It
 *  refuses a reply that carries a different number than was asked for rather
 *  than filing chunk 5's vector under chunk 4. */
export function vectorsFrom(body: string, want: int): Embeddings {
  let vectors: string[] = [];
  let dims: int = 0;
  let from: int = 0;
  while (true) {
    let at = body.indexOf("\"embedding\"", from);
    if (at < 0) {
      break;
    }
    let rest = body.substring(at, body.length);
    let open = rest.indexOf("[");
    let close = rest.indexOf("]");
    if (open < 0 || close < 0 || close < open) {
      let malformed: Embeddings = {
        ok: false, vectors: [], dimensions: 0,
        error: "an embedding is not an array",
      };
      return malformed;
    }
    let literal = rest.substring(open, close + 1);
    let commas: int = 0;
    let i: int = 0;
    while (i < literal.length) {
      if (literal.substring(i, i + 1) == ",") {
        commas = commas + 1;
      }
      i = i + 1;
    }
    let width = literal == "[]" ? 0 : commas + 1;
    if (width == 0) {
      let empty: Embeddings = {
        ok: false, vectors: [], dimensions: 0, error: "an embedding is empty",
      };
      return empty;
    }
    if (dims == 0) {
      dims = width;
    }
    if (width != dims) {
      let ragged: Embeddings = {
        ok: false, vectors: [], dimensions: 0,
        error: "the reply mixes " + `${dims}` + " and " + `${width}` + " dimensions",
      };
      return ragged;
    }
    vectors.push(literal);
    // Past this array's closing bracket. `open` and `close` are offsets into
    // `rest`, so only one of them is added to `at`; adding both walks too far
    // and steps over the next vector entirely.
    from = at + close + 1;
  }
  if (vectors.length != want) {
    let miscounted: Embeddings = {
      ok: false, vectors: [], dimensions: 0,
      error: "asked for " + `${want}` + " embeddings and the reply carried " + `${vectors.length}`,
    };
    return miscounted;
  }
  let out: Embeddings = { ok: true, vectors: vectors, dimensions: dims, error: "" };
  return out;
}

export function vectorFrom(body: string): Embedding {
  let at = body.indexOf("\"embedding\"");
  if (at < 0) {
    let missing: Embedding = {
      ok: false,
      vector: "",
      dimensions: 0,
      error: "no embedding in the reply",
    };
    return missing;
  }
  let rest = body.substring(at, body.length);
  let open = rest.indexOf("[");
  let close = rest.indexOf("]");
  if (open < 0 || close < 0 || close < open) {
    let malformed: Embedding = {
      ok: false,
      vector: "",
      dimensions: 0,
      error: "the embedding is not an array",
    };
    return malformed;
  }
  let literal = rest.substring(open, close + 1);
  let commas: int = 0;
  let i: int = 0;
  while (i < literal.length) {
    if (literal.substring(i, i + 1) == ",") {
      commas = commas + 1;
    }
    i = i + 1;
  }
  let dims = commas + 1;
  if (literal == "[]") {
    dims = 0;
  }
  let out: Embedding = { ok: dims > 0, vector: literal, dimensions: dims, error: "" };
  if (dims == 0) {
    out = { ok: false, vector: "", dimensions: 0, error: "the embedding is empty" };
  }
  return out;
}

/* Addresses out of a provider's error text, locally: router.ts has the full
 * version but imports from here, and a cycle is worse than a copy. */
function scrubbedFault(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let at = text.indexOf("://", i);
    if (at < 0) {
      out = out + text.slice(i);
      break;
    }
    let start = at;
    while (start > i && isLetterAt(text, start - 1)) {
      start = start - 1;
    }
    let end = at + 3;
    while (end < text.length) {
      let c = text.charCodeAt(end);
      let keep = c > 32 && c != 34 && c != 39 && c != 44 && c != 41 && c != 93 && c != 125;
      if (!keep) {
        break;
      }
      end = end + 1;
    }
    out = out + text.slice(i, start) + "[address]";
    i = end;
  }
  return out;
}

function isLetterAt(text: string, at: int): bool {
  let c = text.charCodeAt(at);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

export function streamFault(model: ModelRow, status: int, body: string): string {
  let who = model.label == "" ? "This model" : model.label;
  if (status < 100) {
    return who + " is not responding. If it runs on your own machine, check it is"
      + " still up; otherwise pick another model from the menu beside the composer.";
  }
  if (status == 400) {
    // The provider said WHY, and guessing instead of repeating it turned a
    // first-message refusal into advice to shorten the conversation. Their
    // words ride along, addresses stripped, so the person and the log both
    // see the actual reason.
    let said = scrubbedFault(body);
    let cut = said.length > 220 ? said.slice(0, 220) + "…" : said;
    console.log("provider 400 from " + who + ": " + (body.length > 400 ? body.slice(0, 400) : body));
    return who + " would not take this request"
      + (cut.trim() == "" ? "." : ": " + cut);
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

export function streamDetail(model: ModelRow, status: int, body: string): string {
  let cut = body.length > 300 ? body.slice(0, 300) + "…" : body;
  return "provider failure: model=" + model.id + " (" + model.apiName + ")"
    + " provider=" + model.provider + " status=" + `${status}`
    + " endpoint=" + chatEndpointFor(model) + " said=" + cut;
}

export function chatEndpoint(provider: string): string {
  if (provider == "mistral") {
    return "https://api.mistral.ai/v1/chat/completions";
  }
  if (provider == "anthropic") {
    return "https://api.anthropic.com/v1/messages";
  }
  if (provider == "openai") {
    return "https://api.openai.com/v1/chat/completions";
  }
  return "";
}

export function chatPath(provider: string): string {
  if (provider == "anthropic") {
    return "messages";
  }
  return "chat/completions";
}

export function chatEndpointFor(model: ModelRow): string {
  return endpointFor(model, chatPath(model.provider));
}

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

export type ToolSpec = {
  name: string,
  description: string,
  schema: string,
};

export function toolSpec(name: string, description: string, schema: string): ToolSpec {
  let s: ToolSpec = { name: name, description: description, schema: schema };
  return s;
}

export function toolsJson(provider: string, tools: ToolSpec[]): string {
  if (tools.length == 0) {
    return "";
  }
  let out = "[";
  let i: int = 0;
  while (i < tools.length) {
    if (i > 0) {
      out = out + ",";
    }
    let schema = tools[i].schema;
    if (schema == "") {
      schema = "{\"type\":\"object\",\"properties\":{}}";
    }
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

export type ToolCall = {
  id: string,
  name: string,
  args: string,
};

export type Turn = {
  role: string,
  text: string,
  calls: ToolCall[],
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

type FunctionCall = {
  name: string,
  arguments: string,
};

type ToolCallEntry = {
  id: string,
  type: string,
  function: FunctionCall,
};

type ChatMessage = {
  role: string,
  content: string,
};

type ToolMessage = {
  role: string,
  tool_call_id: string,
  name: string,
  content: string,
};

type TextBlock = {
  type: string,
  text: string,
};

type ToolResultBlock = {
  type: string,
  tool_use_id: string,
  content: string,
};

function openAiAssistant(turn: Turn): string {
  let out = "{\"role\":\"assistant\",\"content\":";
  if (turn.text == "") {
    out = out + "null";
  } else {
    out = out + JSON.stringify(turn.text);
  }
  if (turn.calls.length == 0) {
    return out + "}";
  }
  out = out + ",\"tool_calls\":[";
  let i: int = 0;
  while (i < turn.calls.length) {
    if (i > 0) {
      out = out + ",";
    }
    let fn: FunctionCall = { name: turn.calls[i].name, arguments: turn.calls[i].args };
    let entry: ToolCallEntry = { id: turn.calls[i].id, type: "function", function: fn };
    out = out + JSON.stringify(entry);
    i = i + 1;
  }
  return out + "]}";
}

function anthropicAssistant(turn: Turn): string {
  let out = "{\"role\":\"assistant\",\"content\":[";
  let written: int = 0;
  if (turn.text != "") {
    let block: TextBlock = { type: "text", text: turn.text };
    out = out + JSON.stringify(block);
    written = written + 1;
  }
  let i: int = 0;
  while (i < turn.calls.length) {
    if (written > 0) {
      out = out + ",";
    }
    let input = turn.calls[i].args;
    if (input == "") {
      input = "{}";
    }
    out = out + "{\"type\":\"tool_use\",\"id\":" + JSON.stringify(turn.calls[i].id)
      + ",\"name\":" + JSON.stringify(turn.calls[i].name)
      + ",\"input\":" + input + "}";
    written = written + 1;
    i = i + 1;
  }
  return out + "]}";
}

export function messagesJson(provider: string, systemPrompt: string, turns: Turn[]): string {
  let out = "[";
  let written: int = 0;
  if (provider != "anthropic" && systemPrompt != "") {
    let system: ChatMessage = { role: "system", content: systemPrompt };
    out = out + JSON.stringify(system);
    written = written + 1;
  }

  let i: int = 0;
  while (i < turns.length) {
    let turn = turns[i];
    if (written > 0) {
      out = out + ",";
    }

    if (turn.role == "assistant") {
      if (provider == "anthropic") {
        out = out + anthropicAssistant(turn);
      }
      else {
        out = out + openAiAssistant(turn);
      }
      written = written + 1;
      i = i + 1;
      continue;
    }

    if (turn.role == "tool") {
      if (provider == "anthropic") {
        out = out + "{\"role\":\"user\",\"content\":[";
        let first: bool = true;
        while (i < turns.length && turns[i].role == "tool") {
          if (!first) {
            out = out + ",";
          }
          let result: ToolResultBlock = {
            type: "tool_result",
            tool_use_id: turns[i].callId,
            content: turns[i].text,
          };
          out = out + JSON.stringify(result);
          first = false;
          i = i + 1;
        }
        out = out + "]}";
        written = written + 1;
        continue;
      }
      let answered: ToolMessage = {
        role: "tool",
        tool_call_id: turn.callId,
        name: turn.toolName,
        content: turn.text,
      };
      out = out + JSON.stringify(answered);
      written = written + 1;
      i = i + 1;
      continue;
    }

    let spoken: ChatMessage = { role: "user", content: turn.text };
    out = out + JSON.stringify(spoken);
    written = written + 1;
    i = i + 1;
  }
  return out + "]";
}

export function thinkingJson(provider: string, config: ModelConfigRow): string {
  if (config.thinking == "off") {
    if (provider == "vllm" || provider == "ollama") {
      return ",\"chat_template_kwargs\":{\"enable_thinking\":false}";
    }
    /* DeepSeek's hybrid models reason by default and the digest never survives it:
     * every call ran to the full answer budget (9000 out, three feeds, three
     * "did not answer with JSON") because the reasoning consumed the whole cap before
     * a brace was written. Nothing here disabled it - this branch had no deepseek arm,
     * so "off" meant "send nothing". */
    if (provider == "deepseek") {
      return ",\"thinking\":{\"type\":\"disabled\"}";
    }
    if (provider == "vertex") {
      return ",\"reasoning_effort\":\"low\"";
    }
    return "";
  }
  if (config.thinking == "") {
    return "";
  }
  if (provider == "anthropic") {
    let budget = parseInt(config.thinking, 10) ?? 0;
    if (budget <= 0) {
      return "";
    }
    if (budget >= config.maxTokens) {
      budget = config.maxTokens - 1;
    }
    if (budget <= 0) {
      return "";
    }
    return ",\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":" + `${budget}` + "}";
  }
  if (config.thinking == "low" || config.thinking == "medium" || config.thinking == "high") {
    return ",\"reasoning_effort\":" + JSON.stringify(config.thinking);
  }
  return "";
}

function requestBody(model: ModelRow, config: ModelConfigRow, systemPrompt: string, turns: Turn[], tools: ToolSpec[]): string {
  let asked = thinkingJson(model.provider, config);
  let temperature = config.temperature;
  if (asked != "" && model.provider == "anthropic") {
    temperature = 1;
  }
  let body = "{\"model\":" + JSON.stringify(model.apiName)
    + ",\"messages\":" + messagesJson(model.provider, systemPrompt, turns)
    + ",\"max_tokens\":" + `${config.maxTokens}`
    + ",\"temperature\":" + `${temperature}`
    + asked;
  if (model.provider == "anthropic" && systemPrompt != "") {
    body = body + ",\"system\":" + JSON.stringify(systemPrompt);
  }
  let declared = toolsJson(model.provider, tools);
  if (declared != "") {
    body = body + ",\"tools\":" + declared;
  }
  return body + "}";
}

export function stopReasonOf(provider: string, body: string): string {
  if (provider == "anthropic") {
    return jsonText(body, "stop_reason");
  }
  return jsonText(body, "finish_reason");
}

export function wasTruncated(provider: string, body: string): bool {
  let reason = stopReasonOf(provider, body);
  return reason == "length" || reason == "max_tokens" || reason == "model_length";
}

export function truncationFault(provider: string, body: string, maxTokens: int): string {
  let reason = stopReasonOf(provider, body);
  if (!wasTruncated(provider, body)) {
    return "";
  }
  return "the model ran out of room before it finished this Respond (it stopped on \"" + reason
    + "\"), so nothing was kept: ask for less at a time, or raise this model config's max_tokens, currently "
    + `${maxTokens}` + ".";
}

export function toolCallsFrom(provider: string, body: string): ToolCall[] {
  let out: ToolCall[] = [];

  if (provider == "anthropic") {
    let blocks = jsonList(jsonRaw(body, "content"));
    let b: int = 0;
    while (b < blocks.length) {
      if (jsonText(blocks[b], "type") == "tool_use") {
        let input = jsonRaw(blocks[b], "input");
        if (input == "" && jsonFind(blocks[b], "input") < 0) {
          input = "{}";
        }
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
      let raw = jsonRaw(fn, "arguments");
      let args = raw;
      if (raw.startsWith("\"")) {
        args = jsonText(fn, "arguments");
      }
      if (args == "") {
        args = "{}";
      }
      if (jsonComplete(args)) {
        out.push(toolCall(jsonText(calls[i], "id"), jsonText(fn, "name"), args));
      }
    }
    i = i + 1;
  }
  return out;
}

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
    return jsonStringMember(body, "text");
  }
  return jsonStringMember(body, "content");
}

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
  if (reasoned.found && reasoned.text != "") {
    return reasoned.text;
  }
  let plain = jsonStringMember(body, "reasoning");
  if (plain.found) {
    return plain.text;
  }
  let inline = assistantText(provider, body);
  if (inline.found) {
    return inlineThinking(inline.text);
  }
  return "";
}

export function inlineThinking(text: string): string {
  let open = text.indexOf("<think>");
  if (open < 0 || text.slice(0, open).trim() != "") {
    return "";
  }
  let close = text.indexOf("</think>", open);
  if (close < 0) {
    return "";
  }
  return text.slice(open + 7, close).trim();
}

export function withoutInlineThinking(text: string): string {
  let open = text.indexOf("<think>");
  if (open < 0 || text.slice(0, open).trim() != "") {
    return text;
  }
  let close = text.indexOf("</think>", open);
  if (close < 0) {
    return text;
  }
  return text.slice(close + 8).trim();
}

export function replyText(provider: string, body: string): string {
  let found = assistantText(provider, body);
  if (!found.found) {
    return body;
  }
  return withoutInlineThinking(found.text);
}


export type Thinking = (soFar: string, contentSoFar: string) => void;

export type Halt = () => bool;

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

function assembledBody(content: string, reasoning: string, frags: CallFragment[], finish: string): string {
  let calls = "";
  let i: int = 0;
  while (i < frags.length) {
    if (i > 0) {
      calls = calls + ",";
    }
    calls = calls + "{\"id\":" + JSON.stringify(frags[i].id)
      + ",\"type\":\"function\",\"function\":{\"name\":" + JSON.stringify(frags[i].name)
      + ",\"arguments\":" + JSON.stringify(frags[i].args) + "}}";
    i = i + 1;
  }
  let message = "{\"role\":\"assistant\",\"content\":" + JSON.stringify(content)
    + ",\"reasoning_content\":" + JSON.stringify(reasoning);
  if (frags.length > 0) {
    message = message + ",\"tool_calls\":[" + calls + "]";
  }
  return "{\"choices\":[{\"finish_reason\":" + JSON.stringify(finish)
    + ",\"message\":" + message + "}}]}";
}

export function sseData(line: string): string {
  if (!line.startsWith("data:")) {
    return "";
  }
  let rest = line.slice(5, line.length);
  while (rest.startsWith(" ")) {
    rest = rest.slice(1, rest.length);
  }
  return rest;
}

export function streamTurns(model: ModelRow, config: ModelConfigRow, systemPrompt: string, turns: Turn[], tools: ToolSpec[], apiKey: string, onThinking: Thinking, shouldHalt: Halt): Completion {
  let endpoint = chatEndpointFor(model);
  if (endpoint == "") {
    let nowhere: Completion = {
      ok: false,
      text: "",
      status: 0,
      error: "no chat endpoint for \"" + model.provider + "\"",
      inputTokens: 0,
      outputTokens: 0,
      counted: false,
    };
    return nowhere;
  }
  if (!model.enabled) {
    let off: Completion = {
      ok: false,
      text: "",
      status: 0,
      error: model.label + " is disabled",
      inputTokens: 0,
      outputTokens: 0,
      counted: false,
    };
    return off;
  }
  if (apiKey == "") {
    let keyless: Completion = {
      ok: false,
      text: "",
      status: 0,
      error: "no API key for " + model.provider,
      inputTokens: 0,
      outputTokens: 0,
      counted: false,
    };
    return keyless;
  }

  let carried = wireKey(model.provider, apiKey);
  if (!carried.ok) {
    let unminted: Completion = {
      ok: false,
      text: "",
      status: 0,
      error: carried.error,
      inputTokens: 0,
      outputTokens: 0,
      counted: false,
    };
    return unminted;
  }
  let body = requestBody(model, config, systemPrompt, turns, tools);
  let streamed = body.slice(0, body.length - 1)
    + ",\"stream\":true,\"stream_options\":{\"include_usage\":true}}";
  let s = http.stream(endpoint, "POST", streamed, authHeaders(model.provider, carried.key));

  let status = s.status();
  if (status < 200 || status >= 300) {
    let drained = "";
    while (!s.done()) {
      let line = s.readLine();
      if (s.done()) {
        break;
      }
      drained = drained + line;
    }
    s.close();
    console.error(streamDetail(model, status, drained));
    let refused: Completion = {
      ok: false,
      text: drained,
      status: status,
      error: streamFault(model, status, drained),
      inputTokens: 0,
      outputTokens: 0,
      counted: false,
    };
    return refused;
  }

  let content = "";
  let reasoning = "";
  let finish = "";
  let frags: CallFragment[] = [];
  let inTokens: int = 0;
  let outTokens: int = 0;
  let sinceAsked: int = 0;

  while (!s.done()) {
    sinceAsked = sinceAsked + 1;
    if (sinceAsked >= 5) {
      sinceAsked = 0;
      if (shouldHalt()) {
        s.close();
        let halted: Completion = {
          ok: false,
          text: "",
          status: status,
          error: "stopped mid-stream at the caller's request",
          inputTokens: inTokens,
          outputTokens: outTokens,
          counted: false,
        };
        return halted;
      }
    }
    let line = s.readLine();
    if (line == "") {
      if (s.done()) {
        break;
      }
      continue;
    }
    let data = sseData(line);
    if (data == "" || data == "[DONE]") {
      continue;
    }

    let delta = jsonRaw(data, "delta");
    if (delta != "") {
      let piece = jsonText(delta, "content");
      if (piece != "") {
        content = content + piece;
        onThinking(reasoning, content);
      }
      let thought = jsonText(delta, "reasoning_content");
      if (thought == "") {
        thought = jsonText(delta, "reasoning");
      }
      if (thought != "") {
        reasoning = reasoning + thought;
        onThinking(reasoning, content);
      }
      let calls = jsonList(jsonRaw(delta, "tool_calls"));
      let c: int = 0;
      while (c < calls.length) {
        let at = parseInt(jsonRaw(calls[c], "index"), 10) ?? c;
        let fn = jsonRaw(calls[c], "function");
        frags = withFragment(frags, at, jsonText(calls[c], "id"),
          jsonText(fn, "name"), jsonText(fn, "arguments"));
        c = c + 1;
      }
    }
    let reason = jsonText(data, "finish_reason");
    if (reason != "") {
      finish = reason;
    }
    let usage = jsonRaw(data, "usage");
    if (usage != "") {
      inTokens = parseInt(jsonRaw(usage, "prompt_tokens"), 10) ?? inTokens;
      outTokens = parseInt(jsonRaw(usage, "completion_tokens"), 10) ?? outTokens;
    }
  }
  s.close();

  let whole: Completion = {
    ok: true, text: assembledBody(content, reasoning, frags, finish), status: status,
    error: "", inputTokens: inTokens, outputTokens: outTokens, counted: inTokens > 0,
  };
  return whole;
}

export function complete(model: ModelRow, config: ModelConfigRow, systemPrompt: string, userText: string, apiKey: string): Completion {
  let turns: Turn[] = [userTurn(userText)];
  let none: ToolSpec[] = [];
  return completeTurns(model, config, systemPrompt, turns, none, apiKey);
}

export function completeTurns(model: ModelRow, config: ModelConfigRow, systemPrompt: string, turns: Turn[], tools: ToolSpec[], apiKey: string): Completion {
  let endpoint = chatEndpointFor(model);
  if (endpoint == "") {
    let unknown: Completion = {
      ok: false,
      text: "",
      status: 0,
      error: "no endpoint for provider \"" + model.provider + "\"",
      inputTokens: 0,
      outputTokens: 0,
      counted: false,
    };
    return unknown;
  }
  if (!model.enabled) {
    let off: Completion = {
      ok: false,
      text: "",
      status: 0,
      error: model.label + " is disabled",
      inputTokens: 0,
      outputTokens: 0,
      counted: false,
    };
    return off;
  }
  if (apiKey == "") {
    let keyless: Completion = {
      ok: false,
      text: "",
      status: 0,
      error: "no API key for " + model.provider,
      inputTokens: 0,
      outputTokens: 0,
      counted: false,
    };
    return keyless;
  }

  let carried = wireKey(model.provider, apiKey);
  if (!carried.ok) {
    let unminted: Completion = {
      ok: false,
      text: "",
      status: 0,
      error: carried.error,
      inputTokens: 0,
      outputTokens: 0,
      counted: false,
    };
    return unminted;
  }
  let res = http.request(endpoint, "POST", requestBody(model, config, systemPrompt, turns, tools), authHeaders(model.provider, carried.key));
  if (!res.ok) {
    let dead: Completion = {
      ok: false,
      text: "",
      status: 0,
      error: "no answer from " + endpoint,
      inputTokens: 0,
      outputTokens: 0,
      counted: false,
    };
    return dead;
  }
  if (res.status != 200) {
    let refused: Completion = {
      ok: false,
      text: res.body,
      status: res.status,
      error: "HTTP " + `${res.status}`,
      inputTokens: 0,
      outputTokens: 0,
      counted: false,
    };
    return refused;
  }
  let counts = usageFrom(model.provider, res.body);
  let answered: Completion = {
    ok: true, text: res.body, status: 200, error: "",
    inputTokens: counts.inputTokens, outputTokens: counts.outputTokens, counted: counts.counted,
  };
  return answered;
}
