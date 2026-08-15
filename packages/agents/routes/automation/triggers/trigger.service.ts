import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { stamp } from "../../../api-core.ts";
import { holdsOwner } from "../../../owner.ts";
import { TriggerBotRow, emptyBot } from "../../../triggers.ts";
import { TriggerChangeAsk } from "./dtos/trigger-change-ask.dto.ts";
import { TriggerCreateAsk } from "./dtos/trigger-create-ask.dto.ts";
import { TriggerTestAsk } from "./dtos/trigger-test-ask.dto.ts";
import { TriggerRepository } from "./trigger.repository.ts";
import { draftUntil, minutesWithin } from "./trigger.utils.ts";

export class TriggerService {
  repository: TriggerRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.repository = new TriggerRepository(database);
    this.master = master;
  }

  listing(owner: string): string {
    return this.repository.listing(owner);
  }

  owned(id: string, tags: string[]): TriggerBotRow {
    let document = this.repository.one(id);
    if (document == "") {
      return emptyBot();
    }
    let row: TriggerBotRow = JSON.parse<TriggerBotRow>(document);
    if (!holdsOwner(tags, row.owner)) {
      return emptyBot();
    }
    return row;
  }

  owns(id: string, tags: string[]): bool {
    return this.owned(id, tags).id != "";
  }

  one(id: string, tags: string[]): string {
    return JSON.stringify(this.owned(id, tags));
  }

  queue(id: string, tags: string[]): string {
    return this.repository.queue(this.owned(id, tags).id);
  }

  create(owner: string, body: string): Outcome {
    if (body == "") {
      return refusing("a body is required: {\"name\":\"...\",\"workflowId\":\"...\",\"token\":\"...\"}");
    }
    let ask: TriggerCreateAsk = JSON.parse<TriggerCreateAsk>(body);
    let workflowId = ask.workflowId ?? "";
    if (!this.repository.hasWorkflow(workflowId)) {
      return refusing("no workflow " + workflowId);
    }
    let token = ask.token ?? "";
    if (token.trim() == "") {
      return refusing("a bot needs its token from BotFather");
    }

    let id = crypto.randomUUID();
    let reference = "telegram:" + id;
    let refused = this.repository.keepToken(reference, token, this.master, stamp());
    if (refused != "") {
      return refusing(refused);
    }

    let now = stamp();
    let row: TriggerBotRow = {
      id: id, owner: owner, kind: "telegram",
      name: ask.name ?? "", workflowId: workflowId,
      credentialRef: reference, offset: "0", leaseBy: "", leaseUntil: "",
      enabled: false,
      runsToday: 0, dayStartedAt: now, lastAt: "", lastError: "",
      draftUntil: "", createdAt: now, updatedAt: now,
    };
    let written = this.repository.save(JSON.stringify(row));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(id));
  }

  update(id: string, tags: string[], body: string): Outcome {
    let mine = this.owned(id, tags);
    if (body == "") {
      return refusing("a body is required");
    }
    let ask: TriggerChangeAsk = JSON.parse<TriggerChangeAsk>(body);
    let workflowId = ask.workflowId ?? "";
    if (workflowId != "" && !this.repository.hasWorkflow(workflowId)) {
      return refusing("no workflow " + workflowId);
    }
    let name = ask.name ?? "";
    let edited: TriggerBotRow = {
      id: mine.id, owner: mine.owner, kind: mine.kind,
      name: name == "" ? mine.name : name,
      workflowId: workflowId == "" ? mine.workflowId : workflowId,
      credentialRef: mine.credentialRef, offset: mine.offset,
      leaseBy: mine.leaseBy, leaseUntil: mine.leaseUntil,
      enabled: ask.enabled ?? mine.enabled,
      runsToday: mine.runsToday, dayStartedAt: mine.dayStartedAt,
      lastAt: mine.lastAt, lastError: mine.lastError,
      draftUntil: mine.draftUntil ?? "", createdAt: mine.createdAt, updatedAt: stamp(),
    };
    let written = this.repository.save(JSON.stringify(edited));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(edited.id));
  }

  test(id: string, tags: string[], body: string): Outcome {
    let mine = this.owned(id, tags);
    let minutes: int = 5;
    if (body != "") {
      let ask: TriggerTestAsk = JSON.parse<TriggerTestAsk>(body);
      minutes = ask.minutes ?? 5;
    }
    let until = draftUntil(minutesWithin(minutes), Date.now());
    let written = this.repository.draftWindow(mine.id, until, stamp());
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(mine.id));
  }

  forget(id: string, tags: string[]): Outcome {
    let mine = this.owned(id, tags);
    let droppedToken = this.repository.forgetToken(mine.credentialRef);
    let fault = this.repository.forget(mine.id);
    if (fault != "") {
      return refusing(fault);
    }
    if (!droppedToken && mine.credentialRef != "") {
      return refusing("the bot is gone, but its stored token could not be deleted");
    }
    return produced("");
  }
}
