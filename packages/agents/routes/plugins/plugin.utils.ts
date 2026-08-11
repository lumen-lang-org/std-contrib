import { Manifest } from "../../plugins.ts";
import { ManifestConnectorView } from "./dtos/manifest-connector-view.dto.ts";
import { ManifestSkillView } from "./dtos/manifest-skill-view.dto.ts";
import { ManifestView } from "./dtos/manifest-view.dto.ts";

export function manifestView(manifest: Manifest, clash: string): ManifestView {
  let skills: ManifestSkillView[] = [];
  let i: int = 0;
  while (i < manifest.skills.length) {
    let one: ManifestSkillView = {
      name: manifest.skills[i].skillName,
      description: manifest.skills[i].description,
      files: manifest.skills[i].files.length,
    };
    skills.push(one);
    i = i + 1;
  }
  let connectors: ManifestConnectorView[] = [];
  let c: int = 0;
  while (c < manifest.connectors.length) {
    let link: ManifestConnectorView = {
      name: manifest.connectors[c].serverName,
      endpoint: manifest.connectors[c].endpoint,
      authKind: manifest.connectors[c].authKind,
    };
    connectors.push(link);
    c = c + 1;
  }
  let view: ManifestView = {
    name: manifest.pluginName,
    description: manifest.description,
    version: manifest.version,
    fault: clash,
    skills: skills,
    connectors: connectors,
  };
  return view;
}
