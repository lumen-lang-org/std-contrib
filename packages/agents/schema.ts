import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRelation, DbRepository, field, repository, hasOne, hasMany, hasManyThrough, findById, listOrdered, placeholderAt, createTableSql, dialectType, boolColumn, executeWith, persist } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

export type ModelRow = {
  id: string,
  label: string,
  apiName: string,
  provider: string,
  kind: string,
  dimensions: int,
  baseUrl: string,
  enabled: bool,
  contextTokens: int,
};

export type ModelConfigRow = {
  id: string,
  modelId: string,
  temperature: number,
  maxTokens: int,
  topP: number,
  extra: string,
  thinking: string,
  label: string,
  selectable: bool,
  rank: int,
};

export type ModelChoiceRow = {
  id: string,
  label: string,
  description: string,
  kind: string,
  configId: string,
  routerId: string,
  tier: string,
  enabled: bool,
  rank: int,
};

export const ROUTER_MAX_TOKENS: int = 512;

export type ModelRouterRow = {
  id: string,
  label: string,
  routerConfigId: string,
  candidatesJson: string,
  fallbackConfigId: string,
  routeEvery: string,
  escalateOnly: bool,
  enabled: bool,
};

export type PromptRow = {
  id: string,
  promptName: string,
  version: int,
  body: string,
  createdAt: string,
};

export type McpServerRow = {
  id: string,
  serverName: string,
  transport: string,
  endpoint: string,
  authKind: string,
  authHeader: string,
  enabled: bool,
};

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
  isDefault: bool,
  scriptImageId: string,
  updatedAt: string,
};

export type ScriptImageRow = {
  id: string,
  label: string,
  image: string,
  enabled: bool,
  summary: string,
};

export type SkillRow = {
  id: string,
  skillName: string,
  description: string,
  body: string,
  updatedAt: string,
  visibility: string,
  featuredRank: int,
  source: string,
  sourceUrl: string,
};

export type SkillFileRow = {
  id: string,
  skillId: string,
  path: string,
  body: string,
};

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
  return repository({ table: "models", idField: "id", idColumn: "id", fields: fs });
}

function mcpServersMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("serverName", "server_name", "text"),
    field("transport", "transport", "text"),
    field("endpoint", "endpoint", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository({ table: "mcp_servers", idField: "id", idColumn: "id", fields: fs });
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
  return repository({ table: "agents", idField: "id", idColumn: "id", fields: fs });
}

export function modelsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("label", "label", "text"),
    field("apiName", "api_name", "text"),
    field("provider", "provider", "text"),
    field("kind", "kind", "text"),
    field("dimensions", "dimensions", "int"),
    field("baseUrl", "base_url", "text"),
    field("contextTokens", "context_tokens", "int"),
    field("enabled", "enabled", "bool"),
  ];
  return repository({ table: "models", idField: "id", idColumn: "id", fields: fs });
}

function modelConfigsMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("modelId", "model_id", "text"),
    field("temperature", "temperature", "float8"),
    field("maxTokens", "max_tokens", "int"),
    field("topP", "top_p", "float8"),
    field("extra", "extra", "text"),
  ];
  return repository({ table: "model_configs", idField: "id", idColumn: "id", fields: fs });
}

export function modelConfigsMapping(db: Db): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("modelId", "model_id", "text"),
    field("temperature", "temperature", "float8"),
    field("maxTokens", "max_tokens", "int"),
    field("topP", "top_p", "float8"),
    field("extra", "extra", "text"),
    field("thinking", "thinking", "text"),
    field("label", "label", "text"),
    field("selectable", "selectable", "bool"),
    field("rank", "menu_rank", "int"),
  ];
  let rs: DbRelation[] = [
    hasOne({ field: "model", table: "models", localColumn: "model_id", foreignColumn: "id", columns: "id, label, api_name AS \"apiName\", provider, " + boolColumn(db, "enabled") + " AS \"enabled\"" }),
  ];
  return repository({ table: "model_configs", idField: "id", idColumn: "id", fields: fs, relations: rs });
}

export function modelChoicesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("label", "label", "text"),
    field("description", "description", "text"),
    field("kind", "kind", "text"),
    field("configId", "config_id", "text"),
    field("routerId", "router_id", "text"),
    field("tier", "tier", "text"),
    field("enabled", "enabled", "bool"),
    field("rank", "menu_rank", "int"),
  ];
  return repository({ table: "model_choices", idField: "id", idColumn: "id", fields: fs });
}

export function modelRoutersMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("label", "label", "text"),
    field("routerConfigId", "router_config_id", "text"),
    field("candidatesJson", "candidates_json", "text"),
    field("fallbackConfigId", "fallback_config_id", "text"),
    field("routeEvery", "route_every", "text"),
    field("escalateOnly", "escalate_only", "bool"),
    field("enabled", "enabled", "bool"),
  ];
  return repository({ table: "model_routers", idField: "id", idColumn: "id", fields: fs });
}

