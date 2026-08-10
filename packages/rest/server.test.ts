// Dispatch, without a socket.
//
// `dispatch` is split from `serve` so every route, every refusal and every
// binding failure is exercisable as a function call. A test that has to bind a
// port is a test that gets skipped.
//
//   cd packages/rest && lumen test server.test.ts

import { Route, route, routes } from "./router.ts";
import { Request, Reply, Handler, dispatch, dispatched, bindingProblem, Ok, Created, NoContent, Json, Refused, NotFound, BadRequest, param, queryParam, header, bearerToken } from "./server.ts";

// A record with a required field, to make a parse throw.
type ThrowTarget = {
  name: string,
};

function noHeaders(): Map<string, string> {
  return new Map<string, string>();
}

function agentRoutes(): Route[] {
  return routes([
    route("GET", "/agents", "list"),
    route("POST", "/agents", "create"),
    route("GET", "/agents/:id", "find"),
    route("DELETE", "/agents/:id", "remove"),
  ]);
}

// Handlers that report what they were given, so a test can see the request the
// dispatcher built rather than only the status it produced.
function boundHandlers(): Map<string, Handler> {
  let hs = new Map<string, Handler>();
  hs.set("list", (req: Request) => { return Ok("[\"a1\",\"a2\"]"); });
  hs.set("create", (req: Request) => { return Created(req.body); });
  hs.set("find", (req: Request) => { return Ok("{\"id\":" + JSON.stringify(param(req, "id")) + "}"); });
  hs.set("remove", (req: Request) => { return NoContent(); });
  return hs;
}

function get(target: string): Reply {
  return dispatch(agentRoutes(), boundHandlers(), "GET", target, "", noHeaders());
}

// --- routing through --------------------------------------------------------

test("a request reaches its handler", () => {
  let r = get("/agents");
  expect(r.status == 200);
  expect(r.body == "[\"a1\",\"a2\"]");
  expect(r.headers.get("content-type") == "application/json");
});

test("a path parameter reaches the handler", () => {
  let r = get("/agents/a1");
  expect(r.status == 200);
  expect(r.body == "{\"id\":\"a1\"}");
});

test("a body reaches the handler", () => {
  let r = dispatch(agentRoutes(), boundHandlers(), "POST", "/agents", "{\"id\":\"a9\"}", noHeaders());
  expect(r.status == 201);
  expect(r.body == "{\"id\":\"a9\"}");
});

test("a handler that returns no content says so without a body", () => {
  let r = dispatch(agentRoutes(), boundHandlers(), "DELETE", "/agents/a1", "", noHeaders());
  expect(r.status == 204);
  expect(r.body == "");
});

// --- refusing ----------------------------------------------------------------

test("an unknown path is 404, as JSON", () => {
  let r = get("/teams");
  expect(r.status == 404);
  expect(r.body.indexOf("\"error\"") >= 0);
  expect(r.headers.get("content-type") == "application/json");
});

test("a known path under the wrong method is 405, with Allow", () => {
  let r = dispatch(agentRoutes(), boundHandlers(), "PATCH", "/agents/a1", "", noHeaders());
  expect(r.status == 405);
  let allow = r.headers.get("allow") ?? "";
  expect(allow.indexOf("GET") >= 0);
  expect(allow.indexOf("DELETE") >= 0);
  // The distinction a client acts on: the resource exists, not that way.
  expect(allow.indexOf("POST") < 0);
});

test("an error body is JSON, not a sentence", () => {
  let r = Refused(418, "I'm a \"teapot\"");
  // The quotes inside the message are escaped, so a client can parse it.
  expect(r.body.indexOf("\\\"teapot\\\"") >= 0);
  expect(r.headers.get("content-type") == "application/json");
});

// --- bindings ----------------------------------------------------------------

test("a table whose handler nothing bound is refused before listening", () => {
  let hs = new Map<string, Handler>();
  hs.set("list", (req: Request) => { return Ok("[]"); });
  let problemText = bindingProblem(agentRoutes(), hs);
  // It names the route and the handler, so the fix is obvious.
  expect(problemText.indexOf("create") >= 0);
  expect(problemText.indexOf("POST /agents") >= 0);
});

test("a fully bound table reports no problem", () => {
  expect(bindingProblem(agentRoutes(), boundHandlers()) == "");
});

test("a structurally broken table is caught by the same check", () => {
  let hs = new Map<string, Handler>();
  hs.set("h", (req: Request) => { return Ok("[]"); });
  expect(bindingProblem(routes([route("GET", "agents", "h")]), hs).indexOf("does not start with /") >= 0);
});

