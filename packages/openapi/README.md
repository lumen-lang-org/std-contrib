# openapi

An OpenAPI 3.0 document, generated the way `rest`'s own route table is: two
decorators the compiler runs while compiling, leaving constants behind — no
scanning, no runtime reflection, nothing to keep in sync by hand.

```ts
@controller("/agents")
@bindings
@openapi
class AgentApi {
  @Get("/")
  list(req: Request): Reply { ... }

  @Get("/:id")
  @Returns("AgentBody")
  find(@PathVariable("id") id: string): Reply { ... }

  @Post("/")
  @Returns("AgentBody")
  create(@RequestBody body: AgentBody): Reply { ... }
}
```

```ts
@validated
@schema
class AgentBody {
  @Required("an agent needs a name")
  agentName: string;
  enabled: bool;
}
```

## What `@openapi` does and does not build

`@openapi` reads the same `@Get`/`@Post`/`@PathVariable`/`@RequestParam`/
`@RequestBody` decorators `@controller`/`@bindings` already read, per handler:
its parameters, their location (path/query/header) and type, its request body
type, and its declared response type (`@Returns("AgentBody")` — Lumen has no
dynamic JSON type, so a handler's return type is always `Reply` and never says
what JSON is inside it; this is the one thing no decorator can read on its
own).

**It does not build the path or the method.** A decorator's `Description`
holds only its own arguments, never a sibling decorator's (Lumen spec 459), so
`@openapi` has no way to see `@controller`'s own path prefix except by being
told again — and writing a prefix twice is exactly the kind of copy that
drifts silently from the original. Instead, `openApiOperations` cross-
references what `@openapi` reports against the real, already-deduplicated
`Route[]` `@controller` built — the same one `rest/server.ts`'s `mountFault`
already checks before `listen` will bind. One source of truth for what a
route is; `@openapi` only adds to it.

## Usage

```ts
import { mount } from "../rest/server.ts";
import { openApiDocument, openApiFault, openApiHandlerInfoOf, openApiOperations, openApiSchemaOf } from "../openapi/openapi.ts";

let m = mount(new AgentApi());
let info = openApiHandlerInfoOf(new AgentApi());
let ops = openApiOperations(m.routes, m.controller, info);

let schemas = [openApiSchemaOf(new AgentBody("", false))];

let fault = openApiFault(ops);   // "" once mountFault(mounts) has already answered ""
let doc = openApiDocument("Agents API", "0.1.0", ops, schemas);
```

`doc` is the JSON text of the whole document — `openapi`, `info`, `paths`,
`components.schemas` — ready to serve from a plain `GET /openapi.json`
handler.

## Why two decorators live in separate files from their callers

`rest/controller.ts` and `validation/validation.ts` each declare their own
`Description` type, and Lumen refuses a compilation where both are reachable
from one file by name (confirmed with `strace` against a real compile, not
guessed — see `openapi.ts`'s own header comment). Production code never hits
this: a controller file imports `rest/controller.ts` and the DTO *classes* it
uses, never `validation.ts`'s names directly; a DTO's own file imports
`validation.ts` and never `rest/controller.ts`. `openapi.ts` follows the same
split, and is otherwise self-contained — it declares its own copies of every
description-shaped type it reads rather than importing `rest/controller.ts`'s,
on the same evidence: the compiler's real decorator-invocation JSON carries an
`argsText` key neither `rest/controller.ts`'s types nor an earlier version of
this package's own types declared.

## Public functions

- `openapi(d): OpenApiHandlerInfo[]` / `schema(d): OpenApiField[]` — the two
  decorators.
- `Returns(dtoTypeName)` — a marker decorator, never invoked, for a handler
  to name its response body's type.
- `openApiHandlerInfoOf(c)` / `openApiSchemaOf(c)` — read a decorated
  instance's baked constant at runtime (`Class.decorator`, resolved while
  compiling, same mechanism `rest/server.ts`'s `mount` uses).
- `openApiOperations(routes, controllerName, info)` — cross-references a
  real `Route[]` against `@openapi`'s per-handler output.
- `openApiFault(operations)` — refuses two operations answering the same
  method and path, naming both; a redundant backstop once operations are
  derived from an already-`mountFault`-checked `Route[]`, kept because the
  document is also buildable from operations assembled by hand.
- `openApiPath(pattern)` — `/agents/:id` → `/agents/{id}`.
- `openApiDocument(title, version, operations, schemas)` — the whole
  document, as JSON text.

## Check it locally

```sh
cd packages/openapi
lumen test openapi.test.ts           # @openapi, through a real @controller class
lumen test openapi-schema.test.ts    # @schema, through a real @validated DTO
lumen test openapi-document.test.ts  # the document itself: paths, $ref, dedup
```