export function enabledChoices(db: Db): ModelChoiceRow[] {
  let out: ModelChoiceRow[] = [];
  let keys: DbOrder[] = [{ column: "menu_rank" }, { column: "label" }];
  let listed = listOrdered(db, modelChoicesMapping(), { where: "enabled = " + placeholderAt(db, 1), args: ["1"], order: keys });
  if (listed == "" || listed == "[]") { return out; }
  return JSON.parse<ModelChoiceRow[]>(listed);
}

export function configForChoice(db: Db, choiceId: string): string {
  if (choiceId == "") { return ""; }
  let document = findById(db, modelChoicesMapping(), choiceId);
  if (document == "") { return ""; }
  let choice: ModelChoiceRow = JSON.parse<ModelChoiceRow>(document);
  if (!choice.enabled) { return ""; }
  if (choice.kind != "config") { return ""; }
  return choice.configId;
}

export function modelConfigRows(db: Db): DbRepository {
  return repository({ table: "model_configs", idField: "id", idColumn: "id", fields: modelConfigsMapping(db).fields });
}

export type ConfigAndModel = {
  config: ModelConfigRow,
  model: ModelRow,
  problem: string,
};

function noConfigAndModel(why: string): ConfigAndModel {
  let config: ModelConfigRow = {
    id: "", modelId: "", temperature: 0, maxTokens: 0, topP: 0, extra: "",
    thinking: "", label: "", selectable: false, rank: 0,
  };
  let model: ModelRow = {
    id: "", label: "", apiName: "", provider: "", kind: "", dimensions: 0,
    baseUrl: "", enabled: false, contextTokens: 0 };
  let out: ConfigAndModel = { config: config, model: model, problem: why };
  return out;
}

export function configAndModel(db: Db, configId: string): ConfigAndModel {
  if (configId == "") { return noConfigAndModel("no model config was named"); }
  let configDoc = findById(db, modelConfigRows(db), configId);
  if (configDoc == "") { return noConfigAndModel("no model config " + configId); }
  let config: ModelConfigRow = JSON.parse<ModelConfigRow>(configDoc);
  let modelDoc = findById(db, modelsMapping(), config.modelId);
  if (modelDoc == "") { return noConfigAndModel("no model " + config.modelId); }
  let model: ModelRow = JSON.parse<ModelRow>(modelDoc);
  let out: ConfigAndModel = { config: config, model: model, problem: "" };
  return out;
}

export function promptsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("promptName", "prompt_name", "text"),
    field("version", "version", "int"),
    field("body", "body", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository({ table: "prompts", idField: "id", idColumn: "id", fields: fs });
}

export function mcpServersMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("serverName", "server_name", "text"),
    field("transport", "transport", "text"),
    field("endpoint", "endpoint", "text"),
    field("authKind", "auth_kind", "text"),
    field("authHeader", "auth_header", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository({ table: "mcp_servers", idField: "id", idColumn: "id", fields: fs });
}

export type McpToolOffRow = {
  id: string,
  serverId: string,
  toolName: string,
};

export function mcpToolsOffMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("serverId", "server_id", "text"),
    field("toolName", "tool_name", "text"),
  ];
  return repository({ table: "mcp_tools_off", idField: "id", idColumn: "id", fields: fs });
}

export type McpOauthRow = {
  id: string,
  issuer: string,
  authorizeUrl: string,
  tokenUrl: string,
  clientId: string,
  scope: string,
  redirectUri: string,
  registeredAt: string,
};

export function mcpOauthMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("issuer", "issuer", "text"),
    field("authorizeUrl", "authorize_url", "text"),
    field("tokenUrl", "token_url", "text"),
    field("clientId", "client_id", "text"),
    field("scope", "scope", "text"),
    field("redirectUri", "redirect_uri", "text"),
    field("registeredAt", "registered_at", "text"),
  ];
  return repository({ table: "mcp_oauth", idField: "id", idColumn: "id", fields: fs });
}

export type McpPendingRow = {
  id: string,
  serverId: string,
  owner: string,
  verifier: string,
  startedAt: string,
};

export function mcpPendingMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("serverId", "server_id", "text"),
    field("owner", "owner", "text"),
    field("verifier", "verifier", "text"),
    field("startedAt", "started_at", "text"),
  ];
  return repository({ table: "mcp_oauth_pending", idField: "id", idColumn: "id", fields: fs });
}

export type McpGrantRow = {
  id: string,
  serverId: string,
  owner: string,
  expiresAt: string,
  refreshable: bool,
  connectedAt: string,
};

