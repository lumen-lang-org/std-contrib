import { Db } from "../../../plume/driver.ts";
import { deleteById, executeWith, existsById, findById, persist, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, Accepted, BadRequest, Created, NoContent, NotFound, Ok, param } from "../../../rest/server.ts";
import { callerTags, choiceProblem, guestTag, stamp } from "../../api-core.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { agentsMapping } from "../../schema.ts";
import { MAX_PER_OWNER, TaskRow, compile, emptyTask, enabledCount, isOnce, nextFire, onceInstant, refuse, stampMs, tasksMapping, tasksOf, withNextAt } from "../../tasks.ts";
import { ownedOrEmpty, roleAtLeast } from "../../guards.ts";

export type TaskCreateAsk = {
  agentId?: string,
  modelChoiceId?: string,
  title?: string,
  instruction?: string,
  schedule?: string,
  tz?: string,
  at?: string,
};

export type TaskChangeAsk = {
  agentId?: string,
  modelChoiceId?: string,
  title?: string,
  instruction?: string,
  schedule?: string,
  tz?: string,
  enabled?: bool,
};

@controller("/tasks")
@bindings
export class TaskApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(req: Request): Reply {
    let tags = callerTags(req);
    return Ok(tasksOf(this.db, owningTag(tags)));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a task yours to run"))
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (req.body == "") {
      return BadRequest("a body is required: {\"agentId\":\"a1\",\"instruction\":\"...\",\"schedule\":\"every weekday at 08:00\"}");
    }

    let ask: TaskCreateAsk = JSON.parse<TaskCreateAsk>(req.body);
    let agentId = ask.agentId ?? "";
    if (!existsById(this.db, agentsMapping(), agentId)) {
      return BadRequest("no agent " + agentId);
    }
    let chosen = ask.modelChoiceId ?? "";
    let refusedChoice = choiceProblem(this.db, chosen);
    if (refusedChoice != "") {
      return BadRequest(refusedChoice);
    }

    if (enabledCount(this.db, owner) >= MAX_PER_OWNER) {
      return BadRequest("that is " + `${MAX_PER_OWNER}` + " tasks already — pause one before adding another");
    }

    let said = ask.schedule ?? "";
    let zone = ask.tz ?? "";
    let kind = said == "" || isOnce(said) ? "once" : "every";
    let expr = "";
    let at = "";
    if (kind == "every") {
      let compiled = compile(said);
      if (!compiled.ok) {
        return BadRequest(compiled.error);
      }
      expr = compiled.expr;
    } else if (isOnce(said)) {
      let once = onceInstant(said, zone == "" ? "UTC" : zone, Date.now() as number);
      if (!once.ok) {
        return BadRequest(once.error);
      }
      at = once.at;
    } else {
      at = ask.at ?? "";
      if (stampMs(at) <= (Date.now() as number)) {
        return BadRequest("a one-off task needs an instant in the future: {\"at\":\"<epoch ms>\"}");
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
      return BadRequest(wrong);
    }

    let ready = row;
    if (kind == "every") {
      let first = nextFire(row, Date.now() as number);
      if (!first.ok) {
        return BadRequest(first.error);
      }
      ready = withNextAt(row, first.at);
    }

    let written = persist(this.db, tasksMapping(), JSON.stringify(ready));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, tasksMapping(), ready.id));
  }

  @Put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("task " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }

    let ask: TaskChangeAsk = JSON.parse<TaskChangeAsk>(req.body);
    let said = ask.schedule ?? "";
    let expr = mine.cronExpr;
    let kind = mine.kind;
    let when = mine.nextAt;
    if (said != "" && isOnce(said)) {
      let once = onceInstant(said, mine.tz == "" ? "UTC" : mine.tz, Date.now() as number);
      if (!once.ok) {
        return BadRequest(once.error);
      }
      kind = "once";
      expr = "";
      when = once.at;
    } else if (said != "") {
      let compiled = compile(said);
      if (!compiled.ok) {
        return BadRequest(compiled.error);
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
      return BadRequest(wrong);
    }
    let stored = edited;
    if (edited.kind == "every") {
      let ahead = nextFire(edited, Date.now() as number);
      if (!ahead.ok) {
        return BadRequest(ahead.error);
      }
      stored = withNextAt(edited, ahead.at);
    }

    let written = persist(this.db, tasksMapping(), JSON.stringify(stored));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(findById(this.db, tasksMapping(), stored.id));
  }

  @Post("/:id/run-now")
  runNow(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("task " + id);
    }
    let now = stamp();
    executeWith(this.db,
      "UPDATE scheduled_tasks SET next_at = " + this.db.placeholder
      + ", running_since = '', enabled = true, updated_at = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [now, now, mine.id]);
    return Accepted(findById(this.db, tasksMapping(), mine.id));
  }

  @Delete("/:id")
  remove(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("task " + id);
    }
    let gone = deleteById(this.db, tasksMapping(), mine.id);
    if (!gone.ok) {
      return BadRequest(gone.error);
    }
    return NoContent();
  }

  private owned(req: Request): TaskRow {
    let document = findById(this.db, tasksMapping(), param(req, "id"));
    if (document == "") {
      return emptyTask();
    }
    let row: TaskRow = JSON.parse<TaskRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) {
      return emptyTask();
    }
    return row;
  }
}
