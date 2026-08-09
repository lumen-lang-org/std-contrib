# Secrets for workflow steps

An HTTP step that calls a real API needs a key, and today the node has
nowhere to put one that isn't the graph. The graph is the wrong place three
times over: it is one JSON column rewritten on every drag, it is served to
the browser and printed by `show_workflow`, and it is authored by a model —
a key typed into a node config is a key in a plaintext document an LLM reads
and can reproduce into its next answer. `WfNode.botId` already states the
rule for Telegram: the token "is NOT here and never will be … a credential
belongs in the one table that encrypts it." An HTTP header key is the same
object, so it gets the same treatment.

## The design

**One secrets store, referenced by name.** A secret is a row somebody owns —
`id, owner, name, header, destination, createdAt, lastUsedAt` — and a value
that goes through `credentials.ts` under the ref `secret:<id>`: encrypted
with the master key, write-only forever, forgotten with the row. The node
carries `secretId` and never a value; there is no `{{secret}}` template on
purpose, because a step's output is stored in `workflow_runs.steps` and
drawn on the canvas, so any path that lets a secret into an output is a
leak with a UI.

**The destination is pinned when the secret is stored.** `credentials.ts`
already proved why: a row naming a secret and an address, where only the
secret is write-only, is an exfiltration primitive — repoint the address,
press Run, read the key on your own server. A workflow is the worst
instance, because the address is editable by dragging and by an agent
calling `change_step`. So a secret records the origin it may be sent to,
and an HTTP step using it is refused — at save and again at run — when the
step's origin differs. A templated origin (`https://{{prev}}/…`) never
equals a stored one, so it refuses by construction. Moving the address
means deleting the secret and adding it again, `destinationProblem`'s own
trade: an attacker with write access can destroy a credential, and cannot
read one.

**The header rides the secret, not the node.** The row says which header
the value is sent in (`Authorization` unless said otherwise) and the value
is typed whole ("Bearer sk-…"), so the graph never needs to know how the
key is spelled. The node separately gains plain `headers` (templated
`Name: value` lines) for everything that is not a secret.

**A person types secrets; an agent points at them.** The console gets a
Secrets section (list, add, delete — never the value) and the HTTP
inspector gets a picker. The tools get `list_secrets` (names and
destinations only) and `change_step` learns to attach one by name. No tool
creates or reads a secret.

## The pieces

Engine:
- `secrets.ts` (new) — the rows, migration "109", `refuseSecret`,
  `createSecret` / `forgetSecret` (row + credential together),
  `secretValue`, `touchSecret`, and `graphSecretProblem(db, graph, owner)`
  — the save-time check every graph write runs.
- `packages/workflow/workflow.ts` — `WfNode` gains optional `headers` and
  `secretId` (the `source` precedent: optional or old documents stop
  parsing); HTTP validation checks header lines look like `Name: value`.
- `workflow-run.ts` — `fetchStep` fills the plain headers, resolves the
  secret owner-scoped, refuses an origin mismatch, injects the header
  last so it wins, touches `lastUsedAt`. The recorded step input stays
  `METHOD url` + body — headers are never written to the trail.
- `api.ts` — `@controller("/secrets")`: GET (rows, no values), POST
  ({name, value, destination, header}) → the row, DELETE /:id. Guarded
  like workflow create: signing in is what makes a secret yours to keep.
  Graph writes (create, update, publish) call `graphSecretProblem`.
- `workflow-tools.ts` — `list_secrets`; `change_step` takes `secret` (a
  name, or "none" to detach); both graph-persist sites run
  `graphSecretProblem`.

Console:
- Settings → a Secrets card: name, destination, header, last used, Delete;
  an add form whose value field is `type=password` and never re-shown.
- Workflows → HTTP inspector: a Headers textarea, a secret `nr-select`,
  and a "New secret…" inline form that derives the destination from the
  step's own URL.

## Verification

- `secrets.test.ts` — round-trip, wrong owner absent, delete forgets the
  credential, `graphSecretProblem` refuses a missing secret, a moved
  origin and a templated origin; run-time refusal on mismatch; a failed
  step's output and error never contain the value.
- Existing suites stay green; the api.test.ts fixture drops `secrets` and
  the healthz canary moves with the plan's top.
- Live on prod: add a secret in Settings, attach it to an HTTP step,
  run against httpbin, read the run's trail and confirm the header
  arrived and the trail never shows it. Screenshot the inspector.
