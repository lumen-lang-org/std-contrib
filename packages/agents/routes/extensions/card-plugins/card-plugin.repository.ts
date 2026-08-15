import { Db } from "../../../../plume/driver.ts";
import { DbRepository, DbResult, deleteById, deleteWhere, existsById, findById, listOrdered, listWhere, persist } from "../../../../plume/plume.ts";
import { cardPluginRepository } from "./entities/card-plugin.entity.ts";
import { cardCaseRepository } from "./entities/card-case.entity.ts";
import { toolCardRepository } from "../../authoring/tool-cards/entities/tool-card.entity.ts";

export class CardPluginRepository {
  database: Db;
  plugins: DbRepository;
  cards: DbRepository;
  cases: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.plugins = cardPluginRepository();
    this.cards = toolCardRepository();
    this.cases = cardCaseRepository();
  }

  listing(): string {
    return listOrdered(this.database, this.plugins, { order: [{ column: "plugin_name" }] });
  }

  one(id: string): string {
    return findById(this.database, this.plugins, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.plugins, id);
  }

  save(document: string): DbResult {
    return persist(this.database, this.plugins, document);
  }

  saveCard(document: string): DbResult {
    return persist(this.database, this.cards, document);
  }

  saveCase(document: string): DbResult {
    return persist(this.database, this.cases, document);
  }

  casesOf(id: string): string {
    return listWhere(this.database, this.cases, "plugin_id = " + this.database.placeholder, [id]);
  }

  forget(id: string): string {
    let steps: DbResult[] = [
      deleteWhere(this.database, this.cards, "plugin_id = " + this.database.placeholder, [id]),
      deleteWhere(this.database, this.cases, "plugin_id = " + this.database.placeholder, [id]),
      deleteById(this.database, this.plugins, id),
    ];
    let i: int = 0;
    while (i < steps.length) {
      if (!steps[i].ok) {
        return steps[i].error;
      }
      i = i + 1;
    }
    return "";
  }
}
