import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("prompts")
export class Prompt {
  @Id
  @Column("id", "text")
  id: string;

  @Column("prompt_name", "text")
  promptName: string;

  @Column("version", "int")
  version: int;

  @Column("body", "text")
  body: string;

  @Column("created_at", "text")
  createdAt: string;

  constructor(id: string, promptName: string, version: int, body: string, createdAt: string) {
    this.id = id;
    this.promptName = promptName;
    this.version = version;
    this.body = body;
    this.createdAt = createdAt;
  }
}

export function promptRepository(): DbRepository {
  return entityPrompt;
}
