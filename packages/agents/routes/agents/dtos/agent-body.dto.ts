import { validated, Rule } from "../../../../validation/validation.ts";

@validated
export class AgentBody {
  @required("an \"id\" is required")
  id: string;

  @required("an agent needs a name")
  @maxLength(48, "an agent name is at most 48 characters")
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
