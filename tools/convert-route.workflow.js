export const meta = {
  name: 'convert-route',
  description: 'Convert one Lumen route to the layered pattern and verify it against the scorecard',
  phases: [
    { title: 'Convert', detail: 'read the skill, convert the route folder' },
    { title: 'Verify', detail: 'distrust the report, check the files, fix what is left' },
  ],
}

const input = typeof args === 'string' ? JSON.parse(args) : args
const route = input.route
if (!route) throw new Error('no route given: args was ' + JSON.stringify(args))

const REPO = '/home/ubuntu/projects/std-contrib'
const ENGINE = `${REPO}/packages/agents`

const CONTEXT = `
You are converting ONE route in a Lumen (not TypeScript/Node) codebase: ${ENGINE}/routes/${route}/

Read first, in order:
  1. ${REPO}/.claude/skills/lumen-route/SKILL.md   the rules, not suggestions
  2. ${ENGINE}/routes/agents/                       the worked example, scores 0
  3. ${ENGINE}/routes/runs/                         a small one, scores 0
  4. ${ENGINE}/routes/${route}/                     what you are converting

The scorecard tells you exactly what is wrong and when you are done:
  cd ${REPO} && node tools/check-pattern.mjs --route ${route}

HARD RULES
- Edit ONLY ${ENGINE}/routes/${route}/. Never api.ts, schema.ts, guards.ts, api-core.ts, another
  route, or packages/rest, packages/plume, tools/. Report a needed shared change, do not make it.
- Do NOT rename the exported controller class; api.ts imports it by name. Renaming the FILE to
  <thing>.controller.ts is wanted - do it with git mv and say so; the api.ts import is repaired
  centrally afterwards.
- Entities already exist under routes/<route>/entities/ for: agents, prompts, models,
  model-configs, servers, skills, runs. Import them; never write a second mapping for one table.
- BEHAVIOUR MUST NOT CHANGE: same paths, same status codes, same sentences, same response keys and
  key order. If a change would alter one, do not make it - report it.
- No explanatory comments. Lumen has no capturing lambdas and needs single-line imports.
`

phase('Convert')
const converted = await agent(
  `${CONTEXT}

Convert the route. Work from the scorecard: run it first, fix what it lists, run it again.

Then type-check and format:
  cd ${ENGINE} && timeout 600 lumen check routes/${route}/<controller file>
  cd ${REPO} && node tools/lumen-fmt.mjs packages/agents/routes/${route}

Note: lumen check on a single controller reports one "unknown type name" on the generated
bindings<Class> line - Bound resolves only in the whole program. That one is expected; anything
else is yours.

Report what you changed, the controller's new filename, and anything you deliberately left.`,
  { label: `convert:${route}`, phase: 'Convert' },
)

phase('Verify')
const VERDICT = {
  type: 'object',
  required: ['clean', 'score', 'remaining', 'behaviourRisks', 'controllerFile', 'summary'],
  properties: {
    clean: { type: 'boolean', description: 'scorecard is 0 AND lumen check is clean' },
    score: { type: 'integer', description: 'departures the scorecard still reports for this route' },
    controllerFile: { type: 'string' },
    remaining: { type: 'array', items: { type: 'string' } },
    behaviourRisks: { type: 'array', items: { type: 'string' } },
    sharedChanges: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const verdict = await agent(
  `${CONTEXT}

Another agent reports it converted this route:

${converted}

Distrust that. Check the files on disk yourself, then run:
  cd ${REPO} && node tools/check-pattern.mjs --route ${route}
  cd ${ENGINE} && timeout 600 lumen check routes/${route}/<controller file>

Fix anything still broken, under the same hard rules. Report the scorecard number honestly - a
wrong "clean" is worse than a known remainder, because the parent trusts it and stops looking.

List every way behaviour could have moved: a status code, a sentence, a response key, key order.`,
  { label: `verify:${route}`, phase: 'Verify', schema: VERDICT },
)

return { route, verdict, convertedReport: converted }
