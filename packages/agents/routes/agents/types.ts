import { validated, Rule } from "../../../validation/validation.ts";

export type ServerLink = { serverId: string };

export type SkillLink = { skillId: string };

export type ChildLink = { childId: string };

export type RunBody = { text: string };

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
