import { Db } from "../../../../plume/driver.ts";
import { EnvTemplateWrite, envTemplatesAll, forgetEnvTemplate, saveEnvTemplate } from "../../../env-templates.ts";

export class EnvTemplateRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  listing(): string {
    return JSON.stringify(envTemplatesAll(this.database));
  }

  save(write: EnvTemplateWrite): string {
    return saveEnvTemplate(this.database, write);
  }

  forget(id: string): bool {
    return forgetEnvTemplate(this.database, id);
  }
}
