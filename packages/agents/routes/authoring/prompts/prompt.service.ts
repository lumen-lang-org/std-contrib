import { Db } from "../../../../plume/driver.ts";
import { OWNED_PROMPT, ownRow } from "../../../owner.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { PromptBody } from "./dtos/prompt-body.dto.ts";
import { Prompt } from "./entities/prompt.entity.ts";
import { PromptRepository } from "./prompt.repository.ts";

export class PromptService {
  repository: PromptRepository;

  constructor(database: Db) {
    this.repository = new PromptRepository(database);
  }

  listing(owner: string, name: string): string {
    if (name == "") {
      return this.repository.all(owner);
    }
    return this.repository.named(owner, name);
  }

  create(owner: string, sent: string): Outcome {
    if (sent == "") {
      return refusing("a body is required");
    }
    let body: PromptBody = JSON.parse<PromptBody>(sent);
    if (body.promptName == "") {
      return refusing("promptName is required");
    }
    if (body.body == "") {
      return refusing("an empty prompt is not a version");
    }
    let id = body.id;
    if (id == "") {
      id = crypto.randomUUID();
    }
    if (this.repository.exists(id)) {
      return refusing("prompt \"" + id + "\" already exists; a new version is a new row, so leave \"id\" out or send an unused one");
    }
    let next = 1 + this.repository.newestVersion(body.promptName);
    let row = new Prompt(id, body.promptName, next, body.body, body.createdAt);
    let written = this.repository.save(JSON.stringify(row));
    if (!written.ok) {
      return refusing(written.error);
    }
    if (!ownRow(this.repository.database, OWNED_PROMPT, id, owner)) {
      return refusing("the prompt was written but could not be filed under an owner");
    }
    return produced(this.repository.one(id));
  }
}
