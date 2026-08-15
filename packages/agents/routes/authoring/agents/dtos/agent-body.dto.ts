import { Rule, validated, MaxLength, Required } from "../../../../../validation/validation.ts";

@validated
export class AgentBody {
  @Required("an \"id\" is required")
  id: string;

  @Required("an agent needs a name")
  @MaxLength(48, "an agent name is at most 48 characters")
  agentName: string;

  description: string;

  modelConfigId: string;

  promptId: string;

  enabled: bool;

  isDefault: bool;

  scriptImageId: string;

  updatedAt: string;

  constructor(id: string, agentName: string, description: string, modelConfigId: string,
              promptId: string, enabled: bool, isDefault: bool, scriptImageId: string, updatedAt: string) {
    this.id = id;
    this.agentName = agentName;
    this.description = description;
    this.modelConfigId = modelConfigId;
    this.promptId = promptId;
    this.enabled = enabled;
    this.isDefault = isDefault;
    this.scriptImageId = scriptImageId;
    this.updatedAt = updatedAt;
  }
}
