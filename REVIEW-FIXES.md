# Review fixes

Findings from the nine-agent review of `ai`, `agents` and `plume`. Only items
**verified in the code** are listed; three of the nine reports are in, and the
rest will be appended as they land.

Every item follows the same rule: **a test that fails before the fix and passes
after**, written first. A fix with no failing test is a claim, not a change.

---

## agents — live in production, fix first

- [ ] **A1. A truncated reply is stored as a successful answer.**
  `run.ts:459`, `provider.ts:461`, `threads.ts:399`.
  A reply that is one tool call, cut mid-arguments, loses that call to
  `jsonComplete`; `calls.length == 0` is then read as "the model finished".
  OpenAI-shaped (`content: null`) stores the raw JSON body as the assistant's
  answer; Mistral (`content: ""`) stores the question with **no answer**, and a
  second ask duplicates the round — walking straight past "a failed round stores
  nothing", because `run.ok` is true.
  **Fix:** read `finish_reason` / `stop_reason` — nothing in the package does
  today (`grep` finds only the `runlog` column). A reply that stopped on
  `length` was truncated by definition and must fail the round. Do not infer it
  from an empty call list: reading the reason also catches truncation mid-text,
  which nothing catches now.

- [ ] **A2. Anthropic behind a gateway 404s on every call.**
  `provider.ts:479`, `endpointFor` at `provider.ts:71`.
  `completeTurns` always asks for `chat/completions`, so a model row with a
  `baseUrl` is called at `<base>/chat/completions` instead of `/messages`. Only
  the empty-`baseUrl` path routes correctly.

- [ ] **A3. A working MCP tool is reported broken.**
  `mcp.ts:59`. Failure is judged by `body.indexOf("\"error\"") >= 0`, so a
  server sending `{"result":{…},"error":null}` has every tool marked failed —
  and the raw JSON-RPC envelope is handed to the model as the tool's answer.
  **Fix:** read the top-level `error` member and treat a null or absent one as
  success.

- [ ] **A4. `appendTurns` is not atomic.**
  `threads.ts:236`. Rows are inserted one at a time and it returns on the first
  failure, leaving the earlier ones committed. A cut between the assistant turn
  announcing calls and its tool turns leaves the thread permanently
  unreplayable — the original production bug, by another route. The caller then
  reports "the round was not stored", which is false.

- [ ] **A5. `jsonComplete` accepts balanced non-objects and has no unit test.**
  `scan.ts:263`, `scan.test.ts`. `null`, `12` and a bare word pass, and are
  spliced raw into the stored `calls` column and into an Anthropic `input`.
  It is the fix for a production incident and is tested nowhere.

- [ ] **A6. No deadline on any outbound call.**
  `provider.ts:493`, `mcp.ts:50`. No socket timeout in the runtime and none
  passed at either call site: a server that accepts and stalls hangs the request
  thread forever and loses the question. **Investigate first** — this may need a
  Lumen runtime change, in which case write it up rather than half-doing it.

- [ ] **A7. A round that is not stored still commits its artifact writes.**
  `run.ts:493`, `threads.ts:390`. `baseSeq` is `held.length`, and artifacts are
  written during dispatch. A round that then fails leaves files stamped with a
  `turn_seq` the next round reuses, so the next answer's cards show the previous
  attempt's file. Fix after A1 and A4; the shape depends on both.

## plume

- [ ] **P1. A migration can apply and never be recorded.**
  `migrate.ts:551`. The statement and its history row are two autocommitted
  round trips — there is no `beginTransaction` anywhere in the file. Interrupted
  in between, the migration is applied and still pending, re-runs forever, and
  neither `repairChecksums` nor `forgetMigrations` can recover it. PostgreSQL
  has transactional DDL; use it.

- [ ] **P2. Recorded migrations are generated from live mappings.**
  `agents/schema.ts:290,291,304` and the same shape in `runlog.ts`,
  `threads.ts`, `workspace.ts`, `knowledge.ts`, `indexing.ts`, `artifacts.ts`.
  Migrations 1, 4, 5 use frozen `…MappingV1()` copies; 2, 3, 8 and others pass
  the live mapping. Adding one field to any of those rewrites already-recorded
  SQL, the CRC check fails, and **every deployed database refuses the whole
  plan** while a fresh CI database stays green.
  **Fix:** freeze a `…MappingV1()` for every mapping that feeds a recorded
  migration. **The frozen copy must generate byte-identical SQL to what is
  recorded today** — generate before and after and diff the text; a fix that
  changes one byte causes the exact outage it prevents.

- [ ] **P3. A failed migration does not stop the server.**
  `agents/api.ts:1900`: `if (!ran.ok) { console.error(ran.error); }` then
  `return db`. The API starts and queries columns that do not exist.

- [ ] **P4. `migrationApplied` cannot answer for a repeatable step.**
  `migrate.ts:667`. Its comment says to pass the description as the version; the
  query matches on `version`, and a repeatable is stored with `version = ''`.
  Always false.

- [ ] **P5. Nothing serialises two migrators.** `migrate.ts:532`. Two replicas
  starting together both apply the pending set and the loser wedges itself per
  P1. Needs an advisory lock. **Design note first**, then implement.

## ai

- [ ] **I1. Prompt injection through the entry delimiters.**
  `prompt/prompt.ts:114`. `renderChatPrompt` joins `role + "\t" + content` with
  `"\n"` and then splits on `"\n"`. A substituted value carrying a newline and a
  tab forges an entry, role included. A two-line template breaks the same way
  without an attacker. There is no test file for `prompt.ts`.

- [ ] **I2. The approval loop cannot work against a real provider.**
  `agent/approval.ts:265` writes `"[tool_calls] name"`; `agent/agent.ts:356`
  parses by scanning for `"("` and gives up. Second turn emits
  `"tool_calls":[]` plus a tool message answering nothing. Every test drives a
  fake model that only counts the literal marker.

- [ ] **I3. Trimming separates a tool call from its result.**
  `memory/memory.ts:112,131,202`. `windowMemory`, `charBudgetMemory` and
  `compressHistory` all slice without knowing that an assistant tool-call
  message and the tool messages after it are one unit. `agent.test.ts:547`
  asserts the *belief* that synthesising an id makes it valid; a provider
  rejects it.

- [ ] **I4. `APPROVAL_SENTINEL` is a prefix match on tool output.**
  `agent/approval.ts:129,194`. Tool output is the least trusted string here. A
  document beginning with the sentinel pauses the parent for a tool that has
  **already run**, and approving re-executes it, which pauses again — an endless
  loop repeating the side effect.

- [ ] **I5. `resumeAgent` parses a checkpoint with no guard.**
  `agent/approval.ts:169`. `loadCheckpoint` returns `""` for a missing file, so
  the obvious composition crashes the process. And because `JSON.parse<T>`
  rejects missing fields, a checkpoint cannot survive its record gaining one —
  while `cp.version`, which exists for exactly that, is never read.

- [ ] **I6. Substitution re-expands its own output.**
  `prompt/prompt.ts:62`. Values are folded over the accumulating string, so a
  value containing `{{b}}` is expanded by the next binding. No escape for a
  literal `{{`.

---

## Rules for every fix

1. Failing test first, in the package's own suite, naming the scenario.
2. Do not touch the running API on `:8100`, the Vite server on `:5173`, or the
   live database. Never run a migration against it.
3. No emoji anywhere.
4. Keep the existing suites green: `agents` 209 tests, `rest` 82, `plume` and
   `ai` their own.
5. If a fix needs a language change, stop and write up what and why instead of
   working around it.
