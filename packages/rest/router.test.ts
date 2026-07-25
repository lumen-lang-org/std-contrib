// Matching, entirely without a socket. Every claim a router makes is a claim
// about strings, so none of these needs a server running.
//
//   cd packages/rest && lumen test router.test.ts

import { Route, Match, route, routes, match, allowedMethods, tableProblem, segments, splitQuery, parseQuery, decodeComponent } from "./router.ts";

function agentRoutes(): Route[] {
  return routes([
    route("GET", "/agents", "listAgents"),
    route("POST", "/agents", "createAgent"),
    route("GET", "/agents/:id", "findAgent"),
    route("PUT", "/agents/:id", "replaceAgent"),
    route("DELETE", "/agents/:id", "deleteAgent"),
    route("GET", "/agents/:id/tasks/:taskId", "findTask"),
  ]);
}

// --- splitting ---------------------------------------------------------------

test("a target splits into a path and a query", () => {
  expect(splitQuery("/agents/a1")[0] == "/agents/a1");
  expect(splitQuery("/agents/a1")[1] == "");
  expect(splitQuery("/agents?team=t1")[0] == "/agents");
  expect(splitQuery("/agents?team=t1")[1] == "team=t1");
  // A `?` inside the query is part of it, not a second split.
  expect(splitQuery("/a?q=x?y")[1] == "q=x?y");
});

test("a trailing slash is a typing habit, not a different resource", () => {
  expect(segments("/agents/").length == 1);
  expect(segments("/agents").length == 1);
  expect(segments("//agents//a1//").length == 2);
  expect(segments("/").length == 0);
});

test("percent and plus decode to the bytes they stand for", () => {
  expect(decodeComponent("a%20b") == "a b");
  expect(decodeComponent("a+b") == "a b");
  expect(decodeComponent("%2Fslash") == "/slash");
  expect(decodeComponent("caf%C3%A9") == "café");
  // A stray percent is data, not a crash.
  expect(decodeComponent("100%") == "100%");
  expect(decodeComponent("%zz") == "%zz");
});

test("a query becomes a map, and a bare key is a flag", () => {
  let q = parseQuery("team=t1&limit=10");
  expect(q.get("team") == "t1");
  expect(q.get("limit") == "10");
  let f = parseQuery("verbose&team=t1");
  expect(f.get("verbose") == "");
  expect(f.get("team") == "t1");
  expect(parseQuery("").size == 0);
  // Values are decoded.
  expect(parseQuery("q=a%20b").get("q") == "a b");
});

// --- matching ----------------------------------------------------------------

test("a literal path finds its handler", () => {
  let m = match(agentRoutes(), "GET", "/agents");
  expect(m.found);
  expect(m.handler == "listAgents");
  expect(m.params.size == 0);
});

test("the method selects between routes sharing a path", () => {
  expect(match(agentRoutes(), "GET", "/agents").handler == "listAgents");
  expect(match(agentRoutes(), "POST", "/agents").handler == "createAgent");
  expect(match(agentRoutes(), "DELETE", "/agents/a1").handler == "deleteAgent");
});

test("a method is matched regardless of case", () => {
  expect(match(agentRoutes(), "get", "/agents").found);
  expect(match(agentRoutes(), "GeT", "/agents").found);
});

test("a :name segment becomes a parameter", () => {
  let m = match(agentRoutes(), "GET", "/agents/a1");
  expect(m.found);
  expect(m.handler == "findAgent");
  expect(m.params.get("id") == "a1");
});

test("several parameters all arrive", () => {
  let m = match(agentRoutes(), "GET", "/agents/a1/tasks/k9");
  expect(m.found);
  expect(m.handler == "findTask");
  expect(m.params.get("id") == "a1");
  expect(m.params.get("taskId") == "k9");
});

test("a parameter is decoded, because an id is data", () => {
  let m = match(agentRoutes(), "GET", "/agents/a%20b");
  expect(m.found);
  expect(m.params.get("id") == "a b");
});

