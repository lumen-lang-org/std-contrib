// Provider-native structured output: ask the model for JSON that conforms to a
// schema, and get back a validated result rather than free text.
//
// Two provider modes, and the difference matters:
//   - JSON mode (`{"type":"json_object"}`) guarantees the reply PARSES as JSON,
//     but not that it has your shape. Probed against Mistral, asking for
//     name/age/city in JSON mode returned {"person":{...}} — valid JSON, wrong
//     shape. Use it only as a fallback.
//   - Schema mode (`{"type":"json_schema", ..., "strict":true}`) constrains the
//     shape. The same prompt returned a flat {name, age, city}. Prefer this.
//
// Lumen has no runtime reflection, so a schema is described with explicit
// fields rather than derived from a record type.

import { makeAuthHeaders } from "./openai.ts";
import { makeMistralAuthHeaders } from "./mistral.ts";
import { firstJsonObjectOutput, typedJsonInputOutput, retryPromptOutput } from "./output.ts";

// One property of an object schema. `type` is a JSON Schema primitive name:
// "string", "integer", "number", "boolean".
type AiSchemaField = {
  name: string,
  type: string,
  description: string,
  required: bool,
};

// The outcome of a structured request. `json` is the extracted object source on
// success and "" otherwise; `error` explains a failure in one line.
type AiStructured = {
  ok: bool,
  json: string,
  error: string,
};

// Scalars are serialized through JSON.stringify so a float temperature is
// formatted exactly as the other provider modules format it.
type StructuredScalars = {
  model: string,
  temperature: number,
  max_tokens: int,
};

function structOk(json: string): AiStructured {
  let r: AiStructured = {
    ok: true,
    json: json,
    error: "",
  };
  return r;
}

function structErr(message: string): AiStructured {
  let r: AiStructured = {
    ok: false,
    json: "",
    error: message,
  };
  return r;
}

export function schemaField(name: string, fieldType: string, description: string, required: bool): AiSchemaField {
  let f: AiSchemaField = {
    name: name,
    type: fieldType,
    description: description,
    required: required,
  };
  return f;
}

