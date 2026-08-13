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

  // A project starting point runs rather than being written out.
  @Column("image", "text")
  image: string;

  @Column("bootstrap", "text")
  bootstrap: string;

  @Column("serve", "text")
  serve: string;

  // What the prepared conversation opens with, in the words of whoever
  // prepared it.
  @Column("request", "text")
  request: string;

  constructor(id: string, label: string, description: string, kind: string, skillName: string,
              visibility: string, featuredRank: int, image: string, bootstrap: string,
              serve: string, request: string) {
    this.id = id;
    this.label = label;
    this.description = description;
    this.kind = kind;
    this.skillName = skillName;
    this.visibility = visibility;
    this.featuredRank = featuredRank;
    this.image = image;
    this.bootstrap = bootstrap;
    this.serve = serve;
    this.request = request;
  }
}

export function templateRepository(): DbRepository {
  return entityTemplate;
}
