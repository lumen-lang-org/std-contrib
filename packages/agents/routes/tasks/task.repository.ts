import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, existsById, findById, listOrdered, listWhere, persist, setOn } from "../../../plume/plume.ts";
import { agentRepository } from "../agents/entities/agent.entity.ts";
import { ScheduledTaskRow, scheduledTaskRepository } from "./entities/scheduled-task.entity.ts";

export class TaskRepository {
  database: Db;
  tasks: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.tasks = scheduledTaskRepository();
  }

  listing(owner: string): string {
    let keys: DbOrder[] = [{ column: "next_at" }];
    return listOrdered(this.database, this.tasks, {
      where: "owner = " + this.database.placeholder,
      args: [owner],
      order: keys,
    });
  }

  one(id: string): string {
    return findById(this.database, this.tasks, id);
  }

  hasAgent(id: string): bool {
    return existsById(this.database, agentRepository(), id);
  }

  enabledForOwner(owner: string): int {
    let rows: ScheduledTaskRow[] = JSON.parse<ScheduledTaskRow[]>(listWhere(this.database, this.tasks,
      "owner = " + this.database.placeholder, [owner]));
    let n: int = 0;
    let i: int = 0;
    while (i < rows.length) {
      if (rows[i].enabled) {
        n = n + 1;
      }
      i = i + 1;
    }
    return n;
  }

  save(document: string): DbResult {
    return persist(this.database, this.tasks, document);
  }

  markRunNow(id: string, at: string): DbResult {
    return setOn(this.database, this.tasks, {
      id: id,
      values: [
        { column: "next_at", value: at },
        { column: "running_since", value: "" },
        { column: "enabled", value: "true" },
        { column: "updated_at", value: at },
      ],
    });
  }

  forget(id: string): DbResult {
    return deleteById(this.database, this.tasks, id);
  }
}
