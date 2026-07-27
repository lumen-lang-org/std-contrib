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
// A pattern segment is a literal, a `:name` standing for exactly one segment,
// or — as the LAST segment only — a `*name` standing for the whole rest of the
// path, one segment or more:
//
//   route("GET", "/files/:box/*path", "readFile")
//   // GET /files/b1/css/main.css  ->  box = b1, path = "css/main.css"
//
// A `*name` anywhere but last is a programming error, since nothing after a
// catch-all could ever be reached; `tableProblem` refuses such a table at
// startup rather than letting the route quietly mean something else.
//
// A catch-all is also always the last resort. Any route that matches without
// one beats it, whatever order the table is written in, so `/files/:box/v/:n`
// still wins over `/files/:box/*path` and a literal still wins over both.
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

// The index of a pattern's trailing `*name`, or -1 when it has none.
//
// Only the last segment counts. A `*name` written anywhere else is a
// programming error — everything after a catch-all is unreachable, so the
// pattern does not mean what it looks like it means — and `tableProblem`
// refuses such a table at startup. Until that check has run, the honest answer
// is that this router does not match a wildcard there, and this says so by
// looking at one position only.
function wildcardAt(parts: string[]): int {
  if (parts.length == 0) { return -1; }
  let last = parts.length - 1;
  if (!parts[last].startsWith("*")) { return -1; }
  return last;
}

// The path from `from` on, as one string.
//
// Each segment is decoded on its own and only then joined, so the boundaries
// are the ones `segments` already found and decoding cannot move them: the join
// is structure, the decode is data, and the structure is settled first.
//
// What that does NOT buy is an unambiguous capture, and a caller has to know
// it. `%2F` decodes to a slash like any other byte, so `/x/a%2Fb/c` and
// `/x/a/b/c` both capture `a/b/c` — nothing downstream can tell an encoded
// separator from a real one. Nor is `..` filtered here: `segments` drops empty
// segments and nothing else, so a capture can contain `.` and `..` and arrives
// exactly as sent. A handler that resolves a capture against a filesystem, a
// key space or anything else hierarchical owns that check; the router's job is
// to report what was asked for, not to decide what is allowed.
function joinTail(pathParts: string[], from: int): string {
  let out = "";
  let i: int = from;
  while (i < pathParts.length) {
    if (i > from) { out = out + "/"; }
    out = out + decodeComponent(pathParts[i]);
    i = i + 1;
  }
  return out;
}

