import { validated, Rule } from "../../../../validation/validation.ts";

// The whole of what a caller may send about an agent — every column, so the
// service can write it without the handler passing the raw body alongside.
// The rules are here so no handler has to remember to run them.
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
