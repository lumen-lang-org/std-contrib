import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("templates")
export class Template {
  @Id
  @Column("id", "text")
  id: string;

  @Column("label", "text")
  label: string;

  @Column("description", "text")
  description: string;

  @Column("kind", "text")
  kind: string;

  @Column("skill_name", "text")
  skillName: string;

  @Column("visibility", "text")
  visibility: string;

  @Column("featured_rank", "int")
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
