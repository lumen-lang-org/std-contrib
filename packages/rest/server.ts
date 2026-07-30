// Serving controllers: the glue between the router and the language's HTTP
// server, and the JSON a REST API is made of.
//
//   listen(8080, [new AgentController(db), new ModelController(db)]);
//
// That is the whole call site. No route table is walked, no handler-name
// prefix is invented so two controllers can both have a `list`, and no binding
// map is written out — `mount` says all of it once, generically, using what the
// compiler knows about the class (spec 477):
//
//   Class.nameOf(c)                    "AgentController"
//   Class.decorator(c, "controller")   the Route[] @controller left behind
//   Class.invoke(c, handler, req)      c.list(req), chosen by the string
//
// There is still no reflection in the binary: all three are resolved while
// compiling and rewritten in place, and `Class.invoke` becomes a chain of
// direct method calls. That is what lets `mount` hold the one `try` that
// guards every handler of every controller — a direct call propagates a throw
// (spec 245/247), which a call through a function value does not.
//
// The word `mount` is absent from that call site because a class instance where
// a named record is expected goes through the one generic `f<T>(c: T): R` the
// program declares, which is `mount` (spec 478). Writing it out still compiles
// and means the same thing.
//
// The older three-argument form below (`serve(port, table, handlers)`) still
// works and is unchanged; a program that wrote its own bindings keeps them. It
// is the right answer only for a table that was not derived from a class, since
// there is then no class for `Class.*` to know anything about.

import { Route, Match, match, route, allowedMethods, tableProblem } from "./router.ts";

// What a handler is given. The path parameters and query are already parsed;
// the body and headers are the request's own.
export type Request = {
  method: string,
  path: string,
  body: string,
  headers: Map<string, string>,
  params: Map<string, string>,
  query: Map<string, string>,
};

// What a handler returns. `headers` carries whatever the handler chooses to
// send; `json` and its neighbours below fill in the usual ones.
export type Reply = {
  status: int,
  body: string,
  headers: Map<string, string>,
};

export type Handler = (req: Request) => Reply;

// --- replies -----------------------------------------------------------------

export function reply(status: int, body: string, contentType: string): Reply {
  let headers = new Map<string, string>();
  headers.set("content-type", contentType);
  let r: Reply = { status: status, body: body, headers: headers };
  return r;
}

// A JSON reply. plume's reads already return JSON, so a handler that fetches a
// record hands it straight over — no re-serialising, and no chance of the two
// disagreeing.
export function json(status: int, body: string): Reply {
  return reply(status, body, "application/json");
}

export function ok(body: string): Reply { return json(200, body); }
export function created(body: string): Reply { return json(201, body); }

// The work was taken but is not done — a queued job, not a finished one.
// Answering 201 for something merely accepted tells a client the resource
// exists when it does not yet.
export function accepted(body: string): Reply { return json(202, body); }

export function noContent(): Reply {
  return reply(204, "", "application/json");
}

// An error as a JSON document, because a client parsing the body should not
// have to guess whether it got JSON or a sentence.
export function problem(status: int, message: string): Reply {
  return json(status, "{\"error\":" + JSON.stringify(message) + "}");
}

export function notFound(what: string): Reply {
  return problem(404, what + " not found");
}

export function badRequest(why: string): Reply {
  return problem(400, why);
}

// --- reading a request -------------------------------------------------------

export function param(req: Request, name: string): string {
  return req.params.get(name) ?? "";
}

export function queryParam(req: Request, name: string, fallback: string): string {
  let v = req.query.get(name) ?? "";
  if (v == "") { return fallback; }
  return v;
}

// A header, found case-insensitively. The server lowercases what it receives,
// so a caller asking for "Authorization" and one asking for "authorization"
// get the same answer.
export function header(req: Request, name: string): string {
  return req.headers.get(name.toLowerCase()) ?? "";
}

// The bearer token, or an empty string. Its own function because every API
// grows this and every one writes it slightly differently.
export function bearerToken(req: Request): string {
  let auth = header(req, "authorization");
  let prefix = "Bearer ";
  if (auth.length <= prefix.length) { return ""; }
  if (auth.substring(0, prefix.length).toLowerCase() != prefix.toLowerCase()) { return ""; }
  return auth.substring(prefix.length, auth.length).trim();
}

function emptyRequest(): Request {
  let r: Request = {
    method: "",
    path: "",
    body: "",
    headers: new Map<string, string>(),
    params: new Map<string, string>(),
    query: new Map<string, string>(),
  };
  return r;
}

// --- dispatch ----------------------------------------------------------------

