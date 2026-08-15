import { Rule, validated, Max, Min, OneOf } from "../../../../../validation/validation.ts";
import { OpenApiField, schema } from "../../../../../openapi/openapi.ts";

@validated
@schema
export class WebRagSetup {
  enabled: bool;

  @Min(1, "topK must be between 1 and 20 — the index caps at 20")
  @Max(20, "topK must be between 1 and 20 — the index caps at 20")
  topK: int;

  @Min(500, "maxChars must be between 500 and 100000")
  @Max(100000, "maxChars must be between 500 and 100000")
  maxChars: int;

  @OneOf("verbatim,generated", "queryMode must be verbatim or generated")
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
