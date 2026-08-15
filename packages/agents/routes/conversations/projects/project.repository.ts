import { Db } from "../../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, DbSweep, deleteById, existsById, findById, listOrdered, persist, setOn, setWhere } from "../../../../plume/plume.ts";
import { openThread, rememberRouteKey } from "../../../threads.ts";
import { threadRepository } from "../threads/entities/thread.entity.ts";
import { projectRepository } from "./entities/project.entity.ts";

export const PROJECT_FILES_KEY: string = "project-files";

export class ProjectRepository {
  database: Db;
  projects: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.projects = projectRepository();
  }

  listing(owner: string): string {
    let keys: DbOrder[] = [{ column: "created_at", direction: "desc" }];
    return listOrdered(this.database, this.projects, {
      where: "owner = " + this.database.placeholder,
      args: [owner],
      order: keys,
    });
  }

  one(id: string): string {
    return findById(this.database, this.projects, id);
  }

  save(document: string): DbResult {
    return persist(this.database, this.projects, document);
  }

  /** The conversations are let go of first, and the row only if that worked.
   *
   *  The other order loses: a project deleted while its threads still name it
   *  leaves them pointing at nothing, out of every project listing and with no
   *  briefing, and the caller is told the delete succeeded. Failing here
   *  instead leaves the project and its conversations exactly as they were. */
  remove(id: string): DbResult {
    let sweep: DbSweep = {
      values: [{ column: "project_id", value: "" }],
      match: [{ column: "project_id", operator: "=", value: id }],
    };
    let loosed = setWhere(this.database, threadRepository(), sweep);
    if (!loosed.ok) {
      return loosed;
    }
    return deleteById(this.database, this.projects, id);
  }

  filesThreadExists(threadId: string): bool {
    return existsById(this.database, threadRepository(), threadId);
  }

  openFilesThread(owner: string, now: string): string {
    return openThread(this.database, { agentId: PROJECT_FILES_KEY, owner: owner, now: now });
  }

  markFilesThreadRoute(threadId: string): string {
    return rememberRouteKey(this.database, threadId, PROJECT_FILES_KEY);
  }

  noteFilesThread(id: string, threadId: string): string {
    let wrote = setOn(this.database, this.projects, {
      id: id,
      values: [{ column: "files_thread_id", value: threadId }],
    });
    if (wrote.ok) {
      return "";
    }
    return wrote.error;
  }
}
