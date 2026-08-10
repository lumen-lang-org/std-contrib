import { Db } from "../../../plume/driver.ts";
import { deleteById, executeWith, existsById, findById, persist, placeholderAt } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { forgetCredential, storeCredential } from "../../credentials.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { TriggerBotRow, botsOf, emptyBot, queuedFor, triggerBotsMapping } from "../../triggers.ts";
import { workflowsMapping } from "../../workflow-store.ts";

export type TriggerCreateAsk = {
  name?: string,
  workflowId?: string,
  token?: string,
};

export type TriggerChangeAsk = {
  name?: string,
  workflowId?: string,
  enabled?: bool,
};

export type TriggerTestAsk = {
  minutes?: int,
};

@controller("/triggers")
export class TriggerApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(botsOf(this.db, owningTag(tags)));
  }

  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes a bot yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"workflowId\":\"...\",\"token\":\"...\"}");
    }
    let ask: TriggerCreateAsk = JSON.parse<TriggerCreateAsk>(req.body);
    let workflowId = ask.workflowId ?? "";
    if (!existsById(this.db, workflowsMapping(), workflowId)) { return badRequest("no workflow " + workflowId); }
    let token = ask.token ?? "";
    if (token.trim() == "") { return badRequest("a bot needs its token from BotFather"); }

    let id = crypto.randomUUID();
    let ref = "telegram:" + id;
    let refused = storeCredential(this.db, { provider: ref, apiKey: token, masterKey: this.master, now: stamp() });
    if (refused != "") { return badRequest(refused); }

    let now = stamp();
    let row: TriggerBotRow = {
      id: id, owner: owner, kind: "telegram",
      name: ask.name ?? "", workflowId: workflowId,
      credentialRef: ref, offset: "0", leaseBy: "", leaseUntil: "",
      enabled: false,
      runsToday: 0, dayStartedAt: now, lastAt: "", lastError: "",
      draftUntil: "", createdAt: now, updatedAt: now,
    };
    let written = persist(this.db, triggerBotsMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, triggerBotsMapping(), id));
  }

  @get("/:id")
  one(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("bot " + param(req, "id")); }
    return ok(JSON.stringify(mine));
  }

  @put("/:id")
  update(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("bot " + param(req, "id")); }
    if (req.body == "") { return badRequest("a body is required"); }
    let ask: TriggerChangeAsk = JSON.parse<TriggerChangeAsk>(req.body);
    let workflowId = ask.workflowId ?? "";
    if (workflowId != "" && !existsById(this.db, workflowsMapping(), workflowId)) {
      return badRequest("no workflow " + workflowId);
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
    let written = persist(this.db, triggerBotsMapping(), JSON.stringify(edited));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, triggerBotsMapping(), edited.id));
  }

  @post("/:id/test")
  test(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("bot " + param(req, "id")); }
    let minutes: int = 5;
    if (req.body != "") {
      let ask: TriggerTestAsk = JSON.parse<TriggerTestAsk>(req.body);
      minutes = ask.minutes ?? 5;
    }
    if (minutes < 0) { minutes = 0; }
    if (minutes > 30) { minutes = 30; }
    let until = minutes == 0 ? "" : `${(Date.now() as i64) + (minutes as i64) * 60000}`;
    executeWith(this.db,
      "UPDATE trigger_bots SET draft_until = " + this.db.placeholder
      + ", updated_at = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [until, stamp(), mine.id]);
    return ok(findById(this.db, triggerBotsMapping(), mine.id));
  }

  @get("/:id/queue")
  queue(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("bot " + param(req, "id")); }
    return ok(queuedFor(this.db, mine.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("bot " + param(req, "id")); }
    forgetCredential(this.db, mine.credentialRef);
    executeWith(this.db, "DELETE FROM trigger_inbox WHERE bot_id = " + this.db.placeholder, [mine.id]);
    let gone = deleteById(this.db, triggerBotsMapping(), mine.id);
    if (!gone.ok) { return badRequest(gone.error); }
    return noContent();
  }

  private owned(req: Request): TriggerBotRow {
    let document = findById(this.db, triggerBotsMapping(), param(req, "id"));
    if (document == "") { return emptyBot(); }
    let row: TriggerBotRow = JSON.parse<TriggerBotRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) { return emptyBot(); }
    return row;
  }
}
