import { Db } from "../../../plume/driver.ts";
import { DbRepository, DbResult, deleteById, existsById, findById, persist, setOn } from "../../../plume/plume.ts";
import { agentRepository } from "../agents/entities/agent.entity.ts";
import { enabledCount, tasksMapping, tasksOf } from "../../tasks.ts";

export class TaskRepository {
  database: Db;
  tasks: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.tasks = tasksMapping();
  }

  listing(owner: string): string {
    return tasksOf(this.database, owner);
  }

  one(id: string): string {
    return findById(this.database, this.tasks, id);
  }

  hasAgent(id: string): bool {
    return existsById(this.database, agentRepository(), id);
  }

  enabledForOwner(owner: string): int {
    return enabledCount(this.database, owner);
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
