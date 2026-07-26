// The schema for a set of agents: what each one is, which model it runs on,
// which prompt it uses, which MCP servers it may reach, and which agents it
// delegates to.
//
// Everything is a row. Nothing is compiled in, so a change through the API is
// visible to the next request without a restart — which is the requirement the
// rest of this follows from. In particular the model *name* is a column, not a
// constant: swapping an agent onto a newer model is an UPDATE.
//
//   cd packages/agents && lumen test schema.test.ts

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRelation, DbRepository, field, repository, repositoryWith, hasOne, hasMany, hasManyThrough, createTableSql, boolColumn } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

// --- rows --------------------------------------------------------------------

// A model as the provider names it. `apiName` is what goes on the wire —
// "claude-opus-5" — and `label` is what a human picks from a list, so renaming
// the label never changes a request.
export type ModelRow = {
  id: string,
  label: string,
  apiName: string,
  provider: string,
  // "chat" or "embedding". A provider offers both and they are not
  // interchangeable, so which one a row is is part of what the row says.
  kind: string,
  // How wide this model's vectors are, 0 for a chat model. Stored rather than
  // asked for on every use: it is a fact about the model, it never changes,
  // and a document table is created this wide.
  dimensions: int,
  enabled: bool,
};

// The knobs, separate from the model, because two agents on one model routinely
// want different ones. `extra` carries whatever a provider accepts that this
// does not name, so an unfamiliar parameter needs no migration.
export type ModelConfigRow = {
  id: string,
  modelId: string,
  temperature: number,
  maxTokens: int,
  topP: number,
  extra: string,
};

// A prompt, versioned. A row is never edited: a change writes a new version and
// the agent is pointed at it, so rolling back is an UPDATE rather than an
// archaeology exercise.
export type PromptRow = {
  id: string,
  promptName: string,
  version: int,
  body: string,
  createdAt: string,
};

// An MCP server an agent may reach. `transport` is "stdio" or "http";
// `endpoint` is the command line or the URL, whichever the transport means.
export type McpServerRow = {
  id: string,
  serverName: string,
  transport: string,
  endpoint: string,
  enabled: bool,
};

// A provider's API key, encrypted at rest.
//
// The ciphertext is a row; the key that opens it is not. A master key stored
// beside what it protects is decoration, so it comes from the environment and
// the database never sees it.
//
// `envelope` is what crypto.encrypt returned: base64(nonce ‖ ciphertext ‖ tag),
// authenticated, so a row edited in the database refuses to open rather than
// decrypting to something plausible.
export type CredentialRow = {
  id: string,
  provider: string,
  envelope: string,
  updatedAt: string,
};

export type AgentRow = {
  id: string,
  agentName: string,
  description: string,
  modelConfigId: string,
  promptId: string,
  enabled: bool,
  updatedAt: string,
};

// --- mappings ----------------------------------------------------------------

export function modelsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("label", "label", "text"),
    field("apiName", "api_name", "text"),
    field("provider", "provider", "text"),
    field("kind", "kind", "text"),
    field("dimensions", "dimensions", "int"),
    field("enabled", "enabled", "bool"),
  ];
  return repository("models", "id", "id", fs);
}

// Takes the connection for the same reason agentsFull does: its relation
// projects a bool, and SQLite and MySQL store those as 0 and 1.
export function modelConfigsMapping(db: Db): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("modelId", "model_id", "text"),
    field("temperature", "temperature", "float8"),
    field("maxTokens", "max_tokens", "int"),
    field("topP", "top_p", "float8"),
    field("extra", "extra", "text"),
  ];
  let rs: DbRelation[] = [
    hasOne("model", "models", "model_id", "id",
           "id, label, api_name AS \"apiName\", provider, " + boolColumn(db, "enabled") + " AS \"enabled\""),
  ];
  return repositoryWith("model_configs", "id", "id", fs, rs);
}

export function promptsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("promptName", "prompt_name", "text"),
    field("version", "version", "int"),
    field("body", "body", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("prompts", "id", "id", fs);
}

