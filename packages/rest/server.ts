// Serving a route table: the glue between the router and the language's HTTP
// server, and the JSON a REST API is made of.
//
//   let api = new AgentController(database);
//   let handlers = new Map<string, Handler>();
//   handlers.set("list", (req: Request) => { return api.list(req); });
//   handlers.set("find", (req: Request) => { return api.find(req); });
//
//   serve(8080, controllerAgentController, handlers);
//
// The binding is written out because the decorator cannot call a method: there
// is no reflection here and there will not be. What that buys is that `serve`
// checks the table against the bindings before it listens, so a route with no
// handler is a startup failure naming the route rather than a 500 a user
// finds.

import { Route, Match, match, allowedMethods, tableProblem } from "./router.ts";

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
    let answer = dispatch(table, handlers, req.method, req.path, req.body, req.headers);
    let out: HttpResponse = { status: answer.status, body: answer.body, ok: true, headers: answer.headers };
    return out;
  });
  return "";
}
