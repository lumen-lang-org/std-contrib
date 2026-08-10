import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("skills")
export class Skill {
  @id
  @column("id", "text")
  id: string;

  @column("skill_name", "text")
  skillName: string;

  @column("description", "text")
  description: string;

  @column("body", "text")
  body: string;

  @column("updated_at", "text")
  updatedAt: string;

  @column("visibility", "text")
  visibility: string;

  @column("featured_rank", "int")
  featuredRank: int;

  @column("source", "text")
  source: string;

  @column("source_url", "text")
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