export function mcpServersMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("serverName", "server_name", "text"),
    field("transport", "transport", "text"),
    field("endpoint", "endpoint", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository("mcp_servers", "id", "id", fs);
}

// The agent as a flat row, for writing.
export function credentialsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("provider", "provider", "text"),
    field("envelope", "envelope", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository("provider_credentials", "id", "id", fs);
}

export function agentsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("description", "description", "text"),
    field("modelConfigId", "model_config_id", "text"),
    field("promptId", "prompt_id", "text"),
    field("enabled", "enabled", "bool"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository("agents", "id", "id", fs);
}

// The agent as everything needed to run it, in one read.
//
// One query rather than five, and no N+1: each relation is a correlated
// subquery the database nests, so an agent with three servers and two
// sub-agents is still one row.
//
// `subAgents` names only the children — not their children. A tree is read a
// level at a time, deliberately: a cycle in the delegation graph would
// otherwise be an infinite query rather than a row.
// Takes the connection because a relation's projection is SQL this file
// writes, and a bool has to be spelled for the database it runs against —
// SQLite and MySQL store 0 and 1 where the record declares a bool.
export function agentsFull(db: Db): DbRepository {
  let rs: DbRelation[] = [
    hasOne("prompt", "prompts", "prompt_id", "id",
           "id, prompt_name AS \"promptName\", version, body"),
    hasOne("config", "model_configs", "model_config_id", "id",
           "id, model_id AS \"modelId\", temperature, max_tokens AS \"maxTokens\", top_p AS \"topP\", extra"),
    hasManyThrough({
      field: "servers", table: "mcp_servers", foreignColumn: "id",
      linkTable: "agent_mcp_servers", linkLocalColumn: "agent_id", linkForeignColumn: "server_id",
      localColumn: "id",
      columns: "id, server_name AS \"serverName\", transport, endpoint, "
        + boolColumn(db, "enabled") + " AS \"enabled\"",
    }),
    hasManyThrough({
      field: "subAgents", table: "agents", foreignColumn: "id",
      // The far table is this one: an agent's sub-agents are agents. The
      // generated subquery aliases the link table, which is what lets both
      // sides be named — and what makes swapping these two silent.
      linkTable: "agent_sub_agents", linkLocalColumn: "parent_id", linkForeignColumn: "child_id",
      localColumn: "id",
      columns: "id, agent_name AS \"agentName\", "
        + boolColumn(db, "enabled") + " AS \"enabled\"",
    }),
  ];
  return repositoryWith("agents", "id", "id", agentsMapping().fields, rs);
}

// --- the schema --------------------------------------------------------------

// The migration plan, with each table's statement generated from the mapping
// above rather than restated. The two cannot drift, which is the whole reason
// createTableSql exists.
//
// The link tables are hand-written: they hold no entity, only two keys, so
// there is no mapping for them to be generated from.
export function schemaPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("1", "models", createTableSql(db, modelsMapping())),
    migration("2", "model configs", createTableSql(db, modelConfigsMapping(db))),
    migration("3", "prompts", createTableSql(db, promptsMapping())),
    migration("4", "mcp servers", createTableSql(db, mcpServersMapping())),
    migration("5", "agents", createTableSql(db, agentsMapping())),
    migration("6", "agent to mcp server",
      "CREATE TABLE IF NOT EXISTS agent_mcp_servers ("
      + "agent_id " + db.textType + " NOT NULL, "
      + "server_id " + db.textType + " NOT NULL)"),
    migration("7", "agent to sub agent",
      "CREATE TABLE IF NOT EXISTS agent_sub_agents ("
      + "parent_id " + db.textType + " NOT NULL, "
      + "child_id " + db.textType + " NOT NULL)"),
    // One prompt name has many versions, and a lookup by name is the common
    // read, so it is worth an index rather than a scan.
    migration("8", "provider credentials", createTableSql(db, credentialsMapping())),
    migration("9", "prompts by name",
      "CREATE INDEX IF NOT EXISTS prompts_by_name ON prompts (prompt_name)"),
  ];
  return plan;
}