// Stands in for a binding that is not there. Unreachable once bindingProblem
// has passed, but a Map lookup has to have something to fall back to.
function unboundHandler(req: Request): Reply {
  return problem(500, "no handler bound");
}

// Why a table and its bindings do not agree. Called before listening: a route
// naming a handler nobody bound is a mistake to fail on, not one to discover
// from a 500 in production.
export function bindingProblem(table: Route[], handlers: Map<string, Handler>): string {
  let structural = tableProblem(table);
  if (structural != "") { return structural; }
  let i: int = 0;
  while (i < table.length) {
    if (!handlers.has(table[i].handler)) {
      return "the route " + table[i].method + " " + table[i].pattern
        + " names the handler \"" + table[i].handler + "\", which nothing bound";
    }
    i = i + 1;
  }
  return "";
}

// One request, answered. Separate from `serve` so a test can exercise every
// route without a socket — which is how the suite for this file works.
export function dispatch(table: Route[], handlers: Map<string, Handler>, method: string, target: string, body: string, headers: Map<string, string>): Reply {
  let m = match(table, method, target);
  if (!m.found) {
    if (m.pathMatched) {
      // The resource exists, just not that way — a distinction a client acts
      // on, so it gets the Allow header it is owed.
      let answer = problem(405, method.toUpperCase() + " is not allowed here");
      answer.headers.set("allow", allowedMethods(table, target).join(", "));
      return answer;
    }
    return notFound(target);
  }
  if (!handlers.has(m.handler)) {
    // bindingProblem should have caught this before listening; answering 500
    // rather than crashing keeps one bad route from taking the server down.
    return problem(500, "no handler bound for \"" + m.handler + "\"");
  }
  let handler: Handler = handlers.get(m.handler) ?? unboundHandler;
  let req: Request = {
    method: method.toUpperCase(),
    path: target,
    body: body,
    headers: headers,
    params: m.params,
    query: m.query,
  };
  return handler(req);
}

// Routing that answers instead of dying.
//
// What this catches: a throw raised on the way to a handler — matching the
// path, reading the query. Those are direct calls, and spec 245 propagates a
// throw through those.
//
// What it CANNOT catch, and this is the part to know: a throw inside the
// handler itself. A handler arrives as a function value, spec 245's fixpoint
// pass cannot see through one, and the callee is emitted as non-throwing —
// so the throw panics at the handler and no try up here ever runs. Reduced to
// thirty lines: a throw inside a named function called from a try is caught,
// the same throw inside a lambda is not.
//
// A wrapper taking a Handler and returning a guarded one is the obvious fix
// and does not compile — the backend rejects a returned closure that calls a
// captured parameter. So a handler bound here that parses a body must hold its
// own try, inside its own lambda, which is where it works, and one left out is
// still fatal. That is the trap `mount` exists to close: a controller reached
// through `Class.invoke` needs none of this, because the call is direct.
//
// The status is 400: a request the router could not make sense of is the
// request's fault. A handler failing for its own reasons should return
// `problem(500, ...)` rather than throw.
export function dispatched(table: Route[], handlers: Map<string, Handler>, method: string, target: string,
    body: string, headers: Map<string, string>): Reply {
  try {
    return dispatch(table, handlers, method, target, body, headers);
  } catch (e) {
    return badRequest("the request could not be handled: " + e.message);
  }
}

// --- listening ---------------------------------------------------------------

// Serve the table on `port`. Returns a description of what went wrong, or an
// empty string if it never returns at all.
export function serve(port: int, table: Route[], handlers: Map<string, Handler>): string {
  let problemText = bindingProblem(table, handlers);
  if (problemText != "") { return problemText; }

  // The buffered form: a handler is given the request and returns the
  // response. The streaming form exists too (spec 452) and is what a
  // long-running agent reply would want; a REST table does not.
  http.createServer(port, (req): HttpResponse => {
    let answer = dispatched(table, handlers, req.method, req.path, req.body, req.headers);
    let out: HttpResponse = { status: answer.status, body: answer.body, ok: true, headers: answer.headers };
    return out;
  });
  return "";
}

// --- controllers -------------------------------------------------------------

// One mounted controller: its class name, the routes its `@controller` left
// behind, and the one way in. `call` is a closure over the instance holding the
// `try` that guards every one of its handlers, so nothing outside this file
// ever reaches a handler unguarded.
export type Mount = {
  controller: string,
  routes: Route[],
  call: (handler: string, req: Request) => Reply,
};

