import { validated, Rule } from "../../../../validation/validation.ts";

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