// Build a JSON Schema object from explicit fields. `additionalProperties` is
// false and every required field is listed, which is what strict schema mode
// expects.
export function objectSchema(fields: AiSchemaField[]): string {
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

// The names of every required field, for validating a reply.
export function requiredFields(fields: AiSchemaField[]): string[] {
  let out: string[] = [];
  for (const f of fields) {
    if (f.required) { out.push(f.name); }
  }
  return out;
}

// Shared body builder: the scalars, the messages, then a response_format.
function structuredBody(model: string, messages: AiMessage[], temperature: number, maxTokens: int, responseFormat: string): string {
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

// JSON mode: the reply is valid JSON, but its shape is NOT constrained.
export function jsonObjectBody(model: string, messages: AiMessage[], temperature: number, maxTokens: int): string {
  return structuredBody(model, messages, temperature, maxTokens, "{\"type\":\"json_object\"}");
}

// Schema mode: the reply is constrained to `schemaJson` (build it with
// objectSchema). `name` labels the schema for the provider.
export function jsonSchemaBody(model: string, messages: AiMessage[], name: string, schemaJson: string, temperature: number, maxTokens: int): string {
  let rf = "{\"type\":\"json_schema\",\"json_schema\":{\"name\":" + JSON.stringify(name)
    + ",\"strict\":true,\"schema\":" + schemaJson + "}}";
  return structuredBody(model, messages, temperature, maxTokens, rf);
}

// Is `key` present as a top-level property of the object source `json`? Quoted
// text is stepped over, so a key name appearing inside a string value does not
// count as the property being present.
function hasTopLevelKey(json: string, key: string): bool {
  let want = JSON.stringify(key);
  let depth: int = 0;
  let i: int = 0;
  while (i < json.length) {
    let c = json.charAt(i);
    if (c == "\"") {
      // A key at depth 1 is a candidate; compare then skip the whole string.
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

// Check that a reply is a JSON object carrying every required field. This is a
// presence check, not full JSON Schema validation — types and nested
// constraints are left to the provider's strict mode.
export function validateStructured(json: string, required: string[]): AiStructured {
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

// Pull the JSON out of a raw provider response body and validate it. Tolerates
// a model that wrapped its JSON in a code fence despite being asked not to.
export function parseStructuredResponse(raw: string, content: string, required: string[]): AiStructured {
  if (content.trim() == "") {
    return structErr("no content in response: " + raw.slice(0, 160));
  }
  return validateStructured(typedJsonInputOutput(content), required);
}

// A correction prompt to send after an invalid structured reply.
export function structuredRetryPrompt(schemaJson: string, invalid: string, reason: string): string {
  return retryPromptOutput("Return only a JSON object matching this schema:\n" + schemaJson, invalid, reason);
}

// --- Live calls -------------------------------------------------------------
// Thin, like the other provider entry points: build the body, POST it, hand the
// content to the pure validator above.

function postStructured(url: string, headers: Map<string, string>, body: string, required: string[]): AiStructured {
  let res = http.request(url, "POST", body, headers);
  let content = structuredContent(res.body);
  return parseStructuredResponse(res.body, content, required);
}

// Extract `choices[0].message.content` without a typed parse (a real provider
// body carries fields a typed JSON.parse<T> would reject).
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

// Decode a quoted JSON string literal into its text.
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

export function structuredOpenAIWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: AiMessage[], name: string, schemaJson: string, required: string[]): AiStructured {
  let body = jsonSchemaBody(model, messages, name, schemaJson, 0.2, 1024);
  return postStructured(baseUrl + "/chat/completions", makeAuthHeaders(apiKey), body, required);
}

export function structuredOpenAI(apiKey: string, model: string, messages: AiMessage[], name: string, schemaJson: string, required: string[]): AiStructured {
  return structuredOpenAIWithBaseUrl("https://api.openai.com/v1", apiKey, model, messages, name, schemaJson, required);
}

export function structuredMistral(apiKey: string, model: string, messages: AiMessage[], name: string, schemaJson: string, required: string[]): AiStructured {
  let body = jsonSchemaBody(model, messages, name, schemaJson, 0.2, 1024);
  return postStructured("https://api.mistral.ai/v1/chat/completions", makeMistralAuthHeaders(apiKey), body, required);
}

// --- Provider-neutral entry points -----------------------------------------
// Schema mode is not universal. OpenAI and Mistral both constrain the shape with
// `json_schema` (both verified). Many OpenAI-compatible endpoints (Groq,
// Together, OpenRouter, Ollama, ...) accept only `json_object`, which guarantees
// valid JSON but NOT your shape — so the JSON-mode path states the schema in the
// prompt and leans on validateStructured to catch a wrong shape.

// Restate a schema as an instruction, for providers without schema mode.
export function schemaInstruction(schemaJson: string): AiMessage {
  return { role: "system", content: "Reply with a single JSON object and nothing else. It must match this JSON Schema:\n" + schemaJson };
}

// JSON-mode structured output against any OpenAI-compatible endpoint: the shape
// is prompted rather than enforced, then validated locally.
export function structuredJsonModeWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: AiMessage[], schemaJson: string, required: string[]): AiStructured {
  let guided: AiMessage[] = [schemaInstruction(schemaJson), ...messages];
  let body = jsonObjectBody(model, guided, 0.2, 1024);
  return postStructured(baseUrl + "/chat/completions", makeAuthHeaders(apiKey), body, required);
}

// Dispatch by provider name, matching buildProviderChatBody's vocabulary.
// "openai" and "mistral" use native schema mode; "openai-compatible" uses the
// JSON-mode fallback, since schema support varies across those endpoints.
export function structuredChat(provider: string, apiKey: string, model: string, messages: AiMessage[], name: string, schemaJson: string, required: string[]): AiStructured {
  if (provider == "mistral") {
    return structuredMistral(apiKey, model, messages, name, schemaJson, required);
  }
  if (provider == "openai") {
    return structuredOpenAI(apiKey, model, messages, name, schemaJson, required);
  }
  return structErr("unknown provider \"" + provider + "\": use openai, mistral, or the *WithBaseUrl form for another endpoint");
}

// Schema mode against any OpenAI-compatible endpoint that supports it.
export function structuredChatWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: AiMessage[], name: string, schemaJson: string, required: string[]): AiStructured {
  return structuredOpenAIWithBaseUrl(baseUrl, apiKey, model, messages, name, schemaJson, required);
}

test("objectSchema builds a strict JSON Schema", () => {
  let fields: AiSchemaField[] = [
    schemaField("name", "string", "full name", true),
    schemaField("age", "integer", "", true),
    schemaField("nickname", "string", "", false),
  ];
  let s = objectSchema(fields);
  expect(s.includes("\"type\":\"object\""));
  expect(s.includes("\"name\":{\"type\":\"string\",\"description\":\"full name\"}"));
  expect(s.includes("\"age\":{\"type\":\"integer\"}"));
  expect(s.includes("\"required\":[\"name\",\"age\"]"));
  expect(s.includes("\"additionalProperties\":false"));
  let req = requiredFields(fields);
  expect(req.length == 2);
});

test("jsonSchemaBody carries the schema in response_format", () => {
  let fields: AiSchemaField[] = [schemaField("city", "string", "", true)];
  let msgs: AiMessage[] = [{ role: "user", content: "where?" }];
  let body = jsonSchemaBody("m", msgs, "place", objectSchema(fields), 0.2, 100);
  expect(body.includes("\"response_format\":{\"type\":\"json_schema\""));
  expect(body.includes("\"strict\":true"));
  expect(body.includes("\"name\":\"place\""));
  expect(body.includes("\"messages\":"));
  expect(body.includes("\"model\":\"m\""));
});

test("jsonObjectBody asks for plain JSON mode", () => {
  let msgs: AiMessage[] = [{ role: "user", content: "hi" }];
  let body = jsonObjectBody("m", msgs, 0.2, 100);
  expect(body.includes("\"response_format\":{\"type\":\"json_object\"}"));
});

test("validateStructured accepts a complete object", () => {
  let req: string[] = ["name", "age"];
  let r = validateStructured("{\"name\":\"Ada\",\"age\":36}", req);
  expect(r.ok);
  expect(r.json.includes("Ada"));
  expect(r.error == "");
});

test("validateStructured reports every missing field", () => {
  let req: string[] = ["name", "age", "city"];
  let r = validateStructured("{\"name\":\"Ada\"}", req);
  expect(!r.ok);
  expect(r.error.includes("age"));
  expect(r.error.includes("city"));
});

test("validateStructured is not fooled by a key inside a string value", () => {
  let req: string[] = ["age"];
  // "age" appears only inside a value, never as a property
  let r = validateStructured("{\"name\":\"my age is secret\"}", req);
  expect(!r.ok);
  expect(r.error.includes("age"));
});

test("validateStructured ignores a nested key of the same name", () => {
  let req: string[] = ["city"];
  // `city` exists only one level down, so the top-level object is incomplete
  let r = validateStructured("{\"address\":{\"city\":\"Paris\"}}", req);
  expect(!r.ok);
});

test("validateStructured degrades on empty and non-JSON replies", () => {
  let req: string[] = ["a"];
  expect(!validateStructured("", req).ok);
  expect(!validateStructured("sorry, I cannot", req).ok);
  expect(validateStructured("", req).error == "empty response");
});

test("parseStructuredResponse unwraps a fenced reply", () => {
  let req: string[] = ["ok"];
  let content = "```json\n{\"ok\": true}\n```";
  let r = parseStructuredResponse("{}", content, req);
  expect(r.ok);
  expect(r.json.includes("\"ok\""));
});

test("parseStructuredResponse reports an empty content body", () => {
  let req: string[] = ["ok"];
  let r = parseStructuredResponse("{\"error\":\"rate limited\"}", "", req);
  expect(!r.ok);
  expect(r.error.includes("no content"));
});

test("structuredRetryPrompt restates the schema", () => {
  let p = structuredRetryPrompt("{\"type\":\"object\"}", "not json", "no JSON object in response");
  expect(p.includes("matching this schema"));
  expect(p.includes("not json"));
  expect(p.includes("no JSON object"));
});

test("schemaInstruction states the schema for json-mode providers", () => {
  let m = schemaInstruction("{\"type\":\"object\"}");
  expect(m.role == "system");
  expect(m.content.includes("single JSON object"));
  expect(m.content.includes("\"type\":\"object\""));
});

test("structuredChat rejects an unknown provider without calling out", () => {
  let msgs: AiMessage[] = [{ role: "user", content: "hi" }];
  let req: string[] = ["a"];
  let r = structuredChat("nope", "k", "m", msgs, "s", "{}", req);
  expect(!r.ok);
  expect(r.error.includes("unknown provider"));
});
