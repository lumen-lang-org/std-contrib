import { Db } from "../../../../plume/driver.ts";
import { OWNED_PROMPT, ownRow, ownedRowIds } from "../../../owner.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { PromptBody, PromptRecord } from "./dtos/prompt-body.dto.ts";
import { Prompt } from "./entities/prompt.entity.ts";
import { PromptRepository } from "./prompt.repository.ts";

/** The deployment's prompt text stays the operator's.
 *
 *  A deployment prompt is listed to everybody — the name is how an agent
 *  picker and the canvas name it — but its body is the deployment's own
 *  writing, and serving it to any signed-in caller published every system
 *  prompt on the box. Rows the caller wrote come through whole; the
 *  deployment's come through named and emptied. Filing as the deployment
 *  (which the console grants operators alone) reads everything in full. */
function withheldBodies(db: Db, raw: string, owner: string): string {
  if (owner == "") {
    return raw;
  }
  let rows: PromptRecord[] = JSON.parse<PromptRecord[]>(raw);
  let held = ownedRowIds(db, OWNED_PROMPT, owner);
  let out: PromptRecord[] = [];
  let i: int = 0;
  while (i < rows.length) {
    let each = rows[i];
    if (held.includes(each.id)) {
      out.push(each);
    } else {
      let named: PromptRecord = {
        id: each.id, promptName: each.promptName, version: each.version,
        body: "", createdAt: each.createdAt,
      };
      out.push(named);
    }
    i = i + 1;
  }
  return JSON.stringify(out);
}

export class PromptService {
  repository: PromptRepository;

  constructor(database: Db) {
    this.repository = new PromptRepository(database);
  }

  listing(owner: string, name: string, onlyMine: bool): string {
    if (name == "") {
      return withheldBodies(this.repository.database, this.repository.all(owner, onlyMine), owner);
    }
    return withheldBodies(this.repository.database, this.repository.named(owner, name), owner);
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
