# The standing review

A recurring pass over `packages/agents`: find real defects and pattern debt,
fix them, prove the fix, push. One coherent piece of work per cycle — never
two unverified at once. This is the convention that sweep runs on, and the
tools it built along the way.

## Where to look, in order

1. **The scorecard.** `node tools/check-pattern.mjs` from the repo root. Every
   rule but `repository-delegates-to-legacy-module` is fixable route by
   route. That one rule is not: it drops only when a shared top-level
   module's table gets a real `@entity`, via `tools/extract-entity.workflow.js`
   — converting the route that delegates to it does nothing.

2. **Defect classes.** Worth more than the pattern count, because one shape
   found by hand generalises to every file that has it. The shapes this sweep
   actually found, cheapest tell first:

   - **A discarded write behind an unconditional success.** A `persist` /
     `deleteById` / `deleteWhere` / `executeWith` / `setOn` / `setWhere` /
     `db.query(...)` whose result is never checked, sitting in a function that
     then reports ok regardless. When one turns up, **read every call site in
     the same file** — a file with one instance usually has a second sitting
     next to it (`connect.ts` had four across two commits).
   - **Delete standing in front of an upsert to the same row.** `persist` is
     an upsert; a `deleteById` immediately before it does nothing the write
     does not already do, and is the only way the row ends up gone — the
     delete lands, the write after it fails, and a working credential or
     connector disappears instead of being replaced. Caught a real instance
     four times over (`ffe4fd4`, `4219e03`, `d61e79f`), the last one at twelve
     lines' distance, which is why `tools/delete-then-upsert.mjs` exists now
     instead of relying on reading every file by eye.
   - **A read that answers `""` on both "not found" and "the query failed."**
     `findById` and `listWhere` do this on purpose (there's no bit for it),
     which makes a caller that treats `""` as "definitely absent" wrong twice
     over — once for a message that should have been retried, once for a cap
     that should have refused. `countWhere` is the one read verb that returns
     `-1` on failure instead of folding it into the empty answer; prefer it
     over `listWhere(...).length` for anything a limit or a dedup depends on.
   - **`JSON.parse` on an unchecked `findById`.** `JSON.parse("")` throws —
     it does not return an empty record — so an unguarded `let x: T =
     JSON.parse<T>(findById(...))` turns a merely-absent row into an
     uncaught exception that ends the whole request with nothing recorded.
   - **A dialect-specific clause spelled into raw SQL.** `FOR UPDATE SKIP
     LOCKED` is a syntax error on SQLite, not a no-op — a claim query using it
     fails outright and reads exactly like an empty queue, with nothing in
     the log to say otherwise. `skipLocked(db)` in `plume.ts` exists so this
     can't be re-introduced by hand.
   - Also worth hunting, not yet exhausted: a guard that can never fire, a
     parsed type narrower than the row it reads, an error path that returns a
     success-shaped value.

   `discarded-write.workflow.js` swept the agent-facing tool layer once and
   found 16 of these. What's left after this sweep is `api.ts` / `discover.ts`
   (owned by other sessions — see below) and defensible startup seeding.
   Judge each one; don't wrap on reflex.

3. **Tooling soundness.** `tools/narrow-write.mjs`, `narrow-read.mjs`,
   `dead-guard.mjs` and `delete-then-upsert.mjs` all had real bugs — usually a
   raw-text regex reading a comment as code, or a line-distance window that
   was too short for the real instance. A new detector is not trustworthy
   until it survives the same test its subject does: **plant the defect,
   confirm the tool finds it, remove the defect, confirm the tool goes quiet.**
   `check-pattern.mjs` itself has a long, independently-verified track record
   (~15 route conversions with no false negative) and doesn't need this
   redone absent a specific reason to doubt it.

## Verification, every cycle

- `cd packages/agents && lumen check api.test.ts` — clean.
- `lumen test api.test.ts` — 58 passed, plus every suite covering whatever
  changed.
- **A compile is not a verification.** Drive the changed code and read the
  answer.
- For a behavioural fix, prove **both directions**: `git stash push -- <file>`,
  reproduce the old wrong behaviour, `git stash pop`, show the new one. When
  stashing a fix that spans files that depend on each other, stash all of
  them together — stashing one and leaving another that consumes its new
  return type just breaks the build, and the "before" run silently exercises
  the new binary instead of the old one. (Caught this the hard way rebuilding
  the probe for `4f9c9fe`; the fix was to stash `environments.ts` and
  `env-sync.ts` together.)
- If the path needs a live dependency — an OAuth token endpoint, a
  provider — stand up a real local HTTP stub and drive a real round trip
  rather than skip the proof. See `connect.ts`'s fixes for the pattern: a
  Python `http.server` on a scratch port, answering the real shape.
- **Route table, if a route/handler/query changed:** build a probe.
  ```sh
  cp api.ts api_probe8197.ts
  sed -i 's/listenLocked(8100,/listenLocked(8197,/' api_probe8197.ts
  lumen compile api_probe8197.ts
  LUMEN_MASTER_KEY=$(python3 -c "print('0'*32)") AGENTS_DB_FILE=/tmp/probe.db \
    AGENTS_API_TOKEN=probe AGENTS_TRUST_PROXY_AUTH=1 ./api_probe8197 &
  ```
  **Never 8100** — the production engine binds it, and `SO_REUSEPORT` splits
  traffic between it and a probe silently. **Never 8199** — squatted by
  another session's stub since 2026-08-12; a probe that lands there answers
  curl with the stub's own 404 page and looks like success. Compare the
  printed route table against `/tmp/base.routes` (220 lines) — it must be
  identical unless the change is a deliberate route edit.
- If a workflow or tool reports clean but the scorecard disagrees, **believe
  the scorecard.**

## Rules

- `packages/agents/api.ts` and `discover.ts` carry another session's in-flight
  work. Leave them alone; do not stage them even by accident.
- The environment/docker images are owned elsewhere.
- Stage your own files **by name**. Never `git add -A`.
- Commit and push before starting the next piece.
- If a cycle finds nothing worth doing after real investigation, say so in one
  line and stop. Don't invent work, and don't re-litigate a judgement call
  already made and recorded in a commit message — `steps.ts`'s six discarded
  writes, `mcp-roster.ts`'s two, and `office-render.ts` / `knowledge.ts` /
  `scheduler.ts`'s one each are judged defensible and recorded as such; they
  are not open questions.

## Detectors this sweep built

- `tools/check-pattern.mjs` — the scorecard. Pre-existing, proven, the primary
  signal.
- `tools/delete-then-upsert.mjs` — a `deleteById` immediately in front of a
  `persist` to the same mapping, within the enclosing function. Deliberately
  does not match `deleteWhere` (a whole-set clear followed by fresh-id writes
  is a replace, not this shape) or raw SQL (a delete and a write keyed
  differently is often doing real work).
- `claims.test.ts` — the four claim queries (`claimDue`, `claimDueWorkflow`,
  `claimMessage`, `claimNext`) exercised on SQLite, which is the driver the
  suite runs on and the one a syntax-error clause would silently break on.
  Existed because nothing else called any of the four from a test.
