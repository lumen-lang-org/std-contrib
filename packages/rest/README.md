# rest

A router and an HTTP server for Lumen. Thin on purpose: matching a request to a
handler is the part worth having, and this is that part.

```ts
@controller("/agents")
class AgentController {
  @get("/")       list(req: Request): Reply { ... }
  @get("/:id")    find(req: Request): Reply { ... }
  @post("/")      create(req: Request): Reply { ... }
  @delete("/:id") remove(req: Request): Reply { ... }
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

The verbs are `@get`, `@post`, `@put`, `@patch`, `@delete` and `@head`. `@del`
still works and means the same thing, for code written when this package
believed `delete` was unavailable — it is not: a decorator is an ordinary
imported name, and `delete` is only special to the lexer when deciding whether a
following `/` opens a regex. The list itself is `httpMethodOf` in
`controller.ts`, so adding `@options` is editing that function rather than the
language: the compiler knows the decorator protocol, never the vocabulary.

## Serving

```ts
let mounts: Mount[] = [
  new AgentController(db),
  new ModelController(db),
];

let problem = listen(8080, mounts);
if (problem != "") { console.error(problem); }
```

That is the whole call site, and it is the whole of what `main` used to be. The
same shape in `packages/agents` ran to about 390 lines: a loop per controller
copying that controller's routes into one shared table while rewriting every
handler name with a prefix — `"h" + r.handler`, `"d" + r.handler`, `"ks" +
r.handler` — invented at the call site so that four classes could each have a
`list` without overwriting one another; then some seventy
`bound.set("hlist", (req) => { try { … } catch { … } })` lambdas; then `serve`.
That program was longer than the API it served, its prefixes were a namespace
maintained by attention, and a single `try` left out of a single lambda took the
whole process down. None of it is written now, so none of it can be got wrong
now.

### What `mount` does

`listen` takes `Mount[]`, and a `Mount` is a controller's name, the routes its
decorator left behind, and the one way in:

```ts
export type Mount = {
  controller: string,
  routes: Route[],
  call: (handler: string, req: Request) => Reply,
};
```

`mount` builds one. It is said once, generically, for every controller there
will ever be, because three things the compiler already knows about a class are
reachable as values (Lumen spec 477):

```ts
export function mount<T>(c: T): Mount {
  let m: Mount = {
    controller: Class.nameOf(c),                  // "AgentController"
    routes: Class.decorator(c, "controller"),     // the Route[] @controller left
    call: (handler: string, req: Request) => {
      try { return Class.invoke(c, handler, req); }   // c.list(req), by name
      catch (e) { return badRequest("the request could not be handled: " + e.message); }
    },
  };
  return m;
}
```

Read that and the natural conclusion is that something looks a class up at run
time. Nothing does, and none of the three survives into the binary. There is no
reflection here and there is still no runtime type information in a native
Lumen binary; all three are resolved while checking and rewritten in place.
`Class.nameOf(c)` becomes the string literal `"AgentController"`.
`Class.decorator(c, "controller")` becomes a reference to
`controllerAgentController`, the constant `@controller` already produced, typed
as the `Route[]` that constant is declared to be. `Class.invoke(c, handler, req)`
becomes a call to a dispatcher the compiler generates once per class — a chain
of `if (handler == "list") { return c.list(req); }` over the methods whose
parameter types match, ending in a throw for a name no method has. `mount` is
generic precisely so the substitution happens per controller, at specialization,
before the body is checked.

### What a mountable class may not have

One constraint follows from how that dispatcher is built, and it is worth
knowing before you meet it as a type error. `Class.invoke(c, handler, req)`
gathers **every** method of the class whose parameter list is exactly
`(Request)` — not only the decorated ones, since the decorator is not what it
consults — and those methods have to agree on a return type. So a helper like

```ts
keyOf(req: Request): string { return param(req, "id"); }
```

sitting undecorated beside the handlers makes the class unmountable: it takes a
`Request` like a handler and returns a `string` where the handlers return
`Reply`. It never becomes a route — the decorator reads verbs, and this has none
— but it is still a candidate for dispatch.

Either give the helper a different parameter list, or lift it out of the class
as a free function, which is never a candidate. `examples/agents-controller.ts`
does the second. The diagnostic today is a bare `type mismatch` pointing inside
`server.ts` at `mount`'s own body rather than at your class, so it is worth
recognising by shape.

### Why the call site does not write `mount`

`[new AgentController(db), new ModelController(db)]` is not a `Mount[]`, and it
is not any array: arrays are homogeneous, there are no trait objects, and two
classes share no type. So the erasure to one record has to happen per element,
at the call site. Writing it is what `mount(…)` was, once per line, carrying no
information beyond "this is an instance, boxed".

A value of class type appearing where a **named record type** is expected now
goes through the one generic function that makes that record — a declaration
`f<T>(c: T): R` over a single parameter of its own type parameter (Lumen spec
478). `mount` is that function for `Mount`, so the array elements become
`mount(new AgentController(db))` before anything else sees them. Nothing that
compiled before changes meaning: a class instance was never assignable to a
record, so every site this fires on is a site that was a type error. The rule
can only turn errors into programs.

Writing `mount(…)` yourself still compiles and means exactly the same thing. It
stays exported for a program that wants the record for its own reasons — a test
that dispatches without a socket, say.

A class in the list carrying no `@controller` is a compile error naming that
class, reported at the call that asked for it rather than at the library line
that wrote `Class.decorator` for every class there will ever be:

```
api.ts:14:7: error: `NotAController` carries no `@controller`, so there is no
             `controllerNotAController` to read
  14 |   let problem = listen(8123, [new AgentApi(), new NotAController()]);
    |       ^~~~~~~
