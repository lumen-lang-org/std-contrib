import { Db } from "../../../plume/driver.ts";
import { DbRepository, DbResult, deleteById, deleteWhere, existsById, findById, persist, setOn } from "../../../plume/plume.ts";
import { CredentialWrite, forgetCredential, storeCredential } from "../../credentials.ts";
import { botsOf, queuedFor, triggerBotsMapping, triggerInboxMapping } from "../../triggers.ts";
import { workflowsMapping } from "../../workflow-store.ts";

export class TriggerRepository {
  database: Db;
  bots: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.bots = triggerBotsMapping();
  }

  listing(owner: string): string {
    return botsOf(this.database, owner);
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
      deleteWhere(this.database, triggerInboxMapping(), "bot_id = " + this.database.placeholder, [id]),
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