test("the query arrives alongside the parameters", () => {
  let m = match(agentRoutes(), "GET", "/agents/a1?fields=id&raw");
  expect(m.found);
  expect(m.params.get("id") == "a1");
  expect(m.query.get("fields") == "id");
  expect(m.query.get("raw") == "");
});

test("a path nobody claims is not found", () => {
  let m = match(agentRoutes(), "GET", "/teams");
  expect(!m.found);
  expect(!m.pathMatched);
});

test("a path claimed by another method says so, which is 405 not 404", () => {
  let m = match(agentRoutes(), "PATCH", "/agents/a1");
  expect(!m.found);
  // The difference a client acts on: the thing exists, not that way.
  expect(m.pathMatched);
  let allowed = allowedMethods(agentRoutes(), "/agents/a1");
  expect(allowed.indexOf("GET") >= 0);
  expect(allowed.indexOf("PUT") >= 0);
  expect(allowed.indexOf("DELETE") >= 0);
  expect(allowed.indexOf("POST") < 0);
});

test("a longer path does not match a shorter pattern", () => {
  expect(!match(agentRoutes(), "GET", "/agents/a1/tasks").found);
  expect(!match(agentRoutes(), "GET", "/agents/a1/tasks/k9/extra").found);
});

test("a parameter does not swallow a slash", () => {
  // `/agents/:id` must not match `/agents/a1/tasks` — otherwise an id could be
  // any suffix and the more specific route would never be reached.
  let m = match(agentRoutes(), "GET", "/agents/a1/tasks");
  expect(!m.found);
});

test("the first matching route wins, in the order written", () => {
  let table = routes([
    route("GET", "/agents/new", "newAgentForm"),
    route("GET", "/agents/:id", "findAgent"),
  ]);
  // The literal comes first, so it is reachable.
  expect(match(table, "GET", "/agents/new").handler == "newAgentForm");
  expect(match(table, "GET", "/agents/a1").handler == "findAgent");
});

// --- checking the table ------------------------------------------------------

test("a well-formed table reports no problem", () => {
  expect(tableProblem(agentRoutes()) == "");
});

test("an empty table is a problem, since a server with no routes is a mistake", () => {
  let none: Route[] = [];
  expect(tableProblem(none).indexOf("empty") >= 0);
});

test("a route naming no handler is refused", () => {
  expect(tableProblem(routes([route("GET", "/a", "")])).indexOf("names no handler") >= 0);
});

test("a pattern that does not start with / is refused", () => {
  expect(tableProblem(routes([route("GET", "agents", "h")])).indexOf("does not start with /") >= 0);
});

test("a pattern naming the same parameter twice is refused", () => {
  expect(tableProblem(routes([route("GET", "/a/:id/b/:id", "h")])).indexOf("twice") >= 0);
});

test("a : with no name after it is refused", () => {
  expect(tableProblem(routes([route("GET", "/a/:", "h")])).indexOf("no name after it") >= 0);
});

test("a route that can never match is refused at startup, not discovered in production", () => {
  let shadowed = routes([
    route("GET", "/agents/:id", "findAgent"),
    route("GET", "/agents/new", "newAgentForm"),
  ]);
  let problem = tableProblem(shadowed);
  // `/agents/:id` comes first and matches every path `/agents/new` would.
  expect(problem.indexOf("can never match") >= 0);
  expect(problem.indexOf("newAgentForm") < 0 || problem.indexOf("/agents/new") >= 0);
});

test("two routes differing only in parameter name are the same route", () => {
  let twice = routes([
    route("GET", "/agents/:id", "a"),
    route("GET", "/agents/:key", "b"),
  ]);
  expect(tableProblem(twice).indexOf("can never match") >= 0);
});

test("the same path under different methods is not a conflict", () => {
  expect(tableProblem(routes([
    route("GET", "/agents/:id", "find"),
    route("PUT", "/agents/:id", "replace"),
  ])) == "");
});
