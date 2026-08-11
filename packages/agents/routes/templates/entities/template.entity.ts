import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("templates")
export class Template {
  @id
  @column("id", "text")
  id: string;

  @column("label", "text")
  label: string;

  @column("description", "text")
  description: string;

  @column("kind", "text")
  kind: string;

  @column("skill_name", "text")
  skillName: string;

  @column("visibility", "text")
  visibility: string;

  @column("featured_rank", "int")
  featuredRank: int;

  constructor(id: string, label: string, description: string, kind: string, skillName: string,
              visibility: string, featuredRank: int) {
    this.id = id;
    this.label = label;
    this.description = description;
    this.kind = kind;
    this.skillName = skillName;
    this.visibility = visibility;
    this.featuredRank = featuredRank;
  }
}

export function templateRepository(): DbRepository {
  return entityTemplate;
}
