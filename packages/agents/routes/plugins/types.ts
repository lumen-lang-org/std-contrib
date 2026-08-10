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
