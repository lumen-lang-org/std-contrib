---
name: lumen-route
description: >
  Convert a Lumen REST route in packages/agents to the layered shape: controller / service /
  repository / guard / utils / dtos / entities, with decorators doing the binding, validation and
  refusals, plume doing every database access, and no raw SQL. Use when asked to refactor, clean up,
  split, or "apply the pattern to" a route under packages/agents/routes/, when adding a new route,
  or when a controller is found holding SQL, hand-built JSON, repeated existence checks, or a
  `req: Request` parameter.
---

The worked example is `packages/agents/routes/agents/`. Read it before converting anything —
every rule below is visible there, and it is 19 routes, so it covers the awkward cases.

## The layers

One folder per route. A file's name says which layer it is.

    routes/<name>/
      <thing>.controller.ts     binds, guards, chooses status codes
      <thing>.service.ts        the rules, in sentences. Never a status code
      <thing>.repository.ts     rows in, rows out. No SQL, no policy
      <thing>.guard.ts          refusals that run before a handler is entered
      <thing>.utils.ts          pure functions. No database, no request
      dtos/<name>.dto.ts        one DTO per file
      entities/<name>.entity.ts one @entity class per table

Cross-route imports go to the other route's `entities/`, never to `schema.ts`.

## Controller

- `@controller("/path")` and `@bindings` on the class. `@bindings` makes the library compute the
  dispatch table; without it the compiler guesses and parameter decorators do nothing.
- Capitalised verbs: `@Get @Post @Put @Patch @Delete @Head`. Lowercase still compiles; don't write it.
- **No handler takes `req: Request`.** Every parameter is bound:
  `@PathVariable("id")`, `@RequestParam("enabled", "")`, `@RequestHeader("x-thing")`,
  `@RequestBody`, `@Valid @RequestBody`, `@From(fn)` for anything derived from the request.
- No `db` field. The constructor takes `database: Db` and hands it to the service.
- Refusals from the service become replies through `answered(outcome)` — never re-worded here.
- Capitalised replies: `Ok Created Accepted NoContent NotFound BadRequest OkJson Respond Refused`.
  (`Respond` because `Reply` is the type; `Refused` because "problem" is banned.)

## Service

- Returns `Outcome` (`{ fault, document }`) built with `refusing(said)` / `produced(document)`.
  A sentence, never a status code — that is what keeps it callable from a tool or a test.
- Holds the rules that need the database: does the id already exist, does the thing it points at
  exist, is that model a chat model.
- Orchestration lives here too (tracing, recording a run), not in the controller.

## Repository

- One mapping, not two. A mapping carrying relations still writes: `persist` builds its column
  list from the fields, so relations are read-side only.
- **No SQL.** If you are writing `executeWith(... "INSERT INTO ...")`, the verb is missing from
  plume — add it there. Link tables: `link`, `unlink`, `unlinkAllOwnedBy`, `unlinkAllPointingAt`,
  and `linkOf(repo, field)` to reach the description the entity already declares. Blunt column
  writes: `setEvery`. Raw SQL is only for what an ORM genuinely cannot express (pgvector).
- Every plume call returns `DbResult`. Check it. A discarded result is a silent failed write —
  this was a real bug in every link call before the sweep.

## Guards

A guard is a function returning `Guarded`, built with `resolve()` or `reject(reply)`.

```lumen
export function agentExists(agents: AgentService, request: Request): Guarded {
  let id = param(request, "id");
  if (!agents.exists(id)) {
    return reject(NotFound("agent " + id));
  }
  return resolve();
}
```

Applied as `@Guard(theAgent)` where the controller holds a one-line delegation. That line is
required, not laziness: the dispatcher hands a guard nothing but the request, so a guard needing
the service has to be reached through `self`.

- `@Guard(name)` — a name, never a string.
- `@Guard(roleAtLeast("signed-in", "signing in is what makes a key yours to keep"))` — a call.
  It is sugar, not a generator: Lumen lambdas cannot capture, so it flattens to metadata.
- The refusal sentence is an argument. Every route says why in its own words; one shared sentence
  is a worse page for a smaller diff.
- Shared guards live in `packages/agents/guards.ts`: `pgOnly`, `roleAtLeast`, `ownedOrEmpty`.

## DTOs and validation

