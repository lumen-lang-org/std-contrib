import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("skill_files")
export class SkillFile {
  @Id
  @Column("id", "text")
  id: string;

  @Column("skill_id", "text")
  skillId: string;

  @Column("path", "text")
  path: string;

  @Column("body", "text")
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
