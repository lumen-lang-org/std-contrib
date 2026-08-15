// OpenAPI document generation, the way `@controller` generates a route table:
// a decorator the compiler runs while compiling, leaving a constant behind, no
// scanning and no reflection at runtime (Lumen spec 455/459/477, same as
// rest/controller.ts). `@openapi` reads the same per-method decorators
// `@controller`/`@bindings` already read — @Get/@Post/@PathVariable/
// @RequestBody/@RequestParam — so a route that already serves correctly is
// already described correctly; nothing new to keep in sync.
//
// A DTO's shape is a second, separate decorator: `@schema` on the class,
// reading its fields the way `@validated` (packages/validation) reads them for
// runtime rules. The two do not overlap — `@validated`'s Rule[] carries a
// field's constraints and drops its type; `@schema`'s OpenApiField[] carries
// the type and whether it is required, because a document needs both and
// dropping either was a choice the validator made for its own reasons.
//
// What no decorator can read: a handler's response body. Lumen has no dynamic
// JSON type (see packages/ai/spec.md), so every reply here is a `Reply` — the
// method's return type never says what JSON is inside it, unlike a request
// body's type which the parameter declares. `@Returns("AgentBody")` is a
// marker for that, exactly as `Required`/`MaxLength` in validation.ts are
// markers: never invoked, existing only so a handler can import something real
// when it says what it answers with.
//
// What @openapi does not build: the path or the method. An earlier version
// had it reconstruct both — reading @Get's own tail and joining it to
// @openapi's own copy of the class's path prefix, since a decorator sees only
// its own arguments (Lumen spec 459), never a sibling decorator's. That meant
// writing the prefix twice, `@controller("/agents")` and `@openapi("/agents")`
// beside it, with nothing keeping the two in agreement — and reinventing
// rest/server.ts's own duplicate-route refusal (mountFault: "AgentApi.list and
// ArchiveApi.list both serve GET /agents") on a second, independently
// reconstructed copy of the same paths, which is exactly the kind of copy that
// drifts from the original silently. @openapi now reports only what Route[]
// does not already carry — a handler's parameters, its request body type, its
// declared response type — keyed by handler name; `openApiOperations` below
// cross-references that against the real, already-deduplicated `Route[]`
// `@controller` built, the same one `mountFault` already checked before
// `listen` will bind. One source of truth for what a route is; @openapi only
// adds to it.
//
// Self-contained rather than importing ControllerMethod/ControllerParam/
// ControllerDecoratorUse from rest/controller.ts, on evidence, not by
// convention: strace against a real compile (see the commit this shipped
// with) showed every decorator-use object — method-level, param-level,
// field-level alike — carries an `argsText` key that ControllerDecoratorUse
// does not declare. rest/controller.ts's own decorators never notice, because
// controller.test.ts and bindings' own callers exercise them with hand-built
// Description stubs, never through this generic decorator-execution path.
// `@openapi`/`@schema` go through it for real, so they need the real shape —
// which is also why every decorator module in this codebase (validation.ts
// included) declares its own types rather than sharing rest's.
//
// Route is the one exception, and safely so: rest/router.ts has no imports of
// its own — pure string matching, nothing about Description — so it carries
// none of the collision risk controller.ts does.

import { Route } from "../rest/router.ts";

// argsText only, deliberately: args carries each argument typed as the
// decorator's own parameter declares it — @MaxLength(48, "...")'s first
// argument arrives as a real JSON number, not a string, and a value of
// mixed-typed args cannot be declared as string[] without JSON.parse
// throwing the moment a decorator with a non-string argument is described.
// validation.ts's own FieldRule has the identical shape for the identical
// reason. Caught with strace against a real @MaxLength/@Min compile, not
// assumed: the first version of this file declared args: string[] too, and
// it worked only as long as every decorator this package had been tried
// against happened to take string arguments — @Get, @PathVariable,
// @Required. @MaxLength(48, ...) is the first with a leading int.
export type OpenApiDecoratorUse = {
  name: string,
  argsText: string[],
};

export type OpenApiMethodParam = {
  name: string,
  type: string,
  decorators: OpenApiDecoratorUse[],
};

export type OpenApiMethod = {
  name: string,
  returns: string,
  params: OpenApiMethodParam[],
  decorators: OpenApiDecoratorUse[],
};

export type OpenApiSchemaField = {
  name: string,
  type: string,
  decorators: OpenApiDecoratorUse[],
};

