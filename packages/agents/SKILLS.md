# Skills: instructions an agent loads when the task calls for them

What an agent always knows should be what must always be true. Today the
docflow prompt carries its identity, its invariants, the validator's exact
invocation, the image's file inventory and, soon, a proto-reflection recipe —
and every turn pays for all of it, including "what is a docflow?". The recipes
also go stale with the image while the invariants do not, and the two change on
different clocks.

A skill is the split: a named body of instructions with a one-line description.
The briefing lists the descriptions — one line each, the way it lists artifact
paths — and a new tool, `use_skill(name)`, answers with the body when the model
decides the task matches the line. Pay-per-use context, edited without touching
the agent.

Born from a measured failure. Asked for the legal values of `QueryOperator`,
the docflow agent invented nine (`Equals`, `NotEquals`, `StartsWith`, …) of
which exactly one was real — the same hallucination class its own validator
exists to catch. The real fifteen (`Eq`, `OrEq`, `AndNe`, `Gt`, `Gte`, `Lt`,
`Lte`, `Distinct`, `Group`, `Ne`, `Exists`, `IsNull`, `DistinctOrNull`,
`Regex`, `Contains`) are computable in six lines of protobuf reflection against
`/app/descriptors/descriptor_set.pb` in its own environment. That recipe is the
first skill: not knowledge to retrieve, a value to compute, correct again the
day the proto changes.

## The rows

`skills` — `id`, `skill_name`, `description`, `body`, `updated_at`, mapped in
schema.ts beside `scriptImagesMapping`. `agent_skills` — `agent_id`,
`skill_id`, hand-written like `agent_mcp_servers`. `skill_files` —
`skill_id`, `path`, `body`: the scripts and reference files a skill ships,
`path` a plain name (`enums.py`), no `/` and no `..`, refused otherwise.
Migrations 67–69 on `schemaPlan`.

A skill that only describes a procedure makes the model retype its code into
run_script, and retyping is the corruption channel this package already
distrusts — the reason image base64 is never copied back by hand. So a skill
ships its scripts: the markdown body is the procedure, the files are its
tools, and the body says `python /skills/read-proto-enums/enums.py
QueryOperator` instead of carrying twenty lines to transcribe.

**Mutable, not versioned.** Prompts version because an agent pins a prompt by
id and rollback must be an UPDATE. A skill is looked up by name at call time,
so an edit is already live on the next `use_skill` — the live-rows premise
gives instant updates for free. If rollback pressure ever appears, versions
arrive as a new table and a repointing, with no migration pain. (One planning
pass argued for prompt-style versioning; this is the decision and the reason.)

Caps at the API door, because one bloated description taxes every turn of
every conversation the agent has: description one line, at most 200 bytes;
body at most `SKILL_MAX` (16 KB) so a body can never wander toward the context
budget by accident.

`agentsFull` gains a `skills` relation carrying `skill_name` and `description`
— never the body; the full view is for listing and running, and a body rides
`GET /skills/:id`. Every parser of the full document (schema.test.ts
`AgentView`, api.test.ts, delegate.test.ts) must declare the new key.

## The tool

`use_skill`, offered only when the agent has skills — an agent with none is
told nothing, absent rather than offered-and-failing, the `scriptTools`
rule. Skills are agent-scoped, not thread-scoped: the call record is
`{ agentId, name, args }` and a bare run without a thread still answers.

The description teaches what only telling can teach: the briefing line is for
choosing and this call is how you read the rest; load before taking the first
step the skill would govern, because instructions read mid-task cannot un-make
a choice already made; the body does not change between calls, so load once
and keep working from it; a name the briefing does not list is refused,
nothing fuzzily matched. Schema: one required member, `name` — the console's
transcript parser reads the same member.

Refusals are sentences the model can act on. Missing member: `use_skill needs
a member named "name" — the skill to load, exactly as your briefing lists
it.` Unknown skill: `There is no skill named "…". This agent has:
read-proto-enums, validate-uploaded-docflow, repair-docflow — use one of those
names exactly.` Success is the body whole, nothing wrapped around it —
operator-written configuration, the same trust class as the prompt itself,
subject to the same output cap as every tool result. When the skill ships
files, the answer ends with one line naming them: `This skill ships files
under /skills/read-proto-enums/: enums.py — run them rather than retyping
them.`

## The files in the container