export function mcpGrantsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("serverId", "server_id", "text"),
    field("owner", "owner", "text"),
    field("expiresAt", "expires_at", "text"),
    field("refreshable", "refreshable", "bool"),
    field("connectedAt", "connected_at", "text"),
  ];
  return repository({ table: "mcp_oauth_grants", idField: "id", idColumn: "id", fields: fs });
}

export function credentialsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("provider", "provider", "text"),
    field("envelope", "envelope", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository({ table: "provider_credentials", idField: "id", idColumn: "id", fields: fs });
}

export function scriptImagesMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("label", "label", "text"),
    field("image", "image", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository({ table: "script_images", idField: "id", idColumn: "id", fields: fs });
}

export function scriptImagesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("label", "label", "text"),
    field("image", "image", "text"),
    field("enabled", "enabled", "bool"),
    field("summary", "summary", "text"),
  ];
  return repository({ table: "script_images", idField: "id", idColumn: "id", fields: fs });
}

export function skillsMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("skillName", "skill_name", "text"),
    field("description", "description", "text"),
    field("body", "body", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository({ table: "skills", idField: "id", idColumn: "id", fields: fs });
}

export function skillsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("skillName", "skill_name", "text"),
    field("description", "description", "text"),
    field("body", "body", "text"),
    field("updatedAt", "updated_at", "text"),
    field("visibility", "visibility", "text"),
    field("featuredRank", "featured_rank", "int"),
    field("source", "source", "text"),
    field("sourceUrl", "source_url", "text"),
  ];
  return repository({ table: "skills", idField: "id", idColumn: "id", fields: fs });
}

export function skillFilesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("skillId", "skill_id", "text"),
    field("path", "path", "text"),
    field("body", "body", "text"),
  ];
  return repository({ table: "skill_files", idField: "id", idColumn: "id", fields: fs });
}

export type PluginRow = {
  id: string,
  pluginName: string,
  description: string,
  sourceUrl: string,
  version: string,
  installedAt: string,
};

export function pluginsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("pluginName", "plugin_name", "text"),
    field("description", "description", "text"),
    field("sourceUrl", "source_url", "text"),
    field("version", "version", "text"),
    field("installedAt", "installed_at", "text"),
  ];
  return repository({ table: "plugins", idField: "id", idColumn: "id", fields: fs });
}

export type PluginItemRow = {
  id: string,
  pluginId: string,
  kind: string,
  itemId: string,
};

export function pluginItemsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("pluginId", "plugin_id", "text"),
    field("kind", "kind", "text"),
    field("itemId", "item_id", "text"),
  ];
  return repository({ table: "plugin_items", idField: "id", idColumn: "id", fields: fs });
}

export type ThreadSummaryRow = {
  id: string,
  threadId: string,
  throughSeq: int,
  text: string,
  updatedAt: string,
};

export function threadSummariesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("threadId", "thread_id", "text"),
    field("throughSeq", "through_seq", "int"),
    field("text", "text", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository({ table: "thread_summaries", idField: "id", idColumn: "id", fields: fs });
}

export type AuthProviderRow = {
  id: string,
  label: string,
  kind: string,
  issuer: string,
  clientId: string,
  scopes: string,
  enabled: bool,
};

export function authProvidersMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("label", "label", "text"),
    field("issuer", "issuer", "text"),
    field("clientId", "client_id", "text"),
    field("scopes", "scopes", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository({ table: "auth_providers", idField: "id", idColumn: "id", fields: fs });
}

export function authProvidersMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("label", "label", "text"),
    field("kind", "kind", "text"),
    field("issuer", "issuer", "text"),
    field("clientId", "client_id", "text"),
    field("scopes", "scopes", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository({ table: "auth_providers", idField: "id", idColumn: "id", fields: fs });
}

export type TemplateRow = {
  id: string,
  label: string,
  description: string,
  kind: string,
  skillName: string,
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
  return repository({ table: "templates", idField: "id", idColumn: "id", fields: fs });
}

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
  return repository({ table: "template_files", idField: "id", idColumn: "id", fields: fs });
}

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
  return repository({ table: "office_renders", idField: "id", idColumn: "id", fields: fs });
}

export function agentsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("description", "description", "text"),
    field("modelConfigId", "model_config_id", "text"),
    field("promptId", "prompt_id", "text"),
    field("enabled", "enabled", "bool"),
    field("scriptImageId", "script_image_id", "text"),
    field("isDefault", "is_default", "bool"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository({ table: "agents", idField: "id", idColumn: "id", fields: fs });
}

