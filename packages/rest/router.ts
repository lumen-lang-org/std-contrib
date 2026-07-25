// Matching a request to a handler: the part of a web framework that is worth
// having, and nothing else.
//
// A route is a method, a path pattern, and a name. Matching is a pure function
// over strings, so all of it is testable without a socket — which is why this
// file has no import and knows nothing about HTTP.
//
//   let table = routes([
//     route("GET",  "/agents",     "listAgents"),
//     route("GET",  "/agents/:id", "findAgent"),
//     route("POST", "/agents",     "createAgent"),
//   ]);
//
//   let m = match(table, "GET", "/agents/a1?fields=id");
//   m.found      // true
//   m.handler    // "findAgent"
//   m.params     // id -> a1
//   m.query      // fields -> id
//
// The handler is named rather than held. A record cannot carry a function and
// still be compared, printed or built at compile time by a decorator, and the
// dispatch a name costs is one comparison per route.

export type Route = {
  method: string,
  pattern: string,
  handler: string,
};

export type Match = {
  found: bool,
  handler: string,
  params: Map<string, string>,
  query: Map<string, string>,
  // Set when the path matched but the method did not, so a caller can answer
  // 405 rather than 404 — the difference between "no such thing" and "not that
  // way", which a client acts on differently.
  pathMatched: bool,
};

export function route(method: string, pattern: string, handler: string): Route {
  let r: Route = { method: method.toUpperCase(), pattern: pattern, handler: handler };
  return r;
}

// A table is just the list. Kept as a function so a caller reads `routes([...])`
// rather than assembling an array whose meaning is not obvious.
export function routes(list: Route[]): Route[] {
  return list;
}

// --- splitting ---------------------------------------------------------------

// The path and the query string, split at the first `?`.
export function splitQuery(target: string): string[] {
  let at = target.indexOf("?");
  let out: string[] = [];
  if (at < 0) {
    out.push(target);
    out.push("");
    return out;
  }
  out.push(target.substring(0, at));
  out.push(target.substring(at + 1, target.length));
  return out;
}

// Path segments, with empty ones dropped, so `/agents/` and `/agents` are the
// same path — a trailing slash is a typing habit, not a different resource.
export function segments(pathText: string): string[] {
  let out: string[] = [];
  let parts = pathText.split("/");
  let i: int = 0;
  while (i < parts.length) {
    if (parts[i] != "") { out.push(parts[i]); }
    i = i + 1;
  }
  return out;
}

// `%20` and `+` back to the bytes they stand for. A path parameter is data —
// an id can contain a slash or a space — so it is decoded before a handler
// sees it.
export function decodeComponent(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c == 37 && i + 2 < text.length) {
      let hi = hexDigit(text.charCodeAt(i + 1));
      let lo = hexDigit(text.charCodeAt(i + 2));
      if (hi >= 0 && lo >= 0) {
        out = out + String.fromCharCode(hi * 16 + lo);
        i = i + 3;
        continue;
      }
    }
    if (c == 43) { out = out + " "; i = i + 1; continue; }
    out = out + text.substring(i, i + 1);
    i = i + 1;
  }
  return out;
}

function hexDigit(c: int): int {
  if (c >= 48 && c <= 57) { return c - 48; }
  if (c >= 97 && c <= 102) { return c - 87; }
  if (c >= 65 && c <= 70) { return c - 55; }
  return -1;
}

// `a=1&b=two` as a map. A key with no `=` is present with an empty value,
// which is how a flag reads: `?verbose` means verbose.
export function parseQuery(queryText: string): Map<string, string> {
  let out = new Map<string, string>();
  if (queryText == "") { return out; }
  let pairs = queryText.split("&");
  let i: int = 0;
  while (i < pairs.length) {
    let pair = pairs[i];
    if (pair != "") {
      let at = pair.indexOf("=");
      if (at < 0) {
        out.set(decodeComponent(pair), "");
      } else {
        out.set(decodeComponent(pair.substring(0, at)),
                decodeComponent(pair.substring(at + 1, pair.length)));
      }
    }
    i = i + 1;
  }
  return out;
}

// --- matching ----------------------------------------------------------------

function noMatch(pathMatched: bool): Match {
  let m: Match = {
    found: false,
    handler: "",
    params: new Map<string, string>(),
    query: new Map<string, string>(),
    pathMatched: pathMatched,
  };
  return m;
}

