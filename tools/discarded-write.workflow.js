export const meta = {
  name: 'discarded-write',
  description: 'Find agent-facing tools that report success after a database write whose failure was thrown away, and make them tell the truth',
  phases: [
    { title: 'Fix', detail: 'one agent per tools file, classify each discarded write and repair the dishonest ones' },
    { title: 'Verify', detail: 'distrust the reports, re-derive independently, check nothing fire-and-forget was over-fixed' },
  ],
}

const REPO = '/home/ubuntu/projects/std-contrib'
const ENGINE = `${REPO}/packages/agents`

const FILES = [
  'agent-tools.ts',
  'knowledge-tools.ts',
  'project-tools.ts',
  'task-tools.ts',
  'trigger-tools.ts',
  'workflow-tools.ts',
]

const CONTEXT = `
You are reviewing a Lumen (not TypeScript/Node) codebase: ${ENGINE}

THE DEFECT CLASS. A plume write (persist / executeWith / deleteById / deleteWhere /
setOn / setEvery) returns a DbResult carrying {ok, error}. Several call sites throw that
result away and then immediately report success. In an agent-facing *-tools.ts file this
is worse than an ordinary ignored error: the tool's return value is what the model reads
and repeats to the person, so a failed write becomes the assistant saying "Changed." about
something it did not change.

The worked example, already fixed and committed (0d824b0), in
routes/templates/template.repository.ts:

    // before - the caller's own guard could never fire
    persist(this.database, threadRepository(), JSON.stringify(row));
    return id;

    // after
    let written = persist(this.database, threadRepository(), JSON.stringify(row));
    if (!written.ok) {
      return "";
    }
    return id;

JUDGEMENT IS THE WHOLE TASK. Not every discarded write is a defect. A write whose failure
genuinely does not change what the caller should say is fine as it is - a last_used_at
touch, a best-effort cleanup after the real work already succeeded, a seed routine at
startup. Do NOT mechanically wrap every write. Fix a site only when you can name what the
caller wrongly claims or wrongly assumes if that write fails.

For each site, decide one of:
  - DISHONEST: the function reports success, returns an id, or lets the caller proceed as
    though the row exists. Fix it.
  - FIRE-AND-FORGET: failure genuinely does not change the answer. Leave it, say why.

HOW TO FIX. Keep it local and in the file's existing idiom. These tool functions return a
FileToolResult through helpers named like yes(...)/no(...) - a failed write should come
back through the refusal helper, in the file's own voice, saying what did not happen. Read
the surrounding functions and match how they already word a refusal. Never invent a new
error-reporting mechanism, never change a function's signature, never reword an existing
refusal that is already correct.

HARD RULES
- Edit ONLY ${ENGINE}/<your one file>. Nothing else - not api.ts, not api.test.ts, not
  another tools file, not a route.
- Behaviour on the SUCCESS path must not change at all. Same text, same shape, same order.
  The only new behaviour is on the failure path, which today is silently wrong.
- No explanatory comments. Lumen needs single-line imports and has no capturing lambdas.
- Full words in names (database, request), capitalised decorators.
- Compile before you finish: cd ${ENGINE} && timeout 600 lumen check api.test.ts
  It must be clean. Iterate until it is.

A KNOWN COMPILER TRAP, hit repeatedly in this codebase: a local variable or parameter named
"error" corrupts the native backend (it is a Zig keyword and the emitter does not escape it
in every position). If you introduce a local for a DbResult, name it "written"/"gone"/
"stored", never "error". The reported error location for this bug is never the real one.
`

phase('Fix')
const VERDICT = {
  type: 'object',
  required: ['file', 'fixed', 'left', 'clean', 'summary'],
  properties: {
    file: { type: 'string' },
    fixed: {
      type: 'array',
      description: 'sites changed, each naming what the caller wrongly claimed on failure',
      items: {
        type: 'object',
        required: ['line', 'function', 'wrongClaim'],
        properties: {
          line: { type: 'integer' },
          function: { type: 'string' },
          wrongClaim: { type: 'string' },
        },
      },
    },
    left: {
      type: 'array',
      description: 'sites deliberately left as fire-and-forget, each with its reason',
      items: {
        type: 'object',
        required: ['line', 'function', 'why'],
        properties: {
          line: { type: 'integer' },
          function: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
    clean: { type: 'boolean', description: 'lumen check api.test.ts is clean' },
    summary: { type: 'string' },
  },
}

const reports = await parallel(FILES.map(file => () =>
  agent(
    `${CONTEXT}

Your file, and the only one you may edit: ${ENGINE}/${file}

1. Find every discarded plume write in it:
   grep -nE "^\\s+(persist|executeWith|deleteById|deleteWhere|setOn|setEvery)\\(" ${file}
2. For each, read the whole enclosing function and its callers. Classify it DISHONEST or
   FIRE-AND-FORGET by the rule above.
3. Fix the dishonest ones, in the file's existing idiom.
4. Compile clean.

Report every site you found, on both sides of the split. A site you leave needs a reason a
reviewer can check, not "seemed fine".`,
    { label: `fix:${file}`, phase: 'Fix', schema: VERDICT },
  ),
))

phase('Verify')
const found = reports.filter(Boolean)
const CHECK = {
  type: 'object',
  required: ['clean', 'wrongCalls', 'missed', 'summary'],
  properties: {
    clean: { type: 'boolean', description: 'compiles, success paths untouched, no over-fixing' },
    wrongCalls: {
      type: 'array',
      description: 'sites fixed that should have been left, or left that should have been fixed',
      items: { type: 'string' },
    },
    missed: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const verdict = await agent(
  `${CONTEXT}

Six agents each reviewed one file. Their reports:

${JSON.stringify(found, null, 1)}

Distrust them. Read the actual diffs (git diff -- packages/agents/*-tools.ts) and judge:

- Did anyone change a SUCCESS path? That is a regression, whatever the report claims.
  Compare against git HEAD for every touched function.
- Did anyone mechanically wrap a write whose failure genuinely does not matter, making the
  code noisier for nothing? Name it.
- Did anyone MISS a site of the same shape in their file? Re-grep each file yourself.
- Did anyone introduce a local named "error"? Check every added line.
- Does every new refusal read like the file's existing refusals, or does it read like a
  different author wandered in?

Compile: cd ${ENGINE} && timeout 600 lumen check api.test.ts - must be clean.
Then: cd ${ENGINE} && timeout 900 lumen test api.test.ts - must report 58 passed.

Fix what is wrong, under the same hard rules. Report honestly.`,
  { label: 'verify', phase: 'Verify', schema: CHECK },
)

return { reports: found, verdict }
