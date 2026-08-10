import { Db } from "../../../plume/driver.ts";
import { deleteById, executeWith, existsById, findById, persist, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, Created, NoContent, NotFound, Ok, param } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { forgetCredential, storeCredential } from "../../credentials.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { TriggerBotRow, botsOf, emptyBot, queuedFor, triggerBotsMapping } from "../../triggers.ts";
import { workflowsMapping } from "../../workflow-store.ts";
import { ownedOrEmpty, roleAtLeast } from "../../guards.ts";

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
@bindings
export class TriggerApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(req: Request): Reply {
    let tags = callerTags(req);
    return Ok(botsOf(this.db, owningTag(tags)));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a bot yours to keep"))
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (req.body == "") {
      return BadRequest("a body is required: {\"name\":\"...\",\"workflowId\":\"...\",\"token\":\"...\"}");
    }
    let ask: TriggerCreateAsk = JSON.parse<TriggerCreateAsk>(req.body);
    let workflowId = ask.workflowId ?? "";
    if (!existsById(this.db, workflowsMapping(), workflowId)) {
      return BadRequest("no workflow " + workflowId);
    }
    let token = ask.token ?? "";
    if (token.trim() == "") {
      return BadRequest("a bot needs its token from BotFather");
    }

    let id = crypto.randomUUID();
    let ref = "telegram:" + id;
    let refused = storeCredential(this.db, { provider: ref, apiKey: token, masterKey: this.master, now: stamp() });
    if (refused != "") {
      return BadRequest(refused);
    }

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
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, triggerBotsMapping(), id));
  }

  @Get("/:id")
  one(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("bot " + id);
    }
    return Ok(JSON.stringify(mine));
  }

  @Put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("bot " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    let ask: TriggerChangeAsk = JSON.parse<TriggerChangeAsk>(req.body);
    let workflowId = ask.workflowId ?? "";
    if (workflowId != "" && !existsById(this.db, workflowsMapping(), workflowId)) {
      return BadRequest("no workflow " + workflowId);
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
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(findById(this.db, triggerBotsMapping(), edited.id));
  }

  @Post("/:id/test")
  test(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("bot " + id);
    }
    let minutes: int = 5;
    if (req.body != "") {
      let ask: TriggerTestAsk = JSON.parse<TriggerTestAsk>(req.body);
      minutes = ask.minutes ?? 5;
    }
    if (minutes < 0) {
      minutes = 0;
    }
    if (minutes > 30) {
      minutes = 30;
    }
    let until = minutes == 0 ? "" : `${(Date.now() as i64) + (minutes as i64) * 60000}`;
    executeWith(this.db,
      "UPDATE trigger_bots SET draft_until = " + this.db.placeholder
      + ", updated_at = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [until, stamp(), mine.id]);
    return Ok(findById(this.db, triggerBotsMapping(), mine.id));
  }

  @Get("/:id/queue")
  queue(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("bot " + id);
    }
    return Ok(queuedFor(this.db, mine.id));
  }

  @Delete("/:id")
  remove(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("bot " + id);
    }
    forgetCredential(this.db, mine.credentialRef);
    executeWith(this.db, "DELETE FROM trigger_inbox WHERE bot_id = " + this.db.placeholder, [mine.id]);
    let gone = deleteById(this.db, triggerBotsMapping(), mine.id);
    if (!gone.ok) {
      return BadRequest(gone.error);
    }
    return NoContent();
  }

  private owned(req: Request): TriggerBotRow {
    let document = findById(this.db, triggerBotsMapping(), param(req, "id"));
    if (document == "") {
      return emptyBot();
    }
    let row: TriggerBotRow = JSON.parse<TriggerBotRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) {
      return emptyBot();
    }
    return row;
  }
}