```

### The single `try` is the point

This is the part to understand, because it is why per-handler `try`s are gone
rather than merely tidied away.

A `throw` in this language does not propagate out of a lambda. Spec 245's
fixpoint pass works out which functions can throw, and it cannot see through a
function value, so a callee reached that way is emitted as non-throwing and the
throw panics at the handler. A `try` wrapped around a handler *reached through a
function value* therefore never runs. That is not a theoretical shape: `serve`
has always held such a `try`, and it has never once caught a handler's own
throw.

`Class.invoke` lowers to direct method calls, which spec 245 and spec 247 do
propagate a throw through. So the `try` inside `mount` is the first one on this
path that can work, and because there is exactly one path from a request to a
method, it guards every handler of every controller. No call site can forget it,
because no call site names a handler.

The failure this closes is a specific one. `JSON.parse<T>` throws when a PUT
body omits a field the record declares. Each of about sixty hand-written
bindings needed its own `try` to survive that; one was missing, and a partial
body on that one route took the whole server down. Now a handler that throws is
answered 400 — the request the router could not make sense of is the request's
fault — and the server is still serving. A handler failing for its own reasons
should still return `problem(500, …)` rather than throw.

### Handler names are qualified by their class

Each mount is matched against its own routes, so `AgentController.list` and
`ModelController.list` never share a keyspace and there is nothing for a program
to disambiguate. Where a name has to be shown, it is qualified with the name the
compiler gave the class, never with a prefix a program chose:

```ts
let table = mountedRoutes(mounts);   // Route[], handlers qualified
// route  GET /agents/:id -> AgentController.find
```

`mountedRoutes` is for logging and for the message `mountProblem` gives.
Dispatch never uses it.

### What `listen` refuses before it binds

`mountProblem` runs first, and `listen` returns its message rather than
listening. It checks each controller's own routes with `tableProblem`, naming
the controller:

```
ShadowApi: the route GET /agents/new can never match: GET /agents/:id comes
first and matches the same paths
```

and then it checks that no two controllers claim one method and path:

```
AgentApi.list and ArchiveApi.list both serve GET /agents
```

That second check is new, and it is worth saying what it replaces: nothing.
Two controllers overlapping used to be silent, because the first mount simply
won and the second was dead code that looked live.

A route with no handler is no longer one of the ways to fail. The routes come
from the decorator, which derived them from the class's own methods, and the
dispatch comes from that same class, so the two cannot disagree.

One overlap is still not caught: a route in one controller that *shadows* rather
than duplicates a route in another — `GET /agents/:id` in one class and `GET
/agents/new` in a second — is a conflict `tableProblem` refuses within a single
controller but neither check sees across two. The earlier mount wins, quietly.
Keeping one path prefix in one class avoids it entirely, which is what a
`@controller` prefix is for.

### Serving a table you wrote yourself

`serve(port, table, handlers)` is unchanged and still works. A program that
wrote its own bindings keeps them, and nothing here asks it to move:

```ts
let bound = new Map<string, Handler>();
bound.set("list", listAgents);
bound.set("find", findAgent);

