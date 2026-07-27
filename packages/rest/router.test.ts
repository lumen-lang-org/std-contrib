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

// --- the trailing wildcard ---------------------------------------------------

function fileRoutes(): Route[] {
  return routes([
    route("GET", "/files/:box/v/:n", "readVersion"),
    route("GET", "/files/:box", "readBox"),
    route("GET", "/files/:box/*path", "readFile"),
  ]);
}

test("a *name segment captures the whole rest of the path", () => {
  let m = match(fileRoutes(), "GET", "/files/b1/css/main.css");
  expect(m.found);
  expect(m.handler == "readFile");
  expect(m.params.get("box") == "b1");
  expect(m.params.get("path") == "css/main.css");
});

test("a wildcard captures one segment as readily as many", () => {
  let m = match(fileRoutes(), "GET", "/files/b1/index.html");
  expect(m.found);
  expect(m.handler == "readFile");
  expect(m.params.get("path") == "index.html");
});

test("a wildcard needs at least one segment, so it never covers its own prefix", () => {
  // `/files/:box` and `/files/:box/*path` are disjoint: this is what makes the
  // two routes independent of the order they are written in.
  let m = match(fileRoutes(), "GET", "/files/b1");
  expect(m.found);
  expect(m.handler == "readBox");
});

test("each captured segment is decoded on its own", () => {
  let m = match(fileRoutes(), "GET", "/files/b1/a%20b/c.css");
  expect(m.found);
  expect(m.params.get("path") == "a b/c.css");
});

test("an exact route beats a wildcard, whichever is written first", () => {
  // The point of the rule: the table above puts the wildcard last, this one
  // puts it first, and both answer the same.
  expect(match(fileRoutes(), "GET", "/files/b1/v/3").handler == "readVersion");
  let reversed = routes([
    route("GET", "/files/:box/*path", "readFile"),
    route("GET", "/files/:box/v/:n", "readVersion"),
  ]);
  expect(match(reversed, "GET", "/files/b1/v/3").handler == "readVersion");
  expect(match(reversed, "GET", "/files/b1/v/3").params.get("n") == "3");
  // And a path the exact route does not claim still reaches the wildcard.
  expect(match(reversed, "GET", "/files/b1/v/3/deep").handler == "readFile");
});

test("a literal beats a wildcard that comes before it", () => {
  let table = routes([
    route("GET", "/files/*path", "readFile"),
    route("GET", "/files/index.html", "home"),
  ]);
  expect(match(table, "GET", "/files/index.html").handler == "home");
  expect(match(table, "GET", "/files/other.html").handler == "readFile");
});

test("among wildcards the first one written still wins", () => {
  let table = routes([
    route("GET", "/files/public/*path", "readPublic"),
    route("GET", "/files/:box/*path", "readFile"),
  ]);
  expect(tableProblem(table) == "");
  expect(match(table, "GET", "/files/public/x.css").handler == "readPublic");
  expect(match(table, "GET", "/files/b1/x.css").handler == "readFile");
});

test("a wildcard route claims the path for 405 as any route does", () => {
  let m = match(fileRoutes(), "PATCH", "/files/b1/css/main.css");
  expect(!m.found);
  expect(m.pathMatched);
  expect(allowedMethods(fileRoutes(), "/files/b1/css/main.css").indexOf("GET") >= 0);
});

test("a wildcard does not match a path that stops short of its prefix", () => {
  expect(!match(fileRoutes(), "GET", "/files").found);
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

test("a table mixing exact routes and a wildcard reports no problem", () => {
  expect(tableProblem(fileRoutes()) == "");
});

test("a wildcard before its last segment is refused, since nothing can follow it", () => {
  let problem = tableProblem(routes([route("GET", "/a/*rest/b", "h")]));
  expect(problem.indexOf("nothing can follow it") >= 0);
});

test("a * with no name after it is refused", () => {
  expect(tableProblem(routes([route("GET", "/a/*", "h")])).indexOf("no name after it") >= 0);
});

test("a wildcard and a parameter share one namespace, since a handler reads names", () => {
  expect(tableProblem(routes([route("GET", "/a/:x/*x", "h")])).indexOf("twice") >= 0);
});

test("a wildcard written first does not make a later exact route dead", () => {
  // It would under a first-match-wins rule; `match` prefers the exact route
  // whatever the order, so refusing this table at startup would be wrong.
  expect(tableProblem(routes([
    route("GET", "/files/:box/*path", "readFile"),
    route("GET", "/files/:box/v/:n", "readVersion"),
  ])) == "");
});

test("a wildcard that covers a later wildcard is refused", () => {
  let problem = tableProblem(routes([
    route("GET", "/files/:box/*path", "readFile"),
    route("GET", "/files/b1/*rest", "readBox1"),
  ]));
  expect(problem.indexOf("can never match") >= 0);
});

test("a wildcard reaching further back does not shadow one nested deeper", () => {
  // `/files/:box/logs/*rest` matches paths `/files/*path` also matches, so it
  // is the earlier, wider one that must come second.
  expect(tableProblem(routes([
    route("GET", "/files/:box/logs/*rest", "readLogs"),
    route("GET", "/files/*path", "readFile"),
  ])) == "");
});

test("the same path under different methods is not a conflict", () => {
  expect(tableProblem(routes([
    route("GET", "/agents/:id", "find"),
    route("PUT", "/agents/:id", "replace"),
  ])) == "");
});
