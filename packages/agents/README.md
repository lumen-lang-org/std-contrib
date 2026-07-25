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

## Testing

```sh
cd packages/agents
lumen test schema.test.ts     # 10, against SQLite
```

Requires `sh ../plume/build.sh` first.
