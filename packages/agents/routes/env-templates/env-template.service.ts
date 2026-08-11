import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { EnvTemplateAsk } from "./dtos/env-template-ask.dto.ts";
import { EnvTemplateRepository } from "./env-template.repository.ts";

export class EnvTemplateService {
  repository: EnvTemplateRepository;

  constructor(database: Db) {
    this.repository = new EnvTemplateRepository(database);
  }

  listing(): string {
    return this.repository.listing();
  }

  save(ask: EnvTemplateAsk): Outcome {
    let fault = this.repository.save({
      id: ask.id,
      name: ask.name,
      summary: ask.summary,
      tags: ask.tags,
      image: ask.image,
      dockerfile: ask.dockerfile,
      featuredRank: ask.featuredRank,
      now: stamp(),
    });
    if (fault != "") {
      return refusing(fault);
    }
    return produced(this.repository.listing());
  }

  forget(id: string): bool {
    return this.repository.forget(id);
  }
}
