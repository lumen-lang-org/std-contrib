import { Db } from "../../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, countWhere, deleteById, existsById, findById, listOrdered, persist, placeholderAt, repository } from "../../../../plume/plume.ts";
import { createFault } from "../../../payload.ts";
import { agentRepository } from "../../authoring/agents/entities/agent.entity.ts";
import { modelChoiceRepository } from "../models/entities/model-choice.entity.ts";
import { modelRouterRepository } from "../models/entities/model-router.entity.ts";
import { modelConfigRepository } from "./entities/model-config.entity.ts";

/** The row's own columns, without the model joined onto it. An edit merges
 *  into this, so the join never comes back round as a field to store. */
function storedColumns(): DbRepository {
  return repository({
    table: "model_configs",
    idField: "id",
    idColumn: "id",
    fields: modelConfigRepository().fields,
  });
}

export class ModelConfigRepository {
  database: Db;
  configs: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.configs = modelConfigRepository();
  }

  listing(): string {
    let keys: DbOrder[] = [{ column: "id" }];
    return listOrdered(this.database, this.configs, { order: keys });
  }

  one(id: string): string {
    return findById(this.database, this.configs, id);
  }

  storedRow(id: string): string {
    return findById(this.database, storedColumns(), id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.configs, id);
  }

  creationFault(document: string): string {
    return createFault(this.database, this.configs, document);
  }

  save(document: string): DbResult {
    return persist(this.database, this.configs, document);
  }

  remove(id: string): DbResult {
    return deleteById(this.database, this.configs, id);
  }

  agentsOn(configId: string): int {
    return countWhere(this.database, agentRepository(),
      "model_config_id = " + this.database.placeholder, [configId]);
  }

  menuRowsOn(configId: string): int {
    return countWhere(this.database, modelChoiceRepository(),
      "config_id = " + this.database.placeholder, [configId]);
  }

  routersOn(configId: string): int {
    return countWhere(this.database, modelRouterRepository(),
      "router_config_id = " + placeholderAt(this.database, 1)
      + " OR fallback_config_id = " + placeholderAt(this.database, 2),
      [configId, configId]);
  }
}
