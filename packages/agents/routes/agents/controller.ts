import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, deleteById, executeWith, existsById, findById, listOrdered, persist, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Bound } from "../../../rest/plan.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, reply } from "../../../rest/server.ts";
import { flush, traceId, tracerWithMoreSpans, tracing } from "../../../tracing/tracing.ts";
import { GUEST_DAILY_RUNS, callerTags, guestQuotaJson, guestTag } from "../../api-core.ts";
import { AgentRetrievalRow, agentRetrievalMapping, agentScopes, embeddingModel, grantScope, revokeScope } from "../../knowledge.ts";
import { owningTag } from "../../owner.ts";
import { createProblem, jsonId } from "../../payload.ts";
import { runAgentTraced } from "../../run.ts";
import { recordRun, runsOf } from "../../runlog.ts";
import { AgentRow, ModelRow, agentsFull, agentsMapping, mcpServersMapping, modelConfigsMapping, modelsMapping, promptsMapping, skillsMapping } from "../../schema.ts";
import { tracerFor } from "../../trace.ts";
import { nextUtcMidnightIso, runsSince, secondsToUtcMidnight, utcDayStartText } from "../../usage.ts";
import { AgentWebRagRow, agentWebRagMapping, webRagFor } from "../../webrag.ts";
import { ChildLink, RetrievalSetup, RunBody, ScopeGrant, ServerLink, SkillLink } from "./types.ts";

function agentNameProblem(name: string): string {
  if (name.trim() == "") { return "an agent needs a name"; }
  if (name.length > 48) { return "an agent name is at most 48 characters"; }
  return "";
}

function scopesReply(db: Db, agentId: string): Reply {
  let granted = agentScopes(db, agentId);
  let out = "[";
  let i: int = 0;
  while (i < granted.length) {
    if (i > 0) { out = out + ","; }
    out = out + JSON.stringify(granted[i]);
    i = i + 1;
  }
  return ok(out + "]");
}

export function forgetAgent(db: Db, agentId: string): void {
  executeWith(db, "DELETE FROM agent_sub_agents WHERE parent_id = " + db.placeholder, [agentId]);
  executeWith(db, "DELETE FROM agent_sub_agents WHERE child_id = " + db.placeholder, [agentId]);
  executeWith(db, "DELETE FROM agent_mcp_servers WHERE agent_id = " + db.placeholder, [agentId]);
  executeWith(db, "DELETE FROM agent_scopes WHERE agent_id = " + db.placeholder, [agentId]);
  deleteById(db, agentRetrievalMapping(), agentId);
  deleteById(db, agentsMapping(), agentId);
}

