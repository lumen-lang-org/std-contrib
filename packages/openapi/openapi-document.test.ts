// openApiDocument itself: a pure function over plain values, so this needs
// neither a decorated controller nor a decorated DTO — no @openapi, no
// @schema, no rest/controller.ts, no validation.ts. What openapi.test.ts and
// openapi-schema.test.ts prove separately (each avoiding the other's package
// for the Description collision reason both explain), this proves together:
// a document naming a real route and a real schema at once, the shape
// GET /openapi.json actually answers.
//
//   cd packages/openapi && lumen test openapi-document.test.ts

import { OpenApiField, OpenApiOperation, OpenApiParam, OpenApiSchema, openApiDocument, openApiFault } from "./openapi.ts";

function agentsListOperation(): OpenApiOperation {
  let none: OpenApiParam[] = [];
  let op: OpenApiOperation = {
    method: "GET", path: "/agents", operationId: "AgentApi.list",
    params: none, bodyType: "", responseType: "AgentBody",
  };
  return op;
}

function agentsFindOperation(): OpenApiOperation {
  let idParam: OpenApiParam = { name: "id", location: "path", paramType: "string", required: true };
  let op: OpenApiOperation = {
    method: "GET", path: "/agents/{id}", operationId: "AgentApi.find",
    params: [idParam], bodyType: "", responseType: "AgentBody",
  };
  return op;
}

function agentBodySchema(): OpenApiSchema {
  let name: OpenApiField = { name: "agentName", fieldType: "string", required: true };
  let enabled: OpenApiField = { name: "enabled", fieldType: "bool", required: false };
  let s: OpenApiSchema = { schemaName: "AgentBody", fields: [name, enabled] };
  return s;
}

test("two operations on one path become one path item with two verbs", () => {
  let ops: OpenApiOperation[] = [agentsListOperation()];
  let post: OpenApiOperation = {
    method: "POST", path: "/agents", operationId: "AgentApi.create",
    params: [], bodyType: "AgentBody", responseType: "AgentBody",
  };
  ops.push(post);
  let noSchemas: OpenApiSchema[] = [];
  let doc = openApiDocument("agents pilot", "0.1.0", ops, noSchemas);

  let at = doc.indexOf("\"/agents\":{");
  expect(at >= 0);
  let close = doc.indexOf("\"/agents/{id}\"");
  let section = close >= 0 ? doc.slice(at, close) : doc.slice(at);
  expect(section.indexOf("\"get\":") >= 0);
  expect(section.indexOf("\"post\":") >= 0);
});

test("a $ref points at components.schemas, not at an inline object, for a DTO-typed body or response", () => {
  let ops: OpenApiOperation[] = [agentsFindOperation()];
  let schemas: OpenApiSchema[] = [agentBodySchema()];
  let doc = openApiDocument("agents pilot", "0.1.0", ops, schemas);

  expect(doc.indexOf("\"$ref\":\"#/components/schemas/AgentBody\"") >= 0);
  expect(doc.indexOf("\"schema\":{\"$ref\":\"#/components/schemas/AgentBody\"}") >= 0);
});

test("a path parameter is always required, a query parameter only when its DTO field says so", () => {
  let ops: OpenApiOperation[] = [agentsFindOperation()];
  let noSchemas: OpenApiSchema[] = [];
  let doc = openApiDocument("agents pilot", "0.1.0", ops, noSchemas);

  expect(doc.indexOf("\"name\":\"id\",\"in\":\"path\",\"required\":true") >= 0);
});

test("two operations answering the same method and path is refused, naming both", () => {
  expect(openApiFault([agentsListOperation(), agentsFindOperation()]) == "");

  let impostor: OpenApiOperation = {
    method: "GET", path: "/agents", operationId: "ArchiveApi.list",
    params: [], bodyType: "", responseType: "",
  };
  let clash = openApiFault([agentsListOperation(), impostor]);
  expect(clash == "AgentApi.list and ArchiveApi.list both answer GET /agents");

  // Not a false alarm on a route that legitimately reappears under its own
  // operationId — a document rebuilt from the same mounts twice, say.
  expect(openApiFault([agentsListOperation(), agentsListOperation()]) == "");
});

test("the whole document names a real route and a real schema together", () => {
  let ops: OpenApiOperation[] = [agentsListOperation(), agentsFindOperation()];
  let schemas: OpenApiSchema[] = [agentBodySchema()];
  let doc = openApiDocument("agents pilot", "0.1.0", ops, schemas);

  expect(doc.indexOf("\"openapi\":\"3.0.3\"") >= 0);
  expect(doc.indexOf("\"/agents\"") >= 0);
  expect(doc.indexOf("\"/agents/{id}\"") >= 0);
  expect(doc.indexOf("\"AgentBody\":{\"type\":\"object\"") >= 0);
  expect(doc.indexOf("\"required\":[\"agentName\"]") >= 0);
});
