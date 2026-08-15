import { Db } from "../../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, countWhere, deleteById, existsById, findById, listOrdered, persist, setWhere } from "../../../../plume/plume.ts";
import { createFault } from "../../../payload.ts";
import { modelConfigRepository } from "../model-configs/entities/model-config.entity.ts";
import { MenuChoice } from "./dtos/menu-choice.dto.ts";
import { StoredModel } from "./dtos/stored-model.dto.ts";
import { modelChoiceRepository } from "./entities/model-choice.entity.ts";
import { modelRepository } from "./entities/model.entity.ts";

export class ModelRepository {
  database: Db;
  models: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.models = modelRepository();
  }

  listing(): string {
    let keys: DbOrder[] = [{ column: "label" }];
    return listOrdered(this.database, this.models, { order: keys });
  }

  choices(): MenuChoice[] {
    let out: MenuChoice[] = [];
    let keys: DbOrder[] = [{ column: "menu_rank" }, { column: "label" }];
    let listed = listOrdered(this.database, modelChoiceRepository(), {
      where: "enabled = " + placeholderAt(this.database, 1),
      args: ["1"],
      order: keys,
    });
    if (listed == "" || listed == "[]") {
      return out;
    }
    return JSON.parse<MenuChoice[]>(listed);
  }

  one(id: string): string {
    return findById(this.database, this.models, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.models, id);
  }

  creationFault(document: string): string {
    return createFault(this.database, this.models, document);
  }

  save(document: string): DbResult {
    return persist(this.database, this.models, document);
  }

  disableOtherEmbeddings(id: string): DbResult {
    return setWhere(this.database, this.models, {
      values: [{ column: "enabled", value: "false" }],
      match: [
        { column: "kind", operator: "=", value: "embedding" },
        { column: "id", operator: "<>", value: id },
      ],
    });
  }

  configsUsing(id: string): int {
    return countWhere(this.database, modelConfigRepository(),
      "model_id = " + this.database.placeholder, [id]);
  }

  forget(id: string): DbResult {
    return deleteById(this.database, this.models, id);
  }
}
