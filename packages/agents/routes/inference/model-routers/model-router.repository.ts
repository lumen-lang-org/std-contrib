import { Db } from "../../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, countWhere, deleteById, existsById, findById, listOrdered, persist } from "../../../../plume/plume.ts";
import { createFault } from "../../../payload.ts";
import { modelChoiceRepository } from "../models/entities/model-choice.entity.ts";
import { modelRouterRepository } from "../models/entities/model-router.entity.ts";
import { ModelRouterBody } from "./dtos/model-router-body.dto.ts";

export class ModelRouterRepository {
  database: Db;
  routers: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.routers = modelRouterRepository();
  }

  all(): ModelRouterBody[] {
    let none: ModelRouterBody[] = [];
    let keys: DbOrder[] = [{ column: "label" }, { column: "id" }];
    let listed = listOrdered(this.database, this.routers, { order: keys });
    if (listed == "" || listed == "[]") {
      return none;
    }
    return JSON.parse<ModelRouterBody[]>(listed);
  }

  one(id: string): string {
    return findById(this.database, this.routers, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.routers, id);
  }

  creationFault(document: string): string {
    return createFault(this.database, this.routers, document);
  }

  save(document: string): DbResult {
    return persist(this.database, this.routers, document);
  }

  remove(id: string): DbResult {
    return deleteById(this.database, this.routers, id);
  }

  choicesOn(routerId: string): int {
    return countWhere(this.database, modelChoiceRepository(),
      "router_id = " + this.database.placeholder, [routerId]);
  }
}
