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
import { DbField, DbOrder, DbRelation, DbRepository, field, repository, repositoryWith, hasOne, hasMany, hasManyThrough, createTableSql, dialectType, boolColumn } from "../plume/plume.ts";
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
  // Empty means the provider's own address; anything else is an
  // OpenAI-compatible host answering the same wire format at a different
  // place — a gateway, a proxy, a local server.
  baseUrl: string,
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
  // How hard to think before answering, when the provider can be told. Empty is
  // "as it normally would". A token budget for Anthropic, an effort — low,
  // medium or high — for the reasoning models that take one; `thinkingJson`
  // decides what the text means, per provider.
  thinking: string,
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
  // "none", "bearer" or "header". The token lives in the credential store.
  authKind: string,
  authHeader: string,
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
  // The agent a new conversation opens against.
  isDefault: bool,
  // Which curated image this agent's script environments are built from. ""
  // means the deployment default. An id into script_images and never an image
  // reference: a model that could name its own image could make the server
  // pull anything off the internet and run it, which is the one thing an
  // operator curating a list is for.
  scriptImageId: string,
  updatedAt: string,
};

// An image an operator is willing to run scripts in. A row rather than a
// setting because a deployment has more than one kind of work — a data
// container and a web toolchain are different images — and because the set
// belongs to whoever runs the server, not to whoever is talking to it.
export type ScriptImageRow = {
  id: string,
  // What it is called where somebody picks it.
  label: string,
  // The reference docker is handed: agents-runtime:1, ghcr.io/x/y@sha256:...
  image: string,
  enabled: bool,
};

// A named set of instructions an agent can load mid-run. The description is
// the one line the model's briefing shows — it is how a skill is chosen — and
// the body is what use_skill answers. Looked up by name at call time and read
// fresh on every call, so editing a skill is an UPDATE and the next load sees
// it: no versions, because nothing pins a skill the way an agent pins a
// prompt id (SKILLS.md records the decision).
export type SkillRow = {
  id: string,
  // The name the model sends to use_skill — and a container path segment,
  // /skills/<name>/, so it is held to the environment-name charset at the
  // API door.
  skillName: string,
  // One line, for choosing; never the doing.
  description: string,
  // The full instructions, returned whole.
  body: string,
  updatedAt: string,
  // 'private' (an agent carries it by attachment) or 'public' (use_skill
  // answers for every caller). Two axes with featuredRank, not one enum —
  // "public but not promoted" must stay expressible.
  visibility: string,
  // Orders the console's capability chips; 0 is not featured. Featured
  // implies public, enforced at the API door.
  featuredRank: int,
};

// A file a skill ships — the scripts its body tells the model to run. Rows
// like everything else here, materialised into the container at
// /skills/<skill-name>/<path> fresh on every run, so an edit is live without
// a restart. A body that only *describes* code makes the model retype it into
// run_script, and retyping is the corruption channel this package already
// distrusts.
export type SkillFileRow = {
  id: string,
  skillId: string,
  // A plain name (enums.py): no slash, no dot-dot — it joins a container
  // path, and the guard lives at the API door.
  path: string,
  body: string,
};

// --- mappings ----------------------------------------------------------------

// The shapes migrations 1, 4 and 5 create, frozen as they were when those
// migrations were recorded. The live mappings below grow; these cannot, or the
// generated CREATE drifts from the checksum the history holds and every
// existing database refuses to migrate. A new column is an ALTER at a new
// version, never an edit here.
function modelsMappingV1(): DbRepository {
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

function mcpServersMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("serverName", "server_name", "text"),
    field("transport", "transport", "text"),
    field("endpoint", "endpoint", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository("mcp_servers", "id", "id", fs);
}

function agentsMappingV1(): DbRepository {
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

export function modelsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("label", "label", "text"),
    field("apiName", "api_name", "text"),
    field("provider", "provider", "text"),
    field("kind", "kind", "text"),
    field("dimensions", "dimensions", "int"),
    // Where to send the request, when it is not the provider's own address.
    // An OpenAI-compatible gateway — Ollama, vLLM, Groq, a company proxy — is
    // the same wire format at a different host, so it is a column and not a
    // provider of its own.
    field("baseUrl", "base_url", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository("models", "id", "id", fs);
}

// Takes the connection for the same reason agentsFull does: its relation
// projects a bool, and SQLite and MySQL store those as 0 and 1.
// The shape migration 2 recorded, frozen.
//
// Adding a field to the live mapping above would rewrite this statement, and a
// migration's text is checksummed: every database that has already run it would
// refuse the whole plan, while a fresh one migrated happily and CI stayed
// green. Migrations 1, 4 and 5 already carry a frozen copy for the same reason;
// this one was still generated from the live mapping when `thinking` was added,
// which is exactly the moment the hazard fires.
//
// It takes no `db` because it has no relation to widen: `createTableSql` reads
// fields only.
function modelConfigsMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("modelId", "model_id", "text"),
    field("temperature", "temperature", "float8"),
    field("maxTokens", "max_tokens", "int"),
    field("topP", "top_p", "float8"),
    field("extra", "extra", "text"),
  ];
  return repository("model_configs", "id", "id", fs);
}

