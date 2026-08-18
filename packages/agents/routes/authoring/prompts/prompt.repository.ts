import { Db } from "../../../../plume/driver.ts";
import { OWNED_PROMPT, myRowsClause, ownedRowsClause } from "../../../owner.ts";
import { DbOrder, DbRepository, DbResult, existsById, findById, listOrdered, pageOrdered, persist, placeholderAt } from "../../../../plume/plume.ts";
import { PromptRecord } from "./dtos/prompt-body.dto.ts";
import { promptRepository } from "./entities/prompt.entity.ts";

export class PromptRepository {
  database: Db;
  prompts: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.prompts = promptRepository();
  }

  all(owner: string, onlyMine: bool): string {
    let keys: DbOrder[] = [{ column: "prompt_name" }, { column: "version" }];
    return listOrdered(this.database, this.prompts, {
      where: onlyMine ? myRowsClause(this.database, OWNED_PROMPT, 1)
        : ownedRowsClause(this.database, OWNED_PROMPT, 1),
      args: [owner],
      order: keys,
    });
  }

  named(owner: string, name: string): string {
    let newest: DbOrder[] = [{ column: "version", direction: "desc" }];
    return listOrdered(this.database, this.prompts, {
      where: "prompt_name = " + this.database.placeholder
        + " AND " + ownedRowsClause(this.database, OWNED_PROMPT, 2),
      args: [name, owner],
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
