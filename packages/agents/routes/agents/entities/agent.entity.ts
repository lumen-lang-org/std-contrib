import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("agents")
export class Agent {
  @id
  @column("id", "text")
  id: string;

  @column("agent_name", "text")
  agentName: string;

  @column("description", "text")
  description: string;

  @column("model_config_id", "text")
  modelConfigId: string;

  @column("prompt_id", "text")
  promptId: string;

  @column("enabled", "bool")
  enabled: bool;

  @column("script_image_id", "text")
  scriptImageId: string;

  @column("is_default", "bool")
  isDefault: bool;

  @column("updated_at", "text")
  updatedAt: string;

  @hasOne("prompts", "prompt_id", "id", "id, prompt_name AS \"promptName\", version, body")
  prompt: string;

  @hasOne("model_configs", "model_config_id", "id", "id, model_id AS \"modelId\", temperature, max_tokens AS \"maxTokens\", top_p AS \"topP\", extra, thinking")
  config: string;

  @hasManyThrough("mcp_servers", "id", "agent_mcp_servers", "agent_id", "server_id", "id",
                  "id, server_name AS \"serverName\", transport, endpoint, {bool:enabled} AS \"enabled\"")
  servers: string;

  @hasManyThrough("agents", "id", "agent_sub_agents", "parent_id", "child_id", "id",
                  "id, agent_name AS \"agentName\", {bool:enabled} AS \"enabled\"")
  subAgents: string;

  @hasManyThrough("skills", "id", "agent_skills", "agent_id", "skill_id", "id",
                  "id, skill_name AS \"skillName\", description")
  skills: string;

  @hasManyThrough("agent_scopes", "scope", "agent_scopes", "agent_id", "scope", "id", "scope")
  scopes: string;

  constructor(id: string, agentName: string, description: string, modelConfigId: string,
              promptId: string, enabled: bool, scriptImageId: string, isDefault: bool,
              updatedAt: string, prompt: string, config: string, servers: string,
              subAgents: string, skills: string, scopes: string) {
    this.id = id;
    this.agentName = agentName;
    this.description = description;
    this.modelConfigId = modelConfigId;
    this.promptId = promptId;
    this.enabled = enabled;
    this.scriptImageId = scriptImageId;
    this.isDefault = isDefault;
    this.updatedAt = updatedAt;
    this.prompt = prompt;
    this.config = config;
    this.servers = servers;
    this.subAgents = subAgents;
    this.skills = skills;
    this.scopes = scopes;
  }
}

export function agentRepository(): DbRepository {
  return entityAgent;
}
