// The /triggers routes.

import { Db } from "../plume/driver.ts";
import { deleteById, executeWith, existsById, findById, persist, placeholderAt } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param } from "../rest/server.ts";
import { callerTags, guestTag, stamp } from "./api-core.ts";
import { forgetCredential, masterKey, storeCredential } from "./credentials.ts";
import { holdsOwner, owningTag } from "./owner.ts";
import { jsonFlag, jsonRaw, jsonText } from "./scan.ts";
import { TriggerBotRow, botsOf, emptyBot, queuedFor, triggerBotsMapping } from "./triggers.ts";
import { workflowsMapping } from "./workflow-store.ts";

// A workflow started by something arriving rather than by a clock: for now, a
// Telegram bot (triggers.ts).
//
// This door records the bot and holds its token; it never polls. The poll is
// a separate process — `joule-trigger@<id>`, one per bot — because getUpdates
// blocks for 25 seconds and a request thread that did that would be a request
// thread not serving requests. So creating a bot here is half of switching
// one on; the other half is systemd, and the reply says so rather than
// leaving somebody watching a bot that answers nothing.
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

  // The token arrives once and is never readable again — credentials.ts's
  // rule, and the reason the row keeps a `credentialRef` rather than a token.
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
    let workflowId = jsonText(req.body, "workflowId");
    if (!existsById(this.db, workflowsMapping(), workflowId)) { return badRequest("no workflow " + workflowId); }
    let token = jsonText(req.body, "token");
    if (token.trim() == "") { return badRequest("a bot needs its token from BotFather"); }

    let id = crypto.randomUUID();
    let ref = "telegram:" + id;
    // A string, and "" is success — credentials.ts answers with the problem
    // rather than a record.
    let refused = storeCredential(this.db, { provider: ref, apiKey: token, masterKey: this.master, now: stamp() });
    if (refused != "") { return badRequest(refused); }

    let now = stamp();
    let row: TriggerBotRow = {
      id: id, owner: owner, kind: "telegram",
      name: jsonText(req.body, "name"), workflowId: workflowId,
      credentialRef: ref, offset: "0", leaseBy: "", leaseUntil: "",
      // Off until somebody starts its poller. A bot switched on with nothing
      // polling it looks broken; a bot switched off looks off.
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

  // Switched on, switched off, renamed, or pointed at another workflow. The
  // token is not editable here: replacing one is deleting the bot and making
  // it again, which is also what BotFather makes you do.
  @put("/:id")
  update(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("bot " + param(req, "id")); }
    if (req.body == "") { return badRequest("a body is required"); }
    let workflowId = jsonText(req.body, "workflowId");
    if (workflowId != "" && !existsById(this.db, workflowsMapping(), workflowId)) {
      return badRequest("no workflow " + workflowId);
    }
    let name = jsonText(req.body, "name");
    let edited: TriggerBotRow = {
      id: mine.id, owner: mine.owner, kind: mine.kind,
      name: name == "" ? mine.name : name,
      workflowId: workflowId == "" ? mine.workflowId : workflowId,
      credentialRef: mine.credentialRef, offset: mine.offset,
      leaseBy: mine.leaseBy, leaseUntil: mine.leaseUntil,
      enabled: jsonFlag(req.body, "enabled", mine.enabled),
      runsToday: mine.runsToday, dayStartedAt: mine.dayStartedAt,
      lastAt: mine.lastAt, lastError: mine.lastError,
      draftUntil: mine.draftUntil ?? "", createdAt: mine.createdAt, updatedAt: stamp(),
    };
    let written = persist(this.db, triggerBotsMapping(), JSON.stringify(edited));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, triggerBotsMapping(), edited.id));
  }

  // Point this bot at the DRAFT for a bounded window — the n8n test button,
  // with n8n's honesty about it: the stream cannot be split, so testing IS
  // prod traffic for the duration, made loud and short instead of hidden.
  // {"minutes": 5} starts one (capped at 30), {"minutes": 0} ends it now.
  // The revert needs no daemon: the window is a timestamp the scheduler
  // compares on every claim, so forgetting it is impossible — it just ends.
  @post("/:id/test")
  test(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("bot " + param(req, "id")); }
    // jsonRaw, not jsonText — a JSON number, the ok/update_id lesson.
    let minutes = parseInt(jsonRaw(req.body, "minutes").trim(), 10) ?? 5;
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

  // What is waiting to be answered. The console shows this beside the bot,
  // because "nothing is happening" and "six messages are queued behind a
  // ceiling" look identical from the chat.
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
    // The token goes with the bot. A credential outliving the row that named
    // it is a secret nothing can ever reach to delete.
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
