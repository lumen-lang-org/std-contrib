// Provider-native structured output: ask for JSON conforming to a schema and
// get back a validated result rather than free text.
//
// two provider modes:
//   - `{"type":"json_object"}` guarantees the reply PARSES as JSON but not that
//     it has the requested shape (a flat request can come back nested). Fallback
//     only.
//   - `{"type":"json_schema", ..., "strict":true}` constrains the shape. Prefer.
//
// there is no runtime reflection, so a schema is described with explicit fields
// rather than derived from a record type.

import { makeAuthHeaders } from "../providers/openai.ts";
import { makeMistralAuthHeaders } from "../providers/mistral.ts";
import { firstJsonObjectOutput, typedJsonInputOutput, retryPromptOutput } from "./output.ts";

// `type` is a JSON Schema primitive name: "string", "integer", "number",
// "boolean".
export type SchemaField = {
  name: string,
  type: string,
  description: string,
  required: bool,
};

// `json` is the extracted object source on success, "" otherwise.
export type Structured = {
  ok: bool,
  json: string,
  error: string,
};

// serialized via JSON.stringify so a float temperature is formatted the same
// way the other provider modules format it.
type StructuredScalars = {
  model: string,
  temperature: number,
  max_tokens: int,
};

function structOk(json: string): Structured {
  let r: Structured = {
    ok: true,
    json: json,
    error: "",
  };
  return r;
}

function structErr(message: string): Structured {
  let r: Structured = {
    ok: false,
    json: "",
    error: message,
  };
  return r;
}

export function schemaField(name: string, fieldType: string, description: string, required: bool): SchemaField {
  let f: SchemaField = {
    name: name,
    type: fieldType,
    description: description,
    required: required,
  };
  return f;
}

// strict schema mode requires `additionalProperties:false` and an explicit
// `required` list.
export function objectSchema(fields: SchemaField[]): string {
  let props = "";
  let required = "";
  let i: int = 0;
  while (i < fields.length) {
    let f = fields[i];
    if (props != "") { props = props + ","; }
    props = props + JSON.stringify(f.name) + ":{\"type\":" + JSON.stringify(f.type);
    if (f.description != "") {
      props = props + ",\"description\":" + JSON.stringify(f.description);
    }
    props = props + "}";
    if (f.required) {
      if (required != "") { required = required + ","; }
      required = required + JSON.stringify(f.name);
    }
    i = i + 1;
  }
  return "{\"type\":\"object\",\"properties\":{" + props + "},\"required\":[" + required + "],\"additionalProperties\":false}";
}

export function requiredFields(fields: SchemaField[]): string[] {
  let out: string[] = [];
  for (const f of fields) {
    if (f.required) { out.push(f.name); }
  }
  return out;
}

function structuredBody(model: string, messages: Message[], temperature: number, maxTokens: int, responseFormat: string): string {
  let scalars: StructuredScalars = {
    model: model,
    temperature: temperature,
    max_tokens: maxTokens,
  };
  let head = JSON.stringify(scalars);
  // strip the closing brace so the remaining members can be appended
  let body = head.slice(0, head.length - 1);
  body = body + ",\"messages\":" + JSON.stringify(messages);
  body = body + ",\"response_format\":" + responseFormat + "}";
  return body;
}

// json mode: the reply is valid JSON, but its shape is NOT constrained.
export function jsonObjectBody(model: string, messages: Message[], temperature: number, maxTokens: int): string {
  return structuredBody(model, messages, temperature, maxTokens, "{\"type\":\"json_object\"}");
}

// schema mode: the reply is constrained to `schemaJson` (build it with
// objectSchema).
export function jsonSchemaBody(model: string, messages: Message[], name: string, schemaJson: string, temperature: number, maxTokens: int): string {
  let rf = "{\"type\":\"json_schema\",\"json_schema\":{\"name\":" + JSON.stringify(name)
    + ",\"strict\":true,\"schema\":" + schemaJson + "}}";
  return structuredBody(model, messages, temperature, maxTokens, rf);
}

// quoted text is stepped over, so a key name appearing inside a string value
// does not count as the property being present.
function hasTopLevelKey(json: string, key: string): bool {
  let want = JSON.stringify(key);
  let depth: int = 0;
  let i: int = 0;
  while (i < json.length) {
    let c = json.charAt(i);
    if (c == "\"") {
      // a string at depth 1 is a candidate key; compare, then skip all of it
      let start = i;
      i = i + 1;
      while (i < json.length) {
        let d = json.charAt(i);
        if (d == "\\") { i = i + 2; continue; }
        if (d == "\"") { i = i + 1; break; }
        i = i + 1;
      }
      if (depth == 1 && json.slice(start, i) == want) {
        // must be followed by a colon to be a key rather than a value
        let j = i;
        while (j < json.length && (json.charAt(j) == " " || json.charAt(j) == "\n" || json.charAt(j) == "\t" || json.charAt(j) == "\r")) { j = j + 1; }
        if (j < json.length && json.charAt(j) == ":") { return true; }
      }
      continue;
    }
    if (c == "{" || c == "[") { depth = depth + 1; }
    if (c == "}" || c == "]") { depth = depth - 1; }
    i = i + 1;
  }
  return false;
}

// presence check only, not full JSON Schema validation — types and nested
// constraints are left to the provider's strict mode.
export function validateStructured(json: string, required: string[]): Structured {
  let text = json.trim();
  if (text == "") { return structErr("empty response"); }
  let obj = firstJsonObjectOutput(text);
  if (obj == "") { return structErr("no JSON object in response"); }
  let missing = "";
  for (const key of required) {
    if (!hasTopLevelKey(obj, key)) {
      if (missing != "") { missing = missing + ", "; }
      missing = missing + key;
    }
  }
  if (missing != "") { return structErr("missing required field(s): " + missing); }
  return structOk(obj);
}

