// The /agents routes.

import { Db } from "../plume/driver.ts";
import { DbOrder, DbRepository, asc, deleteById, executeWith, existsById, findById, listOrdered, persist, placeholderAt } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem, queryParam, reply } from "../rest/server.ts";
import { flush, traceId, tracerWithMoreSpans, tracing } from "../tracing/tracing.ts";
import { GUEST_DAILY_RUNS, callerTags, guestQuotaJson, guestTag } from "./api-core.ts";
import { AgentRetrievalRow, agentRetrievalMapping, agentScopes, embeddingModel, grantScope, revokeScope } from "./knowledge.ts";
import { owningTag } from "./owner.ts";
import { createProblem, jsonId } from "./payload.ts";
import { runAgentTraced } from "./run.ts";
import { recordRun, runsOf } from "./runlog.ts";
import { AgentRow, ModelRow, agentsFull, agentsMapping, mcpServersMapping, modelConfigsMapping, modelsMapping, promptsMapping, skillsMapping } from "./schema.ts";
import { tracerFor } from "./trace.ts";
import { nextUtcMidnightIso, runsSince, utcDayStartText } from "./usage.ts";
import { AgentWebRagRow, agentWebRagMapping, webRagFor } from "./webrag.ts";

type ServerLink = { serverId: string };

type SkillLink = { skillId: string };

type ChildLink = { childId: string };

// `RunBody` serves `POST /agents/:id/run` only, which takes no `modelChoiceId`
// — it has no conversation and no picker in front of it. There is deliberately
// no record for either thread door: both take an optional `modelChoiceId`, and
// a record type refuses a document carrying a key it does not declare, so they
// read their members instead. See `askedChoice`.
type RunBody = { text: string };

type ScopeGrant = { scope: string };

type RetrievalSetup = { embeddingModelId: string, topK: int, maxDistance: number, enabled: bool };

// Which database, from the environment. AGENTS_PG_HOST set means PostgreSQL —
// which is also what turns the RAG endpoints on, since documents need
// pgvector. Unset means the sqlite file this always used, so nothing changes
// for anyone running it bare.
// An agent with no name sorts first — `GET /agents` orders by agent_name — so
// it becomes the console's default agent and every new conversation opens
// against it, with an empty entry in the picker. The column is NOT NULL but ""
// is not NULL, so nothing caught this.
function agentNameProblem(name: string): string {
  if (name.trim() == "") { return "an agent needs a name"; }
  // The name becomes a tool name when another agent delegates to it, and
  // providers cap those at 64 characters — after this package has already
  // expanded every unusual character to an underscore.
  if (name.length > 48) { return "an agent name is at most 48 characters"; }
  return "";
}

// Delete an agent, its grants, its retrieval row and its links — in both
// directions.
//
// Neither `agent_scopes` nor `agent_retrieval` has a foreign key and neither
// was ever cleaned, so recreating an id started the new agent already granted
// its predecessor's corpus. `agent_sub_agents WHERE child_id` survived too,
// silently re-attaching it to whoever used to delegate to it.
export function forgetAgent(db: Db, agentId: string): void {
  executeWith(db, "DELETE FROM agent_sub_agents WHERE parent_id = " + db.placeholder, [agentId]);
  executeWith(db, "DELETE FROM agent_sub_agents WHERE child_id = " + db.placeholder, [agentId]);
  executeWith(db, "DELETE FROM agent_mcp_servers WHERE agent_id = " + db.placeholder, [agentId]);
  executeWith(db, "DELETE FROM agent_scopes WHERE agent_id = " + db.placeholder, [agentId]);
  deleteById(db, agentRetrievalMapping(), agentId);
  deleteById(db, agentsMapping(), agentId);
}

