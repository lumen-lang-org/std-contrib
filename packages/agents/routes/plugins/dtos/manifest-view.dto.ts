import { ManifestConnectorView } from "./manifest-connector-view.dto.ts";
import { ManifestSkillView } from "./manifest-skill-view.dto.ts";

export type ManifestView = {
  name: string,
  description: string,
  version: string,
  fault: string,
  skills: ManifestSkillView[],
  connectors: ManifestConnectorView[],
};
