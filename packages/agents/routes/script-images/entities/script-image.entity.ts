import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("script_images")
export class ScriptImage {
  @Id
  @Column("id", "text")
  id: string;

  @Column("label", "text")
  label: string;

  @Column("image", "text")
  image: string;

  @Column("enabled", "bool")
  enabled: bool;

  @Column("summary", "text")
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