export function agentsFull(db: Db): DbRepository {
  let rs: DbRelation[] = [
    hasOne({ field: "prompt", table: "prompts", localColumn: "prompt_id", foreignColumn: "id", columns: "id, prompt_name AS \"promptName\", version, body" }),
    hasOne({ field: "config", table: "model_configs", localColumn: "model_config_id", foreignColumn: "id", columns: "id, model_id AS \"modelId\", temperature, max_tokens AS \"maxTokens\", top_p AS \"topP\", extra, thinking" }),
    hasManyThrough({
      field: "servers", table: "mcp_servers", foreignColumn: "id",
      linkTable: "agent_mcp_servers", linkLocalColumn: "agent_id", linkForeignColumn: "server_id",
      localColumn: "id",
      columns: "id, server_name AS \"serverName\", transport, endpoint, "
        + boolColumn(db, "enabled") + " AS \"enabled\"",
    }),
    hasManyThrough({
      field: "subAgents", table: "agents", foreignColumn: "id",
      linkTable: "agent_sub_agents", linkLocalColumn: "parent_id", linkForeignColumn: "child_id",
      localColumn: "id",
      columns: "id, agent_name AS \"agentName\", "
        + boolColumn(db, "enabled") + " AS \"enabled\"",
    }),
    hasManyThrough({
      field: "skills", table: "skills", foreignColumn: "id",
      linkTable: "agent_skills", linkLocalColumn: "agent_id", linkForeignColumn: "skill_id",
      localColumn: "id",
      columns: "id, skill_name AS \"skillName\", description",
    }),
  ];
  return repository({ table: "agents", idField: "id", idColumn: "id", fields: agentsMapping().fields, relations: rs });
}

function leaveExisting(db: Db, idColumn: string): string {
  if (db.upsertStyle == "on-duplicate-key") {
    return " ON DUPLICATE KEY UPDATE " + idColumn + " = " + idColumn;
  }
  return " ON CONFLICT (" + idColumn + ") DO NOTHING";
}

const FAKE_PROVIDER: string = "double";

export const DERIVED_RANK_BASE: int = 1000;

function concatSql(db: Db, left: string, right: string): string {
  if (db.upsertStyle == "on-duplicate-key") {
    return "CONCAT(" + left + ", " + right + ")";
  }
  return "(" + left + " || " + right + ")";
}

function menuWorthy(cfg: string, mdl: string): string {
  return worthyModel(mdl)
    + " AND NOT EXISTS (SELECT 1 FROM model_routers plume_rt"
    + " WHERE plume_rt.router_config_id = " + cfg + ".id)";
}

function worthyModel(mdl: string): string {
  return mdl + ".kind = 'chat' AND " + mdl + ".enabled = true"
    + " AND " + mdl + ".provider <> '" + FAKE_PROVIDER + "'";
}

function menuLabel(cfg: string, mdl: string): string {
  return "CASE WHEN " + cfg + ".label <> '' THEN " + cfg + ".label ELSE " + mdl + ".label END";
}

function derivedCandidates(db: Db): string {
  let when = concatSql(db, "'messages best answered by '", menuLabel("c", "m"));
  let source = " FROM model_configs c JOIN models m ON m.id = c.model_id"
    + " WHERE " + menuWorthy("c", "m") + " AND c.selectable = true"
    + " ORDER BY c.menu_rank, c.id";
  if (db.docStyle == "pairs") {
    let inner = "SELECT c.id AS k, c.id AS cfg, " + when + " AS wh" + source;
    return "(SELECT coalesce(" + db.jsonAgg + "(" + db.rowToJson
      + "('key', rel.k, 'configId', rel.cfg, 'when', rel.wh)), "
      + db.emptyJsonArray + ") FROM (" + inner + ") rel)";
  }
  let inner = "SELECT c.id AS \"key\", c.id AS \"configId\", " + when + " AS \"when\"" + source;
  return "(SELECT coalesce(" + db.jsonAgg + "(rel), " + db.emptyJsonArray
    + ") FROM (" + inner + ") rel)";
}

function selectableCount(): string {
  return "(SELECT COUNT(*) FROM model_configs c JOIN models m ON m.id = c.model_id"
    + " WHERE " + menuWorthy("c", "m") + " AND c.selectable = true)";
}

function menuDescription(db: Db, cfg: string, mdl: string): string {
  let suffix = concatSql(db, concatSql(db, "' ('", cfg + ".id"), "')'");
  return "CASE WHEN EXISTS (SELECT 1 FROM model_configs plume_sib"
    + " JOIN models plume_sm ON plume_sm.id = plume_sib.model_id"
    + " WHERE plume_sib.model_id = " + cfg + ".model_id AND plume_sib.id <> " + cfg + ".id"
    + " AND " + menuWorthy("plume_sib", "plume_sm") + ")"
    + " THEN " + concatSql(db, mdl + ".api_name", suffix)
    + " ELSE " + mdl + ".api_name END";
}

