import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, badRequest, created, noContent, notFound, ok, okJson, param, passes, reply, stops } from "../../../rest/server.ts";
import { GUEST_DAILY_RUNS, callerTags, guestQuotaJson, guestTag } from "../../api-core.ts";
import { owningTag } from "../../owner.ts";
import { nextUtcMidnightIso, secondsToUtcMidnight } from "../../usage.ts";
import { AgentBody, ChildLink, RetrievalSetup, RunBody, ScopeGrant, ServerLink, SkillLink, WebRagSetup, Written } from "./agents.dto.ts";
import { AgentService } from "./agents.service.ts";
import { scopeFromPath } from "./agents.utils.ts";

@controller("/agents")
@bindings
export class AgentApi {
  agents: AgentService;

  constructor(db: Db, master: string) {
    this.agents = new AgentService(db, master);
  }

  // The check fifteen handlers used to open with. As a guard it runs before the
  // handler is entered, so a missing agent is one sentence in one place.
  theAgent(req: Request): Guarded {
    let id = param(req, "id");
    if (!this.agents.exists(id)) { return stops(notFound("agent " + id)); }
    return passes();
  }

  // A guest gets a fixed number of runs a day, and is told when it resets.
  guestRuns(req: Request): Guarded {
    let guest = guestTag(callerTags(req));
    if (guest == "") { return passes(); }
    let atGate = Date.now();
    let used = this.agents.runsToday(guest, atGate);
    if (used < GUEST_DAILY_RUNS) { return passes(); }
    let refusal = reply(429, guestQuotaJson(used, nextUtcMidnightIso(atGate)), "application/json");
    refusal.headers.set("retry-after", `${secondsToUtcMidnight(atGate)}`);
    return stops(refusal);
  }

  // Everything the service refuses is a 400: it answers with a sentence, and
  // choosing the status for it is this layer's job, not its.
  answered(w: Written): Reply {
    if (w.fault != "") { return badRequest(w.fault); }
    return ok(w.document);
  }

  @Get("/")
  list(@RequestParam("enabled", "") enabled: string): Reply {
    return ok(this.agents.listing(enabled == "true"));
  }

  @Get("/:id")
  @Guard(theAgent)
  find(@PathVariable("id") id: string): Reply {
    return ok(this.agents.one(id));
  }

  @Post("/")
  create(@Valid @RequestBody body: AgentBody): Reply {
    let made = this.agents.create(body);
    if (made.fault != "") { return badRequest(made.fault); }
    return created(made.document);
  }

  @Put("/:id")
  @Guard(theAgent)
  update(@PathVariable("id") id: string, @Valid @RequestBody body: AgentBody): Reply {
    return this.answered(this.agents.update(id, body));
  }

  @Post("/:id/servers")
  @Guard(theAgent)
  addServer(@PathVariable("id") id: string, @RequestBody link: ServerLink): Reply {
    return this.answered(this.agents.attachServer(id, link.serverId));
  }

  @Post("/:id/sub-agents")
  @Guard(theAgent)
  addChild(@PathVariable("id") id: string, @RequestBody link: ChildLink): Reply {
    return this.answered(this.agents.attachChild(id, link.childId));
  }

  @Delete("/:id/sub-agents/:childId")
  @Guard(theAgent)
  removeChild(@PathVariable("id") id: string, @PathVariable("childId") childId: string): Reply {
    return this.answered(this.agents.detachChild(id, childId));
  }

  @Delete("/:id/servers/:serverId")
  @Guard(theAgent)
  removeServer(@PathVariable("id") id: string, @PathVariable("serverId") serverId: string): Reply {
    return this.answered(this.agents.detachServer(id, serverId));
  }

  @Post("/:id/skills")
  @Guard(theAgent)
  addSkill(@PathVariable("id") id: string, @RequestBody link: SkillLink): Reply {
    return this.answered(this.agents.attachSkill(id, link.skillId));
  }

  @Delete("/:id/skills/:skillId")
  @Guard(theAgent)
  removeSkill(@PathVariable("id") id: string, @PathVariable("skillId") skillId: string): Reply {
    return this.answered(this.agents.detachSkill(id, skillId));
  }

  @Get("/:id/scopes")
  @Guard(theAgent)
  scopes(@PathVariable("id") id: string): Reply {
    return okJson(this.agents.scopes(id));
  }

  @Post("/:id/scopes")
  @Guard(theAgent)
  grant(@PathVariable("id") id: string, @Valid @RequestBody body: ScopeGrant): Reply {
    let fault = this.agents.grant(id, body.scope);
    if (fault != "") { return badRequest(fault); }
    return okJson(this.agents.scopes(id));
  }

  @Delete("/:id/scopes/:scope")
  @Guard(theAgent)
  revoke(@PathVariable("id") id: string, @PathVariable("scope") scope: string): Reply {
    let fault = this.agents.revoke(id, scopeFromPath(scope));
    if (fault != "") { return badRequest(fault); }
    return okJson(this.agents.scopes(id));
  }

  @Put("/:id/retrieval")
  @Guard(theAgent)
  setRetrieval(@PathVariable("id") id: string, @Valid @RequestBody body: RetrievalSetup): Reply {
    return this.answered(this.agents.setRetrieval(id, body));
  }

  @Get("/:id/web-rag")
  @Guard(theAgent)
  webRag(@PathVariable("id") id: string): Reply {
    return okJson(this.agents.webRag(id));
  }

  @Put("/:id/web-rag")
  @Guard(theAgent)
  setWebRag(@PathVariable("id") id: string, @Valid @RequestBody body: WebRagSetup): Reply {
    return this.answered(this.agents.setWebRag(id, body));
  }

  @Post("/:id/run")
  @Guard(guestRuns)
  @Guard(theAgent)
  run(req: Request, @PathVariable("id") id: string, @RequestBody body: RunBody): Reply {
    if (body.text == "") { return badRequest("nothing to ask: \"text\" is empty"); }
    let answered = this.agents.run(id, body.text, owningTag(callerTags(req)));
    if (!answered.ok && answered.agentName == "") {
      return badRequest(answered.error);
    }
    return okJson(answered);
  }

  @Get("/:id/runs")
  @Guard(theAgent)
  runs(req: Request, @PathVariable("id") id: string): Reply {
    return ok(this.agents.runs(id, callerTags(req), 50));
  }

  @Delete("/:id")
  @Guard(theAgent)
  remove(@PathVariable("id") id: string): Reply {
    this.agents.forget(id);
    return noContent();
  }
}
