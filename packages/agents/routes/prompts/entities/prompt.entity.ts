import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("prompts")
export class Prompt {
  @id
  @column("id", "text")
  id: string;

  @column("prompt_name", "text")
  promptName: string;

  @column("version", "int")
  version: int;

  @column("body", "text")
  body: string;

  @column("created_at", "text")
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
