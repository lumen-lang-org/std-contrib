import { Db } from "../../../../plume/driver.ts";
import { DbRepository, DbResult, deleteById, existsById, listOrdered, persist } from "../../../../plume/plume.ts";
import { toolCardRepository } from "./entities/tool-card.entity.ts";

export class ToolCardRepository {
  database: Db;
  cards: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.cards = toolCardRepository();
  }

  listing(): string {
    return listOrdered(this.database, this.cards, { order: [{ column: "tool_name" }] });
  }

  exists(id: string): bool {
    return existsById(this.database, this.cards, id);
  }

  save(document: string): DbResult {
    return persist(this.database, this.cards, document);
  }

  forget(id: string): DbResult {
    return deleteById(this.database, this.cards, id);
  }
}
