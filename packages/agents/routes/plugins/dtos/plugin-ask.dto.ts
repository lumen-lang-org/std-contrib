import { Rule, validated, Required } from "../../../../validation/validation.ts";

@validated
export class PluginAsk {
  @Required("a plugin is installed from a manifest URL")
  sourceUrl: string;

  constructor(sourceUrl: string) {
    this.sourceUrl = sourceUrl;
  }
}
