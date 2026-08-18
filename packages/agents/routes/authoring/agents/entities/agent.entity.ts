import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("agents")
export class Agent {
  @Id
  @Column("id", "text")
  id: string;

  @Column("agent_name", "text")
  agentName: string;

  @Column("description", "text")
  description: string;

  @Column("model_config_id", "text")
  modelConfigId: string;

  @Column("prompt_id", "text")
  promptId: string;

  @Column("enabled", "bool")
  enabled: bool;

  @Column("script_image_id", "text")
  scriptImageId: string;

  @Column("is_default", "bool")
  isDefault: bool;

  @Column("updated_at", "text")
  updatedAt: string;

  /* Which prompt, and which version of it — never its text. The body is the
   * deployment's own writing, and an agent row is readable by anybody who may
   * USE the agent, so carrying the text here handed every system prompt on the
   * box to any signed-in caller and walked straight around the withholding
   * /prompts does. Nothing reads it from here: a run looks the prompt up by
   * promptId, and the console shows a name and a version. */
  @HasOne("prompts", "prompt_id", "id", "id, prompt_name AS \"promptName\", version")
  prompt: string;

  @HasOne("model_configs", "model_config_id", "id", "id, model_id AS \"modelId\", temperature, max_tokens AS \"maxTokens\", top_p AS \"topP\", extra, thinking")
  config: string;

  @HasManyThrough("mcp_servers", "id", "agent_mcp_servers", "agent_id", "server_id", "id",
                  "id, server_name AS \"serverName\", transport, endpoint, {bool:enabled} AS \"enabled\"")
  servers: string;

  @HasManyThrough("agents", "id", "agent_sub_agents", "parent_id", "child_id", "id",
                  "id, agent_name AS \"agentName\", {bool:enabled} AS \"enabled\"")
  subAgents: string;

  @HasManyThrough("skills", "id", "agent_skills", "agent_id", "skill_id", "id",
                  "id, skill_name AS \"skillName\", description")
  skills: string;

  @HasManyThrough("agent_scopes", "scope", "agent_scopes", "agent_id", "scope", "id", "scope")
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