export type OpenApiDescription = {
  protocol: int,
  kind: string,
  name: string,
  args: string[],
  fields: OpenApiSchemaField[],
  methods: OpenApiMethod[],
};

function decoratorNamed(decorators: OpenApiDecoratorUse[], name: string): OpenApiDecoratorUse {
  let i: int = 0;
  while (i < decorators.length) {
    if (decorators[i].name == name) {
      return decorators[i];
    }
    i = i + 1;
  }
  let none: OpenApiDecoratorUse = { name: "", argsText: [] };
  return none;
}

function hasDecorator(decorators: OpenApiDecoratorUse[], name: string): bool {
  return decoratorNamed(decorators, name).name != "";
}

// The vocabulary rest/controller.ts's httpMethodOf fixes is fixed again here,
// deliberately: @openapi reads the same @Get/@Post/... a route already
// carries, and duplicating six string comparisons is cheaper and safer than
// making this module depend on rest's ControllerMethod shape for the reason
// explained at the top of the file.
function httpVerbOf(m: OpenApiMethod): string {
  if (hasDecorator(m.decorators, "Get") || hasDecorator(m.decorators, "get")) {
    return "GET";
  }
  if (hasDecorator(m.decorators, "Post") || hasDecorator(m.decorators, "post")) {
    return "POST";
  }
  if (hasDecorator(m.decorators, "Put") || hasDecorator(m.decorators, "put")) {
    return "PUT";
  }
  if (hasDecorator(m.decorators, "Patch") || hasDecorator(m.decorators, "patch")) {
    return "PATCH";
  }
  if (hasDecorator(m.decorators, "Delete") || hasDecorator(m.decorators, "del") || hasDecorator(m.decorators, "delete")) {
    return "DELETE";
  }
  if (hasDecorator(m.decorators, "Head") || hasDecorator(m.decorators, "head")) {
    return "HEAD";
  }
  return "";
}

export type OpenApiParam = {
  name: string,
  location: string,
  paramType: string,
  required: bool,
};

function paramLocation(named: string): string {
  if (named == "path" || named == "query" || named == "header") {
    return named;
  }
  return "";
}

function operationParams(m: OpenApiMethod): OpenApiParam[] {
  let out: OpenApiParam[] = [];
  let i: int = 0;
  while (i < m.params.length) {
    let p = m.params[i];
    let path = decoratorNamed(p.decorators, "PathVariable");
    let query = decoratorNamed(p.decorators, "RequestParam");
    let header = decoratorNamed(p.decorators, "RequestHeader");
    if (path.name != "") {
      let name = path.argsText.length > 0 && path.argsText[0] != "" ? path.argsText[0] : p.name;
      let param: OpenApiParam = { name: name, location: "path", paramType: p.type, required: true };
      out.push(param);
    } else if (query.name != "") {
      let name = query.argsText.length > 0 && query.argsText[0] != "" ? query.argsText[0] : p.name;
      let param: OpenApiParam = { name: name, location: "query", paramType: p.type, required: false };
      out.push(param);
    } else if (header.name != "") {
      let name = header.argsText.length > 0 && header.argsText[0] != "" ? header.argsText[0] : p.name;
      let param: OpenApiParam = { name: name, location: "header", paramType: p.type, required: false };
      out.push(param);
    }
    i = i + 1;
  }
  return out;
}

function bodyTypeOf(m: OpenApiMethod): string {
  let i: int = 0;
  while (i < m.params.length) {
    let p = m.params[i];
    if (hasDecorator(p.decorators, "RequestBody") && p.type != "string") {
      return p.type;
    }
    i = i + 1;
  }
  return "";
}

// The path Lumen's router matches on names a variable `:id`; the spec every
// OpenAPI reader expects names it `{id}`. Translated here, once, rather than
// asking every route to be written twice.
export function openApiPath(pattern: string): string {
  let out = "";
  let parts = pattern.split("/");
  let i: int = 0;
  while (i < parts.length) {
    let seg = parts[i];
    if (seg.startsWith(":")) {
      out = out + "/{" + seg.slice(1, seg.length) + "}";
    } else if (seg != "") {
      out = out + "/" + seg;
    }
    i = i + 1;
  }
  return out == "" ? "/" : out;
}

// One handler's worth of what Route[] does not carry — its class's own
// Route[]/method string tell the rest (see the note at the top of the file).
export type OpenApiHandlerInfo = {
  handlerName: string,
  params: OpenApiParam[],
  bodyType: string,
  responseType: string,
};