export function modelConfigsMapping(db: Db): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("modelId", "model_id", "text"),
    field("temperature", "temperature", "float8"),
    field("maxTokens", "max_tokens", "int"),
    field("topP", "top_p", "float8"),
    field("extra", "extra", "text"),
    // How hard the model should think before it answers, when it can. Empty is
    // the default: think as the provider normally would. What a non-empty value
    // means is the provider's business — a token budget for Anthropic, an
    // effort for OpenAI's reasoning models — so it is text, not a number.
    field("thinking", "thinking", "text"),
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
    // How to authenticate: "none", "bearer", or "header". The token itself is
    // NOT here — it goes through the same encrypted store as a provider key,
    // because a secret beside the thing it authenticates is decoration.
    field("authKind", "auth_kind", "text"),
    // Which header carries it, when the kind is "header".
    field("authHeader", "auth_header", "text"),
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

export function scriptImagesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("label", "label", "text"),
    field("image", "image", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository("script_images", "id", "id", fs);
}

// Migration 67's shape, frozen. A migration's SQL is checksummed at apply
// time, so it must be built from what the table looked like THEN — building
// it from the live mapping turns every later column into an edit of history
// and the engine refuses to boot. threadsMappingV1 is the precedent.
export function skillsMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("skillName", "skill_name", "text"),
    field("description", "description", "text"),
    field("body", "body", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository("skills", "id", "id", fs);
}

export function skillsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("skillName", "skill_name", "text"),
    field("description", "description", "text"),
    field("body", "body", "text"),
    field("updatedAt", "updated_at", "text"),
    // Who may use it, and what the console showcases — two axes, two
    // columns, because a three-value enum breaks on "public but not
    // promoted". 'private' is a skill an agent carries by attachment;
    // 'public' answers use_skill for every caller. featuredRank orders the
    // console's capability chips; 0 is not featured, and featured implies
    // public — enforced where writes land, not here.
    field("visibility", "visibility", "text"),
    field("featuredRank", "featured_rank", "int"),
  ];
  return repository("skills", "id", "id", fs);
}

export function skillFilesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("skillId", "skill_id", "text"),
    field("path", "path", "text"),
    field("body", "body", "text"),
  ];
  return repository("skill_files", "id", "id", fs);
}

// A starting point a conversation can be opened from — Kimi's "featured
// cases". A template is its files; the row is the label on the card.
//
// Deliberately not a skill: a skill is instructions for doing, a template is
// artifacts to begin from. They compose — the Docs page offers make-doc and
// the document templates together — but a template with a briefing in it
// would be a skill nobody could attach, and a skill that shipped starting
// documents would stage them into every run.
export type TemplateRow = {
  id: string,
  label: string,
  // One line on the card.
  description: string,
  // Which capability page shows it: "doc", "sheet", "deck", "page".
  kind: string,
  // The skill the page pins when this template starts a conversation, by
  // name — empty for a template that needs no particular instructions.
  skillName: string,
  // Same two axes as skills: who may use it, and where it ranks on the page.
  visibility: string,
  featuredRank: int,
};

export function templatesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("label", "label", "text"),
    field("description", "description", "text"),
    field("kind", "kind", "text"),
    field("skillName", "skill_name", "text"),
    field("visibility", "visibility", "text"),
    field("featuredRank", "featured_rank", "int"),
  ];
  return repository("templates", "id", "id", fs);
}

// The artifacts a template lays down, copied in as version 1 when a
// conversation starts from it. Paths are artifact paths, so a template with
// site/index.html and site/css/main.css arrives as folders in the Files rail.
export type TemplateFileRow = {
  id: string,
  templateId: string,
  path: string,
  title: string,
  body: string,
};

export function templateFilesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("templateId", "template_id", "text"),
    field("path", "path", "text"),
    field("title", "title", "text"),
    field("body", "body", "text"),
  ];
  return repository("template_files", "id", "id", fs);
}

// One office document, converted to PDF once.
//
// The id is `<artifactId>:<version>` — derived, never random — and that is
// the whole cache design. An artifact version is append-only and immutable,
// so the bytes this row was made from can never change underneath it: there
// is no invalidation, no staleness window, and no need to store a hash of the
// input to compare against. A row here is true forever or absent.
//
// The body is base64 like every other binary body in this package: the store
// holds text, a viewer holds bytes, and the boundary between them is the same
// one `binaryKind` draws for images and office files themselves.
//
// Rows are derived data. Losing this table costs conversions, never work — it
// can be truncated at any time and the next reader rebuilds what they open.
export type OfficeRenderRow = {
  id: string,
  artifactId: string,
  version: int,
  body: string,
  createdAt: string,
};

