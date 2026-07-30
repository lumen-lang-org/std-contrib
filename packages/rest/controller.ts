// The `@controller` decorator: a route table derived from a class, so the
// paths live beside the code that serves them.
//
//   @controller("/agents")
//   class AgentController {
//     @get("/")     list(req: Request): Reply { ... }
//     @get("/:id")  find(req: Request): Reply { ... }
//     @post("/")    create(req: Request): Reply { ... }
//     @del("/:id")  remove(req: Request): Reply { ... }
//   }
//
// The compiler runs `controller` while compiling and leaves the table behind
// as a constant named for the decorator and the class:
//
//   let controllerAgentController: Route[] = [
//     { method: "GET",    pattern: "/agents",     handler: "list" },
//     { method: "GET",    pattern: "/agents/:id", handler: "find" },
//     { method: "POST",   pattern: "/agents",     handler: "create" },
//     { method: "DELETE", pattern: "/agents/:id", handler: "remove" },
//   ];
//
// What it cannot do is call the methods. A decorator's value travels back as
// JSON, and JSON cannot carry a function, so a `Route` names its handler rather
// than holding one.
//
// Closing that gap used to be the program's job: bind each name to its method
// by hand and let `serve` refuse to start if a route had no binding. It is now
// `mount`'s, in server.ts, which reads this constant back off the class through
// `Class.decorator` and calls the methods through `Class.invoke` (spec 477).
// There is still no reflection and there will not be — the product is a native
// binary with no runtime type information — but both of those are resolved
// while compiling, so a route and its handler now come from the same class and
// cannot disagree. The hand-bound path still works; see `serve`.

import { Route, route } from "./router.ts";

// --- the description the compiler passes in ----------------------------------
//
// Declared here rather than imported because the compiler does not yet provide
// it as a type, and named `Description` because the decorator protocol
// requires that exact name — a decorator is `(d: Description) => T`.
//
// A decorator is handed only the keys its own Description declares (spec 459),
// so this may name what it uses and no more.

export type ControllerDecoratorUse = {
  name: string,
  args: string[],
};

export type ControllerParam = {
  name: string,
  type: string,
  decorators: ControllerDecoratorUse[],
};

export type ControllerMethod = {
  name: string,
  returns: string,
  params: ControllerParam[],
  decorators: ControllerDecoratorUse[],
};

export type ControllerField = {
  name: string,
  type: string,
  decorators: ControllerDecoratorUse[],
};

export type Description = {
  protocol: int,
  kind: string,
  name: string,
  args: string[],
  file: string,
  line: int,
  fields: ControllerField[],
  methods: ControllerMethod[],
};

// --- reading it --------------------------------------------------------------

export function methodArg(m: ControllerMethod, name: string, index: int): string {
  let i: int = 0;
  while (i < m.decorators.length) {
    if (m.decorators[i].name == name) {
      if (index < m.decorators[i].args.length) { return m.decorators[i].args[index]; }
      return "";
    }
    i = i + 1;
  }
  return "";
}

export function methodHas(m: ControllerMethod, name: string): bool {
  let i: int = 0;
  while (i < m.decorators.length) {
    if (m.decorators[i].name == name) { return true; }
    i = i + 1;
  }
  return false;
}

// The HTTP method a decorator names, or an empty string when it names none.
// The vocabulary is fixed here rather than in the compiler, which is the point
// of the design: adding `@patch` is editing this list, not the language.
export function httpMethodOf(m: ControllerMethod): string {
  if (methodHas(m, "get")) { return "GET"; }
  if (methodHas(m, "post")) { return "POST"; }
  if (methodHas(m, "put")) { return "PUT"; }
  if (methodHas(m, "patch")) { return "PATCH"; }
  if (methodHas(m, "del")) { return "DELETE"; }
  if (methodHas(m, "head")) { return "HEAD"; }
  return "";
}

// `delete` is a reserved word, so the decorator is `@del`. Naming it anything
// cleverer would be worse: this is the one place the language shows through.
export function routeDecoratorName(m: ControllerMethod): string {
  if (methodHas(m, "get")) { return "get"; }
  if (methodHas(m, "post")) { return "post"; }
  if (methodHas(m, "put")) { return "put"; }
  if (methodHas(m, "patch")) { return "patch"; }
  if (methodHas(m, "del")) { return "del"; }
  if (methodHas(m, "head")) { return "head"; }
  return "";
}

// The class's prefix joined to a method's path. `/agents` and `/:id` make
// `/agents/:id`; `/agents` and `/` make `/agents`, because a controller's own
// path is what its bare route serves.
export function joinPaths(prefix: string, tail: string): string {
  let head = prefix;
  while (head.endsWith("/")) { head = head.substring(0, head.length - 1); }
  let rest = tail;
  while (rest.startsWith("/")) { rest = rest.substring(1, rest.length); }
  if (head == "") { head = ""; }
  if (rest == "") {
    if (head == "") { return "/"; }
    return head;
  }
  return head + "/" + rest;
}

// --- the decorator -----------------------------------------------------------

export function controller(d: Description): Route[] {
  let out: Route[] = [];
  let prefix = "";
  if (d.args.length > 0) { prefix = d.args[0]; }

  let i: int = 0;
  while (i < d.methods.length) {
    let m = d.methods[i];
    let verb = httpMethodOf(m);
    if (verb != "") {
      let tail = methodArg(m, routeDecoratorName(m), 0);
      out.push(route(verb, joinPaths(prefix, tail), m.name));
    }
    i = i + 1;
  }
  return out;
}

// Why a class would not make a controller. A method with no route decorator is
// not an error — a controller may have helpers — but everything else is.
export function controllerProblem(d: Description): string {
  if (d.protocol != 1) {
    return "this decorator understands description protocol 1, not " + `${d.protocol}`;
  }
  if (d.kind != "class") {
    return "@controller goes on a class, not on a " + d.kind;
  }
  if (d.args.length == 0 || d.args[0] == "") {
    return "@controller needs a path: @controller(\"/agents\")";
  }
  if (!d.args[0].startsWith("/")) {
    return "the controller path \"" + d.args[0] + "\" does not start with /";
  }
  let routed: int = 0;
  let i: int = 0;
  while (i < d.methods.length) {
    let m = d.methods[i];
    if (httpMethodOf(m) != "") {
      routed = routed + 1;
      let verbs: int = 0;
      if (methodHas(m, "get")) { verbs = verbs + 1; }
      if (methodHas(m, "post")) { verbs = verbs + 1; }
      if (methodHas(m, "put")) { verbs = verbs + 1; }
      if (methodHas(m, "patch")) { verbs = verbs + 1; }
      if (methodHas(m, "del")) { verbs = verbs + 1; }
      if (methodHas(m, "head")) { verbs = verbs + 1; }
      if (verbs > 1) {
        return d.name + "." + m.name + " carries " + `${verbs}`
          + " route decorators, and a method answers one method and path";
      }
    }
    i = i + 1;
  }
  if (routed == 0) {
    return "no method of " + d.name + " has a route decorator, so it serves nothing";
  }
  return "";
}