export function openapi(d: OpenApiDescription): OpenApiHandlerInfo[] {
  let out: OpenApiHandlerInfo[] = [];
  let i: int = 0;
  while (i < d.methods.length) {
    let m = d.methods[i];
    if (httpVerbOf(m) != "") {
      let returns = decoratorNamed(m.decorators, "Returns");
      let info: OpenApiHandlerInfo = {
        handlerName: m.name,
        params: operationParams(m),
        bodyType: bodyTypeOf(m),
        responseType: returns.argsText.length > 0 ? returns.argsText[0] : "",
      };
      out.push(info);
    }
    i = i + 1;
  }
  return out;
}

// One constraint validation.ts's own decorators carry, translated to the
// OpenAPI schema keyword it means. hasX guards whether x is meaningful at
// all — a plain 0 default would be indistinguishable from "field must be
// exactly 0", which packages/validation.ts's own Rule sidesteps the same
// question differently (a Rule is one constraint; a field here is many).
export type OpenApiField = {
  name: string,
  fieldType: string,
  required: bool,
  hasMaxLength: bool,
  maxLength: int,
  hasMinLength: bool,
  minLength: int,
  hasMinimum: bool,
  minimum: number,
  hasMaximum: bool,
  maximum: number,
  allowedValues: string,
};

function decoratorInt(decorators: OpenApiDecoratorUse[], name: string): int {
  let dec = decoratorNamed(decorators, name);
  if (dec.name == "" || dec.argsText.length == 0) {
    return 0;
  }
  return parseInt(dec.argsText[0], 10) ?? 0;
}

function decoratorNumber(decorators: OpenApiDecoratorUse[], name: string): number {
  let dec = decoratorNamed(decorators, name);
  if (dec.name == "" || dec.argsText.length == 0) {
    return 0.0;
  }
  return parseFloat(dec.argsText[0]) ?? 0.0;
}

export function schema(d: OpenApiDescription): OpenApiField[] {
  let out: OpenApiField[] = [];
  let i: int = 0;
  while (i < d.fields.length) {
    let f = d.fields[i];
    let allowed = decoratorNamed(f.decorators, "OneOf");
    let field: OpenApiField = {
      name: f.name,
      fieldType: f.type,
      required: hasDecorator(f.decorators, "Required"),
      hasMaxLength: hasDecorator(f.decorators, "MaxLength"),
      maxLength: decoratorInt(f.decorators, "MaxLength"),
      hasMinLength: hasDecorator(f.decorators, "MinLength"),
      minLength: decoratorInt(f.decorators, "MinLength"),
      hasMinimum: hasDecorator(f.decorators, "Min"),
      minimum: decoratorNumber(f.decorators, "Min"),
      hasMaximum: hasDecorator(f.decorators, "Max"),
      maximum: decoratorNumber(f.decorators, "Max"),
      allowedValues: allowed.name != "" && allowed.argsText.length > 0 ? allowed.argsText[0] : "",
    };
    out.push(field);
    i = i + 1;
  }
  return out;
}

// Imported by a handler that names what it answers with — @Returns("AgentBody")
// beside @Get — never invoked, the same shape as validation.ts's markers.
export function Returns(dtoTypeName: string): void {}

// --- reading the baked constants at runtime -----------------------------------
//
// `Class.decorator(c, "openapi")` and `Class.decorator(c, "schema")` are
// resolved the same way `Class.decorator(c, "controller")` is in
// rest/server.ts's `mount` — while compiling, not at runtime, and only where a
// real instance of the decorated class triggers the generic's specialization.
// A DTO is not a `Mount` (it has fields to describe, not routes to serve), so
// it needs its own instance to trigger that specialization — built with
// throwaway constructor arguments, since `@schema`'s output does not depend on
// what the instance holds, only on what its class declares.

export type OpenApiSchema = {
  schemaName: string,
  fields: OpenApiField[],
};

export function openApiHandlerInfoOf<T>(c: T): OpenApiHandlerInfo[] {
  return Class.decorator(c, "openapi");
}

export function openApiSchemaOf<T>(c: T): OpenApiSchema {
  let out: OpenApiSchema = { schemaName: Class.nameOf(c), fields: Class.decorator(c, "schema") };
  return out;
}

// --- cross-referencing against the real route table ---------------------------
//
// Route (rest/router.ts) has no imports of its own — it is pure string
// matching, nothing about HTTP or Description — so importing it here carries
// none of the Description-collision risk importing rest/controller.ts did.