function derivedRank(cfg: string, mdl: string): string {
  return `${DERIVED_RANK_BASE}` + " + 1 + (SELECT COUNT(*) FROM model_configs plume_c2"
    + " JOIN models plume_m2 ON plume_m2.id = plume_c2.model_id WHERE "
    + menuWorthy("plume_c2", "plume_m2")
    + " AND (plume_m2.label < " + mdl + ".label OR (plume_m2.label = " + mdl + ".label"
    + " AND plume_c2.id < " + cfg + ".id)))";
}

function leadOfItsLabel(cfg: string, mdl: string): string {
  return "NOT EXISTS (SELECT 1 FROM model_configs plume_pe"
    + " JOIN models plume_pm ON plume_pm.id = plume_pe.model_id"
    + " WHERE " + menuWorthy("plume_pe", "plume_pm") + " AND plume_pe.selectable = true"
    + " AND " + menuLabel("plume_pe", "plume_pm") + " = " + menuLabel(cfg, mdl)
    + " AND (plume_pe.menu_rank < " + cfg + ".menu_rank"
    + " OR (plume_pe.menu_rank = " + cfg + ".menu_rank AND plume_pe.id < " + cfg + ".id)))";
}

function distinguishableCount(): string {
  return "(SELECT COUNT(DISTINCT " + menuLabel("c", "m") + ")"
    + " FROM model_configs c JOIN models m ON m.id = c.model_id"
    + " WHERE " + menuWorthy("c", "m") + " AND c.selectable = true)";
}

function distinguishableWithoutRouters(): string {
  return "(SELECT COUNT(DISTINCT " + menuLabel("c", "m") + ")"
    + " FROM model_configs c JOIN models m ON m.id = c.model_id"
    + " WHERE " + worthyModel("m") + " AND c.selectable = true)";
}

function distinctCandidates(db: Db): string {
  let when = concatSql(db, "'messages best answered by '", menuLabel("c", "m"));
  let source = " FROM model_configs c JOIN models m ON m.id = c.model_id"
    + " WHERE " + menuWorthy("c", "m") + " AND c.selectable = true"
    + " AND " + leadOfItsLabel("c", "m")
    + " ORDER BY c.menu_rank, c.id";
  if (db.docStyle == "pairs") {
    let inner = "SELECT c.id AS k, c.id AS cfg, " + when + " AS wh" + source;
    return "(SELECT coalesce(" + db.jsonAgg + "(" + db.rowToJson
      + "('key', rel.k, 'configId', rel.cfg, 'when', rel.wh)), "
      + db.emptyJsonArray + ") FROM (" + inner + ") rel)";
  }
  let inner = "SELECT c.id AS \"key\", c.id AS \"configId\", " + when + " AS \"when\"" + source;
  return "(SELECT coalesce(" + db.jsonAgg + "(rel), " + db.emptyJsonArray
    + ") FROM (" + inner + ") rel)";
}

function offerMenuedConfigs(db: Db): string {
  return "UPDATE model_configs SET selectable = true, "
    + "menu_rank = (SELECT MIN(ch.menu_rank) FROM model_choices ch WHERE ch.config_id = model_configs.id) "
    + "WHERE selectable = false "
    + "AND EXISTS (SELECT 1 FROM model_choices ch WHERE ch.config_id = model_configs.id) "
    + "AND EXISTS (SELECT 1 FROM models m WHERE m.id = model_configs.model_id "
    + "AND " + menuWorthy("model_configs", "m") + ")";
}

export function derivedMenuStatements(db: Db): string[] {
  let out: string[] = [];
  out.push("INSERT INTO model_choices (id, label, description, kind, config_id, router_id, tier, enabled, menu_rank) "
    + "SELECT " + concatSql(db, "'ch-'", "c.id") + ", " + menuLabel("c", "m") + ", "
    + menuDescription(db, "c", "m") + ", "
    + "'config', c.id, '', '', true, " + derivedRank("c", "m") + " "
    + "FROM model_configs c JOIN models m ON m.id = c.model_id "
    + "WHERE " + menuWorthy("c", "m") + " "
    + "AND NOT EXISTS (SELECT 1 FROM model_choices ch WHERE ch.config_id = c.id)"
    + leaveExisting(db, "id"));
  out.push(offerMenuedConfigs(db));
  out.push("INSERT INTO model_routers (id, label, router_config_id, candidates_json, fallback_config_id, route_every, escalate_only, enabled) "
    + "SELECT 'rt-menu', 'Auto', plume_lead.first_id, " + distinctCandidates(db) + ", plume_lead.first_id, 'turn', false, true "
    + "FROM (SELECT c.id AS first_id FROM model_configs c JOIN models m ON m.id = c.model_id "
    + "WHERE " + menuWorthy("c", "m") + " AND c.selectable = true "
    + "ORDER BY c.menu_rank, c.id LIMIT 1) plume_lead "
    + "WHERE " + distinguishableCount() + " >= 2 "
    + "AND NOT EXISTS (SELECT 1 FROM model_routers r WHERE r.enabled = true)"
    + leaveExisting(db, "id"));
  out.push("INSERT INTO model_choices (id, label, description, kind, config_id, router_id, tier, enabled, menu_rank) "
    + "SELECT 'ch-rt-menu', r.label, 'Picks a model for each message', 'router', '', r.id, '', true, 0 "
    + "FROM model_routers r WHERE r.id = 'rt-menu'"
    + leaveExisting(db, "id"));
  return out;
}

