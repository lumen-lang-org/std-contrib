import { Db } from "../../../../plume/driver.ts";
import { documentIsOwned } from "../../../owner.ts";
import { RunRepository } from "./run.repository.ts";

export class RunService {
  repository: RunRepository;

  constructor(database: Db) {
    this.repository = new RunRepository(database);
  }

  visible(id: string, tags: string[]): string {
    let document = this.repository.one(id);
    if (document == "") {
      return "";
    }
    if (!documentIsOwned(document, tags)) {
      return "";
    }
    return document;
  }

  canSee(id: string, tags: string[]): bool {
    return this.visible(id, tags) != "";
  }
}
