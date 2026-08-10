// The @controller decorator, tested by calling it — no compiler, no socket.
//
//   cd packages/rest && lumen test controller.test.ts

import { Description, ControllerMethod, ControllerParam, ControllerField, ControllerDecoratorUse, controller, controllerProblem, joinPaths, httpMethodOf, methodArg } from "./controller.ts";
import { Route, match, tableProblem } from "./router.ts";

function on(name: string, args: string[]): ControllerDecoratorUse {
  let u: ControllerDecoratorUse = { name: name, args: args };
  return u;
}

function controllerMethod(name: string, decorators: ControllerDecoratorUse[]): ControllerMethod {
  let none: ControllerParam[] = [];
  let m: ControllerMethod = { name: name, returns: "Response", params: none, decorators: decorators };
  return m;
}

// What the compiler hands @controller for:
//
//   @controller("/agents")
//   class AgentController {
//     @get("/")       list(req: Request): Response
//     @get("/:id")    find(req: Request): Response
//     @post("/")      create(req: Request): Response
//     @del("/:id")    remove(req: Request): Response
//                     helper(): string            // no decorator
//   }
function agentController(): Description {
  let none: ControllerDecoratorUse[] = [];
  let noFields: ControllerField[] = [];
  let methods: ControllerMethod[] = [
    controllerMethod("list", [on("get", ["/"])]),
    controllerMethod("find", [on("get", ["/:id"])]),
    controllerMethod("create", [on("post", ["/"])]),
    controllerMethod("remove", [on("del", ["/:id"])]),
    controllerMethod("helper", none),
  ];
  let d: Description = {
    protocol: 1, kind: "class", name: "AgentController", args: ["/agents"],
    file: "api.ts", line: 3, fields: noFields, methods: methods,
  };
  return d;
}

test("a decorated class becomes a route table", () => {
  let table = controller(agentController());
  expect(table.length == 4);
  expect(table[0].method == "GET");
  expect(table[0].pattern == "/agents");
  expect(table[0].handler == "list");
});

test("the class path and the method path join", () => {
  let table = controller(agentController());
  expect(table[1].pattern == "/agents/:id");
  expect(table[1].handler == "find");
});

test("a method with no route decorator serves nothing", () => {
  let table = controller(agentController());
  let i: int = 0;
  let sawHelper = false;
  while (i < table.length) {
    if (table[i].handler == "helper") { sawHelper = true; }
    i = i + 1;
  }
  expect(!sawHelper);
});

test("each verb becomes its HTTP method", () => {
  let table = controller(agentController());
  expect(table[2].method == "POST");
  // `@delete` is the verb; `@del` is kept for code written against it.
  expect(table[3].method == "DELETE");
  expect(table[3].pattern == "/agents/:id");
});

test("paths join without doubling or dropping a slash", () => {
  expect(joinPaths("/agents", "/") == "/agents");
  expect(joinPaths("/agents", "") == "/agents");
  expect(joinPaths("/agents", "/:id") == "/agents/:id");
  expect(joinPaths("/agents/", "/:id") == "/agents/:id");
  expect(joinPaths("/agents", ":id") == "/agents/:id");
  expect(joinPaths("/", "/") == "/");
  expect(joinPaths("/api/v1", "/agents/:id") == "/api/v1/agents/:id");
});

test("the generated table is one the router accepts and matches", () => {
  let table = controller(agentController());
  expect(tableProblem(table) == "");
  let m = match(table, "GET", "/agents/a1");
  expect(m.found);
  expect(m.handler == "find");
  expect(m.params.get("id") == "a1");
  expect(match(table, "POST", "/agents").handler == "create");
  expect(match(table, "DELETE", "/agents/a1").handler == "remove");
});

// --- what it refuses ---------------------------------------------------------

test("a well-formed controller reports no problem", () => {
  expect(controllerProblem(agentController()) == "");
});

test("a protocol it does not know is refused", () => {
  let d = agentController();
  let future: Description = {
    protocol: 2, kind: d.kind, name: d.name, args: d.args,
    file: d.file, line: d.line, fields: d.fields, methods: d.methods,
  };
  expect(controllerProblem(future).indexOf("protocol 1") >= 0);
});

test("a missing or relative path is refused", () => {
  let d = agentController();
  let empty: string[] = [];
  let noPath: Description = {
    protocol: d.protocol, kind: d.kind, name: d.name, args: empty,
    file: d.file, line: d.line, fields: d.fields, methods: d.methods,
  };
  expect(controllerProblem(noPath).indexOf("needs a path") >= 0);

  let relative: string[] = ["agents"];
  let bad: Description = {
    protocol: d.protocol, kind: d.kind, name: d.name, args: relative,
    file: d.file, line: d.line, fields: d.fields, methods: d.methods,
  };
  expect(controllerProblem(bad).indexOf("does not start with /") >= 0);
});

test("a method carrying two verbs is refused, naming it", () => {
  let d = agentController();
  let methods: ControllerMethod[] = [ controllerMethod("both", [on("get", ["/"]), on("post", ["/"])]) ];
  let two: Description = {
    protocol: d.protocol, kind: d.kind, name: "AgentController", args: d.args,
    file: d.file, line: d.line, fields: d.fields, methods: methods,
  };
  let problem = controllerProblem(two);
  expect(problem.indexOf("AgentController.both") >= 0);
  expect(problem.indexOf("2 route decorators") >= 0);
});

test("a class serving nothing is refused", () => {
  let d = agentController();
  let none: ControllerDecoratorUse[] = [];
  let methods: ControllerMethod[] = [ controllerMethod("helper", none) ];
  let bare: Description = {
    protocol: d.protocol, kind: d.kind, name: "AgentController", args: d.args,
    file: d.file, line: d.line, fields: d.fields, methods: methods,
  };
  expect(controllerProblem(bare).indexOf("serves nothing") >= 0);
});

test("two controllers can share a prefix without colliding", () => {
  let d = agentController();
  let methods: ControllerMethod[] = [ controllerMethod("list", [on("get", ["/"])]) ];
  let teams: Description = {
    protocol: 1, kind: "class", name: "TeamController", args: ["/teams"],
    file: "api.ts", line: 20, fields: d.fields, methods: methods,
  };
  let both: Route[] = [];
  let a = controller(d);
  let b = controller(teams);
  let i: int = 0;
  while (i < a.length) { both.push(a[i]); i = i + 1; }
  let j: int = 0;
  while (j < b.length) { both.push(b[j]); j = j + 1; }
  expect(tableProblem(both) == "");
  expect(match(both, "GET", "/teams").handler == "list");
  expect(match(both, "GET", "/agents").handler == "list");
});

test("@delete and @del both mean DELETE", () => {
  let d = agentController();
  let methods: ControllerMethod[] = [
    controllerMethod("remove", [on("delete", ["/:id"])]),
    controllerMethod("drop", [on("del", ["/:id/hard"])]),
  ];
  let spelled: Description = {
    protocol: 1, kind: "class", name: "ThingController", args: ["/things"],
    file: "api.ts", line: 4, fields: d.fields, methods: methods,
  };
  let table = controller(spelled);
  expect(table.length == 2);
  expect(match(table, "DELETE", "/things/x").handler == "remove");
  expect(match(table, "DELETE", "/things/x/hard").handler == "drop");
});
