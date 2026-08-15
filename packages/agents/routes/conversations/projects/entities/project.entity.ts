import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("projects")
export class Project {
  @Id
  @Column("id", "text")
  id: string;

  @Column("owner", "text")
  owner: string;

  @Column("name", "text")
  name: string;

  @Column("instructions", "text")
  instructions: string;

  @Column("files_thread_id", "text")
  filesThreadId: string;

  @Column("created_at", "text")
  createdAt: string;

  constructor(id: string, owner: string, name: string, instructions: string, filesThreadId: string, createdAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.instructions = instructions;
    this.filesThreadId = filesThreadId;
    this.createdAt = createdAt;
  }
}

export function projectRepository(): DbRepository {
  return entityProject;
}