// Mount a `@controller` class. Said once, generically, for every controller
// there will ever be.
//
// The `try` is the point. `Class.invoke` lowers to direct method calls, so a
// handler that throws — `JSON.parse<T>` on a body missing a field is the usual
// way — comes back as a throw and is answered 400. Before this, a `try` here
// could not have worked: a handler arrived as a function value, and spec 245's
// fixpoint pass cannot see through one, so the throw killed the process.
export function mount<T>(c: T): Mount {
  let m: Mount = {
    controller: Class.nameOf(c),
    routes: Class.decorator(c, "controller"),
    call: (handler: string, req: Request) => {
      try { return Class.invoke(c, handler, req); }
      catch (e) {
        let bad: Reply = badRequest("the request could not be handled: " + e.message);
        return bad;
      }
    },
  };
  return m;
}

// Every route, with its handler qualified by the controller it came from —
// `AgentApi.list`, never a prefix a program chose. For logging and for the
// message `mountProblem` gives; dispatch never uses it, because each mount is
// matched against its own routes and there is no shared keyspace to collide in.
export function mountedRoutes(mounts: Mount[]): Route[] {
  let out: Route[] = [];
  let i: int = 0;
  while (i < mounts.length) {
    let j: int = 0;
    while (j < mounts[i].routes.length) {
      let r = mounts[i].routes[j];
      out.push(route(r.method, r.pattern, mounts[i].controller + "." + r.handler));
      j = j + 1;
    }
    i = i + 1;
  }
  return out;
}

// Why a set of mounts will not serve. A route with no handler is no longer one
// of the answers: the routes come from the decorator, which read them off the
// class's own methods, and the dispatch comes from the same class, so the two
// cannot disagree. What is left is a table that is malformed on its own terms,
// and two controllers claiming one path — which is silent otherwise, since the
// first mount would simply win.
export function mountProblem(mounts: Mount[]): string {
  let i: int = 0;
  while (i < mounts.length) {
    let structural = tableProblem(mounts[i].routes);
    if (structural != "") { return mounts[i].controller + ": " + structural; }
    i = i + 1;
  }
  let seen = new Map<string, string>();
  let all = mountedRoutes(mounts);
  let k: int = 0;
  while (k < all.length) {
    let key = all[k].method + " " + all[k].pattern;
    let owner = seen.get(key) ?? "";
    if (owner != "") {
      return owner + " and " + all[k].handler + " both serve " + key;
    }
    seen.set(key, all[k].handler);
    k = k + 1;
  }
  return "";
}

// One request, answered from the mounted controllers. Separate from `listen` so
// a test can exercise every route without a socket.
export function dispatchMounted(mounts: Mount[], method: string, target: string, body: string, headers: Map<string, string>): Reply {
  let pathSeen = false;
  let i: int = 0;
  while (i < mounts.length) {
    let m = match(mounts[i].routes, method, target);
    if (m.found) {
      let req: Request = {
        method: method.toUpperCase(),
        path: target,
        body: body,
        headers: headers,
        params: m.params,
        query: m.query,
      };
      return mounts[i].call(m.handler, req);
    }
    if (m.pathMatched) { pathSeen = true; }
    i = i + 1;
  }
  if (pathSeen) {
    // The resource exists, just not that way — the same distinction the
    // table-based dispatch draws, collected across every mount.
    let answer = problem(405, method.toUpperCase() + " is not allowed here");
    let allowed: string[] = [];
    let j: int = 0;
    while (j < mounts.length) {
      let each = allowedMethods(mounts[j].routes, target);
      let n: int = 0;
      while (n < each.length) {
        if (allowed.indexOf(each[n]) < 0) { allowed.push(each[n]); }
        n = n + 1;
      }
      j = j + 1;
    }
    answer.headers.set("allow", allowed.join(", "));
    return answer;
  }
  return notFound(target);
}

// Routing that answers instead of dying. A handler's own throw is already
// caught inside its mount; this catches a throw on the way to one — matching
// the path, reading the query — which is a direct call and so does propagate.
export function dispatchedMounted(mounts: Mount[], method: string, target: string, body: string, headers: Map<string, string>): Reply {
  try {
    return dispatchMounted(mounts, method, target, body, headers);
  } catch (e) {
    return badRequest("the request could not be handled: " + e.message);
  }
}

// Serve the mounted controllers on `port`. Returns a description of what went
// wrong, or an empty string if it never returns at all.
export function listen(port: int, mounts: Mount[]): string {
  let problemText = mountProblem(mounts);
  if (problemText != "") { return problemText; }

  http.createServer(port, (req): HttpResponse => {
    let answer = dispatchedMounted(mounts, req.method, req.path, req.body, req.headers);
    let out: HttpResponse = { status: answer.status, body: answer.body, ok: true, headers: answer.headers };
    return out;
  });
  return "";
}