const AUTO_CANDIDATES: string =
  "[{\"key\":\"fast\",\"configId\":\"c-gemini-flash\","
  + "\"when\":\"greetings, short factual questions, and edits to text already in the conversation\"},"
  + "{\"key\":\"standard\",\"configId\":\"c-gemini-pro\","
  + "\"when\":\"ordinary work: writing, explaining, and questions that want one careful answer\"},"
  + "{\"key\":\"think\",\"configId\":\"c-gemini-pro-think\","
  + "\"when\":\"the user is stuck, a previous answer was wrong, or the question needs careful reasoning about code or numbers\"}]";

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
    migration("65", "curated script images", createTableSql(db, scriptImagesMappingV1())),
    migration("66", "an agent chooses its script image",
      "ALTER TABLE agents ADD COLUMN script_image_id " + db.textType + " NOT NULL DEFAULT ''"),
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
    migration("81", "office documents converted to pdf",
      createTableSql(db, officeRendersMapping())),
    migration("82.1", "a model config has a label",
      "ALTER TABLE model_configs ADD COLUMN label " + db.textType + " NOT NULL DEFAULT ''"),
    migration("82.2", "a model config may be offered",
      "ALTER TABLE model_configs ADD COLUMN selectable " + dialectType(db, "bool") + " NOT NULL DEFAULT false"),
    migration("82.3", "offered configs have an order",
      "ALTER TABLE model_configs ADD COLUMN menu_rank " + db.intType + " NOT NULL DEFAULT 0"),
    migration("83", "the model menu", createTableSql(db, modelChoicesMapping())),
    migration("84", "model routers", createTableSql(db, modelRoutersMapping())),
    migration("87.1", "a config for the fast model",
      "INSERT INTO model_configs (id, model_id, temperature, max_tokens, top_p, extra, thinking, label, selectable, menu_rank) "
      + "SELECT 'c-gemini-flash', m.id, 0.3, 8192, 1.0, '{}', '', 'Fast', true, 1 "
      + "FROM models m WHERE m.id = 'm-gemini-flash' AND m.kind = 'chat' AND m.enabled = true"
      + leaveExisting(db, "id")),
    migration("87.2", "the same model, thinking",
      "INSERT INTO model_configs (id, model_id, temperature, max_tokens, top_p, extra, thinking, label, selectable, menu_rank) "
      + "SELECT 'c-gemini-pro-think', c.model_id, c.temperature, c.max_tokens, c.top_p, c.extra, 'high', 'Thinking', true, 3 "
      + "FROM model_configs c WHERE c.id = 'c-gemini-pro'"
      + leaveExisting(db, "id")),
    migration("87.3", "the default agent's config is offered",
      "UPDATE model_configs SET selectable = true, menu_rank = 2 WHERE id = 'c-gemini-pro'"),
    migration("87.4", "and it is called Standard",
      "UPDATE model_configs SET label = 'Standard' WHERE id = 'c-gemini-pro' AND label = ''"),
    migration("87.5", "the automatic choice",
      "INSERT INTO model_routers (id, label, router_config_id, candidates_json, fallback_config_id, route_every, escalate_only, enabled) "
      + "SELECT 'rt-auto', 'Auto', 'c-gemini-flash', '" + AUTO_CANDIDATES + "', 'c-gemini-pro', 'turn', false, true "
      + "FROM model_configs f WHERE f.id = 'c-gemini-flash' "
      + "AND EXISTS (SELECT 1 FROM model_configs p WHERE p.id = 'c-gemini-pro')"
      + leaveExisting(db, "id")),
    migration("87.6", "Auto is on the menu",
      "INSERT INTO model_choices (id, label, description, kind, config_id, router_id, tier, enabled, menu_rank) "
      + "SELECT 'ch-auto', 'Auto', 'Picks a model for each message', 'router', '', r.id, '', true, 1 "
      + "FROM model_routers r WHERE r.id = 'rt-auto'"
      + leaveExisting(db, "id")),
    migration("87.7", "Fast is on the menu",
      "INSERT INTO model_choices (id, label, description, kind, config_id, router_id, tier, enabled, menu_rank) "
      + "SELECT 'ch-fast', 'Fast', 'Quick answers to short questions', 'config', c.id, '', '', true, 2 "
      + "FROM model_configs c WHERE c.id = 'c-gemini-flash'"
      + leaveExisting(db, "id")),
    migration("87.8", "Standard is on the menu",
      "INSERT INTO model_choices (id, label, description, kind, config_id, router_id, tier, enabled, menu_rank) "
      + "SELECT 'ch-standard', 'Standard', 'The everyday model', 'config', c.id, '', '', true, 3 "
      + "FROM model_configs c WHERE c.id = 'c-gemini-pro'"
      + leaveExisting(db, "id")),
    migration("87.9", "Thinking is on the menu",
      "INSERT INTO model_choices (id, label, description, kind, config_id, router_id, tier, enabled, menu_rank) "
      + "SELECT 'ch-thinking', 'Thinking', 'Slower, for a problem that needs working through', 'config', c.id, '', '', true, 4 "
      + "FROM model_configs c WHERE c.id = 'c-gemini-pro-think'"
      + leaveExisting(db, "id")),
    migration("87.10", "the router answers in one word, on a config of its own",
      "INSERT INTO model_configs (id, model_id, temperature, max_tokens, top_p, extra, thinking, label, selectable, menu_rank) "
      + "SELECT 'c-router', c.model_id, c.temperature, 16, c.top_p, c.extra, '', 'Router', false, 0 "
      + "FROM model_configs c WHERE c.id = 'c-gemini-flash'"
      + leaveExisting(db, "id")),
    migration("87.11", "and the router is pointed at it",
      "UPDATE model_routers SET router_config_id = 'c-router' "
      + "WHERE id = 'rt-auto' AND router_config_id = 'c-gemini-flash' "
      + "AND EXISTS (SELECT 1 FROM model_configs c WHERE c.id = 'c-router')"),
    migration("87.12", "and it is given enough room to answer",
      "UPDATE model_configs SET max_tokens = 512 WHERE id = 'c-router' AND max_tokens = 16"),
    migration("87.20", "every chat config the operator has not curated is on the menu",
      "INSERT INTO model_choices (id, label, description, kind, config_id, router_id, tier, enabled, menu_rank) "
      + "SELECT " + concatSql(db, "'ch-'", "c.id") + ", " + menuLabel("c", "m") + ", m.api_name, "
      + "'config', c.id, '', '', true, "
      + `${DERIVED_RANK_BASE}` + " + 1 + (SELECT COUNT(*) FROM model_configs c2 JOIN models m2 ON m2.id = c2.model_id "
      + "WHERE " + menuWorthy("c2", "m2") + " AND c2.selectable = false "
      + "AND (m2.label < m.label OR (m2.label = m.label AND c2.id < c.id))) "
      + "FROM model_configs c JOIN models m ON m.id = c.model_id "
      + "WHERE " + menuWorthy("c", "m") + " AND c.selectable = false "
      + "AND NOT EXISTS (SELECT 1 FROM model_choices ch WHERE ch.config_id = c.id)"
      + leaveExisting(db, "id")),
    migration("87.21", "and a config on the menu is one the operator offers",
      offerMenuedConfigs(db)),
    migration("87.22", "a router, when there is more than one thing to route to",
      "INSERT INTO model_routers (id, label, router_config_id, candidates_json, fallback_config_id, route_every, escalate_only, enabled) "
      + "SELECT 'rt-menu', 'Auto', plume_lead.first_id, " + derivedCandidates(db) + ", plume_lead.first_id, 'turn', false, true "
      + "FROM (SELECT c.id AS first_id FROM model_configs c JOIN models m ON m.id = c.model_id "
      + "WHERE " + menuWorthy("c", "m") + " AND c.selectable = true "
      + "ORDER BY c.menu_rank, c.id LIMIT 1) plume_lead "
      + "WHERE " + selectableCount() + " >= 2 "
      + "AND NOT EXISTS (SELECT 1 FROM model_routers r WHERE r.enabled = true)"
      + leaveExisting(db, "id")),
    migration("87.23", "and the router is on the menu",
      "INSERT INTO model_choices (id, label, description, kind, config_id, router_id, tier, enabled, menu_rank) "
      + "SELECT 'ch-rt-menu', r.label, 'Picks a model for each message', 'router', '', r.id, '', true, 0 "
      + "FROM model_routers r WHERE r.id = 'rt-menu'"
      + leaveExisting(db, "id")),
    migration("87.24", "a router with nothing to decide is not on the menu",
      "DELETE FROM model_choices WHERE id = 'ch-rt-menu' AND router_id = 'rt-menu' "
      + "AND " + distinguishableWithoutRouters() + " < 2"),
    migration("87.25", "and it is not kept",
      "DELETE FROM model_routers WHERE id = 'rt-menu' "
      + "AND " + distinguishableWithoutRouters() + " < 2 "
      + "AND NOT EXISTS (SELECT 1 FROM model_choices ch WHERE ch.router_id = 'rt-menu')"),
    migration("87.26", "and two menu rows that read alike are told apart",
      "UPDATE model_choices SET description = "
      + concatSql(db, "description", concatSql(db, concatSql(db, "' ('", "config_id"), "')'"))
      + " WHERE kind = 'config' AND config_id <> '' "
      + "AND EXISTS (SELECT 1 FROM model_configs c JOIN models m ON m.id = c.model_id "
      + "WHERE c.id = model_choices.config_id AND m.api_name = model_choices.description "
      + "AND EXISTS (SELECT 1 FROM model_configs plume_sib JOIN models plume_sm "
      + "ON plume_sm.id = plume_sib.model_id WHERE plume_sib.model_id = c.model_id "
      + "AND plume_sib.id <> c.id AND " + menuWorthy("plume_sib", "plume_sm") + "))"),
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
    migration("90.1", "a skill knows where it came from",
      "ALTER TABLE skills ADD COLUMN source " + db.textType + " NOT NULL DEFAULT 'local'"),
    migration("90.2", "and a sourced skill knows where from",
      "ALTER TABLE skills ADD COLUMN source_url " + db.textType + " NOT NULL DEFAULT ''"),
    migration("90.3", "plugins: a bundle installed from somewhere else",
      createTableSql(db, pluginsMapping())),
    migration("90.4", "what a plugin brought, so removing it can take it back",
      createTableSql(db, pluginItemsMapping())),
    migration("90.5", "an environment says what is inside it",
      "ALTER TABLE script_images ADD COLUMN summary " + db.textType + " NOT NULL DEFAULT ''"),
    migration("90.6", "a model says how much it can hold",
      "ALTER TABLE models ADD COLUMN context_tokens " + db.intType + " NOT NULL DEFAULT 0"),
    migration("90.7", "a thread remembers what it had to forget",
      createTableSql(db, threadSummariesMapping())),
    migration("90.8", "ways of signing in that are not a password",
      createTableSql(db, authProvidersMappingV1())),
    migration("90.9", "an auth provider has a kind",
      "ALTER TABLE auth_providers ADD COLUMN kind " + db.textType + " NOT NULL DEFAULT 'oidc'"),
    migration("93", "deployment settings",
      "CREATE TABLE IF NOT EXISTS settings ("
      + "id " + db.textType + " PRIMARY KEY, "
      + "value " + db.textType + " NOT NULL)"),
    migration("94.1", "the client this deployment registered with a connector",
      createTableSql(db, mcpOauthMapping())),
    migration("94.2", "a connect in progress, waiting on a consent screen",
      createTableSql(db, mcpPendingMapping())),
    migration("94.3", "what is known about a connection without opening it",
      createTableSql(db, mcpGrantsMapping())),
    migration("94.4", "a tool a connector offers that this deployment declines",
      createTableSql(db, mcpToolsOffMapping())),
  ];
  return plan;
}


