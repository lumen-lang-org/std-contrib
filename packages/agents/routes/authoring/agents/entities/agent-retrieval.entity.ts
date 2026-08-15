import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("agent_retrieval")
export class AgentRetrieval {
  @Id
  @Column("agent_id", "text")
  agentId: string;

  @Column("embedding_model_id", "text")
  embeddingModelId: string;

  @Column("top_k", "int")
  topK: int;

  @Column("max_distance", "float8")
  maxDistance: number;

  @Column("enabled", "bool")
  enabled: bool;

  constructor(agentId: string, embeddingModelId: string, topK: int, maxDistance: number, enabled: bool) {
    this.agentId = agentId;
    this.embeddingModelId = embeddingModelId;
    this.topK = topK;
    this.maxDistance = maxDistance;
    this.enabled = enabled;
  }
}

export function agentRetrievalRepository(): DbRepository {
  return entityAgentRetrieval;
}
