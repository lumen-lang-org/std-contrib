import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("skill_files")
export class SkillFile {
  @id
  @column("id", "text")
  id: string;

  @column("skill_id", "text")
  skillId: string;

  @column("path", "text")
  path: string;

  @column("body", "text")
  body: string;

  constructor(id: string, skillId: string, path: string, body: string) {
    this.id = id;
    this.skillId = skillId;
    this.path = path;
    this.body = body;
  }
}

export function skillFileRepository(): DbRepository {
  return entitySkillFile;
}
