import { validated, Rule } from "../../../validation/validation.ts";

export type ServerLink = { serverId: string };

export type SkillLink = { skillId: string };

export type ChildLink = { childId: string };

export type RunBody = { text: string };

// What the service answers with when the work could fail: a sentence saying why
// not, or the document that resulted. The service does not pick status codes —
// that is the controller's job, and the reason this type has no HTTP in it.
export type Written = { fault: string, document: string };

export type RunResult = {
  runId: string,
  ok: bool,
  text: string,
  agentName: string,
  promptVersion: int,
  modelApiName: string,
  stopReason: string,
  toolCalls: int,
  traceId: string,
  error: string,
};

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

@validated
export class ScopeGrant {
  @required("a scope is required")
  scope: string;

  constructor(scope: string) {
    this.scope = scope;
  }
}

@validated
export class RetrievalSetup {
  embeddingModelId: string;

  @min(1, "topK must be between 1 and 100")
  @max(100, "topK must be between 1 and 100")
  topK: int;

  maxDistance: number;

  enabled: bool;

  constructor(embeddingModelId: string, topK: int, maxDistance: number, enabled: bool) {
    this.embeddingModelId = embeddingModelId;
    this.topK = topK;
    this.maxDistance = maxDistance;
    this.enabled = enabled;
  }
}

@validated
export class WebRagSetup {
  enabled: bool;

  @min(1, "topK must be between 1 and 20 — the index caps at 20")
  @max(20, "topK must be between 1 and 20 — the index caps at 20")
  topK: int;

  @min(500, "maxChars must be between 500 and 100000")
  @max(100000, "maxChars must be between 500 and 100000")
  maxChars: int;

  @oneOf("verbatim,generated", "queryMode must be verbatim or generated")
  queryMode: string;

  queryModelId: string;

  constructor(enabled: bool, topK: int, maxChars: int, queryMode: string, queryModelId: string) {
    this.enabled = enabled;
    this.topK = topK;
    this.maxChars = maxChars;
    this.queryMode = queryMode;
    this.queryModelId = queryModelId;
  }
}
