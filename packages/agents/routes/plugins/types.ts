import { validated, Rule } from "../../../validation/validation.ts";

export type ManifestSkillView = {
  name: string,
  description: string,
  files: int,
};

export type ManifestConnectorView = {
  name: string,
  endpoint: string,
  authKind: string,
};

export type ManifestView = {
  name: string,
  description: string,
  version: string,
  problem: string,
  skills: ManifestSkillView[],
  connectors: ManifestConnectorView[],
};

export type PluginItemView = {
  kind: string,
  itemId: string,
  name: string,
};

@validated
export class PluginAsk {
  @required("a plugin is installed from a manifest URL")
  sourceUrl: string;

  constructor(sourceUrl: string) {
    this.sourceUrl = sourceUrl;
  }
}
