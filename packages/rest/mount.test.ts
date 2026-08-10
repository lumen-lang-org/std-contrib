// Mounted controllers, without a socket.
//
//   cd packages/rest && lumen test mount.test.ts
//
// Two controllers each with a `list`, a handler that throws, and a route with a
// path parameter — the three things the hand-written binding map used to be
// responsible for getting right.

import { controller } from "./controller.ts";
import { Route } from "./router.ts";
import { Request, Reply, Mount, mount, mountedRoutes, mountProblem, dispatchMounted, Ok, param } from "./server.ts";

// A record with a required field, so a parse of a partial body throws the way
// a real handler's does.
type NewAgent = {
  name: string,
};

function noHeaders(): Map<string, string> {
  return new Map<string, string>();
}

@controller("/agents")
class AgentApi {
  label: string;

  constructor(label: string) {
    this.label = label;
  }

  @get("/")
  list(req: Request): Reply {
    return Ok("[\"" + this.label + "\"]");
  }

  @get("/:id")
  find(req: Request): Reply {
    return Ok("{\"id\":" + JSON.stringify(param(req, "id")) + "}");
  }

  // The regression this design exists for: a PUT with a partial body. The
  // parse throws, and the process must still be here afterwards.
  @put("/:id")
  update(req: Request): Reply {
    let body = JSON.parse<NewAgent>(req.body);
    return Ok("{\"name\":" + JSON.stringify(body.name) + "}");
  }
}

@controller("/models")
class ModelApi {
  // The same name as AgentApi's. Nothing disambiguates it by hand.
  @get("/")
  list(req: Request): Reply {
    return Ok("[\"opus\"]");
  }
}

// The controllers, as themselves. A class instance where a `Mount` is expected
// goes through `mount` (spec 478), so the call site says which controllers
// there are and nothing else.
function mounted(): Mount[] {
  return [new AgentApi("lead"), new ModelApi()];
}

// The old form, unchanged: a `Mount` built by hand is still a `Mount`.
function mountedByHand(): Mount[] {
  return [mount(new AgentApi("lead")), mount(new ModelApi())];
}

function get(target: string): Reply {
  return dispatchMounted(mounted(), "GET", target, "", noHeaders());
}

test("each controller answers its own routes", () => {
  expect(get("/agents").body == "[\"lead\"]");
  expect(get("/models").body == "[\"opus\"]");
});

test("two controllers may both have a list", () => {
  let rs = mountedRoutes(mounted());
  let names: string[] = [];
  let i: int = 0;
  while (i < rs.length) {
    names.push(rs[i].handler);
    i = i + 1;
  }
  expect(names.indexOf("AgentApi.list") >= 0);
  expect(names.indexOf("ModelApi.list") >= 0);
});

test("a path parameter reaches the handler", () => {
  expect(get("/agents/a1").body == "{\"id\":\"a1\"}");
});

test("a handler that throws answers 400", () => {
  let r = dispatchMounted(mounted(), "PUT", "/agents/a1", "{}", noHeaders());
  expect(r.status == 400);
  expect(r.body.indexOf("could not be handled") >= 0);
});

test("the server is still answering afterwards", () => {
  let r = dispatchMounted(mounted(), "PUT", "/agents/a1", "{}", noHeaders());
  expect(r.status == 400);
  expect(get("/agents").status == 200);
});

test("a handler that does not throw is unaffected", () => {
  let r = dispatchMounted(mounted(), "PUT", "/agents/a1", "{\"name\":\"scout\"}", noHeaders());
  expect(r.status == 200);
  expect(r.body == "{\"name\":\"scout\"}");
});

test("a hand-built Mount still works", () => {
  let r = dispatchMounted(mountedByHand(), "GET", "/agents", "", noHeaders());
  expect(r.status == 200);
  expect(r.body == "[\"lead\"]");
  expect(mountProblem(mountedByHand()) == "");
});

test("an unknown path is 404", () => {
  expect(get("/nope").status == 404);
});

test("a known path with the wrong method is 405", () => {
  let r = dispatchMounted(mounted(), "DELETE", "/agents", "", noHeaders());
  expect(r.status == 405);
});

test("well-formed mounts report no problem", () => {
  expect(mountProblem(mounted()) == "");
});

test("two controllers claiming one path is a startup failure", () => {
  let twice: Mount[] = [new ModelApi(), new ModelApi()];
  expect(mountProblem(twice).indexOf("both serve GET /models") >= 0);
});

// The tracing regression: GET / and PUT / on one controller share the bare
// root pattern, and the PUT must reach the PUT handler — not the GET one that
// happens to sit first in the class.
@controller("/root")
class RootVerbs {
  @get("/")
  status(req: Request): Reply { return Ok("\"from-get\""); }
  @put("/")
  configure(req: Request): Reply { return Ok("\"from-put\""); }
}

test("a PUT on the controller's own root reaches the PUT handler", () => {
  let mounts: Mount[] = [mount(new RootVerbs())];
  expect(dispatchMounted(mounts, "PUT", "/root", "{}", noHeaders()).body == "\"from-put\"");
  expect(dispatchMounted(mounts, "GET", "/root", "", noHeaders()).body == "\"from-get\"");
});

// The full tracing shape: root GET and PUT plus a /key pair below them, and
// a constructor that takes arguments.
@controller("/shape")
class ShapeApi {
  db: string;
  master: string;
  constructor(db: string, master: string) { this.db = db; this.master = master; }
  @get("/")
  status(req: Request): Reply { return Ok("\"s-get\""); }
  @put("/")
  configure(req: Request): Reply { return Ok("\"s-put\""); }
  @put("/key")
  setKey(req: Request): Reply { return Ok("\"s-key\""); }
  @del("/key")
  clearKey(req: Request): Reply { return Ok("\"s-unkey\""); }
}

test("the tracing shape dispatches every verb to its own method", () => {
  let mounts: Mount[] = [mount(new ShapeApi("d", "m"))];
  expect(dispatchMounted(mounts, "PUT", "/shape", "{}", noHeaders()).body == "\"s-put\"");
  expect(dispatchMounted(mounts, "GET", "/shape", "", noHeaders()).body == "\"s-get\"");
  expect(dispatchMounted(mounts, "PUT", "/shape/key", "{}", noHeaders()).body == "\"s-key\"");
  expect(dispatchMounted(mounts, "DELETE", "/shape/key", "", noHeaders()).body == "\"s-unkey\"");
});

// The way api.ts actually mounts: class instances coerced to Mount by spec
// 478, several of them, in one array literal — not explicit mount() calls.
test("implicitly coerced mounts dispatch each verb to its own method", () => {
  let mounts: Mount[] = [new AgentApi("a"), new ModelApi(), new ShapeApi("d", "m"), new RootVerbs()];
  expect(dispatchMounted(mounts, "PUT", "/shape", "{}", noHeaders()).body == "\"s-put\"");
  expect(dispatchMounted(mounts, "GET", "/shape", "", noHeaders()).body == "\"s-get\"");
  expect(dispatchMounted(mounts, "PUT", "/root", "{}", noHeaders()).body == "\"from-put\"");
});