run_script already stages `/artifacts` fresh for every run; skill files are
its sibling. On every run where the agent has skills, each skill's files land
at `/skills/<skill-name>/<path>`, staged on the host and copied in with the
same `docker cp` the run directory uses, cleared and rewritten per run so an
edit to a skill file is live on the very next run — the artifact staleness
rule, no second lifecycle. Not copied at environment creation, which would go
stale on edit; not copied by `use_skill`, which must answer on a bare run
with no thread and no container. A skill name is therefore held to the
environment-name charset rule at the API door — it becomes a container path —
and file bodies count against `SKILL_MAX` alongside the markdown.

`/skills` is read-only in intent but not enforced by mount: a script that
scribbles over it damages one run, and the next run's staging rewrites it —
the same self-healing the run directory has.

Dispatch in run.ts sits ahead of delegation and MCP: `use_skill` belongs to
the package, and a server that happens to export a tool of the same name must
never answer it.

## The briefing

Built beside `artifactBriefing` and shaped like it:

    You have these skills — named instructions you can load with use_skill:
    - read-proto-enums: when a verdict says "Invalid enum value" …
    - repair-docflow: the procedure for fixing a rejected docflow …
    Each line is for choosing, not for doing: when a task matches one, load
    the skill before starting the work.

Appended to the system prompt after the artifact briefing, outside the
thread-gated block — skills ride the agent, not the thread. Ordered by name.
Past `SKILL_BRIEFING_LINES` (50), the remainder appear as names only on one
line, so every skill stays loadable without promising an affordance that does
not exist. Empty string when the agent has none.

## The doctrine: prompt or skill?

**An invariant that prevents a lie belongs in the prompt; a recipe that
produces an answer belongs in a skill.** The prompt keeps what must be true on
turns where no skill loads: identity and scope; the
never-validate-your-own-invention rule — the small models that most need it
are exactly the ones that will not call `use_skill` before violating it;
the run-dir contract (`/artifacts`), because an orientation fact that gates
every tool use must not itself require a tool use; "the proto is the
reference, not your memory". Skills take the procedures: invocation syntax,
file inventories, category-by-category repair recipes — bulky, image-version-
coupled, needed on a minority of turns.

## REST and console

Controller `/skills` mirrors `ScriptImageApi`: GET list ordered by name,
GET `/:id`, POST (createProblem first, then guards: a skill without a
description cannot be chosen; an empty skill is not an instruction), PUT,
DELETE — which also clears `agent_skills` rows, since a dangling link is a
skill the console shows attached that the run never offers. Attach/detach on
`AgentApi` mirror addServer/removeServer: `POST /agents/:id/skills` with
`{"skillId"}`, `DEL /agents/:id/skills/:skillId`, both answering the full row.

In the console, Skills is a Settings tab after Prompts — a skill row is
structurally a prompt row with a different join, and settings is where rows
live. Tab icon `sticky-note` (verified in icon-paths.ts; `book`, `lightbulb`,
`sparkles` do not exist there). Body edits in `nr-code-editor` as markdown —
the existing `updated()` hook dresses every editor with the token colours for
free. Assignment is a checkbox list in the agent form, seeded from
`AgentFull.skills`, diffed on save into link/unlink calls — the canvas's
diff-apply idea, in form clothes. In the transcript card a call renders as
`Used skill <name>` with its duration; there is no body to expand, because a
step row carries arguments, not results. `ui.ts` is not touched — every
component needed is already registered.

## The seeds

Three skills, attached to `a-docflow`, shipped together with docflow-expert
v5 — the prompt slimming lands only with the skills, never before:

- **read-proto-enums** — the reflection recipe, verified against the live
  image. Description echoes the validator's own words ("Invalid enum value"),
  because that is what the model is staring at when it should match. Ships
  `enums.py` (the FileDescriptorSet walk, taking the enum-name suffix as its
  argument); the body says to run
  `python /skills/read-proto-enums/enums.py <EnumName>`, carries the
  case-sensitivity warning, and the rule: never answer an enum question
  without having run this.
- **validate-uploaded-docflow** — name the user's artifact in `paths`, run
  `python /app/docflow_validate.py --json /artifacts/<file>` (several paths in
  one call), read `reports[].violations[]`, report in the validator's words;
  the reference examples are for comparison and a verdict about them is never
  a verdict about the user's file. Absorbs the invocation and inventory now
  hard-coded in prompt v4.
- **repair-docflow** — fresh validate first, never from recollection; repair
  by category (unknown-field: delete exactly the named fields; enum-value:
  load read-proto-enums and substitute only when intent is unambiguous,
  otherwise ask); edit and re-validate in one `run_script` round trip; done
  means the validator passed the user's path in this run.