- One DTO per file under `dtos/`. A DTO is what crosses the wire. `Outcome` is not a DTO.
- Rules go **on the type**, never in the handler: `@validated` on the class, `@required`,
  `@maxLength(48, "…")`, `@min`, `@max`, `@oneOf`. Each carries its own message.
- The DTO is the whole body, so the handler never also takes the request to reach `req.body`.
- A rule needing the database is not a decorator — it is the service's.
- Refusals come back as `{"errors":[{"field","said"}]}`, a list, not a string.

## Entities

- `@entity("table")` with `@id`, `@column("column", "sqltype")` per field. No `field()` lists.
- Relations on the class: `@hasOne(table, localColumn, foreignColumn, columns)`,
  `@hasMany(...)`, `@hasManyThrough(table, foreignColumn, linkTable, linkLocal, linkForeign, local, columns)`.
- A dialect-dependent column is `{bool:enabled}` in the column list — expanded when the query is
  built. A decorator argument is a literal and cannot call `boolColumn(database, ...)`.
- Export `function <thing>Repository(): DbRepository { return entity<Class>; }` — the decorator
  leaves the constant in that module, so the accessor lives beside it.
- Every decorator package exports its own description type name (`EntityDescription`,
  `Description`). Two packages exporting the same type name collide.

## Naming

Full words. `database` not `db`, `request` not `req`, `repository` not `repo`, `document` not `doc`.
A verb says what it does, not which column it matched — `unlinkAllPointingAt`, not `unlinkForeign`.
The word "problem" is banned; use `fault`, `refusal`, `said`.

## Formatting

    node tools/lumen-fmt.mjs packages/agents            # apply
    node tools/lumen-fmt.mjs packages/agents --check    # fail a build

Rule 1: a block is never on one line. Rule 2: a record does not sit inline in a line over 100
characters. No comments explaining what the code already says — `node tools/strip-comments.mjs`
in joule-console removes them.

## The scorecard

    node tools/check-pattern.mjs                  # every rule, every route, exits 1
    node tools/check-pattern.mjs --route tasks    # one route: is it done?
    node tools/check-pattern.mjs --summary        # counts only

Run it BEFORE claiming a route is converted, and before claiming a sweep is
finished. It exists because "I converted the mappings" was true of two of them
and false of thirty-four, and nothing said so — a rule nobody can run is a rule
that gets half-applied.

A route is done when its count is 0. `agents` and `runs` are 0; everything else
is the worklist, worst first.

## Verifying a conversion

All four, every time. The first three are cheap and the fourth catches what they cannot.

1. `lumen check api.test.ts` — clean.
2. `lumen test api.test.ts` — 58 passing, plus the suites of any package touched.
3. **The route table is unchanged.** Compile a copy under a temp name (`FileBusy` over the running
   binary), point it at port 8199 and a throwaway db, and diff its printed table:

   ```
   cp api.ts api_probe.ts && sed -i 's/listenLocked(8100,/listenLocked(8199,/' api_probe.ts
   lumen compile api_probe.ts
   LUMEN_MASTER_KEY=$(python3 -c "print('0'*32)") AGENTS_DB_FILE=/tmp/probe.db \
     AGENTS_API_TOKEN=probe AGENTS_TRUST_PROXY_AUTH=1 ./api_probe > /tmp/probe.log 2>&1 &
   grep -c '^route  ' /tmp/probe.log     # 215
   ```

   **Never bind 8100** — the engine runs there, `SO_REUSEPORT` lets a second process share it, and
   your requests get split between your probe and production.

4. **Drive the routes.** A compile is not a verification: `@delete` once produced no route at all
   and everything still built. Curl the guarded, validated and joined paths and read the answers.

Identity: `AGENTS_TRUST_PROXY_AUTH=1` and `x-user: <owner>`; a guest is `x-user: guest:g1`.

## Traps that have actually bitten

- A quoted header in a curl loop (`-H Authorization:Bearer x` unquoted) silently 401s everything.
- `zig build … | tail && echo OK` reports tail's exit code, not the build's.
- The compiler's dispatcher dump truncates its longest function — it is not proof a route is missing.
- A formatter that rewrites nested blocks inner-first corrupts source that still parses.
- `git show HEAD:new-file > file` truncates the file first, then fails. Renamed files are lost.
