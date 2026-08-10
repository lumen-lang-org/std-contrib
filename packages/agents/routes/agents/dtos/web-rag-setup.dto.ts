import { validated, Rule } from "../../../../validation/validation.ts";

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
