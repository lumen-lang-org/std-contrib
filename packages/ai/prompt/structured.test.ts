// Tests for structured.

import { jsonObjectBody, jsonSchemaBody, objectSchema, parseStructuredResponse, requiredFields, schemaField, schemaInstruction, structuredChat, structuredRetryPrompt, validateStructured } from "./structured.ts";

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
