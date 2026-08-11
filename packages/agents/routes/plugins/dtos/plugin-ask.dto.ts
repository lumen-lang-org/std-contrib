import { validated, Rule } from "../../../../validation/validation.ts";

@validated
export class PluginAsk {
  @required("a plugin is installed from a manifest URL")
  sourceUrl: string;

  constructor(sourceUrl: string) {
    this.sourceUrl = sourceUrl;
  }
}
