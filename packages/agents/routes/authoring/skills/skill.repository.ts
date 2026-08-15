import { Db } from "../../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, countWhere, deleteById, deleteWhere, existsById, findById, linkOf, listOrdered, listWhere, persist, placeholderAt, unlinkAllPointingAt } from "../../../../plume/plume.ts";
import { agentRepository } from "../agents/entities/agent.entity.ts";
import { skillFileRepository } from "./entities/skill-file.entity.ts";
import { skillRepository } from "./entities/skill.entity.ts";

export class SkillRepository {
  database: Db;
  skills: DbRepository;
  files: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.skills = skillRepository();
    this.files = skillFileRepository();
  }

  featured(): string {
    let ranked: DbOrder[] = [{ column: "featured_rank" }];
    return listOrdered(this.database, this.skills, {
      where: "visibility = 'public' AND featured_rank > 0",
      order: ranked,
    });
  }

  listing(): string {
    let keys: DbOrder[] = [{ column: "skill_name" }];
    return listOrdered(this.database, this.skills, { order: keys });
  }

  one(id: string): string {
    return findById(this.database, this.skills, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.skills, id);
  }

  named(name: string): int {
    return countWhere(this.database, this.skills, "skill_name = " + placeholderAt(this.database, 1), [name]);
  }

  save(document: string): DbResult {
    return persist(this.database, this.skills, document);
  }

  fileExists(fileId: string): bool {
    return existsById(this.database, this.files, fileId);
  }

  file(fileId: string): string {
    return findById(this.database, this.files, fileId);
  }

  saveFile(document: string): DbResult {
    return persist(this.database, this.files, document);
  }

  filesOf(id: string): string {
    let keys: DbOrder[] = [{ column: "path" }];
    return listOrdered(this.database, this.files, {
      where: "skill_id = " + placeholderAt(this.database, 1),
      args: [id],
      order: keys,
    });
  }

  fileRowsOf(id: string): string {
    return listWhere(this.database, this.files, "skill_id = " + placeholderAt(this.database, 1), [id]);
  }

  forgetFile(fileId: string): string {
    let gone = deleteById(this.database, this.files, fileId);
    if (!gone.ok) {
      return gone.error;
    }
    return "";
  }

  forget(id: string): string {
    let steps: DbResult[] = [
      unlinkAllPointingAt(this.database, linkOf(agentRepository(), "skills"), id),
      deleteWhere(this.database, this.files, "skill_id = " + placeholderAt(this.database, 1), [id]),
      deleteById(this.database, this.skills, id),
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