// Whether one pattern's segments match one path's, filling in `:name` params
// and, for a pattern ending in `*name`, the whole remaining path under that
// name. A pattern segment that disagrees ends the attempt, which can leave
// `into` half filled — callers pass a map they are willing to throw away.
//
// This says only whether the pattern matches. Whether a match that used a
// catch-all should *win* is `match`'s business, not this function's.
function matchSegments(patternParts: string[], pathParts: string[], into: Map<string, string>): bool {
  let at = wildcardAt(patternParts);

  // How many pattern segments match one path segment each. For a catch-all
  // that is everything before it; the rest of the path is the capture.
  let fixed = patternParts.length;
  if (at >= 0) {
    fixed = at;
    // `*name` stands for one or more segments, never zero. Requiring one keeps
    // `/p/:t` and `/p/:t/*rest` disjoint — no path matches both — so neither
    // can quietly hide the other and their order stops mattering.
    if (pathParts.length <= fixed) { return false; }
  } else {
    if (patternParts.length != pathParts.length) { return false; }
  }

  let i: int = 0;
  while (i < fixed) {
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
  if (at >= 0) {
    let key = patternParts[at].substring(1, patternParts[at].length);
    if (key == "") { return false; }
    into.set(key, joinTail(pathParts, fixed));
  }
  return true;
}

// The first route whose method and pattern both match. First rather than best:
// a table is written in the order its author meant, and a scoring rule is a
// thing to debug at three in the morning.
//
// The one exception is the catch-all, and it is not a score either. A `*name`
// match is held aside rather than returned: the sweep carries on, and any
// fixed-arity route that matches later wins outright. So a catch-all is last
// resort by construction, not by where an author put it — nobody can break
// `/preview/:token/v/:n` by writing `/preview/:token/*path` above it, which is
// a mistake that shows up as a 404 in production and nowhere else.
//
// Held aside, not returned early, because deciding it here costs one sweep. A
// second sweep for catch-alls would re-split every pattern in the table on
// every request that misses.
//
// Among catch-alls themselves the ordinary rule still holds: the first one
// written wins, and `tableProblem` refuses a table where an earlier catch-all
// makes a later one unreachable.
//
// `target` is the request target — the path, optionally with a query string.
export function match(table: Route[], method: string, target: string): Match {
  let split = splitQuery(target);
  let pathParts = segments(split[0]);
  let wanted = method.toUpperCase();
  let sawPath = false;
  // The best catch-all seen so far. `found` doubles as "there is one", which is
  // exactly what it means, so there is no second flag to keep in step with it.
  let viaWildcard = noMatch(false);

  let i: int = 0;
  while (i < table.length) {
    let candidate = table[i];
    let patternParts = segments(candidate.pattern);
    // A fresh map per candidate: `matchSegments` fills it as it goes and can
    // still fail afterwards, so a rejected candidate leaves nothing behind.
    let params = new Map<string, string>();
    if (matchSegments(patternParts, pathParts, params)) {
      if (candidate.method == wanted) {
        let m: Match = {
          found: true,
          handler: candidate.handler,
          params: params,
          query: parseQuery(split[1]),
          pathMatched: true,
        };
        if (wildcardAt(patternParts) < 0) { return m; }
        if (!viaWildcard.found) { viaWildcard = m; }
      } else {
        // The path is claimed either way, so 405 is owed whether the route that
        // claimed it was exact or a catch-all.
        sawPath = true;
      }
    }
    i = i + 1;
  }
  if (viaWildcard.found) { return viaWildcard; }
  return noMatch(sawPath);
}

// Which methods a path does accept, for the `Allow` header a 405 owes the
// client.
//
// A catch-all counts here like any other route: if it would answer that path
// under some method, that method really is allowed, and leaving it out would
// print an `Allow` the server itself contradicts. Precedence does not come into
// it — this is a set, not a choice.
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
      let sigil = parts[j].substring(0, 1);
      if (sigil == ":" || sigil == "*") {
        let key = parts[j].substring(1, parts[j].length);
        if (key == "") {
          return "the pattern \"" + r.pattern + "\" has a " + sigil + " with no name after it";
        }
        // One namespace for both sigils. A handler reads a parameter by name
        // and cannot tell which sigil filled it, so `/a/:x/*x` is the same
        // collision as `/a/:x/b/:x` and deserves the same refusal.
        if (seen.indexOf(key) >= 0) {
          return "the pattern \"" + r.pattern + "\" names \"" + sigil + key + "\" twice";
        }
        seen.push(key);
      }
      // A wildcard swallows the whole rest of the path, so a segment written
      // after one can never be reached — and nothing downstream would ever
      // notice: `matchSegments` only honours a trailing `*name`, so
      // `/a/*rest/b` would silently behave as `/a/*rest` and the `/b` an author
      // wrote would mean nothing. Refuse it here, by name, at startup.
      if (sigil == "*" && j != parts.length - 1) {
        return "the pattern \"" + r.pattern + "\" writes \"" + parts[j]
          + "\" before its last segment: a wildcard takes the rest of the path, so nothing can follow it";
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
//
// A catch-all turns this into a question about two different path lengths, so
// the length test moves out of the loop and the comparison runs only over the
// segments that can still rule a shadow out. Bias the answer towards reporting:
// a missed shadow ships a route that silently never runs, a spurious one is a
// startup error fixed in ten seconds. The one place that bias is deliberately
// not applied is a catch-all over a fixed route, where `match` guarantees the
// fixed route wins.
function shadows(a: string, b: string): bool {
  let pa = segments(a);
  let pb = segments(b);
  let wa = wildcardAt(pa);
  let wb = wildcardAt(pb);

  if (wa < 0) {
    // A fixed-arity pattern matches exactly one path length, and a catch-all
    // matches every length past its prefix, so `a` can never cover all of `b`.
    // It does steal the one length they share — but the question here is
    // whether `b` is wholly unreachable, not whether the two overlap, and an
    // overlap is a legal thing to write.
    if (wb >= 0) { return false; }
    if (pa.length != pb.length) { return false; }
    return prefixCovers(pa, pb, pa.length);
  }

  // `a` is a catch-all. It cannot hide a fixed-arity `b` at all, whatever the
  // two patterns look like, because `match` only falls back to a catch-all once
  // nothing else has matched — `b` wins on its own paths regardless of table
  // order. Refusing this at startup would be refusing a table that works.
  if (wb < 0) { return false; }

  // Two catch-alls, and now order does decide. `a` takes everything from `wa`
  // on, so only the segments before the wildcard can rule the shadow out. A `b`
  // whose own wildcard starts earlier matches shorter paths than `a` ever will,
  // so it keeps a life of its own; otherwise `b` reaches past `a`'s prefix by
  // construction and the prefix is the whole question.
  if (wb < wa) { return false; }
  return prefixCovers(pa, pb, wa);
}

// Whether `a`'s first `upto` segments cover `b`'s: a literal covers only the
// same literal, a `:name` covers any single segment.
function prefixCovers(pa: string[], pb: string[], upto: int): bool {
  let i: int = 0;
  while (i < upto) {
    if (!pa[i].startsWith(":")) {
      if (pa[i] != pb[i]) { return false; }
    }
    i = i + 1;
  }
  return true;
}