function cancelColumn(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("cancelAsked", "cancel_asked", "text"),
  ];
  return repository({ table: "threads", idField: "id", idColumn: "id", fields: fs });
}

type CancelRow = {
  id: string,
  cancelAsked: string,
};

export function askCancel(db: Db, threadId: string): string {
  let wrote = executeWith(db,
    "UPDATE threads SET cancel_asked = " + placeholderAt(db, 1)
    + " WHERE id = " + placeholderAt(db, 2),
    [`${Date.now()}`, threadId]);
  if (wrote.ok) { return ""; }
  return wrote.error;
}

export function clearCancel(db: Db, threadId: string): void {
  executeWith(db,
    "UPDATE threads SET cancel_asked = '' WHERE id = " + placeholderAt(db, 1),
    [threadId]);
}

export function cancelAsked(db: Db, threadId: string): bool {
  if (threadId == "") { return false; }
  let held = findById(db, cancelColumn(), threadId);
  if (held == "") { return false; }
  let row: CancelRow = JSON.parse<CancelRow>(held);
  return row.cancelAsked != "";
}

export type SettingRow = {
  id: string,
  value: string,
};

export function settingsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("value", "value", "text"),
  ];
  return repository({ table: "settings", idField: "id", idColumn: "id", fields: fs });
}

export function readSetting(db: Db, key: string): string {
  let held = findById(db, settingsMapping(), key);
  if (held == "") { return ""; }
  let row: SettingRow = JSON.parse<SettingRow>(held);
  return row.value;
}

export function writeSetting(db: Db, key: string, value: string): string {
  let row: SettingRow = { id: key, value: value };
  let written = persist(db, settingsMapping(), JSON.stringify(row));
  if (written.ok) { return ""; }
  return written.error;
}
