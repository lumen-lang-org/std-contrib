import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("skills")
export class Skill {
  @Id
  @Column("id", "text")
  id: string;

  @Column("skill_name", "text")
  skillName: string;

  @Column("description", "text")
  description: string;

  @Column("body", "text")
  body: string;

  @Column("updated_at", "text")
  updatedAt: string;

  @Column("visibility", "text")
  visibility: string;

  @Column("featured_rank", "int")
  featuredRank: int;

  @Column("source", "text")
  source: string;

  @Column("source_url", "text")
  sourceUrl: string;

  constructor(id: string, skillName: string, description: string, body: string,
              updatedAt: string, visibility: string, featuredRank: int,
              source: string, sourceUrl: string) {
    this.id = id;
    this.skillName = skillName;
    this.description = description;
    this.body = body;
    this.updatedAt = updatedAt;
    this.visibility = visibility;
    this.featuredRank = featuredRank;
    this.source = source;
    this.sourceUrl = sourceUrl;
  }
}

export function skillRepository(): DbRepository {
  return entitySkill;
}