// tolerates a model that wrapped its JSON in a code fence despite being asked
// not to.
export function parseStructuredResponse(raw: string, content: string, required: string[]): Structured {
  if (content.trim() == "") {
    return structErr("no content in response: " + raw.slice(0, 160));
  }
  return validateStructured(typedJsonInputOutput(content), required);
}

export function structuredRetryPrompt(schemaJson: string, invalid: string, reason: string): string {
  return retryPromptOutput("Return only a JSON object matching this schema:\n" + schemaJson, invalid, reason);
}

// --- Live calls -------------------------------------------------------------

function postStructured(url: string, headers: Map<string, string>, body: string, required: string[]): Structured {
  let res = http.request(url, "POST", body, headers);
  let content = structuredContent(res.body);
  return parseStructuredResponse(res.body, content, required);
}

// extracts `choices[0].message.content` by scanning: a real provider body
// carries extra fields, and JSON.parse<T> throws on unknown fields.
function structuredContent(raw: string): string {
  let at = raw.indexOf("\"content\"");
  if (at < 0) { return ""; }
  let i = at + 9;
  while (i < raw.length && raw.charAt(i) != ":") { i = i + 1; }
  i = i + 1;
  while (i < raw.length && (raw.charAt(i) == " " || raw.charAt(i) == "\n")) { i = i + 1; }
  if (i >= raw.length || raw.charAt(i) != "\"") { return ""; }
  let start = i;
  i = i + 1;
  while (i < raw.length) {
    let c = raw.charAt(i);
    if (c == "\\") { i = i + 2; continue; }
    if (c == "\"") { i = i + 1; break; }
    i = i + 1;
  }
  let quoted = raw.slice(start, i);
  return structDecodeString(quoted);
}

function structDecodeString(quoted: string): string {
  if (quoted.length < 2) { return ""; }
  let out = "";
  let i: int = 1;
  while (i < quoted.length - 1) {
    let c = quoted.charAt(i);
    if (c != "\\") { out = out + c; i = i + 1; continue; }
    let esc = quoted.charAt(i + 1);
    if (esc == "n") { out = out + "\n"; i = i + 2; continue; }
    if (esc == "t") { out = out + "\t"; i = i + 2; continue; }
    if (esc == "r") { out = out + "\r"; i = i + 2; continue; }
    if (esc == "\"" || esc == "\\" || esc == "/") { out = out + esc; i = i + 2; continue; }
    i = i + 2;
  }
  return out;
}

export function structuredOpenAIWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: Message[], name: string, schemaJson: string, required: string[]): Structured {
  let body = jsonSchemaBody(model, messages, name, schemaJson, 0.2, 1024);
  return postStructured(baseUrl + "/chat/completions", makeAuthHeaders(apiKey), body, required);
}

export function structuredOpenAI(apiKey: string, model: string, messages: Message[], name: string, schemaJson: string, required: string[]): Structured {
  return structuredOpenAIWithBaseUrl("https://api.openai.com/v1", apiKey, model, messages, name, schemaJson, required);
}

export function structuredMistral(apiKey: string, model: string, messages: Message[], name: string, schemaJson: string, required: string[]): Structured {
  let body = jsonSchemaBody(model, messages, name, schemaJson, 0.2, 1024);
  return postStructured("https://api.mistral.ai/v1/chat/completions", makeMistralAuthHeaders(apiKey), body, required);
}

// --- Provider-neutral entry points -----------------------------------------
// schema mode is not universal: OpenAI and Mistral support `json_schema`, but
// many OpenAI-compatible endpoints (Groq, Together, OpenRouter, Ollama, ...)
// accept only `json_object`. The json-mode path therefore states the schema in
// the prompt and relies on validateStructured to catch a wrong shape.

export function schemaInstruction(schemaJson: string): Message {
  return { role: "system", content: "Reply with a single JSON object and nothing else. It must match this JSON Schema:\n" + schemaJson };
}

// shape is prompted rather than enforced, then validated locally.
export function structuredJsonModeWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: Message[], schemaJson: string, required: string[]): Structured {
  let guided: Message[] = [schemaInstruction(schemaJson), ...messages];
  let body = jsonObjectBody(model, guided, 0.2, 1024);
  return postStructured(baseUrl + "/chat/completions", makeAuthHeaders(apiKey), body, required);
}

// provider names match buildProviderChatBody's vocabulary. Only the two with
// verified schema mode dispatch here; other endpoints go through the
// *WithBaseUrl or json-mode forms.
export function structuredChat(provider: string, apiKey: string, model: string, messages: Message[], name: string, schemaJson: string, required: string[]): Structured {
  if (provider == "mistral") {
    return structuredMistral(apiKey, model, messages, name, schemaJson, required);
  }
  if (provider == "openai") {
    return structuredOpenAI(apiKey, model, messages, name, schemaJson, required);
  }
  return structErr("unknown provider \"" + provider + "\": use openai, mistral, or the *WithBaseUrl form for another endpoint");
}

// schema mode against any OpenAI-compatible endpoint that supports it.
export function structuredChatWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: Message[], name: string, schemaJson: string, required: string[]): Structured {
  return structuredOpenAIWithBaseUrl(baseUrl, apiKey, model, messages, name, schemaJson, required);
}
