import { validated, Rule } from "../../../validation/validation.ts";

@validated
export class EnvTemplateAsk {
  id: string;

  @required("a template needs a name — it is what the catalog shows")
  name: string;

  summary: string;

  tags: string;

  image: string;

  dockerfile: string;

  @min(0, "featuredRank is 0 (not featured) or a positive position")
  featuredRank: int;

  constructor(id: string, name: string, summary: string, tags: string,
              image: string, dockerfile: string, featuredRank: int) {
    this.id = id;
    this.name = name;
    this.summary = summary;
    this.tags = tags;
    this.image = image;
    this.dockerfile = dockerfile;
    this.featuredRank = featuredRank;
  }
}