// Whether one pattern's segments match one path's, filling in `:name` params.
// Returns an empty map and false through `ok`, since a pattern segment that
// disagrees ends the attempt.
function matchSegments(patternParts: string[], pathParts: string[], into: Map<string, string>): bool {
  if (patternParts.length != pathParts.length) { return false; }
  let i: int = 0;
  while (i < patternParts.length) {
    let p = patternParts[i];
    if (p.startsWith(":")) {
      let key = p.substring(1, p.length);
      if (key == "") { return false; }
      into.set(key, decodeComponent(pathParts[i]));
    } else {
      if (p != pathParts[i]) { return false; }
    }
    i = i + 1;
  }
  return true;
}

// The first route whose method and pattern both match. First rather than best:
// a table is written in the order its author meant, and a scoring rule is a
// thing to debug at three in the morning.
//
// `target` is the request target — the path, optionally with a query string.
export function match(table: Route[], method: string, target: string): Match {
  let split = splitQuery(target);
  let pathParts = segments(split[0]);
  let wanted = method.toUpperCase();
  let sawPath = false;

  let i: int = 0;
  while (i < table.length) {
    let candidate = table[i];
    let params = new Map<string, string>();
    if (matchSegments(segments(candidate.pattern), pathParts, params)) {
      if (candidate.method == wanted) {
        let m: Match = {
          found: true,
          handler: candidate.handler,
          params: params,
          query: parseQuery(split[1]),
          pathMatched: true,
        };
        return m;
      }
      sawPath = true;
    }
    i = i + 1;
  }
  return noMatch(sawPath);
}

// Which methods a path does accept, for the `Allow` header a 405 owes the
// client.
export function allowedMethods(table: Route[], target: string): string[] {
  let pathParts = segments(splitQuery(target)[0]);
  let out: string[] = [];
  let i: int = 0;
  while (i < table.length) {
    let params = new Map<string, string>();
    if (matchSegments(segments(table[i].pattern), pathParts, params)) {
      if (out.indexOf(table[i].method) < 0) { out.push(table[i].method); }
    }
    i = i + 1;
  }
  return out;
}

// --- checking a table --------------------------------------------------------

// Why a table would not behave. Called once at startup rather than per
// request: a route that can never match is a mistake worth failing on, not one
// to discover from a 404 in production.
export function tableProblem(table: Route[]): string {
  if (table.length == 0) { return "the route table is empty"; }
  let i: int = 0;
  while (i < table.length) {
    let r = table[i];
    if (r.handler == "") {
      return "the route " + r.method + " " + r.pattern + " names no handler";
    }
    if (!r.pattern.startsWith("/")) {
      return "the pattern \"" + r.pattern + "\" does not start with /";
    }
    let parts = segments(r.pattern);
    let seen: string[] = [];
    let j: int = 0;
    while (j < parts.length) {
      if (parts[j].startsWith(":")) {
        let key = parts[j].substring(1, parts[j].length);
        if (key == "") { return "the pattern \"" + r.pattern + "\" has a : with no name after it"; }
        if (seen.indexOf(key) >= 0) {
          return "the pattern \"" + r.pattern + "\" names \":" + key + "\" twice";
        }
        seen.push(key);
      }
      j = j + 1;
    }
    // An earlier route that matches everything this one does makes it dead.
    let k: int = 0;
    while (k < i) {
      if (table[k].method == r.method && shadows(table[k].pattern, r.pattern)) {
        return "the route " + r.method + " " + r.pattern + " can never match: "
          + table[k].method + " " + table[k].pattern + " comes first and matches the same paths";
      }
      k = k + 1;
    }
    i = i + 1;
  }
  return "";
}

// Whether every path `b` would match, `a` matches too — so `b`, coming later,
// can never be reached.
//
// A parameter segment matches any single segment, so `/agents/:id` shadows
// `/agents/new` but not the other way round. That asymmetry is the whole
// point: it is why the literal has to be written first, and why writing it
// second is the mistake worth catching.
function shadows(a: string, b: string): bool {
  let pa = segments(a);
  let pb = segments(b);
  if (pa.length != pb.length) { return false; }
  let i: int = 0;
  while (i < pa.length) {
    if (!pa[i].startsWith(":")) {
      // A literal in `a` only covers the same literal in `b`.
      if (pa[i] != pb[i]) { return false; }
    }
    i = i + 1;
  }
  return true;
}
