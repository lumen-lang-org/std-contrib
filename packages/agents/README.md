# agents

The schema for a set of agents: what each one is, which model it runs on, which
prompt it uses, which MCP servers it may reach, and which agents it delegates
to.

Everything is a row. Nothing is compiled in, so a change through an API is
visible to the next request without a restart — which is the requirement the
rest of this follows from.

## One read gives a runnable agent

```ts
let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
```

```json
{"id":"a1","agentName":"lead","enabled":true,
 "prompt":{"id":"p2","promptName":"lead","version":2,"body":"You lead, briefly."},
 "config":{"id":"c1","modelId":"m1","temperature":0.2,"maxTokens":8192,"topP":0.95},
 "servers":[{"id":"s1","serverName":"filesystem","transport":"stdio","endpoint":"mcp-fs","enabled":true}],
 "subAgents":[{"id":"a2","agentName":"scout","enabled":true}]}
```

One query, not five, and no N+1: each relation is a correlated subquery the
database nests, so an agent with three servers and two sub-agents is still one
row.

## The decisions worth knowing

**A model name is a column.** `models.api_name` holds `claude-opus-5`; `label`
is what a human picks from a list. Renaming the label never changes a request,
and moving an agent to a newer model is an UPDATE.

**A prompt is versioned and never edited.** A change writes a new row with the
next version; the agent points at one. Rolling back is an UPDATE, and the
version you rolled back from is still there.

**Config is separate from the model**, because two agents on one model
routinely want different knobs. `extra` carries whatever a provider accepts
that the named columns do not, so an unfamiliar parameter needs no migration.

**Sub-agents read one level at a time.** `subAgents` names an agent's children,
not its grandchildren. A cycle in the delegation graph is therefore a row
rather than an infinite query — and the suite inserts one to prove it.

**The schema is generated from the mappings.** `schemaPlan` builds each
`CREATE TABLE` with `createTableSql`, so the schema a program expects and the
schema a migration builds cannot drift. Only the two link tables are written by
hand, because they hold keys rather than an entity.

## Serving it

`api.ts` is the schema behind a `rest` controller:

```
GET    /agents            every agent, ordered, with ?enabled=true
GET    /agents/:id        the whole agent in one query
POST   /agents            create
PUT    /agents/:id/model  point at a different model config
PUT    /agents/:id/prompt point at a different prompt version
POST   /agents/:id/servers  attach an MCP server
DELETE /agents/:id
```

Every read goes to the database. Nothing is cached and nothing is compiled in,
so a change — through this API or from anything else touching the same tables —
is visible to the very next request. That is met by not doing the thing that
would break it, rather than by machinery.

## Talking to what the rows describe

`mcp.ts` mounts an MCP server from its row, and `provider.ts` calls a model
from its row. Neither file names a server or a model.

```
mounting  demo-mcp at http://127.0.0.1:8200
initialize ok=true
tools     add, echo
add(2,40) 42
disabled  ok=false demo-mcp is disabled
```

```
model     Mistral Small -> mistral-small-latest
ok=true status=200
disabled  Mistral Small is disabled
```

In both, the last line is the point: `enabled` was flipped in the database and
the next call refused, with no restart.

**MCP is HTTP-transport only.** The other transport is stdio, which needs to
spawn a process, and Lumen has no subprocess API — so a stdio server has to be
fronted by something speaking HTTP. The client says exactly that rather than
failing obscurely.

## Credentials

A provider's API key is a row, encrypted:

```ts
storeCredential(db, "mistral", "sk-...", masterKey(), now);
complete(model, config, prompt, text, credentialFor(db, "mistral", masterKey()));
```

```
stored for  mistral
envelope    yV23Bn0vGDrN3+lEt04PhvRyL4jYo1JVWajaKcaW7m3J…
plaintext in the row? false
call        ok=true status=200
wrong master ok=false no API key for mistral
```

**The ciphertext is a row; the key that opens it is not.** `LUMEN_MASTER_KEY`
comes from the environment, so the database never sees it. Encrypting a
credential with a key stored beside it protects nothing. The trade is real and
intended: losing the environment loses the credentials.

AES-256-GCM, so it is authenticated — a row edited in the database refuses to
open rather than decrypting to something plausible that would then be sent to a
provider. A test does exactly that edit.

**Every failure to open answers the same way**: absent, wrong master key, and
tampered all return `""`. A caller that could tell them apart could use this
table to test master keys against.

An empty key is refused at the door, because an empty plaintext encrypts to a
valid envelope that decrypts to `""` — indistinguishable from a failure.

`providersWithCredentials` returns names only; nothing in this module returns an
envelope, so a listing endpoint cannot leak one by accident.

## Testing

```sh
cd packages/agents
lumen test schema.test.ts     # 10, against SQLite
lumen test mcp.test.ts        # 3, the refusals — the live half is an example
lumen test provider.test.ts   # 5, provider selection and refusals
lumen test credentials.test.ts # 13, encryption at rest
```

The live halves are `examples/mount-mcp.ts` and `examples/call-model.ts`. A test
that needs a credential or a listening port is a test that gets skipped, so
those stay examples and the refusals stay tests.

Requires `sh ../plume/build.sh` first.
