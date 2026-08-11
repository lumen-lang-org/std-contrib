import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("script_images")
export class ScriptImage {
  @id
  @column("id", "text")
  id: string;

  @column("label", "text")
  label: string;

  @column("image", "text")
  image: string;

  @column("enabled", "bool")
  enabled: bool;

  @column("summary", "text")
  summary: string;

  constructor(id: string, label: string, image: string, enabled: bool, summary: string) {
    this.id = id;
    this.label = label;
    this.image = image;
    this.enabled = enabled;
    this.summary = summary;
  }
}

export function scriptImageRepository(): DbRepository {
  return entityScriptImage;
}
