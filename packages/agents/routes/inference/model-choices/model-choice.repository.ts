import { Db } from "../../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, countWhere, deleteById, existsById, findById, listOrdered, persist } from "../../../../plume/plume.ts";
import { createFault } from "../../../payload.ts";
import { threadRepository } from "../../conversations/threads/entities/thread.entity.ts";
import { modelChoiceRepository } from "../models/entities/model-choice.entity.ts";

export class ModelChoiceRepository {
  database: Db;
  choices: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.choices = modelChoiceRepository();
  }

  listing(): string {
    let keys: DbOrder[] = [{ column: "menu_rank" }, { column: "label" }];
    return listOrdered(this.database, this.choices, { order: keys });
  }

  one(id: string): string {
    return findById(this.database, this.choices, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.choices, id);
  }

  creationFault(document: string): string {
    return createFault(this.database, this.choices, document);
  }

  save(document: string): DbResult {
    return persist(this.database, this.choices, document);
  }

  remove(id: string): DbResult {
    return deleteById(this.database, this.choices, id);
  }

  threadsOn(choiceId: string): int {
    return countWhere(this.database, threadRepository(),
      "model_choice_id = " + this.database.placeholder, [choiceId]);
  }
}
