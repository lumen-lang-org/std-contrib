export const meta = {
  name: 'extract-entity',
  description: 'Give a shared top-level module a real @entity for one table, and repoint the routes that reach into it for reads',
  phases: [
    { title: 'Extract', detail: 'read the module, add the entity, repoint pure-read call sites' },
    { title: 'Verify', detail: 'distrust the report, check behaviour is unchanged, especially orchestration left alone' },
  ],
}

const input = typeof args === 'string' ? JSON.parse(args) : args
const module = input.module
const table = input.table
const routes = input.routes || []
if (!module || !table) throw new Error('need {module, table}: args was ' + JSON.stringify(args))

const REPO = '/home/ubuntu/projects/std-contrib'
const ENGINE = `${REPO}/packages/agents`

const CONTEXT = `
You are giving one table a real @entity, in a Lumen (not TypeScript/Node) codebase: ${ENGINE}

Target module: ${ENGINE}/${module}  (owns the "${table}" table's mapping today, as a hand-written
field() list, per the "mapping-not-entity" rule in .claude/skills/lumen-route/SKILL.md)

Routes whose repository.ts imports from this module for reads of this table (flagged by
tools/check-pattern.mjs's repository-delegates-to-legacy-module rule): ${routes.join(', ') || '(see check-pattern.mjs --summary for the full list)'}

Read first:
  1. ${REPO}/.claude/skills/lumen-route/SKILL.md   - the Entities section
  2. ${ENGINE}/routes/prompts/entities/prompt.entity.ts   - the simplest worked example
  3. ${ENGINE}/${module}                            - what you are extracting from

THE CRITICAL DISTINCTION, already drawn correctly by every route-conversion agent this sweep:
a bare mapping (field() list, a straight findById/listOrdered/persist read or write) is what
becomes the entity. Anything carrying real logic - retry/claim semantics, docker calls, credential
store/rollback, quota checks, cross-table validation - is a SERVICE, not a mapping, and stays
exactly where it is. Do NOT move orchestration into the entity or delete it. If a function mixes
both (e.g. a read with a WHERE clause narrowing by status), the entity/repository owns the
plume call and the narrowing logic can move to a service-layer function that composes it - but
only if you can prove byte-identical output. When in doubt, leave the function alone and only
add the entity + a repointed import for the routes that use it for a truly bare read.

HARD RULES
- Edit ONLY: ${module}, the new entity file(s), and the *.repository.ts files of the listed routes
  (only their imports and the specific calls that read/write this table - nothing else in those
  files). Never api.ts, api.test.ts, guards.ts, or any other route's files.
- The module's own existing mapping function (e.g. indexJobsMapping()) must keep working for every
  existing caller: make it delegate to the new entity ("return entityX;"), do not delete it, do
  not change its signature.
- BEHAVIOUR MUST NOT CHANGE. Same SQL shape, same filtered rows, same column set in a response.
  If a hand-written SELECT narrows columns or filters rows in a way plume's listWhere/findById
  cannot reproduce exactly, do not force it through the entity - leave that function as it is and
  say so.
- No explanatory comments. Lumen has no capturing lambdas and needs single-line imports.
- Full names (database, request), capitalised decorators (@Entity fields: @Id @Column @HasOne
  @HasMany @HasManyThrough - both cases work, prefer capitalised for anything you write).
`

phase('Extract')
const converted = await agent(
  `${CONTEXT}

Do the extraction. Steps, in order:
1. Read ${module} fully. Identify the field()-mapped function for "${table}" and every function that
   reads or writes it, and for each, classify: bare mapping access, or real logic.
2. Create the entity under whichever route most naturally owns "${table}" (or a shared location if
   no single route does - use your judgement and say why).
3. Make the module's existing mapping function delegate to the entity.
4. For each listed route's repository.ts: if its import from this module is a bare read/write
   already, repoint it to import the entity/repository directly instead. If it is calling a
   function with real logic attached, LEAVE IT and explain why in your report - do not force it.
5. Compile: cd ${ENGINE} && timeout 600 lumen check api.test.ts
   Iterate until clean.

Report exactly which routes you repointed, which you left and why, and the module's remaining
functions that still carry real logic (so the next phase or a human knows what's left).`,
  { label: `extract:${table}`, phase: 'Extract' },
)

phase('Verify')
const VERDICT = {
  type: 'object',
  required: ['clean', 'remaining', 'behaviourRisks', 'summary'],
  properties: {
    clean: { type: 'boolean', description: 'compiles clean AND no behaviour moved AND orchestration left alone' },
    remaining: { type: 'array', items: { type: 'string' } },
    behaviourRisks: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const verdict = await agent(
  `${CONTEXT}

Another agent just did this extraction. Its report:

${converted}

Distrust it. Check the files themselves. In particular:
- Did it accidentally move orchestration logic (retries, docker calls, credential handling,
  quota checks) into the entity or delete it? That would be a real regression.
- Does the module's original mapping function still work for every existing caller (not just the
  routes named here - grep the whole engine for other callers)?
- For every route repointed: does the entity's column order match the old mapping's field order,
  so response key order is unchanged? Does a WHERE-narrowed read still narrow the same way?

Compile: cd ${ENGINE} && timeout 600 lumen check api.test.ts - must be clean.

Fix anything broken, under the same hard rules. Report honestly - a wrong "clean" here risks a
real regression in shared code many routes depend on.`,
  { label: `verify:${table}`, phase: 'Verify', schema: VERDICT },
)

return { module, table, routes, verdict, extractedReport: converted }