let problem = serve(8080, table, bound);
```

`bindingProblem` checks the table against the bindings before it listens, so a
route naming a handler nothing bound is a startup failure naming the route
rather than a 500 a user finds. What it cannot do is guard the handlers: each
binding still has to hold its own `try`, inside its own lambda, which is the
only place one works, and forgetting one is still fatal.

**A new program should reach for `listen`.** `serve` is the right answer only
for a table that was not derived from a class — one built by hand with `route`
and `routes`, or read from somewhere — where there is no class for `Class.*` to
know anything about.

## Without a decorator

The table is an ordinary value; the decorator only derives one.

```ts
let table = routes([
  route("GET",  "/agents",     "list"),
  route("GET",  "/agents/:id", "find"),
]);
```

`match(table, method, target)` is the whole router, and it is a pure function
over strings — no import, no socket, nothing about HTTP — which is why every
routing question in this package is answerable by a test that calls a function.

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

Both `mountProblem` and `bindingProblem` run `tableProblem` first, so these hold
whichever way a program serves:

- **A shadowed route.** `/agents/:id` written before `/agents/new` makes the
  second unreachable — a `:param` matches any literal. Named at startup rather
  than found as a 404 later.
- **A `*name` that is not the last segment.** Nothing after a catch-all could
  ever be reached, so the pattern does not mean what it looks like.
- **A pattern that does not start with `/`**, one naming a parameter twice —
  `:` and `*` share one namespace, since a handler reads a parameter by name —
  or a `:` or `*` with no name.
- **An empty table**, and a route naming no handler.

Then each adds the check its own shape makes possible:

- `listen` refuses **two mounted controllers claiming one method and path**,
  which is otherwise silent: the first one mounted quietly wins.
- `serve` refuses **a route naming a handler nothing bound**, which cannot
  arise under `listen` because routes and dispatch come from the same class.

## What it answers

- A path nobody claims: **404**, as JSON.
- A path claimed under another method: **405**, with the `Allow` header it
  owes. That is a distinction a client acts on, and it needs the difference
  between "no such thing" and "not that way". Under `listen` the header is
  collected across every mount, so a path split between two controllers still
  reports both.
- A handler that throws: **400**, from the `try` inside `mount`.
- Under `serve` only, an unbound handler that somehow reached dispatch:
  **500**, rather than taking the server down.

## Reading a request

`param(req, "id")`, `queryParam(req, "limit", "10")`, `header(req, name)` —
case-insensitive, since the server lowercases what it receives — and
`bearerToken(req)`, which every API grows and every one writes differently.

`ok`, `created`, `accepted`, `noContent`, `json`, `problem`, `notFound` and
`badRequest` build replies, over `reply(status, body, contentType)` for anything
that is not JSON.

Those take a body that is already text. **`okJson`, `createdJson` and
`jsonOf(status, value)` take the value itself** and serialise it once:

```ts
type JobView = { id: string, source: string, chunks: int, failed: bool };

@get("/")
list(req: Request): Reply {
  return okJson(pendingJobs(this.db).map(view));
}
```

A handler that builds its body by concatenation is doing three jobs: choosing
the shape, escaping the values and remembering the commas. Only the first is
its own. `JSON.stringify` lives here, once, instead of at every route that has
to get the quoting right — and a record literal cannot infer a generic type
parameter, so the call site names its type, which is what decides the fields
that ship rather than the author remembering which to concatenate. An error is a JSON document, because a client parsing the body
should not have to guess whether it got JSON or a sentence. `accepted` is its own
function rather than a 201 with a different number: answering 201 for work
merely queued tells a client the resource exists when it does not yet.

<!-- website:skip -->
## Testing

```sh
cd packages/rest
lumen test router.test.ts       # 41 — matching, params, query, decoding
lumen test controller.test.ts   # 12 — the decorator, by calling it
lumen test server.test.ts       # 18 — dispatch, refusals, bindings
lumen test mount.test.ts        # 11 — mounted controllers, throws, collisions
```

None of them binds a port. `dispatch` and `dispatchMounted` are split from
`serve` and `listen` precisely so that every route, refusal and binding failure
is a function call — a test that has to bind a port is a test that gets skipped.
`dispatched` and `dispatchedMounted` are the same two wrapped in the `try` that
catches a throw raised on the way to a handler, which is what `serve` and
`listen` actually call.

`mount.test.ts` is the suite that would have caught the outage: it mounts two
controllers that each have a `list`, PUTs a partial body at a handler that
parses one, and asserts both that the reply is 400 and that the next request is
still answered.
<!-- /website:skip -->

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
  let mounts: Mount[] = [new AgentController(agents)];
  listen(8080, mounts);
}
```

There is no `@inject`, no auto-wiring and no lifetime management, and spec 478
adds none: it converts an instance the program already constructed, and never
constructs one or scans for one. `main` builds the dependencies and hands them
over, where a reader can see what each controller was given. With no reflection
there is no honest way to do more, and that being visible is better than
dressing it up.

## Status

`@controller` needs the decorator compiler (Lumen spec 455, merged) and the
method descriptions it reads (spec 459, merged). `listen` and `mount` need class
metadata as values (spec 477, merged); dropping the word `mount` from the call
site needs class-to-record conversion (spec 478, merged).

`examples/agents-controller.ts` is a full REST API over a `plume`-mapped table,
written as a controller and served with `listen`.
`examples/agents-api.ts` is the same API as a plain route table served with
`serve`, kept because that path is still supported and still worth having an
example of.

**Not yet safe under concurrency.** `http.createServer` dispatches each request
to a worker thread, and a `plume` connection shared across threads has its
result set overwritten by whichever request runs next — a POST followed by a
read of the same id can report not found. Thread-local connections are in
progress. Until then these examples are correct only for sequential traffic.
