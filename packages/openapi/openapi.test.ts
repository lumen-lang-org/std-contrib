// @openapi, exercised through a real @controller/@bindings class — no
// compiler-internals mock, the way rest/mount.test.ts proves @controller by
// actually declaring one.
//
// A separate file from openapi-schema.test.ts on purpose: rest/controller.ts
// and validation/validation.ts each declare their own `Description` type, and
// two packages exporting the same type name collide the moment both are
// imported into one file — which production code never does (a DTO's own file
// imports validation.ts; its controller's file imports controller.ts), so this
// keeps the same split.
//
//   cd packages/openapi && lumen test openapi.test.ts

import { OpenApiOperation, Returns, openApiHandlerInfoOf, openApiOperations, openApiPath, openapi } from "./openapi.ts";
import { bindings, controller } from "../rest/controller.ts";
import { Reply, Request, Ok, OkJson, mount } from "../rest/server.ts";
import { Bound } from "../rest/plan.ts";

// A plain DTO, undecorated — @openapi only needs its name as the request/
// response body type, never its own shape; that is @schema's file to prove.
class AgentBody {
  agentName: string;
  enabled: bool;

  constructor(agentName: string, enabled: bool) {
    this.agentName = agentName;
    this.enabled = enabled;
  }
}

@controller("/agents")
@bindings
@openapi
class AgentApi {
  @Get("/")
  list(req: Request): Reply {
    return Ok("[]");
  }

  @Get("/:id")
  @Returns("AgentBody")
  find(@PathVariable("id") id: string): Reply {
    return OkJson("{\"id\":\"" + id + "\"}");
  }

  @Post("/")
  @Returns("AgentBody")
  create(@RequestBody body: AgentBody): Reply {
    return OkJson("{\"agentName\":\"" + body.agentName + "\"}");
  }

  @Get("/search")
  search(@RequestParam("q") q: string): Reply {
    return OkJson("{\"q\":\"" + q + "\"}");
  }
}

test("a class path segment becomes a spec path parameter", () => {
  expect(openApiPath("/agents/:id") == "/agents/{id}");
  expect(openApiPath("/agents") == "/agents");
  expect(openApiPath("/") == "/");
});

test("openApiOperations reads @controller's own Route[], enriched by @openapi", () => {
  // The path, the method and the dedup guarantee all come from mount() —
  // rest/server.ts's own, the same one listen() uses — not from a second copy
  // @openapi reconstructed itself. This is the point: rename a route in
  // @controller and there is nothing else to keep in sync.
  let m = mount(new AgentApi());
  let info = openApiHandlerInfoOf(new AgentApi());
  let ops: OpenApiOperation[] = openApiOperations(m.routes, m.controller, info);
  expect(ops.length == 4);

  let list = ops[0];
  expect(list.method == "GET");
  expect(list.path == "/agents");
  expect(list.operationId == "AgentApi.list");
  expect(list.params.length == 0);
  expect(list.bodyType == "");
  expect(list.responseType == "");

  let find = ops[1];
  expect(find.method == "GET");
  expect(find.path == "/agents/{id}");
  expect(find.params.length == 1);
  expect(find.params[0].name == "id");
  expect(find.params[0].location == "path");
  expect(find.params[0].paramType == "string");
  expect(find.params[0].required);
  expect(find.responseType == "AgentBody");

  let create = ops[2];
  expect(create.method == "POST");
  expect(create.bodyType == "AgentBody");
  expect(create.responseType == "AgentBody");

  let search = ops[3];
  expect(search.path == "/agents/search");
  expect(search.params[0].location == "query");
  expect(!search.params[0].required);
});