@controller("/agents")
@bindings
export class AgentApi {
  db: Db;
  flat: DbRepository;
  full: DbRepository;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.flat = agentsMapping();
    this.full = agentsFull(db);
    this.master = master;
  }

  @get("/")
  list(@RequestParam("enabled", "") enabled: string): Reply {
    let keys: DbOrder[] = [{ column: "agent_name" }];
    if (enabled == "true") {
      return ok(listOrdered(this.db, this.full, { where: "enabled = " + this.db.placeholder, args: ["1"], order: keys }));
    }
    return ok(listOrdered(this.db, this.full, { order: keys }));
  }

  @get("/:id")
  find(@PathVariable("id") id: string): Reply {
    let document = findById(this.db, this.full, id);
    if (document == "") { return notFound("agent " + id); }
    return ok(document);
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, this.flat, req.body);
    if (problem != "") { return badRequest(problem); }
    let fresh: AgentRow = JSON.parse<AgentRow>(req.body);
    let named = agentNameProblem(fresh.agentName);
    if (named != "") { return badRequest(named); }
    if (!existsById(this.db, modelConfigsMapping(this.db), fresh.modelConfigId)) {
      return badRequest("no model config " + fresh.modelConfigId);
    }
    if (!existsById(this.db, promptsMapping(), fresh.promptId)) {
      return badRequest("no prompt " + fresh.promptId);
    }
    let written = persist(this.db, this.flat, req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, this.full, jsonId(req.body)));
  }

  @put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let row: AgentRow = JSON.parse<AgentRow>(req.body);
    if (row.id != id) {
      return badRequest("the id in the body must match the path");
    }
    if (!existsById(this.db, modelConfigsMapping(this.db), row.modelConfigId)) {
      return badRequest("no model config " + row.modelConfigId);
    }
    if (!existsById(this.db, promptsMapping(), row.promptId)) {
      return badRequest("no prompt " + row.promptId);
    }
    let named = agentNameProblem(row.agentName);
    if (named != "") { return badRequest(named); }

    if (row.isDefault) {
      executeWith(this.db, "UPDATE agents SET is_default = " + this.db.placeholder, ["0"]);
    }
    let written = persist(this.db, this.flat, req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, this.full, id));
  }

  @post("/:id/servers")
  addServer(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    let link: ServerLink = JSON.parse<ServerLink>(req.body);
    if (!existsById(this.db, mcpServersMapping(), link.serverId)) {
      return badRequest("no server " + link.serverId);
    }
    executeWith(this.db, "INSERT INTO agent_mcp_servers (agent_id, server_id) VALUES ("
      + this.db.placeholder + ", " + placeholderAt(this.db, 2) + ")", [id, link.serverId]);
    return ok(findById(this.db, this.full, id));
  }

  @post("/:id/sub-agents")
  addChild(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    let link: ChildLink = JSON.parse<ChildLink>(req.body);
    if (!existsById(this.db, this.flat, link.childId)) {
      return badRequest("no agent " + link.childId);
    }
    if (link.childId == id) {
      return badRequest("an agent cannot be its own sub-agent");
    }
    executeWith(this.db, "INSERT INTO agent_sub_agents (parent_id, child_id) VALUES ("
      + this.db.placeholder + ", " + placeholderAt(this.db, 2) + ")", [id, link.childId]);
    return ok(findById(this.db, this.full, id));
  }

  @del("/:id/sub-agents/:childId")
  removeChild(@PathVariable("id") id: string, @PathVariable("childId") childId: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    executeWith(this.db, "DELETE FROM agent_sub_agents WHERE parent_id = " + this.db.placeholder
      + " AND child_id = " + placeholderAt(this.db, 2), [id, childId]);
    return ok(findById(this.db, this.full, id));
  }

  @del("/:id/servers/:serverId")
  removeServer(@PathVariable("id") id: string, @PathVariable("serverId") serverId: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    executeWith(this.db, "DELETE FROM agent_mcp_servers WHERE agent_id = " + this.db.placeholder
      + " AND server_id = " + placeholderAt(this.db, 2), [id, serverId]);
    return ok(findById(this.db, this.full, id));
  }

  @post("/:id/skills")
  addSkill(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    let link: SkillLink = JSON.parse<SkillLink>(req.body);
    if (!existsById(this.db, skillsMapping(), link.skillId)) {
      return badRequest("no skill " + link.skillId);
    }
    executeWith(this.db, "INSERT INTO agent_skills (agent_id, skill_id) VALUES ("
      + this.db.placeholder + ", " + placeholderAt(this.db, 2) + ")", [id, link.skillId]);
    return ok(findById(this.db, this.full, id));
  }

  @del("/:id/skills/:skillId")
  removeSkill(@PathVariable("id") id: string, @PathVariable("skillId") skillId: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    executeWith(this.db, "DELETE FROM agent_skills WHERE agent_id = " + this.db.placeholder
      + " AND skill_id = " + placeholderAt(this.db, 2), [id, skillId]);
    return ok(findById(this.db, this.full, id));
  }

  @get("/:id/scopes")
  scopes(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    return scopesReply(this.db, id);
  }

  @post("/:id/scopes")
  grant(@PathVariable("id") id: string, @Valid @RequestBody body: ScopeGrant): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    let problem = grantScope(this.db, id, body.scope);
    if (problem != "") { return badRequest(problem); }
    return scopesReply(this.db, id);
  }

  @del("/:id/scopes/:scope")
  revoke(@PathVariable("id") id: string, @PathVariable("scope") scope: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    let problem = revokeScope(this.db, id, scope.replaceAll("~", "/"));
    if (problem != "") { return badRequest(problem); }
    return this.scopes(id);
  }

  @put("/:id/retrieval")
  setRetrieval(@PathVariable("id") id: string, @Valid @RequestBody body: RetrievalSetup): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    if (embeddingModel(this.db, body.embeddingModelId).id == "") {
      return badRequest("no usable embedding model " + body.embeddingModelId);
    }
    let row: AgentRetrievalRow = {
      agentId: id,
      embeddingModelId: body.embeddingModelId,
      topK: body.topK,
      maxDistance: body.maxDistance,
      enabled: body.enabled,
    };
    let written = persist(this.db, agentRetrievalMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, agentRetrievalMapping(), id));
  }

  @get("/:id/web-rag")
  webRag(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    return ok(JSON.stringify(webRagFor(this.db, id)));
  }

  @put("/:id/web-rag")
  setWebRag(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: AgentWebRagRow = JSON.parse<AgentWebRagRow>(req.body);
    if (body.topK <= 0 || body.topK > 20) { return badRequest("topK must be between 1 and 20 — the index caps at 20"); }
    if (body.maxChars < 500 || body.maxChars > 100000) { return badRequest("maxChars must be between 500 and 100000"); }
    if (body.queryMode != "verbatim" && body.queryMode != "generated") {
      return badRequest("queryMode must be verbatim or generated");
    }
    if (body.queryMode == "generated") {
      let modelDoc = findById(this.db, modelsMapping(), body.queryModelId);
      if (modelDoc == "") { return badRequest("queryMode generated needs an existing chat model as queryModelId"); }
      let m: ModelRow = JSON.parse<ModelRow>(modelDoc);
      if (m.kind != "chat") { return badRequest(m.label + " is not a chat model"); }
    }
    let row: AgentWebRagRow = {
      agentId: id,
      enabled: body.enabled,
      topK: body.topK,
      maxChars: body.maxChars,
      queryMode: body.queryMode,
      queryModelId: body.queryModelId,
    };
    let written = persist(this.db, agentWebRagMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, agentWebRagMapping(), id));
  }

  @post("/:id/run")
  run(req: Request, @PathVariable("id") id: string): Reply {
    if (req.body == "") { return badRequest("a body is required: {\"text\":\"...\"}"); }
    let body: RunBody = JSON.parse<RunBody>(req.body);
    if (body.text == "") { return badRequest("nothing to ask: \"text\" is empty"); }
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }

    let guest = guestTag(callerTags(req));
    if (guest != "") {
      let atGate = Date.now();
      let used = runsSince(this.db, guest, utcDayStartText(atGate));
      if (used >= GUEST_DAILY_RUNS) {
        let refusal = reply(429, guestQuotaJson(used, nextUtcMidnightIso(atGate)), "application/json");
        refusal.headers.set("retry-after", `${secondsToUtcMidnight(atGate)}`);
        return refusal;
      }
    }

    let tracer = tracerFor(this.db, this.master);
    let answered = runAgentTraced(this.db, id, body.text, this.master, tracer);

    let runId = recordRun(this.db, {
      agentId: id, threadId: "", owner: owningTag(callerTags(req)),
      question: body.text, run: answered, modelChoiceId: "", routeNote: "",
    });

    let traced = "";
    if (tracing(tracer) && answered.spans.length > 0) {
      let sent = flush(tracerWithMoreSpans(tracer, answered.spans));
      if (sent.ok) { traced = traceId(tracer); }
    }

    let out = "{\"runId\":" + JSON.stringify(runId)
      + ",\"ok\":" + `${answered.ok}`
      + ",\"text\":" + JSON.stringify(answered.text)
      + ",\"agentName\":" + JSON.stringify(answered.agentName)
      + ",\"promptVersion\":" + `${answered.promptVersion}`
      + ",\"modelApiName\":" + JSON.stringify(answered.modelApiName)
      + ",\"stopReason\":" + JSON.stringify(answered.stopReason)
      + ",\"toolCalls\":" + `${answered.steps.length}`
      + ",\"traceId\":" + JSON.stringify(traced)
      + ",\"error\":" + JSON.stringify(answered.error) + "}";
    if (!answered.ok && answered.agentName == "") {
      return badRequest(answered.error);
    }
    return ok(out);
  }

  @get("/:id/runs")
  runs(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    return ok(runsOf(this.db, id, callerTags(req), 50));
  }

  @del("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, this.flat, id)) {
      return notFound("agent " + id);
    }
    forgetAgent(this.db, id);
    return noContent();
  }
}
