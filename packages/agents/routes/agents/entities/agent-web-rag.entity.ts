import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("agent_web_rag")
export class AgentWebRag {
  @Id
  @Column("agent_id", "text")
  agentId: string;

  @Column("enabled", "bool")
  enabled: bool;

  @Column("top_k", "int")
  topK: int;

  @Column("max_chars", "int")
  maxChars: int;

  @Column("query_mode", "text")
  queryMode: string;

  @Column("query_model_id", "text")
  queryModelId: string;

  constructor(agentId: string, enabled: bool, topK: int, maxChars: int, queryMode: string, queryModelId: string) {
    this.agentId = agentId;
    this.enabled = enabled;
    this.topK = topK;
    this.maxChars = maxChars;
    this.queryMode = queryMode;
    this.queryModelId = queryModelId;
  }
}

export function agentWebRagRepository(): DbRepository {
  return entityAgentWebRag;
}
