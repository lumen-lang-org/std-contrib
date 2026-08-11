import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("env_templates")
export class EnvTemplate {
  @Id
  @Column("id", "text")
  id: string;

  @Column("name", "text")
  name: string;

  @Column("summary", "text")
  summary: string;

  @Column("tags", "text")
  tags: string;

  @Column("source", "text")
  source: string;

  @Column("image", "text")
  image: string;

  @Column("dockerfile", "text")
  dockerfile: string;

  @Column("featured_rank", "int")
  featuredRank: int;

  @Column("created_at", "text")
  createdAt: string;

  constructor(id: string, name: string, summary: string, tags: string, source: string, image: string, dockerfile: string, featuredRank: int, createdAt: string) {
    this.id = id;
    this.name = name;
    this.summary = summary;
    this.tags = tags;
    this.source = source;
    this.image = image;
    this.dockerfile = dockerfile;
    this.featuredRank = featuredRank;
    this.createdAt = createdAt;
  }
}

export function envTemplateRepository(): DbRepository {
  return entityEnvTemplate;
}
