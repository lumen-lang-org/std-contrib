import { Db } from "../../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, existsById, findById, listOrdered, pageOrdered, persist } from "../../../../plume/plume.ts";
import { PromptRecord } from "./dtos/prompt-body.dto.ts";
import { promptRepository } from "./entities/prompt.entity.ts";

export class PromptRepository {
  database: Db;
  prompts: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.prompts = promptRepository();
  }

  all(): string {
    let keys: DbOrder[] = [{ column: "prompt_name" }, { column: "version" }];
    return listOrdered(this.database, this.prompts, { order: keys });
  }

  named(name: string): string {
    let newest: DbOrder[] = [{ column: "version", direction: "desc" }];
    return listOrdered(this.database, this.prompts, {
      where: "prompt_name = " + this.database.placeholder,
      args: [name],
      order: newest,
    });
  }

  newestVersion(name: string): int {
    let newest: DbOrder[] = [{ column: "version", direction: "desc" }];
    let page = pageOrdered(this.database, this.prompts, {
      where: "prompt_name = " + this.database.placeholder,
      args: [name],
      order: newest,
      limit: 1,
      offset: 0,
    });
    if (page == "" || page == "[]") {
      return 0;
    }
    let rows: PromptRecord[] = JSON.parse<PromptRecord[]>(page);
    if (rows.length == 0) {
      return 0;
    }
    return rows[0].version;
  }

  exists(id: string): bool {
    return existsById(this.database, this.prompts, id);
  }

  save(document: string): DbResult {
    return persist(this.database, this.prompts, document);
  }

  one(id: string): string {
    return findById(this.database, this.prompts, id);
  }
}
