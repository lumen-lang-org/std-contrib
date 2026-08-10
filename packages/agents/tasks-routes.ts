// The /tasks routes.

import { Db } from "../plume/driver.ts";
import { deleteById, executeWith, existsById, findById, persist, placeholderAt } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, accepted, badRequest, created, noContent, notFound, ok, param } from "../rest/server.ts";
import { askedChoice, callerTags, choiceProblem, guestTag, stamp } from "./api-core.ts";
import { holdsOwner, owningTag } from "./owner.ts";
import { jsonFlag, jsonText } from "./scan.ts";
import { agentsMapping } from "./schema.ts";
import { MAX_PER_OWNER, TaskRow, compile, emptyTask, enabledCount, isOnce, nextFire, onceInstant, refuse, stampMs, tasksMapping, tasksOf, withNextAt } from "./tasks.ts";

// Things that run without anybody asking.
//
// The rows only. Nothing here fires a task: `scheduler.ts` does, as a separate
// process on a timer, for the reasons tasks.ts records. That is why even
// "run now" is a write — it moves the task's next firing to now and lets the
// runner pick it up — rather than a second path into `runAgent`. One firing
// path means one place where a claim, a failure count and a transcript are
// written, and no chance of the two drifting apart.
@controller("/tasks")
export class TaskApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  // This caller's tasks, soonest first.
  //
  // Scoped by owner and not merely filtered in the console: a task carries an
  // instruction that runs against somebody's connectors on their schedule, and
  // a list that leaked would be a list of what a stranger has automated.
  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(tasksOf(this.db, owningTag(tags)));
  }

  // Create one. The words a person typed arrive as `schedule`; the cron
  // expression is compiled here and never sent by a client — a client that
  // could send its own expression could schedule a task per second, and a
  // client that could send its own `nextAt` could schedule one in the past and
  // have it fire on every tick forever.
  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    // Nobody unnamed may schedule. A guest already runs under a daily cap, and
    // a task is a standing instruction — a scheduler for callers nobody can
    // name is an open tap on a provider bill that nobody can turn off either.
    //
    // Two shapes of "not signed in" and both are refused: a guest carries
    // `guest:<hex>`, while a signed-out visitor behind a trusted proxy carries
    // `[""]`, the unowned bucket. The first version of this line tested only
    // the second and so refused the unowned bucket while waving guests
    // through, which is precisely backwards.
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes a task yours to run");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"agentId\":\"a1\",\"instruction\":\"...\",\"schedule\":\"every weekday at 08:00\"}");
    }

    let agentId = jsonText(req.body, "agentId");
    if (!existsById(this.db, agentsMapping(), agentId)) { return badRequest("no agent " + agentId); }
    let chosen = askedChoice(req.body);
    let refusedChoice = choiceProblem(this.db, chosen);
    if (refusedChoice != "") { return badRequest(refusedChoice); }

    if (enabledCount(this.db, owner) >= MAX_PER_OWNER) {
      return badRequest("that is " + `${MAX_PER_OWNER}` + " tasks already — pause one before adding another");
    }

    // "every ..." compiles; a one-off carries the instant instead. The instant
    // comes from the client because the wall-clock intent lives where the
    // calendar is, and it is checked here because a time in the past is a task
    // that fires on the next tick and every tick after it.
    let said = jsonText(req.body, "schedule");
    let zone = jsonText(req.body, "tz");
    let kind = said == "" || isOnce(said) ? "once" : "every";
    let expr = "";
    let at = "";
    if (kind == "every") {
      let compiled = compile(said);
      if (!compiled.ok) { return badRequest(compiled.error); }
      expr = compiled.expr;
    } else if (isOnce(said)) {
      // A date said in words rather than an instant computed by a client.
      // Same grammar the task tools use, resolved server-side for the same
      // reason cron is: a browser that worked out "2026-08-06 09:00 in
      // Europe/Paris" itself would be wrong twice a year and believed anyway.
      let once = onceInstant(said, zone == "" ? "UTC" : zone, Date.now() as number);
      if (!once.ok) { return badRequest(once.error); }
      at = once.at;
    } else {
      at = jsonText(req.body, "at");
      if (stampMs(at) <= (Date.now() as number)) {
        return badRequest("a one-off task needs an instant in the future: {\"at\":\"<epoch ms>\"}");
      }
    }

    let now = stamp();
    let row: TaskRow = {
      id: crypto.randomUUID(),
      owner: owner,
      agentId: agentId,
      modelChoiceId: chosen,
      title: jsonText(req.body, "title"),
      instruction: jsonText(req.body, "instruction"),
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
    if (wrong != "") { return badRequest(wrong); }

    // The first firing, computed here and not by whoever asked.
    let ready = row;
    if (kind == "every") {
      let first = nextFire(row, Date.now() as number);
      if (!first.ok) { return badRequest(first.error); }
      ready = withNextAt(row, first.at);
    }

    let written = persist(this.db, tasksMapping(), JSON.stringify(ready));
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, tasksMapping(), ready.id));
  }

  // Pause, resume, retitle, reschedule. One PUT of the whole row, as agents
  // do — and the schedule is recompiled rather than trusted, for the same
  // reason it is compiled on the way in.
  @put("/:id")
  update(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("task " + param(req, "id")); }
    if (req.body == "") { return badRequest("a body is required"); }

    let said = jsonText(req.body, "schedule");
    let expr = mine.cronExpr;
    let kind = mine.kind;
    let when = mine.nextAt;
    if (said != "" && isOnce(said)) {
      let once = onceInstant(said, mine.tz == "" ? "UTC" : mine.tz, Date.now() as number);
      if (!once.ok) { return badRequest(once.error); }
      // A repeating task rescheduled onto a date becomes a one-off, which is
      // what "actually, just do it once, on Thursday" means.
      kind = "once";
      expr = "";
      when = once.at;
    } else if (said != "") {
      let compiled = compile(said);
      if (!compiled.ok) { return badRequest(compiled.error); }
      kind = "every";
      expr = compiled.expr;
    }
    let title = jsonText(req.body, "title");
    let instruction = jsonText(req.body, "instruction");
    let tz = jsonText(req.body, "tz");
    let on = jsonFlag(req.body, "enabled", mine.enabled);

    let edited: TaskRow = {
      id: mine.id, owner: mine.owner, agentId: mine.agentId,
      modelChoiceId: mine.modelChoiceId,
      title: title == "" ? mine.title : title,
      instruction: instruction == "" ? mine.instruction : instruction,
      kind: kind, cronExpr: expr,
      tz: tz == "" ? mine.tz : tz,
      nextAt: when, runningSince: mine.runningSince,
      enabled: on,
      // Switching a paused task back on is what clears its failures. Leaving
      // them would pause it again on the next failure rather than the fifth,
      // which reads as "it will not stay on" to the person who just fixed it.
      failures: on && !mine.enabled ? 0 : mine.failures,
      pausedReason: on ? "" : mine.pausedReason,
      lastRunAt: mine.lastRunAt, lastRunId: mine.lastRunId,
      lastStatus: mine.lastStatus, lastError: mine.lastError,
      runCount: mine.runCount, createdAt: mine.createdAt, updatedAt: stamp(),
    };
    let wrong = refuse(edited);
    if (wrong != "") { return badRequest(wrong); }
    let stored = edited;
    if (edited.kind == "every") {
      let ahead = nextFire(edited, Date.now() as number);
      if (!ahead.ok) { return badRequest(ahead.error); }
      stored = withNextAt(edited, ahead.at);
    }

    let written = persist(this.db, tasksMapping(), JSON.stringify(stored));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, tasksMapping(), stored.id));
  }

  // Fire it on the next tick.
  //
  // A write, not a run: moving `next_at` to now is how this door reaches the
  // one firing path instead of building a second one. Whoever asked waits up
  // to a tick, which is the price of there being exactly one place a task can
  // be claimed, counted and recorded.
  @post("/:id/run-now")
  runNow(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("task " + param(req, "id")); }
    let now = stamp();
    executeWith(this.db,
      "UPDATE scheduled_tasks SET next_at = " + this.db.placeholder
      + ", running_since = '', enabled = true, updated_at = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [now, now, mine.id]);
    return accepted(findById(this.db, tasksMapping(), mine.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("task " + param(req, "id")); }
    let gone = deleteById(this.db, tasksMapping(), mine.id);
    if (!gone.ok) { return badRequest(gone.error); }
    return noContent();
  }

  // The row this caller is allowed to touch, or an empty one. Every write goes
  // through here rather than checking the owner in four places — three of them
  // would be right and the fourth would be the interesting one.
  private owned(req: Request): TaskRow {
    let document = findById(this.db, tasksMapping(), param(req, "id"));
    if (document == "") { return emptyTask(); }
    let row: TaskRow = JSON.parse<TaskRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) { return emptyTask(); }
    return row;
  }
}