test("an unbound handler at dispatch time is 500, not a crash", () => {
  // bindingProblem should have caught this at startup; if it somehow did not,
  // one bad route must not take the server down.
  let hs = new Map<string, Handler>();
  hs.set("list", (req: Request) => { return Ok("[]"); });
  let r = dispatch(agentRoutes(), hs, "GET", "/agents/a1", "", noHeaders());
  expect(r.status == 500);
});

// --- reading a request -------------------------------------------------------

test("a query parameter is read, with a fallback", () => {
  let hs = new Map<string, Handler>();
  hs.set("list", (req: Request) => { return Ok(queryParam(req, "limit", "10")); });
  let table = routes([route("GET", "/agents", "list")]);
  expect(dispatch(table, hs, "GET", "/agents?limit=50", "", noHeaders()).body == "50");
  expect(dispatch(table, hs, "GET", "/agents", "", noHeaders()).body == "10");
  // An empty value falls back too: `?limit=` said nothing.
  expect(dispatch(table, hs, "GET", "/agents?limit=", "", noHeaders()).body == "10");
});

test("a header is found however the client capitalised it", () => {
  let hs = new Map<string, Handler>();
  hs.set("list", (req: Request) => { return Ok(header(req, "Content-Type")); });
  let table = routes([route("GET", "/agents", "list")]);
  let sent = new Map<string, string>();
  // The server lowercases what it receives, so this is what a handler sees.
  sent.set("content-type", "application/json");
  expect(dispatch(table, hs, "GET", "/agents", "", sent).body == "application/json");
});

test("a missing header reads as empty, not as a failure", () => {
  let hs = new Map<string, Handler>();
  hs.set("list", (req: Request) => { return Ok("[" + header(req, "x-absent") + "]"); });
  let table = routes([route("GET", "/agents", "list")]);
  expect(dispatch(table, hs, "GET", "/agents", "", noHeaders()).body == "[]");
});

test("a bearer token is read off the Authorization header", () => {
  let hs = new Map<string, Handler>();
  hs.set("list", (req: Request) => { return Ok("[" + bearerToken(req) + "]"); });
  let table = routes([route("GET", "/agents", "list")]);

  let withToken = new Map<string, string>();
  withToken.set("authorization", "Bearer abc123");
  expect(dispatch(table, hs, "GET", "/agents", "", withToken).body == "[abc123]");

  // The scheme is matched case-insensitively, as the spec requires.
  let lower = new Map<string, string>();
  lower.set("authorization", "bearer abc123");
  expect(dispatch(table, hs, "GET", "/agents", "", lower).body == "[abc123]");

  // Anything else is no token rather than a wrong one.
  let basic = new Map<string, string>();
  basic.set("authorization", "Basic dXNlcjpwdw==");
  expect(dispatch(table, hs, "GET", "/agents", "", basic).body == "[]");
  expect(dispatch(table, hs, "GET", "/agents", "", noHeaders()).body == "[]");
});

test("the method reaches the handler already normalised", () => {
  let hs = new Map<string, Handler>();
  hs.set("list", (req: Request) => { return Ok(req.method); });
  let table = routes([route("GET", "/agents", "list")]);
  expect(dispatch(table, hs, "get", "/agents", "", noHeaders()).body == "GET");
});

// --- a handler that throws --------------------------------------------------------

// A handler that throws is NOT covered, and cannot be tested here — it panics
// rather than returning, so the case that would assert it kills the test run.
// The reduction lives in the comment on `dispatched`; the fix is a try inside
// the handler's own lambda, which the agents API has at every binding.

test("a handler that returns normally is untouched by the guard", () => {
  let hs = new Map<string, Handler>();
  hs.set("list", (req: Request) => { return Ok("[]"); });
  let table = routes([route("GET", "/things", "list")]);
  let reply = dispatched(table, hs, "GET", "/things", "", noHeaders());
  expect(reply.status == 200);
  expect(reply.body == "[]");
});

test("the guard does not swallow a 404 or a 405", () => {
  // Those are answers, not failures, and turning them into 400 would lose the
  // Allow header a client needs.
  let hs = new Map<string, Handler>();
  hs.set("list", (req: Request) => { return Ok("[]"); });
  let table = routes([route("GET", "/things", "list")]);
  expect(dispatched(table, hs, "GET", "/nope", "", noHeaders()).status == 404);
  expect(dispatched(table, hs, "DELETE", "/things", "", noHeaders()).status == 405);
});
