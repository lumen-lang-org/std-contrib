import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, deleteWhere, existsById, findById, listOrdered, persist, setOn } from "../../../plume/plume.ts";
import { CredentialWrite, forgetCredential, storeCredential } from "../../credentials.ts";
import { queuedFor } from "../../triggers.ts";
import { workflowsMapping } from "../../workflow-store.ts";
import { triggerBotRepository } from "./entities/trigger-bot.entity.ts";
import { triggerInboxRepository } from "./entities/trigger-inbox.entity.ts";

export class TriggerRepository {
  database: Db;
  bots: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.bots = triggerBotRepository();
  }

  listing(owner: string): string {
    let keys: DbOrder[] = [{ column: "name" }];
    return listOrdered(this.database, this.bots, {
      where: "owner = " + this.database.placeholder,
      args: [owner],
      order: keys,
    });
  }

  one(id: string): string {
    return findById(this.database, this.bots, id);
  }

  hasWorkflow(id: string): bool {
    return existsById(this.database, workflowsMapping(), id);
  }

  save(document: string): DbResult {
    return persist(this.database, this.bots, document);
  }

  keepToken(reference: string, token: string, master: string, at: string): string {
    let write: CredentialWrite = {
      provider: reference,
      apiKey: token,
      masterKey: master,
      now: at,
    };
    return storeCredential(this.database, write);
  }

  forgetToken(reference: string): bool {
    return forgetCredential(this.database, reference);
  }

  draftWindow(id: string, until: string, at: string): DbResult {
    return setOn(this.database, this.bots, {
      id: id,
      values: [
        { column: "draft_until", value: until },
        { column: "updated_at", value: at },
      ],
    });
  }

  queue(id: string): string {
    return queuedFor(this.database, id);
  }

  forget(id: string): string {
    let steps: DbResult[] = [
      deleteWhere(this.database, triggerInboxRepository(), "bot_id = " + this.database.placeholder, [id]),
      deleteById(this.database, this.bots, id),
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
