import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, existsById, findById, listOrdered, persist } from "../../../plume/plume.ts";
import { PROJECT_FILES_KEY, releaseThreads, rememberFilesThread } from "../../projects.ts";
import { openThread, rememberRouteKey } from "../../threads.ts";
import { threadRepository } from "../threads/entities/thread.entity.ts";
import { projectRepository } from "./entities/project.entity.ts";

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

  remove(id: string): DbResult {
    releaseThreads(this.database, id);
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
    return rememberFilesThread(this.database, id, threadId);
  }
}
