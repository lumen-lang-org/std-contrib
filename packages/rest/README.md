# rest

A router and an HTTP server for Lumen. Thin on purpose: matching a request to a
handler is the part worth having, and this is that part.

```ts
@controller("/agents")
class AgentController {
  @get("/")       list(req: Request): Reply { ... }
  @get("/:id")    find(req: Request): Reply { ... }
  @post("/")      create(req: Request): Reply { ... }
  @del("/:id")    remove(req: Request): Reply { ... }
}
```

The compiler runs `controller` while compiling and leaves the route table
behind as a constant — no scanning, no registration at startup:

```ts
let controllerAgentController: Route[] = [
  { method: "GET",    pattern: "/agents",     handler: "list" },
  { method: "GET",    pattern: "/agents/:id", handler: "find" },
  { method: "POST",   pattern: "/agents",     handler: "create" },
  { method: "DELETE", pattern: "/agents/:id", handler: "remove" },
];
```

`@del`, not `@delete` — `delete` is a reserved word. It is the one place the
language shows through, and that beats something cleverer.

## Serving

```ts
let bound = new Map<string, Handler>();
bound.set("list", listAgents);
bound.set("find", findAgent);

let problem = serve(8080, controllerAgentController, bound);
if (problem != "") { console.error(problem); }
```

The binding is written out because a decorator cannot call a method: there is
no reflection here and there will not be, since the product is a native binary
with no runtime type information. What that buys is that `serve` checks the
table against the bindings **before it listens** — a route naming a handler
nothing bound is a startup failure naming the route, not a 500 a user finds.

Handlers close over what they need, which is the dependency inversion: nothing
reaches for a global, and a test builds the same handlers against a different
`Db`.

## Without a decorator

The table is an ordinary value; the decorator only derives one.

```ts
let table = routes([
  route("GET",  "/agents",     "list"),
  route("GET",  "/agents/:id", "find"),
]);
```

## Catching the rest of a path

A pattern's **last** segment may be `*name`, which stands for the whole rest of
the path — one segment or more, joined with `/`, each segment decoded on its
own.

```ts
let table = routes([
  route("GET", "/files/:box/*path", "readFile"),
]);
// GET /files/b1/css/main.css  ->  box = b1, path = "css/main.css"
```

A catch-all is always the last resort: any route that matches without one wins,
whatever order the table is written in. So `/files/:box/v/:n` still answers
`/files/b1/v/3` even if the catch-all is written above it, and you never have to
reason about placement to keep an exact route alive.

The capture is reported, not vetted. `..` and an encoded `%2F` arrive as sent
and read as ordinary path text, so a handler that resolves one against a
filesystem or key space owns that check itself.

## What it refuses, at startup

- **A shadowed route.** `/agents/:id` written before `/agents/new` makes the
  second unreachable — a `:param` matches any literal. Named at startup rather
  than found as a 404 later.
- **A `*name` that is not the last segment.** Nothing after a catch-all could
  ever be reached, so the pattern does not mean what it looks like.
- **A pattern that does not start with `/`**, one naming a parameter twice —
  `:` and `*` share one namespace, since a handler reads a parameter by name —
  or a `:` or `*` with no name.
- **An empty table**, and a route naming no handler.

## What it answers

- A path nobody claims: **404**, as JSON.
- A path claimed under another method: **405**, with the `Allow` header it
  owes. That is a distinction a client acts on, and it needs the difference
  between "no such thing" and "not that way".
- An unbound handler that somehow reached dispatch: **500**, rather than
  taking the server down.

## Reading a request

`param(req, "id")`, `queryParam(req, "limit", "10")`, `header(req, name)` —
case-insensitive, since the server lowercases what it receives — and
`bearerToken(req)`, which every API grows and every one writes differently.

`ok`, `created`, `noContent`, `json`, `problem`, `notFound`, `badRequest` build
replies. An error is a JSON document, because a client parsing the body should
not have to guess whether it got JSON or a sentence.

## Testing

```sh
cd packages/rest
lumen test router.test.ts       # 25 — matching, params, query, decoding
lumen test controller.test.ts   # 12 — the decorator, by calling it
lumen test server.test.ts       # 16 — dispatch, refusals, bindings
```

None of them binds a port. `dispatch` is split from `serve` precisely so every
route, refusal and binding failure is a function call — a test that has to bind
a port is a test that gets skipped.

## Dependency inversion

A controller takes what it needs through its constructor. Nothing reaches for a
global, so a test builds one against a different database and the same code
runs.

```ts
@controller("/agents")
class AgentController {
  agents: Store;
  constructor(agents: Store) { this.agents = agents; }

  @get("/:id")
  find(req: Request): Reply {
    let document = this.agents.findById(param(req, "id"));
    if (document == "") { return notFound("agent " + param(req, "id")); }
    return ok(document);
  }
}
```

```ts
function main(): void {
  let agents = store(openDatabase(), agentsMapping());
  let api = new AgentController(agents);
  ...
}
```

There is no `@inject`, no auto-wiring and no lifetime management. `main` builds
the dependencies and hands them over. With no reflection there is no honest way
to do more, and that being visible is better than dressing it up.

## Status

`@controller` needs the decorator compiler (Lumen spec 455, merged) and the
method descriptions it reads (spec 459, merged). `examples/agents-api.ts` is a
full REST API over a `plume`-mapped table, written with a plain route table;
`examples/agents-controller.ts` is the same API as a controller.

**Not yet safe under concurrency.** `http.createServer` dispatches each request
to a worker thread, and a `plume` connection shared across threads has its
result set overwritten by whichever request runs next — a POST followed by a
read of the same id can report not found. Thread-local connections are in
progress. Until then these examples are correct only for sequential traffic.