export type OpenApiOperation = {
  method: string,
  path: string,
  operationId: string,
  params: OpenApiParam[],
  bodyType: string,
  responseType: string,
};

function infoFor(info: OpenApiHandlerInfo[], handlerName: string): OpenApiHandlerInfo {
  let i: int = 0;
  while (i < info.length) {
    if (info[i].handlerName == handlerName) {
      return info[i];
    }
    i = i + 1;
  }
  let none: OpenApiHandlerInfo = { handlerName: "", params: [], bodyType: "", responseType: "" };
  return none;
}

// The real, already-deduplicated Route[] `@controller` built — the one
// rest/server.ts's `mountFault` already checks before `listen` will bind —
// enriched with what `@openapi` reported per handler name. Call this after
// `mountFault(mounts)` answers "", the same precondition `listen` itself
// holds to, so a document is never built from a route table the server would
// have refused to serve.
export function openApiOperations(routes: Route[], controllerName: string, info: OpenApiHandlerInfo[]): OpenApiOperation[] {
  let out: OpenApiOperation[] = [];
  let i: int = 0;
  while (i < routes.length) {
    let r = routes[i];
    let found = infoFor(info, r.handler);
    let op: OpenApiOperation = {
      method: r.method,
      path: openApiPath(r.pattern),
      operationId: controllerName + "." + r.handler,
      params: found.params,
      bodyType: found.bodyType,
      responseType: found.responseType,
    };
    out.push(op);
    i = i + 1;
  }
  return out;
}

// --- building the document ----------------------------------------------------

function openApiType(lumenType: string): string {
  if (lumenType == "int") {
    return "integer";
  }
  if (lumenType == "number") {
    return "number";
  }
  if (lumenType == "bool") {
    return "boolean";
  }
  if (lumenType == "string") {
    return "string";
  }
  return "";
}

function propertySchema(fieldType: string): string {
  let known = openApiType(fieldType);
  if (known != "") {
    return "{\"type\":" + JSON.stringify(known) + "}";
  }
  return "{\"$ref\":\"#/components/schemas/" + fieldType + "\"}";
}

// propertySchema for one DTO field, with whatever constraints its
// @MaxLength/@MinLength/@Min/@Max/@OneOf carry folded in as the OpenAPI
// keyword each means. Only meaningful beside a known primitive type — a
// constraint decorator has never been written on a field whose type is
// itself another DTO, so this does not attempt to compose one with a $ref.
function fieldPropertySchema(f: OpenApiField): string {
  let known = openApiType(f.fieldType);
  if (known == "") {
    return propertySchema(f.fieldType);
  }
  let extra = "";
  if (f.hasMaxLength) {
    extra = extra + ",\"maxLength\":" + `${f.maxLength}`;
  }
  if (f.hasMinLength) {
    extra = extra + ",\"minLength\":" + `${f.minLength}`;
  }
  if (f.hasMinimum) {
    extra = extra + ",\"minimum\":" + `${f.minimum}`;
  }
  if (f.hasMaximum) {
    extra = extra + ",\"maximum\":" + `${f.maximum}`;
  }
  if (f.allowedValues != "") {
    let values = f.allowedValues.split(",");
    let enumOut = "";
    let i: int = 0;
    while (i < values.length) {
      if (enumOut != "") {
        enumOut = enumOut + ",";
      }
      enumOut = enumOut + JSON.stringify(values[i].trim());
      i = i + 1;
    }
    extra = extra + ",\"enum\":[" + enumOut + "]";
  }
  return "{\"type\":" + JSON.stringify(known) + extra + "}";
}

function schemaObject(fields: OpenApiField[]): string {
  let properties = "";
  let required = "";
  let i: int = 0;
  while (i < fields.length) {
    let f = fields[i];
    if (properties != "") {
      properties = properties + ",";
    }
    properties = properties + JSON.stringify(f.name) + ":" + fieldPropertySchema(f);
    if (f.required) {
      if (required != "") {
        required = required + ",";
      }
      required = required + JSON.stringify(f.name);
    }
    i = i + 1;
  }
  let out = "{\"type\":\"object\",\"properties\":{" + properties + "}";
  if (required != "") {
    out = out + ",\"required\":[" + required + "]";
  }
  return out + "}";
}