export function officeRendersMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("artifactId", "artifact_id", "text"),
    field("version", "version", "int"),
    field("body", "body", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("office_renders", "id", "id", fs);
}

export function agentsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("description", "description", "text"),
    field("modelConfigId", "model_config_id", "text"),
    field("promptId", "prompt_id", "text"),
    field("enabled", "enabled", "bool"),
    // Added after migration 5 shipped, so it arrives as an ALTER at 66 and
    // agentsMappingV1 below keeps generating the original CREATE.
    field("scriptImageId", "script_image_id", "text"),
    // The agent a new conversation opens against. Without it the console took
    // whichever sorted first by name, which is how a blank name became the
    // default for everyone.
    field("isDefault", "is_default", "bool"),
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
           "id, model_id AS \"modelId\", temperature, max_tokens AS \"maxTokens\", top_p AS \"topP\", extra, thinking"),
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
    hasManyThrough({
      field: "skills", table: "skills", foreignColumn: "id",
      linkTable: "agent_skills", linkLocalColumn: "agent_id", linkForeignColumn: "skill_id",
      localColumn: "id",
      // Name and description, never the body: the full view is for listing
      // and running, and a body rides GET /skills/:id when someone edits.
      columns: "id, skill_name AS \"skillName\", description",
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
    migration("1", "models", createTableSql(db, modelsMappingV1())),
    migration("2", "model configs", createTableSql(db, modelConfigsMappingV1())),
    migration("3", "prompts", createTableSql(db, promptsMapping())),
    migration("4", "mcp servers", createTableSql(db, mcpServersMappingV1())),
    migration("5", "agents", createTableSql(db, agentsMappingV1())),
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
    // The images an operator will run scripts in, and the agent's choice among
    // them. Two migrations because they are two facts: the table is new, the
    // column is an ALTER on a table whose CREATE was checksummed long ago.
    migration("65", "curated script images", createTableSql(db, scriptImagesMapping())),
    migration("66", "an agent chooses its script image",
      "ALTER TABLE agents ADD COLUMN script_image_id " + db.textType + " NOT NULL DEFAULT ''"),
    // Skills and what they ship. Three migrations because they are three
    // facts: the skill, its files, and which agents carry it.
    migration("67", "skills", createTableSql(db, skillsMappingV1())),
    migration("68", "skill files", createTableSql(db, skillFilesMapping())),
    migration("69", "agent to skill",
      "CREATE TABLE IF NOT EXISTS agent_skills ("
      + "agent_id " + db.textType + " NOT NULL, "
      + "skill_id " + db.textType + " NOT NULL)"),
    migration("77", "a skill has a visibility",
      "ALTER TABLE skills ADD COLUMN visibility " + db.textType + " NOT NULL DEFAULT 'private'"),
    migration("79", "templates", createTableSql(db, templatesMapping())),
    migration("80", "template files", createTableSql(db, templateFilesMapping())),
    migration("78", "featured skills order the capability chips",
      "ALTER TABLE skills ADD COLUMN featured_rank " + db.intType + " NOT NULL DEFAULT 0"),
    // Converted office documents. Derived data with an immutable key, so this
    // table is a cache in the strict sense: dropping it loses nothing.
    migration("81", "office documents converted to pdf",
      createTableSql(db, officeRendersMapping())),
    migration("61", "a model config can ask for thinking",
      "ALTER TABLE model_configs ADD COLUMN thinking " + db.textType + " NOT NULL DEFAULT ''"),
    migration("8", "provider credentials", createTableSql(db, credentialsMapping())),
    migration("9", "prompts by name",
      "CREATE INDEX IF NOT EXISTS prompts_by_name ON prompts (prompt_name)"),
    migration("42", "model base url",
      "ALTER TABLE models ADD COLUMN base_url " + db.textType + " NOT NULL DEFAULT ''"),
    migration("43", "mcp auth kind",
      "ALTER TABLE mcp_servers ADD COLUMN auth_kind " + db.textType + " NOT NULL DEFAULT 'none'"),
    migration("44", "mcp auth header",
      "ALTER TABLE mcp_servers ADD COLUMN auth_header " + db.textType + " NOT NULL DEFAULT ''"),
    migration("45", "default agent",
      "ALTER TABLE agents ADD COLUMN is_default " + dialectType(db, "bool") + " NOT NULL DEFAULT false"),
  ];
  return plan;
}
