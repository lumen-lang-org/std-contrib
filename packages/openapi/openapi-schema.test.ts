// @schema, exercised through a real @validated DTO — a separate file from
// openapi.test.ts because rest/controller.ts and validation/validation.ts each
// declare their own `Description`, and the two collide the moment both are
// imported into one file. See openapi.test.ts's header for the full reason.
//
//   cd packages/openapi && lumen test openapi-schema.test.ts

import { OpenApiOperation, OpenApiSchema, openApiDocument, openApiSchemaOf, schema } from "./openapi.ts";
import { Required, Rule, faults, validated } from "../validation/validation.ts";

@validated
@schema
class AgentBody {
  @Required("an agent needs a name")
  agentName: string;
  enabled: bool;

  constructor(agentName: string, enabled: bool) {
    this.agentName = agentName;
    this.enabled = enabled;
  }
}

test("@schema reads a DTO's fields and its @Required markers, beside @validated", () => {
  let s: OpenApiSchema = openApiSchemaOf(new AgentBody("", false));
  expect(s.schemaName == "AgentBody");
  expect(s.fields.length == 2);
  expect(s.fields[0].name == "agentName");
  expect(s.fields[0].fieldType == "string");
  expect(s.fields[0].required);
  expect(s.fields[1].name == "enabled");
  expect(s.fields[1].fieldType == "bool");
  expect(!s.fields[1].required);

  // @schema describing a field as required and @validated actually refusing
  // its absence are two different decorators agreeing, not one implying the
  // other — proven by exercising both on the same class.
  let rules: Rule[] = Class.decorator(new AgentBody("", false), "validated");
  expect(faults(rules, "{\"agentName\":\"\"}").length == 1);
  expect(faults(rules, "{\"agentName\":\"lead\"}").length == 0);
});

test("the document is valid JSON naming every schema, its properties and its required fields", () => {
  let schemas: OpenApiSchema[] = [openApiSchemaOf(new AgentBody("", false))];
  let noOps: OpenApiOperation[] = [];
  let doc = openApiDocument("agents pilot", "0.1.0", noOps, schemas);

  // The document's own components.schemas keys are dynamic — DTO class names,
  // not fields any static type could declare — which is exactly why this
  // checks the text rather than JSON.parse<T>-ing the whole thing.
  expect(doc.indexOf("\"openapi\":\"3.0.3\"") >= 0);
  expect(doc.indexOf("\"title\":\"agents pilot\"") >= 0);
  expect(doc.indexOf("\"AgentBody\":{\"type\":\"object\"") >= 0);
  expect(doc.indexOf("\"agentName\":{\"type\":\"string\"}") >= 0);
  expect(doc.indexOf("\"enabled\":{\"type\":\"boolean\"}") >= 0);
  expect(doc.indexOf("\"required\":[\"agentName\"]") >= 0);
});