## The eval

Extend the direct harness (`docflow_eval.py` — Langfuse stays off), keeping
its founding rule: ground truth is read from the validator and the descriptor
set at run start, never fixtured. The enum scorer's fabricated-value blacklist
must subtract the real set first — `Contains` is both invented-sounding and
real, which is exactly the trap. Route assertions come from the reply's
`steps`.

1. **enum-fix** — upload a bad-enum docflow (a valid example with one `Eq`
   turned `Equals`), get the verdict, then "fix it". Score: repaired artifact
   passes a harness-run validator; answer and artifact contain no blacklisted
   value; route saw `use_skill(read-proto-enums)` and `run_script`.
2. **enum-question** — no document: "what are the legal values of
   QueryOperator?" Exact set match against the computed fifteen. Fails if the
   model answers from the description alone.
3. **validate-uploaded** — the existing broken-example case, unchanged scorer,
   plus the route now showing `use_skill(validate-uploaded-docflow)` first.
   Proves the prompt slimming lost nothing.
4. **repair-unknown-fields** — "repair this so it validates": final version
   passes, the two named fields gone, nothing else removed (structural diff).
5. **control** — a pure corpus question: correct answer, zero `use_skill`,
   zero `run_script`, before and after seeding. Three description lines must
   not make the model spawn containers for questions that never needed them.
6. **stale-skill-honesty** — an enum the example does not mention
   (`ProductionFormat`): computed, not recited.

Failure modes measured, not assumed: small-model adoption is a column
(`use_skill` present when expected — mistral-large must be 100% on 1–4 to
ship; small is tracked, not gated); a misnamed skill gets the actionable
refusal and the trace should show a corrected call after it; briefing
invariance (system-prompt length with a maximal body equals with a one-line
body — only the description ever counts).

## Build order

- [ ] 1. schema.ts: `SkillRow`, `skillsMapping`, `agent_skills`,
       `skill_files`, migrations 67–69, `agentsFull` skills relation;
       schema.test.ts applied-count 16→19, `AgentView.skills`, the
       no-bodies-in-full-view case
- [ ] 2. tools.ts: `agentSkills`, `skillTool`/`skillTools`, `callSkillTool`,
       `skillBriefing` + `SKILL_BRIEFING_LINES`; tools.test.ts "the skill
       door" section, eight cases (nothing-offered, only-linked, one-line-never-
       the-body, body-whole, invented-name refusal, missing-member refusal,
       overflow names-only, edit-visible-next-call)
- [ ] 3. run.ts: offer after the thread-gated block, briefing at the system-
       prompt assembly, dispatch branch ahead of delegation and MCP
- [ ] 4. run-script.ts: stage `/skills/<name>/<path>` beside `/artifacts`,
       cleared and rewritten per run; test that an edited skill file is what
       the next run executes
- [ ] 5. api.ts: `/skills` controller with the caps and the charset guard on
       skill names, file routes, attach/detach on `AgentApi`, DELETE clearing
       links and files
- [ ] 6. app: `SkillRow` + calls + `AgentFull.skills` in api.ts; Skills tab,
       skill form with a file list (one nr-code-editor per file, language by
       extension), agent-form checklist in settings.ts; `Used skill <name>`
       row in chat-session.ts; e2e/skills.spec.ts (five cases: list, editor-
       stores-markdown, edit-replaces, assignment-round-trip, transcript-
       reads-as-skill — the last needs a canned use_skill turn in
       model-double.mjs)
- [ ] 7. Seed the three skills (read-proto-enums shipping enums.py), attach
       to a-docflow, ship docflow-expert v5 with the procedures removed
- [ ] 8. Extend docflow_eval.py with the six cases and the adoption column;
       run the control case before and after seeding; run the suite on
       mistral-large and mistral-small and record both

## Not building, and why

- **No versioning** — lookup is by name at call time; an edit is live on the
  next call. Rollback pressure, if it ever appears, is a new table.
- **No enabled flag** — detach is the off switch; a second door to the same
  fact is an invariant with two doors and one guard.
- **No per-model gating** — the agent row already chooses its model; gating
  skills by model restates that decision somewhere it can disagree.
- **No model-writable skills** — a model that can write its own standing
  instructions has a persistence channel into every future run.
- **No auto-inlining when the list is short** — one behavior, always;
  two paths mean instructions the model was never taught to ask for.
- **No filesystem skills** — everything here is a row so a change through the
  API is visible without a restart; files reintroduce the deploy step the
  package exists to remove.