function paramObject(p: OpenApiParam): string {
  return "{\"name\":" + JSON.stringify(p.name)
    + ",\"in\":" + JSON.stringify(p.location)
    + ",\"required\":" + (p.required ? "true" : "false")
    + ",\"schema\":" + propertySchema(p.paramType) + "}";
}

function requestBodyObject(bodyType: string): string {
  if (bodyType == "") {
    return "";
  }
  return "\"requestBody\":{\"required\":true,\"content\":{\"application/json\":{\"schema\":"
    + propertySchema(bodyType) + "}}}";
}

function responsesObject(responseType: string): string {
  if (responseType == "") {
    return "\"responses\":{\"200\":{\"description\":\"ok\"}}";
  }
  return "\"responses\":{\"200\":{\"description\":\"ok\",\"content\":{\"application/json\":{\"schema\":"
    + propertySchema(responseType) + "}}}}";
}

function operationObject(op: OpenApiOperation): string {
  let params = "";
  let i: int = 0;
  while (i < op.params.length) {
    if (params != "") {
      params = params + ",";
    }
    params = params + paramObject(op.params[i]);
    i = i + 1;
  }
  let out = "{\"operationId\":" + JSON.stringify(op.operationId) + ",\"parameters\":[" + params + "]";
  let body = requestBodyObject(op.bodyType);
  if (body != "") {
    out = out + "," + body;
  }
  return out + "," + responsesObject(op.responseType) + "}";
}

// Two operations sharing a method and a path is exactly what rest/server.ts's
// mountFault already refuses before it will listen — "AgentApi.list and
// ArchiveApi.list both serve GET /agents" — but that check runs over Route[],
// never over what @openapi built, so a document generated alongside it has no
// reason to inherit the refusal. Unchecked, pathsObject below would still
// build something: two "get" keys written into the same JSON object, which
// is not invalid syntax so much as invisible — every reader keeps only the
// last one and says nothing about the first, so the earlier of the two
// colliding routes silently vanishes from the document.
export function openApiFault(operations: OpenApiOperation[]): string {
  let seen = new Map<string, string>();
  let i: int = 0;
  while (i < operations.length) {
    let op = operations[i];
    let key = op.method + " " + op.path;
    let owner = seen.get(key) ?? "";
    if (owner != "" && owner != op.operationId) {
      return owner + " and " + op.operationId + " both answer " + key;
    }
    seen.set(key, op.operationId);
    i = i + 1;
  }
  return "";
}

// Every operation sharing a path becomes one path item, `{"get": {...}, "post":
// {...}}` — the spec's own shape — rather than one entry per method, which is
// why this groups instead of walking the flat list straight into text.
function pathsObject(operations: OpenApiOperation[]): string {
  let paths: string[] = [];
  let bodies = new Map<string, string>();
  let i: int = 0;
  while (i < operations.length) {
    let op = operations[i];
    if (!bodies.has(op.path)) {
      paths.push(op.path);
      bodies.set(op.path, "");
    }
    let prior = bodies.get(op.path) ?? "";
    let sep = prior == "" ? "" : ",";
    bodies.set(op.path, prior + sep + JSON.stringify(op.method.toLowerCase()) + ":" + operationObject(op));
    i = i + 1;
  }
  let out = "";
  let p: int = 0;
  while (p < paths.length) {
    if (out != "") {
      out = out + ",";
    }
    out = out + JSON.stringify(paths[p]) + ":{" + (bodies.get(paths[p]) ?? "") + "}";
    p = p + 1;
  }
  return "{" + out + "}";
}

function schemasObject(schemas: OpenApiSchema[]): string {
  let out = "";
  let i: int = 0;
  while (i < schemas.length) {
    if (out != "") {
      out = out + ",";
    }
    out = out + JSON.stringify(schemas[i].schemaName) + ":" + schemaObject(schemas[i].fields);
    i = i + 1;
  }
  return "{" + out + "}";
}

// The whole document, built once at startup from the same operations and
// schemas the pilot's api.ts assembles by hand — the same "an explicit array,
// not a scan" style `mounts: Mount[]` already uses.
export function openApiDocument(title: string, version: string, operations: OpenApiOperation[], schemas: OpenApiSchema[]): string {
  return "{\"openapi\":\"3.0.3\",\"info\":{\"title\":" + JSON.stringify(title)
    + ",\"version\":" + JSON.stringify(version) + "}"
    + ",\"paths\":" + pathsObject(operations)
    + ",\"components\":{\"schemas\":" + schemasObject(schemas) + "}}";
}