@controller("/agents")
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
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("agent_name")];
    if (queryParam(req, "enabled", "") == "true") {
      return ok(listOrdered(this.db, this.full, "enabled = " + this.db.placeholder, ["1"], keys));
    }
    return ok(listOrdered(this.db, this.full, "", [], keys));
  }

  // The whole agent: its prompt, its model config, its servers, its children.
  // One query, so a caller never has to assemble it.
  @get("/:id")
  find(req: Request): Reply {
    let document = findById(this.db, this.full, param(req, "id"));
    if (document == "") { return notFound("agent " + param(req, "id")); }
    return ok(document);
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, this.flat, req.body);
    if (problem != "") { return badRequest(problem); }
    // The same guards the edit form gets. A create was the one way in that
    // skipped them, so an agent could be born nameless or pointing at a
    // config that does not exist.
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

  // Editing an agent is one PUT of its whole row. The referenced config and
  // prompt must exist — persist would happily write a dangling reference, and
  // the run loop would then name the missing row at the worst time.
  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let row: AgentRow = JSON.parse<AgentRow>(req.body);
    if (row.id != param(req, "id")) {
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

    // Exactly one default, enforced on the way in. This used to live in a
    // route of its own, which meant the rule held through that door and not
    // through this one — and an invariant with two doors and one guard is not
    // an invariant.
    if (row.isDefault) {
      executeWith(this.db, "UPDATE agents SET is_default = " + this.db.placeholder, ["0"]);
    }
    let written = persist(this.db, this.flat, req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  @post("/:id/servers")
  addServer(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    let link: ServerLink = JSON.parse<ServerLink>(req.body);
    if (!existsById(this.db, mcpServersMapping(), link.serverId)) {
      return badRequest("no server " + link.serverId);
    }
    executeWith(this.db, "INSERT INTO agent_mcp_servers (agent_id, server_id) VALUES ("
      + this.db.placeholder + ", " + placeholderAt(this.db, 2) + ")", [param(req, "id"), link.serverId]);
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  // Make one agent another's child. The link is what offers the child to the
  // parent as a tool, so delegation is an INSERT like everything else.
  //
  // A cycle is accepted here and refused by the run. That is deliberate and
  // not laziness: a graph is assembled a row at a time, and refusing the row
  // that closes a loop would mean the order you build in decides whether you
  // can build it at all. The run knows its own path and can say exactly which
  // chain it would re-enter.
  @post("/:id/sub-agents")
  addChild(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    let link: ChildLink = JSON.parse<ChildLink>(req.body);
    if (!existsById(this.db, this.flat, link.childId)) {
      return badRequest("no agent " + link.childId);
    }
    if (link.childId == param(req, "id")) {
      // The one case worth refusing at write time: it can never be anything
      // but a mistake, and the run would only meet it later.
      return badRequest("an agent cannot be its own sub-agent");
    }
    executeWith(this.db, "INSERT INTO agent_sub_agents (parent_id, child_id) VALUES ("
      + this.db.placeholder + ", " + placeholderAt(this.db, 2) + ")", [param(req, "id"), link.childId]);
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  @del("/:id/sub-agents/:childId")
  removeChild(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    executeWith(this.db, "DELETE FROM agent_sub_agents WHERE parent_id = " + this.db.placeholder
      + " AND child_id = " + placeholderAt(this.db, 2), [param(req, "id"), param(req, "childId")]);
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  // Detaching a server is the same shape, and was missing for the same
  // reason: attaching one had a route and taking it away did not.
  @del("/:id/servers/:serverId")
  removeServer(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    executeWith(this.db, "DELETE FROM agent_mcp_servers WHERE agent_id = " + this.db.placeholder
      + " AND server_id = " + placeholderAt(this.db, 2), [param(req, "id"), param(req, "serverId")]);
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  // A skill on an agent is a link, exactly like a server: an INSERT the next
  // run reads. Both sides are checked because a link to a skill that does not
  // exist would sit invisible — the briefing joins through the skills table
  // and would simply never list it.
  @post("/:id/skills")
  addSkill(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    let link: SkillLink = JSON.parse<SkillLink>(req.body);
    if (!existsById(this.db, skillsMapping(), link.skillId)) {
      return badRequest("no skill " + link.skillId);
    }
    executeWith(this.db, "INSERT INTO agent_skills (agent_id, skill_id) VALUES ("
      + this.db.placeholder + ", " + placeholderAt(this.db, 2) + ")", [param(req, "id"), link.skillId]);
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  @del("/:id/skills/:skillId")
  removeSkill(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    executeWith(this.db, "DELETE FROM agent_skills WHERE agent_id = " + this.db.placeholder
      + " AND skill_id = " + placeholderAt(this.db, 2), [param(req, "id"), param(req, "skillId")]);
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  // What this agent may read. A grant is a fact, so granting twice is not an
  // error and does not duplicate the row.
  @get("/:id/scopes")
  scopes(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    let granted = agentScopes(this.db, param(req, "id"));
    let out = "[";
    let i: int = 0;
    while (i < granted.length) {
      if (i > 0) { out = out + ","; }
      out = out + JSON.stringify(granted[i]);
      i = i + 1;
    }
    return ok(out + "]");
  }

  @post("/:id/scopes")
  grant(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required: {\"scope\":\"/specs\"}"); }
    let body: ScopeGrant = JSON.parse<ScopeGrant>(req.body);
    if (body.scope == "") { return badRequest("a scope is required"); }
    let problem = grantScope(this.db, param(req, "id"), body.scope);
    if (problem != "") { return badRequest(problem); }
    return this.scopes(req);
  }

  @del("/:id/scopes/:scope")
  revoke(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    // A path cannot survive a URL segment, so the scope arrives with its
    // slashes as `~` — "/specs/plume" is "~specs~plume". Ugly, and better than
    // a route that cannot express the thing it grants.
    let problem = revokeScope(this.db, param(req, "id"), param(req, "scope").replaceAll("~", "/"));
    if (problem != "") { return badRequest(problem); }
    return this.scopes(req);
  }

  // How this agent retrieves: which embedding model, how many passages, how
  // far is too far. Absent until set, which is how an agent that does not
  // retrieve is spelled.
  @put("/:id/retrieval")
  setRetrieval(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: RetrievalSetup = JSON.parse<RetrievalSetup>(req.body);
    if (embeddingModel(this.db, body.embeddingModelId).id == "") {
      return badRequest("no usable embedding model " + body.embeddingModelId);
    }
    if (body.topK <= 0 || body.topK > 100) { return badRequest("topK must be between 1 and 100"); }
    let row: AgentRetrievalRow = {
      agentId: param(req, "id"),
      embeddingModelId: body.embeddingModelId,
      topK: body.topK,
      maxDistance: body.maxDistance,
      enabled: body.enabled,
    };
    let written = persist(this.db, agentRetrievalMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, agentRetrievalMapping(), param(req, "id")));
  }

  // Whether and how this agent reads the public web index. Its own GET,
  // unlike the knowledge row, because the form that edits it wants to draw
  // the saved state and the agent document does not carry this.
  @get("/:id/web-rag")
  webRag(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    return ok(JSON.stringify(webRagFor(this.db, param(req, "id"))));
  }

  @put("/:id/web-rag")
  setWebRag(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: AgentWebRagRow = JSON.parse<AgentWebRagRow>(req.body);
    if (body.topK <= 0 || body.topK > 20) { return badRequest("topK must be between 1 and 20 — the index caps at 20"); }
    if (body.maxChars < 500 || body.maxChars > 100000) { return badRequest("maxChars must be between 500 and 100000"); }
    if (body.queryMode != "verbatim" && body.queryMode != "generated") {
      return badRequest("queryMode must be verbatim or generated");
    }
    // A generated mode with no model would silently behave as verbatim
    // (generateQuery falls back), and a form that saves one thing and gets
    // another teaches people the form is broken. Refused instead.
    if (body.queryMode == "generated") {
      let modelDoc = findById(this.db, modelsMapping(), body.queryModelId);
      if (modelDoc == "") { return badRequest("queryMode generated needs an existing chat model as queryModelId"); }
      let m: ModelRow = JSON.parse<ModelRow>(modelDoc);
      if (m.kind != "chat") { return badRequest(m.label + " is not a chat model"); }
    }
    let row: AgentWebRagRow = {
      agentId: param(req, "id"),
      enabled: body.enabled,
      topK: body.topK,
      maxChars: body.maxChars,
      queryMode: body.queryMode,
      queryModelId: body.queryModelId,
    };
    let written = persist(this.db, agentWebRagMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, agentWebRagMapping(), param(req, "id")));
  }

  // Run the agent against a user's text. The reply is the conversation's side
  // of the run — the answer and what served it. The context's side (every tool
  // call and result) is written to the run log and answered by /runs/:id,
  // because the two are different things and a chat client should not have to
  // filter one out of the other.
  @post("/:id/run")
  run(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required: {\"text\":\"...\"}"); }
    let body: RunBody = JSON.parse<RunBody>(req.body);
    if (body.text == "") { return badRequest("nothing to ask: \"text\" is empty"); }
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }

    // The same ceiling the thread door enforces, or this route is the way
    // around it: it is the only other door that spends a provider call, and a
    // guest who found it would have unlimited turns while say() counted them.
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

    // The tracer is read per request, not held: turning tracing on is an
    // UPDATE and takes effect on the next run like everything else here.
    // Unconfigured, it records nothing and sends nothing.
    let tracer = tracerFor(this.db, this.master);
    let answered = runAgentTraced(this.db, param(req, "id"), body.text, this.master, tracer);

    // Logged either way: the runs an operator needs to read are mostly the
    // ones that went wrong. No thread asked, so the caller's own tag is the
    // owner — there is no conversation to inherit one from.
    // No choice and no routing: this door has no conversation and no picker in
    // front of it, so the agent's own model answered and there is nothing to
    // explain. "" for both, which is what every row written before the menu
    // existed carries.
    let runId = recordRun(this.db, {
      agentId: param(req, "id"), threadId: "", owner: owningTag(callerTags(req)),
      question: body.text, run: answered, modelChoiceId: "", routeNote: "",
    });

    // The collector is told after the answer is in hand, and a collector that
    // is down or wrong does not cost the caller its answer -- it costs a
    // trace, which is the right thing to lose.
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
      // The one refusal that is the caller's mistake rather than the run's:
      // the agent existed a moment ago and does not now, or a row it needs is
      // dangling. Either way the name of what is missing is the answer.
      return badRequest(answered.error);
    }
    return ok(out);
  }

  // The agent's recent runs, newest first — the transcript side only. The
  // steps are behind /runs/:id, so a list view never pays for them.
  //
  // Scoped to the caller's own, in SQL. An agent is a shared row — everyone
  // runs the same one — so an agent id is not a tenant boundary and this
  // listing served every tenant's questions and answers to whoever asked.
  @get("/:id/runs")
  runs(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    return ok(runsOf(this.db, param(req, "id"), callerTags(req), 50));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    forgetAgent(this.db, param(req, "id"));
    return noContent();
  }
}
