import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { choiceFault, stamp } from "../../api-core.ts";
import { holdsOwner } from "../../owner.ts";
import { MAX_PER_OWNER, TaskRow, compile, emptyTask, isOnce, nextFire, onceInstant, refuse, stampMs, withNextAt } from "../../tasks.ts";
import { TaskChangeAsk } from "./dtos/task-change-ask.dto.ts";
import { TaskCreateAsk } from "./dtos/task-create-ask.dto.ts";
import { TaskRepository } from "./task.repository.ts";

export class TaskService {
  repository: TaskRepository;

  constructor(database: Db) {
    this.repository = new TaskRepository(database);
  }

  listing(owner: string): string {
    return this.repository.listing(owner);
  }

  owned(id: string, tags: string[]): TaskRow {
    let document = this.repository.one(id);
    if (document == "") {
      return emptyTask();
    }
    let row: TaskRow = JSON.parse<TaskRow>(document);
    if (!holdsOwner(tags, row.owner)) {
      return emptyTask();
    }
    return row;
  }

  owns(id: string, tags: string[]): bool {
    return this.owned(id, tags).id != "";
  }

  create(owner: string, body: string): Outcome {
    if (body == "") {
      return refusing("a body is required: {\"agentId\":\"a1\",\"instruction\":\"...\",\"schedule\":\"every weekday at 08:00\"}");
    }

    let ask: TaskCreateAsk = JSON.parse<TaskCreateAsk>(body);
    let agentId = ask.agentId ?? "";
    if (!this.repository.hasAgent(agentId)) {
      return refusing("no agent " + agentId);
    }
    let chosen = ask.modelChoiceId ?? "";
    let refusedChoice = choiceFault(this.repository.database, chosen);
    if (refusedChoice != "") {
      return refusing(refusedChoice);
    }

    if (this.repository.enabledForOwner(owner) >= MAX_PER_OWNER) {
      return refusing("that is " + `${MAX_PER_OWNER}` + " tasks already — pause one before adding another");
    }

    let said = ask.schedule ?? "";
    let zone = ask.tz ?? "";
    let kind = said == "" || isOnce(said) ? "once" : "every";
    let expr = "";
    let at = "";
    if (kind == "every") {
      let compiled = compile(said);
      if (!compiled.ok) {
        return refusing(compiled.error);
      }
      expr = compiled.expr;
    } else if (isOnce(said)) {
      let once = onceInstant(said, zone == "" ? "UTC" : zone, Date.now() as number);
      if (!once.ok) {
        return refusing(once.error);
      }
      at = once.at;
    } else {
      at = ask.at ?? "";
      if (stampMs(at) <= (Date.now() as number)) {
        return refusing("a one-off task needs an instant in the future: {\"at\":\"<epoch ms>\"}");
      }
    }

    let now = stamp();
    let row: TaskRow = {
      id: crypto.randomUUID(),
      owner: owner,
      agentId: agentId,
      modelChoiceId: chosen,
      title: ask.title ?? "",
      instruction: ask.instruction ?? "",
      kind: kind,
      cronExpr: expr,
      tz: zone,
      nextAt: at,
      runningSince: "",
      enabled: true,
      failures: 0,
      pausedReason: "",
      lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    let wrong = refuse(row);
    if (wrong != "") {
      return refusing(wrong);
    }

    let ready = row;
    if (kind == "every") {
      let first = nextFire(row, Date.now() as number);
      if (!first.ok) {
        return refusing(first.error);
      }
      ready = withNextAt(row, first.at);
    }

    let written = this.repository.save(JSON.stringify(ready));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(ready.id));
  }

  update(id: string, tags: string[], body: string): Outcome {
    let mine = this.owned(id, tags);
    if (body == "") {
      return refusing("a body is required");
    }

    let ask: TaskChangeAsk = JSON.parse<TaskChangeAsk>(body);
    let said = ask.schedule ?? "";
    let expr = mine.cronExpr;
    let kind = mine.kind;
    let when = mine.nextAt;
    if (said != "" && isOnce(said)) {
      let once = onceInstant(said, mine.tz == "" ? "UTC" : mine.tz, Date.now() as number);
      if (!once.ok) {
        return refusing(once.error);
      }
      kind = "once";
      expr = "";
      when = once.at;
    } else if (said != "") {
      let compiled = compile(said);
      if (!compiled.ok) {
        return refusing(compiled.error);
      }
      kind = "every";
      expr = compiled.expr;
    }
    let title = ask.title ?? "";
    let instruction = ask.instruction ?? "";
    let tz = ask.tz ?? "";
    let on = ask.enabled ?? mine.enabled;

    let edited: TaskRow = {
      id: mine.id, owner: mine.owner, agentId: mine.agentId,
      modelChoiceId: mine.modelChoiceId,
      title: title == "" ? mine.title : title,
      instruction: instruction == "" ? mine.instruction : instruction,
      kind: kind, cronExpr: expr,
      tz: tz == "" ? mine.tz : tz,
      nextAt: when, runningSince: mine.runningSince,
      enabled: on,
      failures: on && !mine.enabled ? 0 : mine.failures,
      pausedReason: on ? "" : mine.pausedReason,
      lastRunAt: mine.lastRunAt, lastRunId: mine.lastRunId,
      lastStatus: mine.lastStatus, lastError: mine.lastError,
      runCount: mine.runCount, createdAt: mine.createdAt, updatedAt: stamp(),
    };
    let wrong = refuse(edited);
    if (wrong != "") {
      return refusing(wrong);
    }
    let stored = edited;
    if (edited.kind == "every") {
      let ahead = nextFire(edited, Date.now() as number);
      if (!ahead.ok) {
        return refusing(ahead.error);
      }
      stored = withNextAt(edited, ahead.at);
    }

    let written = this.repository.save(JSON.stringify(stored));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(stored.id));
  }

  runNow(id: string, tags: string[]): Outcome {
    let mine = this.owned(id, tags);
    let written = this.repository.markRunNow(mine.id, stamp());
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(mine.id));
  }

  forget(id: string, tags: string[]): Outcome {
    let mine = this.owned(id, tags);
    let gone = this.repository.forget(mine.id);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced("");
  }
}
