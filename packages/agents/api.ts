// The agents API: the schema, served.
//
//   cd packages/agents && lumen run api.ts
//   curl -s localhost:8100/agents
//   curl -s localhost:8100/agents/a1
//   curl -s -X POST localhost:8100/agents -d '{"id":"a3",...}'
//   curl -s -X PUT  localhost:8100/agents/a1/model -d '{"modelConfigId":"c2"}'
//   curl -s -X PUT  localhost:8100/agents/a1/prompt -d '{"promptId":"p1"}'
//
// The model menu has two faces and they are different routes on purpose:
//
//   curl -s localhost:8100/models/choices     # the composer's menu: enabled only
//   curl -s localhost:8100/model-choices      # the operator's list: every row
//   curl -s -X PUT localhost:8100/model-choices/ch-fast -d '{"label":"Instant"}'
//   curl -s -X PUT localhost:8100/model-configs/c1 -d '{"selectable":true,"menuRank":2}'
//   curl -s -X POST localhost:8100/model-routers -d '{"id":"rt-1","label":"Auto",
//     "routerConfigId":"c-small","fallbackConfigId":"c-small","routeEvery":"turn",
//     "candidates":[{"key":"fast","configId":"c1","when":"greetings, short questions"},
//                   {"key":"deep","configId":"c2","when":"writing, multi-step analysis"}]}'
//
// A write there is a MERGE of the members the body names: what is left out is
// left alone, so moving one row up the menu is one field. See "reading an
// operator's body".
//
// Every read goes to the database. Nothing is cached and nothing is compiled
// in, so a change made through this API — or by anything else touching the
// same tables — is visible to the very next request, with no restart. That is
// the whole requirement, and it is met by not doing the thing that would break
// it rather than by machinery.

import { controller } from "../rest/controller.ts";
import { Request, Reply, Mount, mountedRoutes, mountProblem, dispatchedMounted, reply, ok, created, accepted, noContent, notFound, badRequest, param, queryParam, header } from "../rest/server.ts";
import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { postgres } from "../plume/postgres.ts";
import { DbOrder, DbRepository, asc, desc, safeIdentifier, placeholderAt, connectDatabase, persist, findById, listOrdered, listWhere, pageOrdered, existsById, deleteById, execute, executeWith, countWhere, jsonMember } from "../plume/plume.ts";
import { migrate, appliedHighWater } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, ModelChoiceRow, ModelRouterRow, PromptRow, McpServerRow, AgentRow, ScriptImageRow, SkillRow, SkillFileRow, modelsMapping, modelConfigsMapping, modelConfigRows, configAndModel, modelChoicesMapping, modelRoutersMapping, enabledChoices, promptsMapping, mcpServersMapping, agentsMapping, agentsFull, scriptImagesMapping, skillsMapping, skillFilesMapping, AuthProviderRow, authProvidersMapping, PluginRow, PluginItemRow, pluginsMapping, pluginItemsMapping, schemaPlan, derivedMenuStatements } from "./schema.ts";
import { DestinationMove, destinationOf, masterKey, masterKeyProblem, storeCredential, credentialFor, providersWithCredentials, hasCredential, forgetCredential, destinationProblem } from "./credentials.ts";
import { AgentRun, runAgent, runAgentTraced } from "./run.ts";
import { chatEndpoint, embeddingEndpoint, endpointFor, complete, embedText, replyText } from "./provider.ts";
import { runsMapping, runsFull, runLogPlan, recordRun, runsOf, ownedRun } from "./runlog.ts";
import { TraceConfigRow, traceConfigMapping, tracePlan, tracerFor } from "./trace.ts";
import { jsonId, createProblem, backendOr, knownBackend, scopesJson } from "./payload.ts";
import { jsonList, jsonText, jsonFind, jsonUnescape, jsonRaw} from "./scan.ts";
import { toolListing } from "./mcp.ts";
import { userTokenKey } from "./tools.ts";
import { Manifest, manifestFrom, manifestUrl, fetchManifest, installProblem, install, uninstall, itemsOf } from "./plugins.ts";
import { ModelPick, ThreadListing, ThreadTurnRow, threadsMapping, listThreads, openThread, ownedThread, threadOwner, threadChoice, threadTitle, rememberChoice, sweepEmptyThreads, sweepIdleMs, threadMessageRows, runInThreadWith, threadPlan, listReplayable, markReplayable, remixThread, readableThread} from "./threads.ts";
import { trustsProxyAuth, tagsFromHeader, identityUnreadable, owningTag, holdsOwner } from "./owner.ts";
import { ownerUsage, usageJson } from "./usage.ts";
import { workspacePlan, putFile, getFile, listFiles, deleteFile, promoteFile, mimeOf } from "./workspace.ts";
// `mimeOf` is deliberately not taken from here: workspace.ts already owns that
// name in this file, and an artifact's type is on its row anyway.
import { ArtifactRow, TurnArtifact, TURN_SEQ_NONE, artifactPlan, artifactsMapping, imageMediaType, putArtifact, listArtifacts, getArtifact, findByToken, getVersion, deleteArtifact, artifactsForTurn, artifactsByTurn, utf8Length } from "./artifacts.ts";
import { scriptEnvNameProblem } from "./run-script.ts";
import { OfficeRenderAsk, officeRender, officeRenderExt } from "./office-render.ts";
import { stepPlan, stepsOfRound, stepsOfThread, roundRunning, latestRound, stepMillis, thoughtsOfRound, thoughtsOfThread, LiveStep, Thought } from "./steps.ts";
import { EnvSweep, ENV_IDLE_MS, envPlan, envDockerUp, envIdle } from "./environments.ts";
import { WireRef, wireView } from "./artifacts-fence.ts";
import { IndexJobRow, indexingPlan, enqueue, pendingJobs, JOB_QUEUED } from "./indexing.ts";
import { SourceListing, listSources, ScopeNode, AgentRetrievalRow, agentRetrievalMapping, knowledgePlan, embeddingModel, createDocuments, uploadDocument, scopeCounts, normalScope, agentScopes, grantScope, revokeScope, documentsMapping } from "./knowledge.ts";
import { Tracer, flush, traceId, spanCount, tracing, tracerWithMoreSpans } from "../tracing/tracing.ts";

// A change to which model or prompt an agent uses, as a body.
type ModelChange = { modelConfigId: string };
type PromptChange = { promptId: string };
type ServerLink = { serverId: string };
type SkillLink = { skillId: string };
type ChildLink = { childId: string };
type KeyBody = { apiKey: string };
// `RunBody` serves `POST /agents/:id/run` only, which takes no `modelChoiceId`
// — it has no conversation and no picker in front of it. There is deliberately
// no record for either thread door: both take an optional `modelChoiceId`, and
// a record type refuses a document carrying a key it does not declare, so they
// read their members instead. See `askedChoice`.
type RunBody = { text: string };
type TraceSecret = { secretKey: string };
type ScopeGrant = { scope: string };
type ServerAuth = { authKind: string, authHeader: string, token: string };
type FileUpload = { name: string, content: string };
// Every field is required, `note` included — JSON.parse refuses a body missing
// one, so "no note" is spelled "note":"" rather than left out.
type ArtifactPost = { path: string, title: string, content: string, note: string };
type FilePromote = { scope: string, modelId: string };
type FilePull = { name: string, documentId: string };
type DocumentUpload = { source: string, scope: string, body: string };
type RetrievalSetup = { embeddingModelId: string, topK: int, maxDistance: number, enabled: bool };

// Who is calling, as far as this process is willing to know — an empty list
// unless a trusted proxy said otherwise, which is every deployment that has
// not turned the gate on. owner.ts holds the whole of the contract; this is
// the only line that reads it off a request, so that "did this route scope?"
// is a question about one call and not about a header check copied sixteen
// times.
function callerTags(req: Request): string[] {
  return tagsFromHeader(trustsProxyAuth(), header(req, "x-user"));
}

// Credentials, over the API. A key can be written and named; it can never be
// read back. Anything that returns one is a leak waiting for a log line, and
// the caller who set it already knows what they set.
@controller("/providers")
class ProviderApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @get("/")
  list(req: Request): Reply {
    let names = providersWithCredentials(this.db);
    let out = "[";
    let i: int = 0;
    while (i < names.length) {
      if (i > 0) { out = out + ","; }
      out = out + JSON.stringify(names[i]);
      i = i + 1;
    }
    return ok(out + "]");
  }

  // Whether a provider has a usable key, without saying what it is. A caller
  // needs to know a deployment is configured; it does not need the secret to
  // find that out.
  @get("/:provider")
  status(req: Request): Reply {
    let usable = credentialFor(this.db, param(req, "provider"), this.master) != "";
    return ok("{\"provider\":" + JSON.stringify(param(req, "provider"))
      + ",\"configured\":" + `${usable}` + "}");
  }

  @put("/:provider/key")
  setKey(req: Request): Reply {
    let problem = masterKeyProblem(this.master);
    if (problem != "") { return badRequest(problem); }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: KeyBody = JSON.parse<KeyBody>(req.body);
    let stored = storeCredential(this.db, { provider: param(req, "provider"), apiKey: body.apiKey, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return ok("{\"provider\":" + JSON.stringify(param(req, "provider")) + ",\"configured\":true}");
  }

  @del("/:provider/key")
  clearKey(req: Request): Reply {
    if (!forgetCredential(this.db, param(req, "provider"))) {
      return notFound("no key for " + param(req, "provider"));
    }
    return noContent();
  }
}

@controller("/agents")
class AgentApi {
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

// Where traces go, configured like everything else.
//
// Off unless a row says otherwise, and off is not an error: a deployment with
// no collector runs exactly as it did before this existed.
@controller("/tracing")
class TraceApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  // What is configured, and whether it would actually send. The secret is
  // never in this answer -- only whether one is stored, which is the only
  // thing a caller needs to know.
  @get("/")
  status(req: Request): Reply {
    let document = findById(this.db, traceConfigMapping(), "default");
    if (document == "") {
      return ok("{\"configured\":false,\"active\":false}");
    }
    let row: TraceConfigRow = JSON.parse<TraceConfigRow>(document);
    let hasSecret = credentialFor(this.db, "tracing", this.master) != "";
    // `active` is the question that matters: enabled, addressed and keyed.
    // Three ways to be configured and still silent, so it is answered rather
    // than left to be inferred from the other fields.
    return ok("{\"configured\":true,\"active\":" + `${tracing(tracerFor(this.db, this.master))}`
      + ",\"backend\":" + JSON.stringify(backendOr(row.backend))
      + ",\"endpoint\":" + JSON.stringify(row.endpoint)
      + ",\"publicKey\":" + JSON.stringify(row.publicKey)
      + ",\"serviceName\":" + JSON.stringify(row.serviceName)
      + ",\"environment\":" + JSON.stringify(row.environment)
      + ",\"enabled\":" + `${row.enabled}`
      + ",\"secretStored\":" + `${hasSecret}` + "}");
  }

  // The collector's address and labels. Written whole rather than field by
  // field: there is one row, and a partial update of a connection is how you
  // get a deployment pointing half at one collector and half at another.
  @put("/")
  configure(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let body: TraceConfigRow = JSON.parse<TraceConfigRow>(req.body);
    if (body.enabled && body.endpoint == "") {
      return badRequest("tracing cannot be enabled without an endpoint");
    }
    if (!knownBackend(backendOr(body.backend))) {
      return badRequest("unknown backend \"" + body.backend + "\"; this understands langfuse, otlp, phoenix, braintrust, langsmith and arize");
    }
    let moved = traceDestinationProblem(this.db, body);
    if (moved != "") { return badRequest(moved); }
    let row: TraceConfigRow = {
      id: "default",
      backend: backendOr(body.backend),
      endpoint: body.endpoint,
      publicKey: body.publicKey,
      serviceName: body.serviceName,
      environment: body.environment,
      enabled: body.enabled,
    };
    let written = persist(this.db, traceConfigMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return this.status(req);
  }

  // The secret half, through the same encrypted store as a provider's key --
  // and, like those, it can be written and never read back.
  @put("/key")
  setKey(req: Request): Reply {
    let problem = masterKeyProblem(this.master);
    if (problem != "") { return badRequest(problem); }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: TraceSecret = JSON.parse<TraceSecret>(req.body);
    let stored = storeCredential(this.db, { provider: "tracing", apiKey: body.secretKey, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return this.status(req);
  }

  // Clearing the secret is how the collector's address is moved: writing a
  // key is what authorises an address, so changing the address means writing
  // the key again. Destructive on purpose — whoever moves the collector has to
  // be able to supply the secret a second time.
  @del("/key")
  clearKey(req: Request): Reply {
    if (!forgetCredential(this.db, "tracing")) {
      return notFound("a tracing key");
    }
    return this.status(req);
  }
}

// The catalog: models, model configs, prompts and MCP servers, over HTTP.
// This is the rest of "no code": with these, an agent is assembled entirely
// by API calls, and nothing was ever written in a file.
//
// One class per table would repeat the same four methods with different
// mappings; one class with the table in the path would put plume mappings
// behind a string. Four small classes, sharing shape but not machinery, is
// the least clever thing that works.

// Why an image row will not be written. A label to pick it by, and an image
// reference that is one word with no shell metacharacters — it becomes an
// argv entry to docker, never a shell string, but a reference carrying a
// space or a quote is a mistake worth naming at the door.
export function scriptImageProblem(row: ScriptImageRow): string {
  if (row.label.trim() == "") { return "an image needs a label to pick it by"; }
  if (row.image.trim() == "") { return "an image needs a reference, such as agents-runtime:1"; }
  let i: int = 0;
  while (i < row.image.length) {
    let c = row.image.charCodeAt(i);
    if (c <= 32 || c == 34 || c == 39 || c == 96 || c == 36 || c == 59) {
      return "an image reference is one word: \"" + row.image + "\" carries a space or a shell character";
    }
    i = i + 1;
  }
  return "";
}

// The images an operator will run scripts in.
//
// Curated, and by an operator rather than by a model: run_script builds a
// conversation's container from the agent's chosen row, and a model that
// could name its own image could make this server pull anything off the
// internet and execute it. So the set lives here, an agent points at one, and
// nothing on the model's side of the wire names an image at all.
@controller("/script-images")
class ScriptImageApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("label")];
    return ok(listOrdered(this.db, scriptImagesMapping(), "", [], keys));
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, scriptImagesMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let row: ScriptImageRow = JSON.parse<ScriptImageRow>(req.body);
    let named = scriptImageProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, scriptImagesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, scriptImagesMapping(), jsonId(req.body)));
  }

  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, scriptImagesMapping(), param(req, "id"))) {
      return notFound("script image " + param(req, "id"));
    }
    let row: ScriptImageRow = JSON.parse<ScriptImageRow>(req.body);
    if (row.id != param(req, "id")) {
      return badRequest("the id in the body must match the path");
    }
    let named = scriptImageProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, scriptImagesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, scriptImagesMapping(), param(req, "id")));
  }

  // Removing an image leaves the agents that pointed at it alone: their
  // environments fall back to the deployment default, which is a working
  // image by definition. Rewriting other rows from a delete would be a
  // surprise larger than the one it prevents.
  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, scriptImagesMapping(), param(req, "id"))) {
      return notFound("script image " + param(req, "id"));
    }
    deleteWhere(this.db, scriptImagesMapping(), "id = " + placeholderAt(this.db, 1), [param(req, "id")]);
    return noContent();
  }
}

// The caps a skill is held to at the door. The description is a line in the
// system prompt of every turn of every conversation its agent has, so one
// bloated description taxes everything — 200 bytes, one line. The body and
// each file arrive only on use, but a runaway one would lean on the tool
// output cap every call, so 16 KB names the mistake earlier and better.
export const SKILL_DESCRIPTION_MAX: int = 200;
export const SKILL_MAX: int = 16384;

// Why a skill row will not be written. The name is held to the environment
// name rule because it becomes a container path segment — /skills/<name>/ —
// and the file rule below keeps a path inside that directory.
export function skillProblem(row: SkillRow): string {
  if (row.skillName.trim() == "") { return "a skill needs a name — it is what use_skill is called with"; }
  if (row.visibility != "private" && row.visibility != "public") {
    return "visibility is 'private' or 'public' — nothing else";
  }
  if (row.featuredRank > 0 && row.visibility != "public") {
    return "a featured skill must be public — featured is promotion, not access, and a featured private skill is a button most users cannot press";
  }
  if (row.featuredRank < 0) { return "featuredRank is 0 (not featured) or a positive position"; }
  if (row.source != "local" && row.source != "repo") {
    return "source is 'local' (written here) or 'repo' (a copy of one a repository owns)";
  }
  if (row.source == "repo" && row.sourceUrl.trim() == "") {
    return "a skill from a repository has to say which one — sourceUrl is empty";
  }
  if (row.source == "local" && row.sourceUrl.trim() != "") {
    return "a local skill has no sourceUrl — set source to 'repo' if it came from one";
  }
  let named = scriptEnvNameProblem(row.skillName);
  if (named != "") { return "a skill name becomes a container path: " + named; }
  if (row.description.trim() == "") { return "a skill without a description cannot be chosen"; }
  if (utf8Length(row.description) > SKILL_DESCRIPTION_MAX) {
    return "a skill description is at most " + `${SKILL_DESCRIPTION_MAX}` + " bytes of UTF-8 — it is a line in every turn's briefing";
  }
  if (row.description.indexOf("\n") >= 0) { return "a skill description is one line"; }
  if (row.body.trim() == "") { return "an empty skill is not an instruction"; }
  if (utf8Length(row.body) > SKILL_MAX) {
    return "a skill body is at most " + `${SKILL_MAX}` + " bytes of UTF-8; ship the bulk as files";
  }
  return "";
}

export function skillFileProblem(row: SkillFileRow): string {
  if (row.path.trim() == "") { return "a skill file needs a name, such as enums.py"; }
  if (row.path.indexOf("/") >= 0 || row.path.indexOf("..") >= 0) {
    return "a skill file is a plain name inside its skill's directory — no slash, no dot-dot";
  }
  if (row.body == "") { return "an empty skill file carries nothing worth staging"; }
  if (utf8Length(row.body) > SKILL_MAX) {
    return "a skill file is at most " + `${SKILL_MAX}` + " bytes of UTF-8";
  }
  return "";
}

// Templates: the cards a capability page shows. Read is open — a template is
// a starting point, not a secret — and writes are the operator's, the same
// posture as curated script images.
@controller("/templates")
class TemplateApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // `?kind=doc` is what a capability page asks with; without it, everything
  // public, ranked. Both orders are by rank then label so a page's cards do
  // not reshuffle between visits.
  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("featured_rank"), asc("label")];
    let kind = queryParam(req, "kind", "");
    if (kind != "") {
      return ok(listOrdered(this.db, templatesMapping(),
        "visibility = 'public' AND kind = " + placeholderAt(this.db, 1), [kind], keys));
    }
    return ok(listOrdered(this.db, templatesMapping(), "visibility = 'public'", [], keys));
  }

  @get("/:id")
  find(req: Request): Reply {
    let held = findById(this.db, templatesMapping(), param(req, "id"));
    if (held == "") { return notFound("template " + param(req, "id")); }
    return ok(held);
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, templatesMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let written = persist(this.db, templatesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, templatesMapping(), jsonId(req.body)));
  }

  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, templatesMapping(), param(req, "id"))) {
      return notFound("template " + param(req, "id"));
    }
    let written = persist(this.db, templatesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, templatesMapping(), param(req, "id")));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, templatesMapping(), param(req, "id"))) {
      return notFound("template " + param(req, "id"));
    }
    deleteWhere(this.db, templateFilesMapping(), "template_id = " + placeholderAt(this.db, 1),
      [param(req, "id")]);
    deleteById(this.db, templatesMapping(), param(req, "id"));
    return noContent();
  }

  @get("/:id/files")
  files(req: Request): Reply {
    let keys: DbOrder[] = [asc("path")];
    return ok(listOrdered(this.db, templateFilesMapping(),
      "template_id = " + placeholderAt(this.db, 1), [param(req, "id")], keys));
  }

  @post("/:id/files")
  addFile(req: Request): Reply {
    if (!existsById(this.db, templatesMapping(), param(req, "id"))) {
      return notFound("template " + param(req, "id"));
    }
    let written = persist(this.db, templateFilesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, templateFilesMapping(), jsonId(req.body)));
  }

  @put("/:id/files/:fileId")
  putFile(req: Request): Reply {
    if (!existsById(this.db, templateFilesMapping(), param(req, "fileId"))) {
      return notFound("template file " + param(req, "fileId"));
    }
    let written = persist(this.db, templateFilesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, templateFilesMapping(), param(req, "fileId")));
  }

  // A template's files are editable, so they are removable — a seed that
  // replaces what a template ships needs to retire what it shipped before,
  // and without this the old file rides along forever, laid down beside its
  // replacement every time somebody starts from the template.
  @del("/:id/files/:fileId")
  removeFile(req: Request): Reply {
    if (!existsById(this.db, templateFilesMapping(), param(req, "fileId"))) {
      return notFound("template file " + param(req, "fileId"));
    }
    deleteById(this.db, templateFilesMapping(), param(req, "fileId"));
    return noContent();
  }

  // The template's document as a PDF, for the picker's thumbnail.
  //
  // A card that says "Status report" is a claim; the first page of the actual
  // document is proof. Same converter and same cache as the artifact panel's
  // PDF route — one LibreOffice pass per document, then immutable.
  //
  // The cache key needs a version and a template file has none, so the body's
  // LENGTH stands in for one: `office_renders` is keyed artifactId:version,
  // and a re-uploaded document that kept its byte count to the digit is the
  // kind of collision worth accepting for not adding a column. Wrong at most
  // until the next edit, and never wrong about WHICH template it shows.
  //
  // Open like every other template read — the menu shows these cards to
  // whoever can start a conversation, so the thumbnail is as public as the
  // label it sits under. Non-public templates 404 here exactly as they do on
  // GET /templates/:id.
  @get("/:id/pdf")
  pdf(req: Request): Reply {
    let held = findById(this.db, templatesMapping(), param(req, "id"));
    if (held == "") { return notFound("template " + param(req, "id")); }
    let tpl: TemplateRow = JSON.parse<TemplateRow>(held);
    if (tpl.visibility != "public") { return notFound("template " + param(req, "id")); }

    let listed = listWhere(this.db, templateFilesMapping(),
      "template_id = " + placeholderAt(this.db, 1), [param(req, "id")]);
    let files: TemplateFileRow[] = listed == "" ? [] : JSON.parse<TemplateFileRow[]>(listed);
    // The first convertible file is the template's face. Templates today ship
    // exactly one office document; the loop is for the day one ships a
    // reference file beside it.
    let i: int = 0;
    while (i < files.length && officeRenderExt(files[i].path) == "") { i = i + 1; }
    if (i >= files.length) {
      return badRequest("template " + tpl.label + " holds no document a PDF can be made of");
    }

    let ask: OfficeRenderAsk = {
      artifactId: "tpl:" + files[i].id, version: files[i].body.length,
      path: files[i].path, body: files[i].body, now: stamp(),
    };
    let made = officeRender(this.db, ask);
    if (!made.ok) { return badRequest(made.problem); }
    let out = ok("{\"template\":" + JSON.stringify(tpl.id)
      + ",\"path\":" + JSON.stringify(files[i].path)
      + ",\"cached\":" + (made.cached ? "true" : "false")
      + ",\"pdf\":" + JSON.stringify(made.body) + "}");
    // An hour, not immutable: the underlying document is editable and the id
    // in this URL does not change when it is.
    out.headers.set("cache-control", "public, max-age=3600");
    return out;
  }
}

@controller("/skills")
class SkillApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(req: Request): Reply {
    // The chips row asks with ?featured=1: public, ranked, in rank order.
    // Everything else (the settings tab) gets the whole list by name.
    if (queryParam(req, "featured", "") == "1") {
      let ranked: DbOrder[] = [asc("featured_rank")];
      return ok(listOrdered(this.db, skillsMapping(),
        "visibility = 'public' AND featured_rank > 0", [], ranked));
    }
    let keys: DbOrder[] = [asc("skill_name")];
    return ok(listOrdered(this.db, skillsMapping(), "", [], keys));
  }

  // One row whole, body included — the edit form wants it. The full-agent
  // view is the one place bodies are excluded, because it is read per run.
  @get("/:id")
  find(req: Request): Reply {
    let held = findById(this.db, skillsMapping(), param(req, "id"));
    if (held == "") { return notFound("skill " + param(req, "id")); }
    return ok(held);
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, skillsMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let row: SkillRow = JSON.parse<SkillRow>(req.body);
    let named = skillProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, skillsMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, skillsMapping(), jsonId(req.body)));
  }

  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, skillsMapping(), param(req, "id"))) {
      return notFound("skill " + param(req, "id"));
    }
    let row: SkillRow = JSON.parse<SkillRow>(req.body);
    if (row.id != param(req, "id")) {
      return badRequest("the id in the body must match the path");
    }
    // A skill a repository owns is read here and changed there. Refused at the
    // door and not merely hidden in the console: the console is one caller,
    // and a rule that only one caller keeps is not a rule. What a person wants
    // when they reach this is almost always their own copy, so the message
    // says so rather than only saying no.
    let before: SkillRow = JSON.parse<SkillRow>(findById(this.db, skillsMapping(), param(req, "id")));
    if (before.source == "repo") {
      return badRequest("this skill comes from " + before.sourceUrl
        + " and is edited there; copy it to a local skill to change it here");
    }
    let named = skillProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, skillsMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, skillsMapping(), param(req, "id")));
  }

  // Your own copy of a skill a repository owns.
  //
  // The other half of read-only, and without it 'repo' is a one-way door: the
  // update route refuses the write and there is nothing else to do, so a
  // person who wants to change one word has no move at all. This is the move.
  //
  // A new name, not the same one. use_skill resolves by name against the
  // agent's attached skills and takes the first match, so two rows sharing a
  // name attached to one agent is a coin toss over which body answers —
  // "-local" says where this one came from and the suffix keeps counting if
  // that is taken too.
  //
  // Private and unfeatured whatever the original was: featuring is the
  // operator's curation of a shelf, and a copy quietly inheriting a place on
  // it would promote something nobody chose to promote. Files come across,
  // because a skill whose body says "run report.py" and whose report.py did
  // not follow is a copy that cannot do the thing it describes.
  @post("/:id/copy")
  copyLocal(req: Request): Reply {
    let held = findById(this.db, skillsMapping(), param(req, "id"));
    if (held == "") { return notFound("skill " + param(req, "id")); }
    let from: SkillRow = JSON.parse<SkillRow>(held);
    if (from.source != "repo") {
      return badRequest("this skill is already yours to edit — copying it would only make a second name for the same instructions");
    }
    let base = from.skillName + "-local";
    let name = base;
    let n: int = 2;
    while (countWhere(this.db, skillsMapping(), "skill_name = " + placeholderAt(this.db, 1), [name]) > 0) {
      name = base + "-" + `${n}`;
      n = n + 1;
    }
    let made: SkillRow = {
      id: crypto.randomUUID(),
      skillName: name,
      description: from.description,
      body: from.body,
      updatedAt: `${Date.now()}`,
      visibility: "private",
      featuredRank: 0,
      source: "local",
      sourceUrl: "",
    };
    let written = persist(this.db, skillsMapping(), JSON.stringify(made));
    if (!written.ok) { return badRequest(written.error); }
    // Read here rather than through tools.ts's skillFiles: this module does
    // not import that one, and reaching for a helper across that line to save
    // three statements is how a cycle starts.
    let listed = listWhere(this.db, skillFilesMapping(),
      "skill_id = " + placeholderAt(this.db, 1), [from.id]);
    let files: SkillFileRow[] = listed == "" || listed == "[]"
      ? [] : JSON.parse<SkillFileRow[]>(listed);
    let f: int = 0;
    while (f < files.length) {
      let copy: SkillFileRow = {
        id: crypto.randomUUID(),
        skillId: made.id,
        path: files[f].path,
        body: files[f].body,
      };
      let fileWritten = persist(this.db, skillFilesMapping(), JSON.stringify(copy));
      if (!fileWritten.ok) { return badRequest(fileWritten.error); }
      f = f + 1;
    }
    return created(findById(this.db, skillsMapping(), made.id));
  }

  // Deleting a skill clears its links and files in the same route: there is
  // no fallback for a dangling link the way a script image has a deployment
  // default — it would just be a skill the console shows attached that the
  // run never offers.
  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, skillsMapping(), param(req, "id"))) {
      return notFound("skill " + param(req, "id"));
    }
    executeWith(this.db, "DELETE FROM agent_skills WHERE skill_id = " + this.db.placeholder, [param(req, "id")]);
    deleteWhere(this.db, skillFilesMapping(), "skill_id = " + placeholderAt(this.db, 1), [param(req, "id")]);
    deleteWhere(this.db, skillsMapping(), "id = " + placeholderAt(this.db, 1), [param(req, "id")]);
    return noContent();
  }

  // The files a skill ships. Listed with the skill, replaced one by one; a
  // file's id is its own, so two skills can both ship an enums.py.
  @get("/:id/files")
  files(req: Request): Reply {
    if (!existsById(this.db, skillsMapping(), param(req, "id"))) {
      return notFound("skill " + param(req, "id"));
    }
    let keys: DbOrder[] = [asc("path")];
    return ok(listOrdered(this.db, skillFilesMapping(), "skill_id = " + placeholderAt(this.db, 1), [param(req, "id")], keys));
  }

  @post("/:id/files")
  addFile(req: Request): Reply {
    if (!existsById(this.db, skillsMapping(), param(req, "id"))) {
      return notFound("skill " + param(req, "id"));
    }
    let problem = createProblem(this.db, skillFilesMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let row: SkillFileRow = JSON.parse<SkillFileRow>(req.body);
    if (row.skillId != param(req, "id")) {
      return badRequest("the skillId in the body must match the path");
    }
    let named = skillFileProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, skillFilesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, skillFilesMapping(), jsonId(req.body)));
  }

  @put("/:id/files/:fileId")
  updateFile(req: Request): Reply {
    if (!existsById(this.db, skillFilesMapping(), param(req, "fileId"))) {
      return notFound("skill file " + param(req, "fileId"));
    }
    let row: SkillFileRow = JSON.parse<SkillFileRow>(req.body);
    if (row.id != param(req, "fileId")) {
      return badRequest("the id in the body must match the path");
    }
    if (row.skillId != param(req, "id")) {
      return badRequest("the skillId in the body must match the path");
    }
    let named = skillFileProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, skillFilesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, skillFilesMapping(), param(req, "fileId")));
  }

  @del("/:id/files/:fileId")
  removeFile(req: Request): Reply {
    if (!existsById(this.db, skillFilesMapping(), param(req, "fileId"))) {
      return notFound("skill file " + param(req, "fileId"));
    }
    deleteWhere(this.db, skillFilesMapping(), "id = " + placeholderAt(this.db, 1), [param(req, "fileId")]);
    return noContent();
  }
}

// The model menu, as the composer draws it.
//
// `configId` and `routerId` are deliberately not on the wire. They are the
// operator's plumbing, and a client that can see them is a client that will
// eventually send one back as a `modelChoiceId` — which names no choice row,
// so it would be refused at the door and read as the menu being broken. What a
// caller may name is a choice id, and everything needed to draw one is here.
//
// `enabled` and `rank` are absent for the same kind of reason: every row in
// this answer is enabled and the array is already in rank order, so both
// fields would carry one value forever and invite a client to filter or sort
// on them — work that can only produce the same list again.
export function choicesJson(rows: ModelChoiceRow[]): string {
  let out = "[";
  let i: int = 0;
  while (i < rows.length) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"id\":" + JSON.stringify(rows[i].id)
      + ",\"label\":" + JSON.stringify(rows[i].label)
      + ",\"description\":" + JSON.stringify(rows[i].description)
      // "config" or "router" — the console shows an automatic choice
      // differently, and it is the row that says which it is rather than
      // whichever of two ids happens to be filled in.
      + ",\"kind\":" + JSON.stringify(rows[i].kind)
      // "" or "premium". Rendered as a lock and enforced nowhere near here;
      // see the messages POST, which is where a choice is applied.
      + ",\"tier\":" + JSON.stringify(rows[i].tier) + "}";
    i = i + 1;
  }
  return out + "]";
}

@controller("/models")
class ModelApi {
  db: Db;
  // Testing a model calls it, which needs the key out of the encrypted store.
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("label")];
    return ok(listOrdered(this.db, modelsMapping(), "", [], keys));
  }

  // The menu a person picks from, in the order it is shown.
  //
  // Not scoped to a caller and not filtered by one: `model_choices` is the
  // operator's product surface, exactly as `models` and `script_images` are,
  // and every caller sees the same list — including the premium rows they may
  // not be able to pick, because a menu that hides what upgrading would buy
  // cannot sell it (MODEL-CHOICE.md, "the menu, which only renders the lock").
  //
  // A curated table rather than "every enabled chat config", and the live
  // deployment is the argument: it holds `c-double`, the e2e's fake provider,
  // and three `e2e-link-*` agents. An uncurated menu offers those to real
  // people.
  //
  // A literal under a prefix that also has parameter routes, so it is declared
  // above them — the router matches in order, and a `:id` written first would
  // shadow this. There is no GET /:id here today; this is the line one would
  // have to go below.
  @get("/choices")
  choices(req: Request): Reply {
    return ok(choicesJson(enabledChoices(this.db)));
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, modelsMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let m: ModelRow = JSON.parse<ModelRow>(req.body);
    let wrong = modelProblem(m);
    if (wrong != "") { return badRequest(wrong); }
    let moved = modelDestinationProblem(this.db, m);
    if (moved != "") { return badRequest(moved); }
    let written = persist(this.db, modelsMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, modelsMapping(), jsonId(req.body)));
  }

  // Enabled is the kill switch: flipping it refuses the next call to every
  // agent on this model, which is the point of it being a column.
  // Call the model once and say what happened. A row can name a provider, a
  // base URL and a key and still be wrong in a way only the provider knows —
  // a retired model id, a gateway that speaks a different dialect, a key
  // without access. Finding that out at the first conversation is finding it
  // out in front of a user.
  @post("/:id/test")
  test(req: Request): Reply {
    let document = findById(this.db, modelsMapping(), param(req, "id"));
    if (document == "") { return notFound("model " + param(req, "id")); }
    let stored: ModelRow = JSON.parse<ModelRow>(document);
    let key = credentialFor(this.db, stored.provider, this.master);
    if (key == "") { return badRequest("no credential stored for " + stored.provider); }

    // Tested as if enabled. A test is what you run to decide whether to enable
    // a row, so refusing to test a disabled one refuses the only question the
    // button is asked.
    let model: ModelRow = {
      id: stored.id, label: stored.label, apiName: stored.apiName,
      provider: stored.provider, kind: stored.kind, dimensions: stored.dimensions,
      baseUrl: stored.baseUrl, enabled: true, contextTokens: 0 };

    if (model.kind == "embedding") {
      let vector = embedText(model, "a probe from the console", key);
      if (!vector.ok) { return ok("{\"ok\":false,\"error\":" + JSON.stringify(vector.error) + "}"); }
      // The width it returns is the width the corpus was built at. A model
      // that answers a different number is not the model this row describes.
      let agrees = vector.dimensions == model.dimensions;
      return ok("{\"ok\":" + `${agrees}`
        + ",\"dimensions\":" + `${vector.dimensions}`
        + ",\"declared\":" + `${model.dimensions}`
        + ",\"error\":" + JSON.stringify(agrees ? "" : "the model returned a different width than this row declares") + "}");
    }

    // Never persisted and never offered: this row exists for the length of one
    // "does this model answer" call, so it is unlabelled and not selectable.
    let config: ModelConfigRow = { id: "probe", modelId: model.id, temperature: 0, maxTokens: 16, topP: 1, extra: "" , thinking: "", label: "", selectable: false, rank: 0 };
    let said = complete(model, config, "Reply with the single word: ok", "ping", key);
    if (!said.ok) { return ok("{\"ok\":false,\"error\":" + JSON.stringify(said.error) + "}"); }
    // The provider's whole envelope is not an answer. replyText pulls the
    // assistant's own words out of it, which is what a person is looking at.
    let answer = replyText(model.provider, said.text);
    return ok("{\"ok\":true,\"reply\":" + JSON.stringify(answer.slice(0, 120))
      + ",\"inputTokens\":" + `${said.inputTokens}`
      + ",\"outputTokens\":" + `${said.outputTokens}` + "}");
  }

  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, modelsMapping(), param(req, "id"))) {
      return notFound("model " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let row: ModelRow = JSON.parse<ModelRow>(req.body);
    if (row.id != param(req, "id")) {
      return badRequest("the id in the body must match the path");
    }
    let wrong = modelProblem(row);
    if (wrong != "") { return badRequest(wrong); }
    let moved = modelDestinationProblem(this.db, row);
    if (moved != "") { return badRequest(moved); }

    // At most one embedding model is enabled at a time. Enforced here rather
    // than asked of a caller: two enabled embedders is not a preference, it is
    // a corpus split in half — a document embedded by one is invisible to
    // every agent retrieving through the other, and nothing reports it.
    if (row.enabled && row.kind == "embedding") {
      executeWith(this.db, "UPDATE models SET enabled = " + this.db.placeholder
        + " WHERE kind = " + placeholderAt(this.db, 2)
        + " AND id <> " + placeholderAt(this.db, 3), ["0", "embedding", param(req, "id")]);
    }
    let written = persist(this.db, modelsMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, modelsMapping(), param(req, "id")));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, modelsMapping(), param(req, "id"))) {
      return notFound("model " + param(req, "id"));
    }
    if (countWhere(this.db, modelConfigsMapping(this.db), "model_id = " + this.db.placeholder, [param(req, "id")]) > 0) {
      return badRequest("model " + param(req, "id") + " is used by a model config; delete or repoint those first");
    }
    deleteById(this.db, modelsMapping(), param(req, "id"));
    return noContent();
  }
}

@controller("/model-configs")
class ConfigApi {
  db: Db;
  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("id")];
    return ok(listOrdered(this.db, modelConfigsMapping(this.db), "", [], keys));
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, modelConfigsMapping(this.db), req.body);
    if (problem != "") { return badRequest(problem); }
    // Still a whole-row parse, and deliberately: a create has no stored row to
    // merge onto, so every field has to be stated anyway, and the record type
    // is the cheapest way to say that. The PUT below cannot do the same — see
    // the comment on it.
    let body: ModelConfigRow = JSON.parse<ModelConfigRow>(req.body);
    let wrong = configProblem(this.db, body);
    if (wrong != "") { return badRequest(wrong); }
    let written = persist(this.db, modelConfigsMapping(this.db), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, modelConfigsMapping(this.db), jsonId(req.body)));
  }

  // The three columns that decide whether a config is on offer and what it is
  // called — `label`, `selectable`, `menu_rank` — were reachable only from a
  // psql session until this route existed. So were the tuning fields, on a row
  // that was create-or-delete.
  //
  // A MERGE of the members the body carries, not a replacement of the row, and
  // read member by member rather than parsed. Both halves are forced:
  //
  // - `JSON.parse<ModelConfigRow>` refuses a document carrying a member the
  //   record does not declare, and what `GET /model-configs` hands a console is
  //   NOT a `ModelConfigRow`: `modelConfigsMapping` declares a hasOne relation,
  //   so every row arrives with the whole `model` object nested inside it. A
  //   form that PUTs back what it read would 400 every time. This is the same
  //   trap the thread doors document at length — see `askedChoice`.
  // - Absent therefore has to mean "leave it alone", so a console that only
  //   wants to move a row up the menu sends `{"menuRank":2}` and nothing else
  //   is at risk of being reset to a zero value by omission.
  //
  // `rank` is read before `menuRank` because `rank` is the name the GET emits
  // and a round trip has to be lossless; `menuRank` is accepted beside it
  // because that is what the column is called and what an operator writing a
  // curl reaches for. Same pair on `/model-choices`.
  @put("/:id")
  update(req: Request): Reply {
    // Read through `modelConfigRows`, which is the same table without the
    // nested model, for exactly the reason above: the relation's document
    // cannot be parsed back into the record.
    let stored = findById(this.db, modelConfigRows(this.db), param(req, "id"));
    if (stored == "") { return notFound("model config " + param(req, "id")); }
    if (req.body == "") { return badRequest("a body is required"); }
    if (bodyText(req.body, "id", param(req, "id")) != param(req, "id")) {
      return badRequest("the id in the body must match the path");
    }
    let row = mergedConfig(JSON.parse<ModelConfigRow>(stored), req.body);
    let wrong = configProblem(this.db, row);
    if (wrong != "") { return badRequest(wrong); }
    let written = persist(this.db, modelConfigsMapping(this.db), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, modelConfigsMapping(this.db), param(req, "id")));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, modelConfigsMapping(this.db), param(req, "id"))) {
      return notFound("model config " + param(req, "id"));
    }
    let used = configInUse(this.db, param(req, "id"));
    if (used != "") { return badRequest(used); }
    deleteById(this.db, modelConfigsMapping(this.db), param(req, "id"));
    return noContent();
  }
}

// --- reading an operator's body ----------------------------------------------
//
// Every write route below reads its body one member at a time. The rule is not
// a style preference: `JSON.parse<T>` refuses a document that carries a member
// the record does not declare as firmly as one that is missing a member it
// does, so a record type on a request body makes the API refuse the two things
// an admin console does most — echo back the row it just read (which carries
// the nested `model`, or a `candidates` array, or a field added next month),
// and send only the field the operator changed.
//
// `jsonMember` and not scan.ts's `jsonFind`, and that difference matters here
// where it does not on the thread doors: `jsonFind` searches at ANY depth, and
// a router body carries an array of objects with their own `configId` members.
// A top-level reader cannot mistake a candidate's config for the router's.
//
// A member holding the wrong TYPE reads as absent. That is the one place these
// are lenient, and it is bounded: the merged row is validated afterwards, so
// `{"maxTokens":"lots"}` keeps the stored number rather than writing a zero.

// A top-level string member, or `fallback` when the body does not carry one.
export function bodyText(body: string, key: string, fallback: string): string {
  let raw = jsonMember(body, key);
  if (raw.length < 2 || !raw.startsWith("\"")) { return fallback; }
  return jsonUnescape(raw.slice(1, raw.length - 1));
}

// A top-level member's raw text, with a string member unquoted.
//
// For `extra`, which is a text column holding whatever a provider accepts that
// this schema does not name. A console that sends it as an object means the
// object; one that sends it as a string means the string. Both end up as the
// text the column holds.
export function bodyJson(body: string, key: string, fallback: string): string {
  let raw = jsonMember(body, key);
  if (raw == "") { return fallback; }
  if (raw.length >= 2 && raw.startsWith("\"")) {
    return jsonUnescape(raw.slice(1, raw.length - 1));
  }
  return raw;
}

// A top-level bool. `"true"` is taken as well as `true`, because an HTML form
// serialised by hand sends the first and refusing it teaches nobody anything.
export function bodyBool(body: string, key: string, fallback: bool): bool {
  let raw = jsonMember(body, key).trim();
  if (raw == "true" || raw == "\"true\"") { return true; }
  if (raw == "false" || raw == "\"false\"") { return false; }
  return fallback;
}

export function bodyInt(body: string, key: string, fallback: int): int {
  let raw = jsonMember(body, key).trim();
  if (raw.length >= 2 && raw.startsWith("\"")) {
    raw = raw.slice(1, raw.length - 1).trim();
  }
  if (raw == "") { return fallback; }
  return parseInt(raw, 10) ?? fallback;
}

export function bodyNumber(body: string, key: string, fallback: number): number {
  let raw = jsonMember(body, key).trim();
  if (raw.length >= 2 && raw.startsWith("\"")) {
    raw = raw.slice(1, raw.length - 1).trim();
  }
  if (raw == "") { return fallback; }
  let parsed = parseFloat(raw);
  if (parsed == null) { return fallback; }
  let value: number = parsed;
  return value;
}

// Where a row sits in the menu, under either of its two names.
//
// The record's field is `rank` and the column is `menu_rank` — RANK is a window
// function in MySQL 8 and `createTableSql` does not quote identifiers, which is
// why the column was renamed and the field was not (schema.ts says so at
// length). That leaves two spellings loose in the world, and both arrive here:
// `rank` is what every GET emits, `menuRank` is what the column is called.
// Taking `rank` first keeps the round trip lossless.
export function bodyRank(body: string, fallback: int): int {
  if (jsonMember(body, "rank") != "") { return bodyInt(body, "rank", fallback); }
  return bodyInt(body, "menuRank", fallback);
}

// --- model configs, written ---------------------------------------------------

export function mergedConfig(stored: ModelConfigRow, body: string): ModelConfigRow {
  let out: ModelConfigRow = {
    // Never from the body. The path names the row; a body that disagrees is
    // refused at the door rather than allowed to rename anything.
    id: stored.id,
    modelId: bodyText(body, "modelId", stored.modelId),
    temperature: bodyNumber(body, "temperature", stored.temperature),
    maxTokens: bodyInt(body, "maxTokens", stored.maxTokens),
    topP: bodyNumber(body, "topP", stored.topP),
    extra: bodyJson(body, "extra", stored.extra),
    thinking: bodyText(body, "thinking", stored.thinking),
    label: bodyText(body, "label", stored.label),
    selectable: bodyBool(body, "selectable", stored.selectable),
    rank: bodyRank(body, stored.rank),
  };
  return out;
}

// Why a model config will not be written, in words, or "".
//
// Shared by the POST and the PUT so that the two doors cannot drift — the POST
// used to carry the model check inline and the PUT did not exist, which is how
// a rule ends up holding through one door and not the other.
//
// Deliberately NOT checked: that a `selectable` row has a label. Migration
// 87.21 turns `selectable` on for every config the derived menu covers and
// never writes `model_configs.label` — the menu row carries the words — so
// requiring one here would refuse an edit to rows this package created itself.
export function configProblem(db: Db, row: ModelConfigRow): string {
  if (row.modelId == "") { return "a modelId is required"; }
  if (!existsById(db, modelsMapping(), row.modelId)) {
    return "no model " + row.modelId + "; create it first";
  }
  if (row.maxTokens < 1) {
    return "maxTokens must be at least 1; a config that asks for no tokens cannot answer";
  }
  if (row.rank < 0) { return "menuRank cannot be negative"; }
  return "";
}

// --- the menu, written --------------------------------------------------------
//
// Who may call these: exactly whoever may already call `POST /model-configs`,
// `POST /models` and `PUT /models/:id` — which is anybody the process answers
// at all. `callerTags` is read by the thread, run and usage routes and by
// nothing else in this file; the operator's tables (`models`, `model_configs`,
// `agents`, `prompts`, `script_images`, `skills`) are deployment-global and
// unscoped, exactly as MODEL-CHOICE.md describes them, and the only lock in
// front of any of it is `AGENTS_API_TOKEN` — off by default, deployment-wide,
// not a caller.
//
// That posture is stated here rather than changed here. EDITIONS.md is explicit
// that identity belongs to the gateway and that the engine keeps not knowing
// what a user is ("community is authless on purpose"), so inventing a scope for
// these three routes would put a second, weaker answer to "who is calling" in a
// binary whose whole design is that it has none — and would leave the POST
// beside them wider than the PUT, which is the shape that actually gets
// exploited. If these should be operator-only, the change is one gate over
// every write route in this file, made once, and it is not this commit.

// Why a config cannot serve where it was named, in words, or "".
//
// `role` is the field that named it, because "no model config c-x" three times
// in one router tells an operator nothing about which of the three ids is
// wrong.
//
// The chat check is the one that would otherwise be found by a user: an
// embedding config in the menu is a row somebody picks and then gets an
// embedding endpoint's refusal from, per turn, until an operator reads a log.
export function chatConfigProblem(db: Db, configId: string, role: string): string {
  if (configId == "") { return role + " is required"; }
  let pair = configAndModel(db, configId);
  if (pair.problem != "") { return role + ": " + pair.problem; }
  if (pair.model.kind != "chat") {
    return role + ": model config " + configId + " runs on a \"" + pair.model.kind
      + "\" model, and only a chat model can answer a turn";
  }
  return "";
}

// The row a POST starts from: nothing stated, on the menu unless the body says
// otherwise. `kind` is "" rather than a default, so a create that does not say
// which kind of choice it is meets `choiceRowProblem` and is told.
export function blankChoice(id: string): ModelChoiceRow {
  let out: ModelChoiceRow = {
    id: id, label: "", description: "", kind: "", configId: "", routerId: "",
    tier: "", enabled: true, rank: 0,
  };
  return out;
}

export function mergedChoice(stored: ModelChoiceRow, body: string): ModelChoiceRow {
  let out: ModelChoiceRow = {
    id: stored.id,
    label: bodyText(body, "label", stored.label),
    description: bodyText(body, "description", stored.description),
    kind: bodyText(body, "kind", stored.kind),
    configId: bodyText(body, "configId", stored.configId),
    routerId: bodyText(body, "routerId", stored.routerId),
    tier: bodyText(body, "tier", stored.tier),
    enabled: bodyBool(body, "enabled", stored.enabled),
    rank: bodyRank(body, stored.rank),
  };
  return out;
}

// Why a menu row will not be written, in words, or "".
//
// Every one of these is a refusal rather than a repair, because the row IS the
// menu: a choice with no label is a blank line everybody sees, a "config"
// choice whose config was never created is an option that hard-fails every turn
// (run.ts refuses a dangling config by name rather than answering on something
// else), and a row with both ids set is the ambiguity `kind` exists to prevent.
export function choiceRowProblem(db: Db, row: ModelChoiceRow): string {
  if (row.label == "") { return "a choice needs a label; it is the word in the menu"; }
  if (row.tier != "" && row.tier != "premium") {
    return "tier is \"\" or \"premium\", not \"" + row.tier + "\"";
  }
  if (row.rank < 0) { return "menuRank cannot be negative"; }
  if (row.kind == "config") {
    if (row.routerId != "") {
      return "a \"config\" choice carries no routerId; clear it, or set kind to \"router\"";
    }
    return chatConfigProblem(db, row.configId, "configId");
  }
  if (row.kind == "router") {
    if (row.configId != "") {
      return "a \"router\" choice carries no configId; clear it, or set kind to \"config\"";
    }
    if (row.routerId == "") { return "routerId is required"; }
    if (!existsById(db, modelRoutersMapping(), row.routerId)) {
      return "no model router " + row.routerId + "; create it first";
    }
    return "";
  }
  return "kind is \"config\" or \"router\", not \"" + row.kind + "\"";
}

// Why a menu row cannot be deleted, in words, or "".
//
// The reference that would be stranded is `threads.model_choice_id`. It does
// not hard-fail — `chooseModel` answers "the agent's own" and writes a note for
// an id that names nothing, on purpose, because a conversation must not stop
// working because a menu changed — so this is not the same order of danger as
// `configInUse`. It is refused anyway, for one reason: the operator's actual
// intent is almost always "take this off the menu", `enabled` does exactly that
// without stranding anything, and the refusal names it. A DELETE is the only
// version of that intent which silently changes what somebody else's next turn
// runs on.
//
// `runs.model_choice_id` is deliberately NOT checked. A run is history; a row
// that can never be deleted once it has answered once is a table that only
// grows.
export function choiceInUse(db: Db, choiceId: string): string {
  if (countWhere(db, threadsMapping(), "model_choice_id = " + db.placeholder, [choiceId]) > 0) {
    return "model choice " + choiceId + " is what conversations are still set to; "
      + "take it off the menu instead — PUT /model-choices/" + choiceId
      + " with {\"enabled\":false} leaves those conversations running";
  }
  return "";
}

@controller("/model-choices")
class ChoiceApi {
  db: Db;
  constructor(db: Db) { this.db = db; }

  // EVERY row, disabled ones included, and the two ids the menu hides.
  //
  // Distinct from `GET /models/choices`, which is the user-facing menu: that
  // one filters to the enabled rows and refuses to put `configId` on the wire,
  // because a client that can see one will eventually post it back as a
  // `modelChoiceId`. This is the operator's list, and an operator who cannot
  // see the disabled rows cannot re-enable them.
  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("menu_rank"), asc("label")];
    return ok(listOrdered(this.db, modelChoicesMapping(), "", [], keys));
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, modelChoicesMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let row = mergedChoice(blankChoice(jsonId(req.body)), req.body);
    let wrong = choiceRowProblem(this.db, row);
    if (wrong != "") { return badRequest(wrong); }
    let written = persist(this.db, modelChoicesMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, modelChoicesMapping(), row.id));
  }

  @put("/:id")
  update(req: Request): Reply {
    let stored = findById(this.db, modelChoicesMapping(), param(req, "id"));
    if (stored == "") { return notFound("model choice " + param(req, "id")); }
    if (req.body == "") { return badRequest("a body is required"); }
    if (bodyText(req.body, "id", param(req, "id")) != param(req, "id")) {
      return badRequest("the id in the body must match the path");
    }
    let row = mergedChoice(JSON.parse<ModelChoiceRow>(stored), req.body);
    let wrong = choiceRowProblem(this.db, row);
    if (wrong != "") { return badRequest(wrong); }
    let written = persist(this.db, modelChoicesMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, modelChoicesMapping(), param(req, "id")));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, modelChoicesMapping(), param(req, "id"))) {
      return notFound("model choice " + param(req, "id"));
    }
    let used = choiceInUse(this.db, param(req, "id"));
    if (used != "") { return badRequest(used); }
    deleteById(this.db, modelChoicesMapping(), param(req, "id"));
    return noContent();
  }
}

// --- routers, written ---------------------------------------------------------
//
// The router is the part of MODEL-CHOICE.md that has no other way in: "a
// special type where we select a list of models and add a route description for
// each, and each request an LLM call decides which one to use". That list of
// pairs is `candidatesJson`, and over this API it is a real JSON array named
// `candidates` — not a string the client pre-encoded, which would make the one
// structure an operator actually edits the one thing the API could not check.
//
// Everything here is checked BEFORE the write and refused rather than repaired.
// The reason is asymmetric cost: a bad candidate is not a failed request that
// somebody retries, it is a menu entry that quietly routes wrong — or does not
// route at all — for every user of the deployment, and `routeTurn` is built to
// fall back silently rather than to complain.

// The row a POST starts from. `routeEvery` defaults to "turn", which is what
// MODEL-CHOICE.md describes and what the seeded router uses; "thread" is the
// deployment that would rather pay once.
export function blankRouter(id: string): ModelRouterRow {
  let out: ModelRouterRow = {
    id: id, label: "", routerConfigId: "", candidatesJson: "[]",
    fallbackConfigId: "", routeEvery: "turn", escalateOnly: false, enabled: true,
  };
  return out;
}

// The candidate array a body carries, as raw text, or what is already stored.
//
// Raw and unvalidated on purpose: `candidatesProblem` is what judges it, and
// judging it here would mean the merge decided what a valid router is.
export function bodyCandidates(body: string, fallback: string): string {
  let raw = jsonMember(body, "candidates");
  if (raw == "") { return fallback; }
  return raw;
}

// A body that sends the column instead of the list, refused by name.
//
// Accepting `candidatesJson` would accept a blob this API cannot look inside —
// which is the whole thing this route exists to stop — and ignoring it silently
// is worse: the operator's edit vanishes and the router goes on routing the way
// it did yesterday.
export function preEncodedCandidates(body: string): string {
  if (jsonMember(body, "candidatesJson") == "") { return ""; }
  return "candidatesJson is not accepted here; send \"candidates\" as a JSON array of "
    + "{key, configId, when}";
}

export function mergedRouter(stored: ModelRouterRow, body: string): ModelRouterRow {
  let out: ModelRouterRow = {
    id: stored.id,
    label: bodyText(body, "label", stored.label),
    routerConfigId: bodyText(body, "routerConfigId", stored.routerConfigId),
    candidatesJson: bodyCandidates(body, stored.candidatesJson),
    fallbackConfigId: bodyText(body, "fallbackConfigId", stored.fallbackConfigId),
    routeEvery: bodyText(body, "routeEvery", stored.routeEvery),
    escalateOnly: bodyBool(body, "escalateOnly", stored.escalateOnly),
    enabled: bodyBool(body, "enabled", stored.enabled),
  };
  return out;
}

// Why a candidate list will not be written, in words, or "".
//
// Every rule here is a failure `routeTurn` cannot report, because every failure
// path in that file leads to `fallbackConfigId` on purpose — so a router with a
// dud candidate does not throw, it just never picks that one, and the only
// symptom is that "Auto" answers a bit worse than it used to.
//
//   - a key that is empty can never be matched, so its candidate is prompt text
//     the model is not allowed to choose;
//   - two keys that differ only in case are ONE key to the router, because
//     `matchKey` and `indexOfKey` both fold case — so which of the two a reply
//     selects is whichever comes first, which is not a decision anybody made;
//   - a `when` that is empty is a candidate the routing model cannot choose on
//     purpose. This is the rule the human asked for by name, and it is the one
//     that matters most: `when` is the entire interface to the decision;
//   - a config that is missing, or is an embedding config, is a turn that
//     hard-fails or a menu row that quietly falls back for ever.
export function candidatesProblem(db: Db, candidatesJson: string): string {
  let text = candidatesJson.trim();
  if (text == "" || !text.startsWith("[")) {
    return "\"candidates\" must be a JSON array of {key, configId, when}";
  }
  let items = jsonList(text);
  if (items.length == 0) {
    return "a router needs at least one candidate; with none there is nothing for "
      + "the routing model to choose and every turn falls back";
  }
  let seen: string[] = [];
  let i: int = 0;
  while (i < items.length) {
    let item = items[i].trim();
    let at = "candidate " + `${i + 1}`;
    if (!item.startsWith("{")) { return at + " is not an object"; }
    let key = jsonText(item, "key").trim();
    if (key == "") { return at + " has no \"key\""; }
    let folded = key.toLowerCase();
    let j: int = 0;
    while (j < seen.length) {
      if (seen[j] == folded) {
        return at + " repeats the key \"" + key + "\"; the router matches keys "
          + "without regard to case, so two of them are one";
      }
      j = j + 1;
    }
    seen.push(folded);
    let named = at + " (\"" + key + "\")";
    if (jsonText(item, "when").trim() == "") {
      return named + " has no \"when\"; a candidate with no description is a "
        + "candidate the routing model cannot choose on purpose";
    }
    let unusable = chatConfigProblem(db, jsonText(item, "configId").trim(), named + " configId");
    if (unusable != "") { return unusable; }
    i = i + 1;
  }
  return "";
}

// Why a router will not be written, in words, or "".
//
// The candidate list is judged only for a router that is ON, and that
// exemption is the kill switch rather than a relaxation. `configInUse`
// deliberately does not guard a config named inside `candidatesJson` — three
// dialects of JSON function for a case run.ts already refuses by name — so a
// config a candidate names CAN be deleted while the router still lists it.
// Judging the whole stored list on every write then made the one action an
// operator needs unreachable: `PUT {"id":"rt-1","enabled":false}` answered 400
// "candidate 2 (\"deep\") configId: no model config c-deep", and the router
// went on spending a completion per turn until somebody reconstructed the
// array by hand. A router that is off routes nothing, so its candidates cannot
// be wrong about anything; turning it back on is a write, and this runs again.
export function routerRowProblem(db: Db, row: ModelRouterRow): string {
  if (row.label == "") { return "a router needs a label"; }
  if (row.routeEvery != "turn" && row.routeEvery != "thread") {
    return "routeEvery is \"turn\" or \"thread\", not \"" + row.routeEvery + "\"";
  }
  // The config that DOES the routing. Without it there is no call to make —
  // `routeChoice` writes a note and the menu's lead row never routes.
  let routing = chatConfigProblem(db, row.routerConfigId, "routerConfigId");
  if (routing != "") { return routing; }
  // And where every failure path lands. A router nobody gave a usable fallback
  // is a router that should not be enabled.
  let landing = chatConfigProblem(db, row.fallbackConfigId, "fallbackConfigId");
  if (landing != "") { return landing; }
  if (!row.enabled) { return ""; }
  return candidatesProblem(db, row.candidatesJson);
}

// The same row with its candidates rewritten as the three fields the router
// reads, in order.
//
// Called only after `candidatesProblem` has passed, so nothing is being
// repaired: what this drops is a member of a candidate object that is neither
// `key`, `configId` nor `when` — which `candidatesFrom` in router.ts already
// steps over, so it has never reached a routing prompt. Normalising it away on
// write means what a later GET shows is what the router actually sees.
export function withCanonicalCandidates(row: ModelRouterRow): ModelRouterRow {
  let items = jsonList(row.candidatesJson.trim());
  let list = "[";
  let i: int = 0;
  while (i < items.length) {
    if (i > 0) { list = list + ","; }
    list = list + "{\"key\":" + JSON.stringify(jsonText(items[i], "key").trim())
      + ",\"configId\":" + JSON.stringify(jsonText(items[i], "configId").trim())
      + ",\"when\":" + JSON.stringify(jsonText(items[i], "when").trim()) + "}";
    i = i + 1;
  }
  let out: ModelRouterRow = {
    id: row.id, label: row.label, routerConfigId: row.routerConfigId,
    candidatesJson: list + "]", fallbackConfigId: row.fallbackConfigId,
    routeEvery: row.routeEvery, escalateOnly: row.escalateOnly, enabled: row.enabled,
  };
  return out;
}

// A stored candidate column as it goes on the wire: the array itself, or an
// empty one when the column holds something that is not an array. Hand-written
// rows exist — this table was seeded by SQL — so "not an array" is a state a
// GET has to survive rather than a case that cannot happen.
function candidateArray(candidatesJson: string): string {
  let text = candidatesJson.trim();
  if (text.startsWith("[")) { return text; }
  return "[]";
}

// A router as the admin sees it: `candidates` is the array, in and out. What
// you PUT is what you GET, which is the property that lets a settings form read
// a row, change one `when` line and send it back.
export function routerJson(row: ModelRouterRow): string {
  return "{\"id\":" + JSON.stringify(row.id)
    + ",\"label\":" + JSON.stringify(row.label)
    + ",\"routerConfigId\":" + JSON.stringify(row.routerConfigId)
    + ",\"fallbackConfigId\":" + JSON.stringify(row.fallbackConfigId)
    + ",\"routeEvery\":" + JSON.stringify(row.routeEvery)
    + ",\"escalateOnly\":" + `${row.escalateOnly}`
    + ",\"enabled\":" + `${row.enabled}`
    + ",\"candidates\":" + candidateArray(row.candidatesJson) + "}";
}

export function routersJson(rows: ModelRouterRow[]): string {
  let out = "[";
  let i: int = 0;
  while (i < rows.length) {
    if (i > 0) { out = out + ","; }
    out = out + routerJson(rows[i]);
    i = i + 1;
  }
  return out + "]";
}

export function allRouters(db: Db): ModelRouterRow[] {
  let none: ModelRouterRow[] = [];
  let keys: DbOrder[] = [asc("label"), asc("id")];
  let listed = listOrdered(db, modelRoutersMapping(), "", [], keys);
  if (listed == "" || listed == "[]") { return none; }
  return JSON.parse<ModelRouterRow[]>(listed);
}

// Why a router cannot be deleted, in words, or "".
//
// `model_choices.router_id` is the only way anything names a router — a thread
// points at a choice, and the choice points here — so this one reference is the
// whole guard. Left unguarded it is the same class of break `configInUse`
// catches: the menu goes on offering "Auto", `chooseModel` goes on accepting
// it, and `routeChoice` finds no row, writes "the router rt-x is gone" into a
// note nobody reads, and answers on the agent's own model for every user, for
// ever.
export function routerInUse(db: Db, routerId: string): string {
  if (countWhere(db, modelChoicesMapping(), "router_id = " + db.placeholder, [routerId]) > 0) {
    return "router " + routerId + " is what a menu choice points at; delete or "
      + "repoint that choice first";
  }
  return "";
}

@controller("/model-routers")
class RouterApi {
  db: Db;
  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    return ok(routersJson(allRouters(this.db)));
  }

  @get("/:id")
  find(req: Request): Reply {
    let document = findById(this.db, modelRoutersMapping(), param(req, "id"));
    if (document == "") { return notFound("model router " + param(req, "id")); }
    return ok(routerJson(JSON.parse<ModelRouterRow>(document)));
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, modelRoutersMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let blob = preEncodedCandidates(req.body);
    if (blob != "") { return badRequest(blob); }
    let row = mergedRouter(blankRouter(jsonId(req.body)), req.body);
    let wrong = routerRowProblem(this.db, row);
    if (wrong != "") { return badRequest(wrong); }
    let written = persist(this.db, modelRoutersMapping(), JSON.stringify(withCanonicalCandidates(row)));
    if (!written.ok) { return badRequest(written.error); }
    return created(routerJson(JSON.parse<ModelRouterRow>(findById(this.db, modelRoutersMapping(), row.id))));
  }

  @put("/:id")
  update(req: Request): Reply {
    let stored = findById(this.db, modelRoutersMapping(), param(req, "id"));
    if (stored == "") { return notFound("model router " + param(req, "id")); }
    if (req.body == "") { return badRequest("a body is required"); }
    if (bodyText(req.body, "id", param(req, "id")) != param(req, "id")) {
      return badRequest("the id in the body must match the path");
    }
    let blob = preEncodedCandidates(req.body);
    if (blob != "") { return badRequest(blob); }
    let row = mergedRouter(JSON.parse<ModelRouterRow>(stored), req.body);
    let wrong = routerRowProblem(this.db, row);
    if (wrong != "") { return badRequest(wrong); }
    let written = persist(this.db, modelRoutersMapping(), JSON.stringify(withCanonicalCandidates(row)));
    if (!written.ok) { return badRequest(written.error); }
    return ok(routerJson(JSON.parse<ModelRouterRow>(findById(this.db, modelRoutersMapping(), param(req, "id")))));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, modelRoutersMapping(), param(req, "id"))) {
      return notFound("model router " + param(req, "id"));
    }
    let used = routerInUse(this.db, param(req, "id"));
    if (used != "") { return badRequest(used); }
    deleteById(this.db, modelRoutersMapping(), param(req, "id"));
    return noContent();
  }
}

// Why a model config cannot be deleted, in words, or "".
//
// An agent was the only thing this asked about, and the two it missed are the
// ones a person notices. A `model_choices` row is a LIVE MENU ENTRY: delete the
// config under it and the option is still offered, still picked, still accepted
// at the door — `choiceProblem` asks only whether the choice is enabled — and
// then hard-fails every turn with "no model config c-x", because run.ts
// deliberately refuses a dangling config by name rather than quietly answering
// on something else. Every message sent on "Fast" dies until an operator edits
// the table by hand.
//
// A router is the same failure one level down, on both of the columns it
// resolves by id: the routing call cannot be made without `routerConfigId`, and
// `fallbackConfigId` is where every failure path in router.ts lands.
//
// NOT guarded: a config named inside a router's `candidatesJson`. That is JSON
// in a text column, and asking three databases to look inside it is three
// dialects of JSON function with three failure modes — for a case run.ts
// already answers with a named refusal rather than a wrong model. The rows
// below are guarded because a menu row and a fallback fail EVERY turn; a dead
// candidate fails only the turns routed to it.
//
// Each sentence says what to do next, because a refusal that does not is a
// locked door.
export function configInUse(db: Db, configId: string): string {
  if (countWhere(db, agentsMapping(), "model_config_id = " + db.placeholder, [configId]) > 0) {
    return "config " + configId + " is used by an agent; repoint it first";
  }
  if (countWhere(db, modelChoicesMapping(), "config_id = " + db.placeholder, [configId]) > 0) {
    return "config " + configId + " is a row of the model menu; take the choice off the menu first";
  }
  if (countWhere(db, modelRoutersMapping(),
                 "router_config_id = " + placeholderAt(db, 1)
                 + " OR fallback_config_id = " + placeholderAt(db, 2),
                 [configId, configId]) > 0) {
    return "config " + configId + " is a router's own config or its fallback; repoint the router first";
  }
  return "";
}

@controller("/prompts")
class PromptApi {
  db: Db;
  constructor(db: Db) { this.db = db; }

  // All versions, or one name's versions newest first — the roll-back view.
  @get("/")
  list(req: Request): Reply {
    let name = queryParam(req, "name", "");
    if (name == "") {
      let keys: DbOrder[] = [asc("prompt_name"), asc("version")];
      return ok(listOrdered(this.db, promptsMapping(), "", [], keys));
    }
    let newest: DbOrder[] = [desc("version")];
    return ok(listOrdered(this.db, promptsMapping(), "prompt_name = " + this.db.placeholder, [name], newest));
  }

  // A prompt row is never edited, so the only write is a new version. Both
  // the version and the id are assigned here rather than taken from the
  // caller:
  //
  // - the version, because letting a caller pick one is how two writers both
  //   create version 4;
  // - the id, because a caller with no id to hand reaches for one it already
  //   knows, and an id that is already a row turns a create into an edit. A
  //   POST that reused an id was observed replacing version 3's text in place
  //   while every agent pointing at it silently changed behaviour. An id it
  //   sends is still honoured, and still refused if taken.
  @post("/")
  create(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let body: PromptRow = JSON.parse<PromptRow>(req.body);
    if (body.promptName == "") { return badRequest("promptName is required"); }
    if (body.body == "") { return badRequest("an empty prompt is not a version"); }
    let id = body.id;
    if (id == "") { id = crypto.randomUUID(); }
    if (existsById(this.db, promptsMapping(), id)) {
      return badRequest("prompt \"" + id + "\" already exists; a new version is a new row, so leave \"id\" out or send an unused one");
    }
    let next = 1 + maxVersion(this.db, body.promptName);
    let row: PromptRow = { id: id, promptName: body.promptName, version: next, body: body.body, createdAt: body.createdAt };
    let written = persist(this.db, promptsMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, promptsMapping(), id));
  }
}

// Bundles, installed from a manifest somebody else publishes.
//
// Four routes and no editing: a plugin is not a form. Its skills and its
// connectors are ordinary rows the moment they land, and they are edited —
// or refused, in the case of a skill a repository owns — through the routes
// that already own those tables. What is here is the acquisition: what is
// installed, install one, look before you install, take it back out.
@controller("/plugins")
class PluginApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("plugin_name")];
    return ok(listOrdered(this.db, pluginsMapping(), "", [], keys));
  }

  // What a plugin brought, by id, so the console can say "3 skills, 1
  // connector" without joining anything itself and can name them on the way
  // to a delete that will remove them.
  @get("/:id/items")
  items(req: Request): Reply {
    if (!existsById(this.db, pluginsMapping(), param(req, "id"))) {
      return notFound("plugin " + param(req, "id"));
    }
    let rows = itemsOf(this.db, param(req, "id"));
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      let name = "";
      if (rows[i].kind == "skill") {
        let held = findById(this.db, skillsMapping(), rows[i].itemId);
        if (held != "") { name = JSON.parse<SkillRow>(held).skillName; }
      } else {
        let held = findById(this.db, mcpServersMapping(), rows[i].itemId);
        if (held != "") { name = JSON.parse<McpServerRow>(held).serverName; }
      }
      // A receipt whose row is gone reads as "" and is still listed: it is
      // the honest answer to "what did this bring", and hiding it would make
      // a plugin look smaller than the mess it left.
      out = out + "{\"kind\":" + JSON.stringify(rows[i].kind)
        + ",\"itemId\":" + JSON.stringify(rows[i].itemId)
        + ",\"name\":" + JSON.stringify(name) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  // Read a manifest and say what installing it would do — without doing it.
  //
  // The confirm step exists because a manifest is somebody else's code path
  // into this deployment's skill table, and "install" with no preview is a
  // button that does an unknown number of unknown things. It is also where a
  // name collision surfaces while it is still cheap.
  @post("/inspect")
  inspect(req: Request): Reply {
    let url = jsonText(req.body, "sourceUrl");
    if (url.trim() == "") { return badRequest("a plugin is installed from a manifest URL"); }
    let got = fetchManifest(url);
    if (got.problem != "") { return badRequest(got.problem); }
    let m = manifestFrom(got.body);
    if (m.problem != "") { return badRequest(m.problem); }
    return ok(manifestJson(m, installProblem(this.db, m)));
  }

  @post("/install")
  add(req: Request): Reply {
    let url = jsonText(req.body, "sourceUrl");
    if (url.trim() == "") { return badRequest("a plugin is installed from a manifest URL"); }
    let got = fetchManifest(url);
    if (got.problem != "") { return badRequest(got.problem); }
    let m = manifestFrom(got.body);
    if (m.problem != "") { return badRequest(m.problem); }
    // Checked here and not only in the console: the console is one caller.
    let clash = installProblem(this.db, m);
    if (clash != "") { return badRequest(clash); }
    let made = install(this.db, m, manifestUrl(url), stamp());
    return created(findById(this.db, pluginsMapping(), made.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, pluginsMapping(), param(req, "id"))) {
      return notFound("plugin " + param(req, "id"));
    }
    uninstall(this.db, param(req, "id"));
    return noContent();
  }
}

// A read manifest, as the console reads it back.
function manifestJson(m: Manifest, clash: string): string {
  let out = "{\"name\":" + JSON.stringify(m.pluginName)
    + ",\"description\":" + JSON.stringify(m.description)
    + ",\"version\":" + JSON.stringify(m.version)
    + ",\"problem\":" + JSON.stringify(clash)
    + ",\"skills\":[";
  let i: int = 0;
  while (i < m.skills.length) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"name\":" + JSON.stringify(m.skills[i].skillName)
      + ",\"description\":" + JSON.stringify(m.skills[i].description)
      + ",\"files\":" + `${m.skills[i].files.length}` + "}";
    i = i + 1;
  }
  out = out + "],\"connectors\":[";
  let c: int = 0;
  while (c < m.connectors.length) {
    if (c > 0) { out = out + ","; }
    out = out + "{\"name\":" + JSON.stringify(m.connectors[c].serverName)
      + ",\"endpoint\":" + JSON.stringify(m.connectors[c].endpoint)
      + ",\"authKind\":" + JSON.stringify(m.connectors[c].authKind) + "}";
    c = c + 1;
  }
  return out + "]}";
}

// The one member PUT /servers/:id/mine reads.
type MineAsk = {
  token: string,
};

/* Ways of signing in that are not a password.
 *
 * The console's own auth reads this list at sign-in time and builds its
 * providers from it, so adding Google is a row and a secret rather than a
 * deploy. The secret is never returned by any route here — `configured` is
 * the only thing that can be known about it afterwards, exactly as with a
 * provider key or a connector token.
 */
@controller("/auth-providers")
class AuthProviderApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("label")];
    let rows = JSON.parse<AuthProviderRow[]>(listOrdered(this.db, authProvidersMapping(), "", [], keys));
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"id\":" + JSON.stringify(rows[i].id)
        + ",\"label\":" + JSON.stringify(rows[i].label)
        + ",\"issuer\":" + JSON.stringify(rows[i].issuer)
        + ",\"clientId\":" + JSON.stringify(rows[i].clientId)
        + ",\"scopes\":" + JSON.stringify(rows[i].scopes)
        + ",\"enabled\":" + (rows[i].enabled ? "true" : "false")
        + ",\"configured\":" + (hasCredential(this.db, "oauth:" + rows[i].id) ? "true" : "false") + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  // What the console's auth actually needs: the enabled rows WITH their
  // secrets, so it can complete an OAuth exchange. Its own route because it
  // is the one place a secret leaves this process, and the gateway admits
  // only the console's own server to it.
  @get("/resolved")
  resolved(req: Request): Reply {
    let rows = JSON.parse<AuthProviderRow[]>(listWhere(this.db, authProvidersMapping(),
      "enabled = " + placeholderAt(this.db, 1), ["1"]));
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      let secret = credentialFor(this.db, "oauth:" + rows[i].id, this.master);
      // A provider with no secret stored cannot complete a sign-in, and
      // offering its button would be offering a dead end.
      if (secret != "") {
        if (out.length > 1) { out = out + ","; }
        out = out + "{\"id\":" + JSON.stringify(rows[i].id)
          + ",\"label\":" + JSON.stringify(rows[i].label)
          + ",\"issuer\":" + JSON.stringify(rows[i].issuer)
          + ",\"clientId\":" + JSON.stringify(rows[i].clientId)
          + ",\"clientSecret\":" + JSON.stringify(secret)
          + ",\"scopes\":" + JSON.stringify(rows[i].scopes) + "}";
      }
      i = i + 1;
    }
    return ok(out + "]");
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, authProvidersMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let row: AuthProviderRow = JSON.parse<AuthProviderRow>(req.body);
    let bad = authProviderProblem(row);
    if (bad != "") { return badRequest(bad); }
    let written = persist(this.db, authProvidersMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, authProvidersMapping(), jsonId(req.body)));
  }

  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, authProvidersMapping(), param(req, "id"))) {
      return notFound("auth provider " + param(req, "id"));
    }
    let row: AuthProviderRow = JSON.parse<AuthProviderRow>(req.body);
    if (row.id != param(req, "id")) { return badRequest("the id in the body must match the path"); }
    let bad = authProviderProblem(row);
    if (bad != "") { return badRequest(bad); }
    let written = persist(this.db, authProvidersMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, authProvidersMapping(), param(req, "id")));
  }

  @put("/:id/secret")
  setSecret(req: Request): Reply {
    if (!existsById(this.db, authProvidersMapping(), param(req, "id"))) {
      return notFound("auth provider " + param(req, "id"));
    }
    let secret = jsonText(req.body, "clientSecret");
    if (secret == "") { return badRequest("a client secret is required"); }
    let stored = storeCredential(this.db, { provider: "oauth:" + param(req, "id"),
      apiKey: secret, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return ok("{\"configured\":true}");
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, authProvidersMapping(), param(req, "id"))) {
      return notFound("auth provider " + param(req, "id"));
    }
    forgetCredential(this.db, "oauth:" + param(req, "id"));
    deleteById(this.db, authProvidersMapping(), param(req, "id"));
    return noContent();
  }
}

// Why a provider row will not do, in words, or "".
export function authProviderProblem(row: AuthProviderRow): string {
  if (row.id.trim() == "") { return "a provider needs an id — it is what the callback URL carries"; }
  if (row.label.trim() == "") { return "a provider needs a label — it is what the sign-in button says"; }
  if (!row.issuer.startsWith("https://")) {
    return "the issuer is an https address whose /.well-known/openid-configuration describes the provider";
  }
  if (row.clientId.trim() == "") { return "a client id is required"; }
  return "";
}

@controller("/servers")
class ServerApi {
  db: Db;
  // Setting a server's auth writes its token to the encrypted store.
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("server_name")];
    return ok(listOrdered(this.db, mcpServersMapping(), "", [], keys));
  }

  // What this server offers, asked of the server itself.
  //
  // Not stored: an MCP server's tool list is its own to change, and a copy
  // here would be a second source of truth that goes stale silently. The
  // console draws what the server says right now, or says why it could not
  // be asked — an unreachable server and one with no tools look the same on
  // a graph and mean opposite things.
  @get("/:id/tools")
  tools(req: Request): Reply {
    let document = findById(this.db, mcpServersMapping(), param(req, "id"));
    if (document == "") { return notFound("no server " + param(req, "id")); }
    let server: McpServerRow = JSON.parse<McpServerRow>(document);
    let token = "";
    if (server.authKind != "" && server.authKind != "none") {
      // The caller's own token when they stored one — the listing should see
      // the same tools a run on their conversation will mount.
      let owner = owningTag(callerTags(req));
      if (owner != "") {
        token = credentialFor(this.db, userTokenKey(server.id, owner), this.master);
      }
      if (token == "") {
        token = credentialFor(this.db, "mcp:" + server.id, this.master);
      }
    }
    let listed = toolListing(server, token);
    let out = "{\"serverId\":" + JSON.stringify(server.id)
      + ",\"problem\":" + JSON.stringify(listed.problem) + ",\"tools\":[";
    let i: int = 0;
    while (i < listed.tools.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"name\":" + JSON.stringify(listed.tools[i].name)
        + ",\"description\":" + JSON.stringify(listed.tools[i].description) + "}";
      i = i + 1;
    }
    return ok(out + "]}");
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, mcpServersMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let body: McpServerRow = JSON.parse<McpServerRow>(req.body);
    // The same rule the update path applies. Accepting "stdio" here and
    // refusing it there let a server be created that could never afterwards be
    // saved — including the one the seed shipped.
    if (body.transport != "http") {
      return badRequest("this speaks http; \"" + body.transport + "\" needs a subprocess it cannot spawn");
    }
    let moved = serverDestinationProblem(this.db, body);
    if (moved != "") { return badRequest(moved); }
    let written = persist(this.db, mcpServersMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, mcpServersMapping(), jsonId(req.body)));
  }

  // How a server authenticates us. The token never lands in this table: it
  // goes through the same encrypted store as a provider key, under the
  // server's own id, because a secret beside the thing it authenticates is
  // decoration.
  @put("/:id/auth")
  setAuth(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: ServerAuth = JSON.parse<ServerAuth>(req.body);
    if (body.authKind != "none" && body.authKind != "bearer" && body.authKind != "header") {
      return badRequest("auth is none, bearer or header, not \"" + body.authKind + "\"");
    }
    if (body.authKind == "header" && body.authHeader.trim() == "") {
      return badRequest("a custom header needs a name");
    }
    if (body.authKind != "none" && body.token == "") {
      return badRequest("that auth kind needs a token");
    }
    executeWith(this.db, "UPDATE mcp_servers SET auth_kind = " + this.db.placeholder
      + ", auth_header = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [body.authKind, body.authHeader, param(req, "id")]);
    if (body.authKind == "none") {
      // Switching a server to no auth used to leave the token in the store,
      // where nothing ever read it again and nothing ever deleted it — until
      // the kind was switched back, or the id was reused.
      forgetCredential(this.db, "mcp:" + param(req, "id"));
      return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
    }
    let stored = storeCredential(this.db, { provider: "mcp:" + param(req, "id"),
      apiKey: body.token, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
  }

  // The caller's OWN token for this server — the per-person half of auth.
  //
  // The deployment's token (PUT /:id/auth above) is one credential everybody
  // rides, which is right for a company Jira and wrong for a personal GitHub:
  // one account, one rate limit, one audit trail, shared by every user. This
  // pair of routes lets a signed-in person store a token that is theirs —
  // used for THEIR conversations, fallback to the shared one for everyone
  // else. Keyed by (server, owner) in the same encrypted store, and never
  // read back, exactly like every other credential here.
  //
  // No :owner in the path, ever: the owner is whoever the verified header
  // says is asking. A route that took the owner as a parameter would be a
  // route for writing other people's credentials.
  @put("/:id/mine")
  setMine(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    let owner = owningTag(callerTags(req));
    if (owner == "") {
      return badRequest("a personal token needs a signed-in person — this deployment saw nobody");
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let asked: MineAsk = JSON.parse<MineAsk>(req.body);
    if (asked.token == "") {
      return badRequest("a token is required — to stop using your own, DELETE this route instead");
    }
    let stored = storeCredential(this.db, { provider: userTokenKey(param(req, "id"), owner),
      apiKey: asked.token, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return ok("{\"stored\":true}");
  }

  // Whether the caller has one stored — true/false and nothing else, because
  // the token itself can never be read back.
  @get("/:id/mine")
  mine(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    let owner = owningTag(callerTags(req));
    if (owner == "") { return ok("{\"stored\":false}"); }
    let has = hasCredential(this.db, userTokenKey(param(req, "id"), owner));
    return ok("{\"stored\":" + (has ? "true" : "false") + "}");
  }

  @del("/:id/mine")
  forgetMine(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    let owner = owningTag(callerTags(req));
    if (owner == "") { return badRequest("nobody is signed in, so there is nothing of theirs to forget"); }
    forgetCredential(this.db, userTokenKey(param(req, "id"), owner));
    return noContent();
  }

  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let row: McpServerRow = JSON.parse<McpServerRow>(req.body);
    if (row.id != param(req, "id")) {
      return badRequest("the id in the body must match the path");
    }
    if (row.serverName.trim() == "") { return badRequest("a server needs a name"); }
    // Only the transport the client actually speaks. Offering one it refuses
    // is offering a server that mounts no tools and says why only at run time.
    if (row.transport != "http") {
      return badRequest("this speaks http; \"" + row.transport + "\" needs a subprocess it cannot spawn");
    }
    if (row.endpoint.trim() == "") { return badRequest("a server needs an endpoint"); }
    let moved = serverDestinationProblem(this.db, row);
    if (moved != "") { return badRequest(moved); }
    let written = persist(this.db, mcpServersMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    forgetServer(this.db, param(req, "id"));
    return noContent();
  }
}

// The highest version a prompt name has, 0 when it has none.
function maxVersion(db: Db, name: string): int {
  let newest: DbOrder[] = [desc("version")];
  let page = pageOrdered(db, promptsMapping(), "prompt_name = " + db.placeholder, [name], newest, 1, 0);
  if (page == "" || page == "[]") { return 0; }
  let rows: PromptRow[] = JSON.parse<PromptRow[]>(page);
  if (rows.length == 0) { return 0; }
  return rows[0].version;
}

// --- which model a conversation runs on --------------------------------------
//
// One field, `modelChoiceId`, on the two doors that already exist, and no route
// of its own. The composer's picker is used BEFORE the thread exists on a new
// conversation, so a PUT would be a request the console could not make at the
// moment a person makes the choice — the selection travels with the message
// instead (MODEL-CHOICE.md, "API").
//
// This is the door's half only: reading the field off a body, and refusing an
// id that names nothing. What the field MEANS — message over thread over the
// agent's own, and what happens when the row is gone — is `chooseModel` in
// threads.ts, deliberately in one place, and it is not repeated here.

// The choice a body names, or "" for "no id".
//
// Read off the raw body rather than declared on a record, and BOTH halves of
// that rule are load-bearing. `JSON.parse<T>` refuses a document missing a
// member the record declares — so adding the field to a body record would
// refuse every request that leaves it out. It also refuses a document carrying
// a member the record does NOT declare, which is the half that was missed and
// the more expensive one: `{ text: string }` parsed against
// `{"text":"hi","modelChoiceId":""}` throws UnknownField, and that is the body
// the console sends on every single message. Declaring the field breaks the
// old callers; not declaring it breaks the new ones. So neither thread door
// parses its body into a narrow record at all — each reads the members it
// wants, exactly as `fromTemplate` reads `templateId`.
//
// Verified rather than reasoned about: both record types were run verbatim
// under `lumen run` against both body shapes.
export function askedChoice(body: string): string {
  if (body == "") { return ""; }
  return jsonText(body, "modelChoiceId");
}

// Whether the body said anything about the model at all — which is a different
// question from what it said, and the difference is the menu's last row.
//
// "Agent default" is a real choice a person makes, and the only value the wire
// can carry for it is "". If "" meant "the caller said nothing" then picking it
// would leave the thread's memory in place and the next turn would answer on
// the model the person just moved away from, for ever: there would be no value
// on the wire meaning "clear". So absence and "" are separated here, one field
// still, read twice:
//
//   field absent  -> keep answering with whatever the thread last chose
//   field present -> this is the choice, "" included, and the thread learns it
//
// The console always sends the field (`say` in app/src/api.ts), so it is
// always making a statement; a curl that leaves it out inherits, which is what
// every request written before this feature does.
export function choiceWasSent(body: string): bool {
  if (body == "") { return false; }
  return jsonFind(body, "modelChoiceId") >= 0;
}

// The two halves together, in the shape `runInThreadWith` takes them.
export function askedPick(body: string): ModelPick {
  let pick: ModelPick = { choiceId: askedChoice(body), sent: choiceWasSent(body) };
  return pick;
}

// Why a chosen menu row will not be accepted, in words, or "".
//
// The door refuses what `chooseModel` tolerates, and the asymmetry is the point
// rather than an inconsistency to be tidied away. A thread that has pointed at
// a row since before the operator retired it must keep running — so the
// RESOLVER falls back to the agent's own model and writes a route note, because
// a conversation must not stop working because a menu changed. But a request
// arriving now with a `modelChoiceId` is a claim that the row exists now, made
// by a client that could have reloaded the menu; answering it on the agent's
// default while the composer reads "Thinking" tells the person nothing, and the
// only symptom is a picker that appears not to work. One is a memory, and it is
// absorbed; the other is an assertion, and it is answered.
//
// "Offered" is asked over the menu itself — the same read `GET /models/choices`
// answers with and the same one threads.ts resolves against — rather than by
// re-deciding it from a row's columns here. Two definitions of "offered" agree
// right up until somebody adds a condition to one of them.
export function choiceProblem(db: Db, choiceId: string): string {
  if (choiceId == "") { return ""; }
  let offered = enabledChoices(db);
  let i: int = 0;
  while (i < offered.length) {
    if (offered[i].id == choiceId) { return ""; }
    i = i + 1;
  }
  // The row is read only to tell the two mistakes apart, never to decide: an
  // id a client invented and a menu the operator changed under a console that
  // has not reloaded want different sentences, and "not offered" against an id
  // that was never a row would send somebody looking for a row to re-enable.
  if (findById(db, modelChoicesMapping(), choiceId) == "") {
    return "no model choice " + choiceId;
  }
  return "model choice " + choiceId + " is not offered";
}

// A conversation that continues.
//
// The whole context is replayed into every turn — the tool calls, their
// results, the passages — so a follow-up means what it says. The transcript a
// person reads is the same rows with the working left out.
@controller("/threads")
class ThreadApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  // The sidebar's list: id, agent, when, and the first thing the user said.
  // Conversations their owners have offered as starting points.
  //
  // Declared before every "/:id" route in this controller, and that is a hard
  // requirement rather than tidiness: "replayable" is a literal where ":id" is
  // a parameter, and the router refuses at startup a table whose literal is
  // written second — the parameter would shadow it. `GET /threads/by-turn`
  // carries the same note for the same reason.
  //
  // Unscoped by owner, because that is what being offered means. What it does
  // not carry is WHO offered each one: an owner tag is an opaque identifier a
  // gateway minted, not a name anybody chose to publish.
  @get("/replayable")
  replayable(req: Request): Reply {
    let limit = parseInt(queryParam(req, "limit", "50")) ?? 50;
    let rows = listReplayable(this.db, limit);
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"id\":" + JSON.stringify(rows[i].id)
        + ",\"agentId\":" + JSON.stringify(rows[i].agentId)
        + ",\"createdAt\":" + JSON.stringify(rows[i].createdAt)
        + ",\"title\":" + JSON.stringify(rows[i].title)
        + ",\"replayable\":true}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  // Offer this conversation, or stop offering it. The owner's decision, and
  // `ownedThread` is what proves it is theirs — the same gate every other
  // write to a thread goes through, so an operator with no tag on a community
  // box can still mark one and a tagged caller can only mark their own.
  @put("/:id/replayable")
  offer(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required: {\"replayable\":true}"); }
    // `jsonRaw`, never `jsonText`: this member is a JSON BOOLEAN, and jsonText
    // answers "" for anything that is not a string — so it returns "" for true
    // and "" for false alike. Written with jsonText first, this read said "on"
    // for every body including {"replayable":false}, which made offering a
    // conversation irreversible. Caught by putting both halves of the loop in
    // one prod check rather than only the half that turns it on.
    let on = jsonRaw(req.body, "replayable") == "true";
    let wrong = markReplayable(this.db, param(req, "id"), on);
    if (wrong != "") { return badRequest(wrong); }
    return ok("{\"id\":" + JSON.stringify(param(req, "id"))
      + ",\"replayable\":" + (on ? "true" : "false") + "}");
  }

  // Start a conversation of your own from somebody else's offered one.
  //
  // No `ownedThread` here, deliberately, and it is the only door in this file
  // that reads another owner's rows: the flag IS the authorisation, and it is
  // checked inside `remixThread` beside the read it permits rather than here,
  // so no future caller can forget it. What comes back is a thread owned by
  // whoever asked.
  @post("/:id/remix")
  remix(req: Request): Reply {
    let made = remixThread(this.db, { sourceId: param(req, "id"),
      owner: owningTag(callerTags(req)), now: stamp() });
    if (made.threadId == "") { return notFound(made.problem); }
    return created("{\"id\":" + JSON.stringify(made.threadId)
      + ",\"files\":" + `${made.files}` + "}");
  }

  @get("/")
  list(req: Request): Reply {
    let limit = parseInt(queryParam(req, "limit", "50")) ?? 50;
    let offset = parseInt(queryParam(req, "offset", "0")) ?? 0;
    // No sweep here, and nowhere else on a request path: a read that destroys
    // rows is, the moment threads have owners, one person's sidebar deleting
    // somebody else's conversations. Where an operator asks for one it runs on
    // a thread of its own; see `sweepLoop`.
    let rows = listThreads(this.db, { tags: callerTags(req), limit: limit, offset: offset });
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"id\":" + JSON.stringify(rows[i].id)
        + ",\"agentId\":" + JSON.stringify(rows[i].agentId)
        + ",\"createdAt\":" + JSON.stringify(rows[i].createdAt)
        + ",\"title\":" + JSON.stringify(rows[i].title)
        + ",\"replayable\":" + (rows[i].replayable ? "true" : "false") + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  @post("/")
  open(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required: {\"agentId\":\"a1\"}"); }
    // Read member by member, never parsed into `{ agentId: string }`. A record
    // type refuses a document that carries a key it does not declare, and this
    // body carries `modelChoiceId` whenever the composer had a model showing —
    // so the narrow parse answered 400 to exactly the requests the field was
    // added for. See `askedChoice`.
    let agentId = jsonText(req.body, "agentId");
    if (agentId == "") { return badRequest("a body is required: {\"agentId\":\"a1\"}"); }
    if (!existsById(this.db, agentsMapping(), agentId)) {
      return badRequest("no agent " + agentId);
    }
    // Optional. A conversation is usually opened with the picker already
    // showing something, so the first message must not have to re-state it.
    let chosen = askedChoice(req.body);
    let refused = choiceProblem(this.db, chosen);
    if (refused != "") { return badRequest(refused); }
    // Stamped with the caller's own tag, never with the whole set it may read:
    // a shared thread has one owner.
    let id = openThread(this.db, { agentId: agentId, owner: owningTag(callerTags(req)), now: stamp() });
    if (id == "") { return badRequest("the thread could not be opened"); }

    // A second statement rather than an argument to `openThread`, which
    // deliberately takes none: the picker travels with the message, so the
    // field is written by whichever door was used and there is exactly one
    // place — `rememberChoice` — that writes it.
    let kept = chosen;
    if (chosen != "") {
      // Not a 400 when the UPDATE fails, and that is deliberate. The thread
      // exists by now, so a 400 says "nothing happened", which is false: a
      // console that retries opens a second conversation and the first is an
      // orphan the sweeper is off by default to collect. The reply instead
      // says what was actually stored, and "" arriving at a composer showing
      // "Thinking" is a disagreement a client can see and act on.
      if (rememberChoice(this.db, id, chosen) != "") { kept = ""; }
    }
    return created("{\"id\":" + JSON.stringify(id) + ",\"agentId\":" + JSON.stringify(agentId)
      + ",\"modelChoiceId\":" + JSON.stringify(kept) + "}");
  }

  // What the run is doing right now.
  //
  // Polled while `POST /:id/messages` is still in flight, which is the only
  // way to see inside a round: that request answers once, at the end. The
  // answer is the round's dispatched calls, each either open — no `endedAt` —
  // or closed with how long it took.
  //
  // Steps belong to a round, never to a thread at large: every row carries its
  // `seq`, which is the same number an artifact of that round carries, so a
  // card joins to the message that produced it exactly as an artifact card
  // does.
  //
  // `?seq=` names a round. `?seq=all` is the whole transcript, for a console
  // that has just reloaded and needs a card above every message that called
  // something. Without either, the newest round — what a console watching the
  // message it just sent wants. A thread that has never called a tool answers
  // an empty list rather than a 404: having nothing to show is the ordinary
  // case, not a mistake.
  @get("/:id/steps")
  steps(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let asked = queryParam(req, "seq", "");
    let round = latestRound(this.db, param(req, "id"));
    let live: LiveStep[] = [];
    let thoughts: Thought[] = [];
    if (asked == "all") {
      // The whole transcript's worth, so a reloaded conversation draws a card
      // above every message that called something, not only the last one.
      // The reasoning comes with it: `round` is NONE here, so asking for one
      // round's thoughts would answer none, and a reload would come back with
      // the calls and none of the thinking.
      round = TURN_SEQ_NONE;
      live = stepsOfThread(this.db, param(req, "id"));
      thoughts = thoughtsOfThread(this.db, param(req, "id"));
    } else {
      if (asked != "") { round = parseInt(asked, 10) ?? -1; }
      if (round >= 0) {
        live = stepsOfRound(this.db, param(req, "id"), round);
        thoughts = thoughtsOfRound(this.db, param(req, "id"), round);
      }
    }
    return ok("{\"seq\":" + `${round}`
      + ",\"running\":" + boolJson(roundRunning(live))
      + ",\"thoughts\":" + thoughtsJson(thoughts)
      + ",\"steps\":" + stepsJson(live) + "}");
  }

  // Ask the thread. The reply is this turn's answer; the transcript is a GET.
  @post("/:id/messages")
  say(req: Request): Reply {
    let tags = callerTags(req);
    let agentId = ownedThread(this.db, param(req, "id"), tags);
    if (agentId == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required: {\"text\":\"...\"}"); }
    // Member by member, never `JSON.parse<{ text: string }>`: the console's
    // send always carries `modelChoiceId` too, and a record refuses a document
    // holding a key it does not declare. See `askedChoice`.
    let text = jsonText(req.body, "text");
    if (text == "") { return badRequest("nothing to ask: \"text\" is empty"); }

    // What the composer's picker was showing when this was sent, and whether
    // it said anything at all — the second half is what makes "Agent default"
    // reachable. Refused by name for the reason `choiceProblem` records.
    let pick = askedPick(req.body);
    let noSuchChoice = choiceProblem(this.db, pick.choiceId);
    if (noSuchChoice != "") { return badRequest(noSuchChoice); }

    // ---- THE PREMIUM GATE GOES HERE, AND NOWHERE ELSE ----
    //
    // `model_choices.tier` is "" or "premium", and MODEL-CHOICE.md puts
    // enforcement at the point a choice is APPLIED rather than in the menu:
    // `GET /models/choices` above serves premium rows to everybody so the
    // console can render the lock and say what upgrading buys, and this line
    // is what the lock would MEAN.
    //
    // Nothing is checked today, deliberately, and not as an oversight to be
    // tidied up later: there is no billing anywhere in this codebase, and the
    // community edition will never have any (EDITIONS.md) — so a check
    // invented here would be a guess at an interface that does not exist, and
    // `tier` is inert on a laptop running Ollama by design. When editions do
    // price a row (LICENSING.md), the check belongs on this line: read the
    // chosen row, and if its tier is "premium" and this caller's edition does
    // not include it, refuse HERE — which is before the turn below applies it,
    // remembers it, and spends a provider call on it.

    let tracer = tracerFor(this.db, this.master);
    // Handed to the turn rather than written here first. Applying the choice
    // and remembering it are one act, and `runInThreadWith` is where that act
    // lives — it resolves the precedence, keeps the pick only if it survived
    // resolution, and hands back what was in force. A door that wrote the
    // column itself would be a second writer of one field, and the two would
    // disagree the first time a rule was added to only one of them.
    let answered = runInThreadWith(this.db, param(req, "id"), {
      userText: text, master: this.master, tracer: tracer, pick: pick,
    });
    let run = answered.run;
    // The run log keeps the RAW reply — `run.text`, fences and bodies intact —
    // because the log is the audit trail of what the model actually said.
    // Extraction's notes fold in beside the run's own, so a refused fence is
    // read where an operator reads every other warning about the run.
    // The run is filed under the THREAD's owner, not the caller's tag: once
    // sharing exists a guest may ask a question in somebody else's
    // conversation, and the run belongs to the conversation.
    //
    // The decision travels into the row rather than being recomputed from the
    // config that answered: "the run used c-gemini-flash" is not the claim
    // "a person chose Fast", and only the second is what an eval seeded from
    // real traffic can read (MODEL-CHOICE.md, "Evaluation"). This is also the
    // only place a silent fallback — a retired menu row, a router that did not
    // route, a dangling config — is written down at all; the wire below is
    // read once by a client and discarded.
    let runId = recordRun(this.db, {
      agentId: agentId, threadId: param(req, "id"),
      owner: threadOwner(this.db, param(req, "id")),
      question: text, run: withNotes(run, answered.notes),
      modelChoiceId: answered.modelChoiceId, routeNote: answered.routeNote,
    });

    let traced = "";
    if (tracing(tracer) && run.spans.length > 0) {
      if (flush(tracerWithMoreSpans(tracer, run.spans)).ok) { traced = traceId(tracer); }
    }
    // The wire answers the rewritten text with its nonce stripped, plus the
    // refs a card resolves by. Never `run.text`: the raw reply is the log's,
    // and the marker's nonce must not reach a DOM.
    let view = wireView(answered.text);
    return ok("{\"runId\":" + JSON.stringify(runId)
      + ",\"ok\":" + `${run.ok}`
      + ",\"text\":" + JSON.stringify(view.text)
      + ",\"refs\":" + refsJson(view.refs)
      + ",\"seq\":" + `${answered.baseSeq}`
      // Which menu row this turn ran under, "" for the agent's own — the
      // decision as it was made, not as it was asked for. Echoed because a
      // composer that sent a choice needs to know it took, and one that sent
      // none is being told what the thread remembered.
      + ",\"modelChoiceId\":" + JSON.stringify(answered.modelChoiceId)
      // Why the model that answered was the one that did, "" when there is
      // nothing to explain. This is what the round card's "routed → Thinking"
      // row is drawn from, and the only place a fallback is said out loud to
      // the person who chose.
      + ",\"routeNote\":" + JSON.stringify(answered.routeNote)
      + ",\"toolCalls\":" + `${run.steps.length}`
      + ",\"steps\":" + stepsJson(stepsOfRound(this.db, param(req, "id"), answered.baseSeq))
      + ",\"thoughts\":" + thoughtsJson(thoughtsOfRound(this.db, param(req, "id"), answered.baseSeq))
      + ",\"inputTokens\":" + `${run.inputTokens}`
      + ",\"outputTokens\":" + `${run.outputTokens}`
      + ",\"traceId\":" + JSON.stringify(traced)
      + ",\"error\":" + JSON.stringify(run.error) + "}");
  }

  // What a person reads: the questions and the answers. The tool calls and the
  // passages are in the trace, which is where somebody debugging looks.
  //
  // Each message carries its stored seq and its structured refs, and its text
  // passes through wireView — the reference nonce stays on the server, and a
  // client maps cards by slot@version from `refs`, never by text order.
  //
  // An OBJECT, and it was the bare array that `messages` still holds. A
  // conversation's current choice is a fact about the thread and not about any
  // one message, and an array has nowhere to put one. The alternatives were a
  // second round trip for a single field, or a response header — and a header
  // is where facts go to be forgotten. Reopening a conversation has to show
  // the picker set to what was last chosen, or the memory the column exists
  // for is invisible.
  //
  // The console reads `.messages` where it used to read the body: `transcript`
  // in app/src/api.ts, and the conversation page's SSR loader in
  // app/pages/c/[id].ts, which fetches the same route as the person asking.
  //
  // `routeNote` — why a routed round picked what it picked — joins here when
  // the router lands. `runs.route_note` is already the column it comes from.
  //
  // `title` joins for the same reason `modelChoiceId` did: it is a fact about
  // the thread with nowhere to sit on a message, and a conversation page that
  // wants its own name in the header would otherwise have to list every thread
  // to find one. "" for a conversation nobody named, which is what the sidebar
  // already falls back on; the LIST route serves the fallback text and this one
  // serves the column, because a header showing the first message back to the
  // person who typed it is noise rather than a name.
  @get("/:id")
  transcript(req: Request): Reply {
    // `readableThread`, not `ownedThread`: a conversation somebody offered as a
    // starting point can be READ by anyone, which is what makes a Starting
    // point openable rather than only remixable. Every write to a thread still
    // goes through `ownedThread` — the two are separate functions precisely so
    // that widening reading cannot widen writing by accident.
    if (readableThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    // Whose it is, so the console knows whether to draw a composer or a Remix
    // button. Computed here because the client cannot: it never sees an owner
    // tag, deliberately.
    let mine = ownedThread(this.db, param(req, "id"), callerTags(req)) != "";
    let said: ThreadTurnRow[] = threadMessageRows(this.db, param(req, "id"));
    let out = "[";
    let i: int = 0;
    while (i < said.length) {
      if (i > 0) { out = out + ","; }
      // Assistant rows only. Storage neutralises lookalike markers in the
      // assistant reply, so a genuine marker there is extraction's own — but
      // a USER row is stored verbatim, and running the marker-to-card
      // conversion over it would let pasted third-party text mint a
      // "[saved …]" caption and a card for any slot@version the thread
      // holds. A user's words are served as words, with no refs.
      if (said[i].role == "assistant") {
        let view = wireView(said[i].text);
        out = out + "{\"role\":" + JSON.stringify(said[i].role)
          + ",\"seq\":" + `${said[i].seq}`
          + ",\"text\":" + JSON.stringify(view.text)
          + ",\"refs\":" + refsJson(view.refs) + "}";
      } else {
        let none: WireRef[] = [];
        out = out + "{\"role\":" + JSON.stringify(said[i].role)
          + ",\"seq\":" + `${said[i].seq}`
          + ",\"text\":" + JSON.stringify(said[i].text)
          + ",\"refs\":" + refsJson(none) + "}";
      }
      i = i + 1;
    }
    return ok("{\"modelChoiceId\":" + JSON.stringify(threadChoice(this.db, param(req, "id")))
      + ",\"title\":" + JSON.stringify(threadTitle(this.db, param(req, "id")))
      + ",\"mine\":" + (mine ? "true" : "false")
      + ",\"messages\":" + out + "]}");
  }
}

// A run with more notes folded in. A copy, because records are immutable and
// the extraction notes belong to the round, not to the run that produced the
// raw text — they meet only in the log.
function withNotes(run: AgentRun, more: string[]): AgentRun {
  let notes: string[] = [];
  let i: int = 0;
  while (i < run.notes.length) { notes.push(run.notes[i]); i = i + 1; }
  let m: int = 0;
  while (m < more.length) { notes.push(more[m]); m = m + 1; }
  let out: AgentRun = {
    ok: run.ok, text: run.text, body: run.body, status: run.status,
    agentName: run.agentName, promptVersion: run.promptVersion,
    modelApiName: run.modelApiName, error: run.error,
    context: run.context, retrieved: run.retrieved, steps: run.steps,
    stopReason: run.stopReason, rounds: run.rounds,
    inputTokens: run.inputTokens, outputTokens: run.outputTokens,
    notes: notes, calledTools: run.calledTools, calledAgents: run.calledAgents,
    spans: run.spans,
  };
  return out;
}

// References as the wire carries them.
function refsJson(refs: WireRef[]): string {
  let out = "[";
  let i: int = 0;
  while (i < refs.length) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"slot\":" + `${refs[i].slot}`
      + ",\"version\":" + `${refs[i].version}`
      + ",\"path\":" + JSON.stringify(refs[i].path) + "}";
    i = i + 1;
  }
  return out + "]";
}

// The files a conversation is working on: uploaded by the user, written by
// the model with its write_file tool, or pulled in from the corpus.
//
// Every route here opens with `ownedThread`, before it looks at a name or a
// body. Three of them used to resolve the file straight out of
// `workspace_files` by (thread, name) — correct about which row, silent about
// whose — so a conversation id was the whole of the authorisation to read,
// delete or publish somebody else's upload.
@controller("/threads/:id/files")
class WorkspaceApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @get("/")
  list(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let files = listFiles(this.db, param(req, "id"));
    let out = "[";
    let i: int = 0;
    while (i < files.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"name\":" + JSON.stringify(files[i].fileName)
        + ",\"mime\":" + JSON.stringify(files[i].mime)
        + ",\"origin\":" + JSON.stringify(files[i].origin)
        + ",\"bytes\":" + `${files[i].body.length}`
        + ",\"documentId\":" + JSON.stringify(files[i].documentId) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  // Upload. The body is JSON text; a binary file needs base64 at this edge and
  // is not pretended to work.
  @post("/")
  upload(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required: {\"name\":\"notes.md\",\"content\":\"...\"}"); }
    let body: FileUpload = JSON.parse<FileUpload>(req.body);
    let problem = putFile(this.db, { threadId: param(req, "id"), fileName: body.name, mime: mimeOf(body.name), origin: "uploaded", body: body.content, documentId: "", now: stamp() });
    if (problem != "") { return badRequest(problem); }
    return created("{\"name\":" + JSON.stringify(body.name) + ",\"bytes\":" + `${body.content.length}` + "}");
  }

  @get("/:name")
  read(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let file = getFile(this.db, param(req, "id"), param(req, "name"));
    if (file.id == "") { return notFound("file " + param(req, "name")); }
    return ok("{\"name\":" + JSON.stringify(file.fileName)
      + ",\"mime\":" + JSON.stringify(file.mime)
      + ",\"origin\":" + JSON.stringify(file.origin)
      + ",\"content\":" + JSON.stringify(file.body) + "}");
  }

  @del("/:name")
  remove(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (getFile(this.db, param(req, "id"), param(req, "name")).id == "") {
      return notFound("file " + param(req, "name"));
    }
    deleteFile(this.db, param(req, "id"), param(req, "name"));
    return noContent();
  }

  // Pull a corpus document into the workspace, as a pointer with its body. The
  // agent can then read it whole, which retrieval never offers.
  @post("/pull")
  pull(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (this.db.name != "postgres") {
      return badRequest("the corpus needs PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    let body: FilePull = JSON.parse<FilePull>(req.body);
    let document = findById(this.db, documentsMapping(), body.documentId);
    if (document == "") { return badRequest("no document " + body.documentId); }
    let content = jsonText(document, "body");
    let problem = putFile(this.db, { threadId: param(req, "id"), fileName: body.name, mime: mimeOf(body.name), origin: "retrieved", body: content, documentId: body.documentId, now: stamp() });
    if (problem != "") { return badRequest(problem); }
    return created("{\"name\":" + JSON.stringify(body.name) + ",\"documentId\":" + JSON.stringify(body.documentId) + "}");
  }

  // Make a file part of the corpus, under a scope. Explicit, never a side
  // effect of saving: this is the moment a conversation's artifact becomes
  // team knowledge, and the file's documentId is the audit trail.
  @post("/:name/promote")
  promote(req: Request): Reply {
    // Ownership first, even before the dialect check: which database this runs
    // on is not something a caller with no business here needs told.
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (this.db.name != "postgres") {
      return badRequest("the corpus needs PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    if (req.body == "") { return badRequest("a body is required: {\"scope\":\"/specs\",\"modelId\":\"e1\"}"); }
    let body: FilePromote = JSON.parse<FilePromote>(req.body);
    let embedder = embeddingModel(this.db, body.modelId);
    if (embedder.id == "") { return badRequest("no usable embedding model " + body.modelId); }
    let key = credentialFor(this.db, embedder.provider, this.master);
    if (key == "") { return badRequest("no credential for " + embedder.provider); }

    let stored = promoteFile(this.db, embedder, param(req, "id"), param(req, "name"), body.scope, key, stamp());
    if (!stored.ok) { return badRequest(stored.error); }
    return ok("{\"name\":" + JSON.stringify(param(req, "name"))
      + ",\"scope\":" + JSON.stringify(normalScope(body.scope))
      + ",\"chunks\":" + `${stored.chunks}` + "}");
  }
}

// The artifact a slot names, or a row whose id is "". Callers test `id == ""`.
//
// A slot and not a path in the URL, because the slot is the number a tab keeps
// while a title is edited and a path is a second thing to escape. There is no
// index on (thread_id, slot) and no lookup for it in the storage module, so
// this walks the list a tab strip already reads — a thread holds a handful of
// artifacts, and a scan of a handful is not worth an index that would then
// have to be kept honest against the slot-reuse bug the module documents.
function artifactAtSlot(db: Db, threadId: string, slot: int): ArtifactRow {
  let absent: ArtifactRow = {
    id: "", threadId: "", slot: -1, path: "", title: "", kind: "", mime: "",
    currentVersion: 0, previewToken: "", createdAt: "", updatedAt: "",
  };
  if (slot < 0) { return absent; }
  let rows = listArtifacts(db, threadId);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].slot == slot) { return rows[i]; }
    i = i + 1;
  }
  return absent;
}

// A slot from the URL, or -1 when it is not a number. -1 matches nothing:
// every stored slot counts up from 0.
function slotParam(req: Request): int {
  return parseInt(param(req, "slot")) ?? -1;
}

// An artifact's identity as JSON. The body is never in here — a listing that
// carried half a megabyte per row is why the versions table stores `bytes`.
function artifactJson(a: ArtifactRow): string {
  return "{\"slot\":" + `${a.slot}`
    + ",\"path\":" + JSON.stringify(a.path)
    + ",\"title\":" + JSON.stringify(a.title)
    + ",\"kind\":" + JSON.stringify(a.kind)
    + ",\"mime\":" + JSON.stringify(a.mime)
    + ",\"version\":" + `${a.currentVersion}`
    + ",\"previewToken\":" + JSON.stringify(a.previewToken)
    + ",\"createdAt\":" + JSON.stringify(a.createdAt)
    + ",\"updatedAt\":" + JSON.stringify(a.updatedAt) + "}";
}

// What a conversation produced, over the API. This is the console's view:
// metadata, bodies as JSON, and the token that builds a preview link. It never
// serves an artifact as itself — that is the preview host's job, below, and
// keeping the two apart is the whole of the containment.
@controller("/threads/:id/artifacts")
class ArtifactApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let rows = listArtifacts(this.db, param(req, "id"));
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + artifactJson(rows[i]);
      i = i + 1;
    }
    return ok(out + "]");
  }

  // Save a body at a path. A path that already exists gets a new version, not
  // a second artifact, and the reply carries the version number so a caller
  // knows which of two concurrent saves it won.
  @post("/")
  create(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"path\":\"/report.html\",\"title\":\"Q3\",\"content\":\"...\",\"note\":\"\"}");
    }
    let body: ArtifactPost = JSON.parse<ArtifactPost>(req.body);
    // "uploaded", always. This route is a person with a console; the model's
    // writes come through the tool and say "generated". The distinction is the
    // only thing in a version row that answers "who wrote this", so a route
    // that let the caller name its own origin would erase it.
    let written = putArtifact(this.db, {
      threadId: param(req, "id"), path: body.path, title: body.title,
      content: body.content, note: body.note, origin: "uploaded",
      // A person may deliberately re-upload a path — that IS a new version.
      mustCreate: false,
      // A console upload happens outside any conversation round, so there is
      // no turn for the version row to point at.
      turnSeq: TURN_SEQ_NONE, now: stamp(),
    });
    if (!written.ok) { return badRequest(written.problem); }
    return created("{\"slot\":" + `${written.slot}`
      + ",\"path\":" + JSON.stringify(normalScope(body.path))
      + ",\"version\":" + `${written.version}`
      + ",\"previewToken\":" + JSON.stringify(written.previewToken) + "}");
  }

  // Start this conversation from a template: its files land as version 1,
  // in one call, before anything is said. "uploaded" for the same reason the
  // route above is — a template is a person choosing a starting point, and
  // nothing generated it.
  //
  // Partial application is possible and deliberate: a template whose third
  // file is refused still lays down the first two, and the reply names what
  // did not land. The alternative — a transaction across artifact writes —
  // would make one bad path lose the whole start.
  @post("/from-template")
  fromTemplate(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let templateId = jsonText(req.body, "templateId");
    if (templateId == "") { return badRequest("a body is required: {\"templateId\":\"tpl-...\"}"); }
    let held = findById(this.db, templatesMapping(), templateId);
    if (held == "") { return notFound("template " + templateId); }
    let tpl: TemplateRow = JSON.parse<TemplateRow>(held);
    if (tpl.visibility != "public") { return notFound("template " + templateId); }

    let where = "template_id = " + placeholderAt(this.db, 1);
    let listed = listWhere(this.db, templateFilesMapping(), where, [templateId]);
    let files: TemplateFileRow[] = listed == "" ? [] : JSON.parse<TemplateFileRow[]>(listed);
    let wrote = "";
    let refused = "";
    let i: int = 0;
    while (i < files.length) {
      let put = putArtifact(this.db, {
        threadId: param(req, "id"), path: files[i].path, title: files[i].title,
        content: files[i].body, note: "started from template " + tpl.label,
        origin: "uploaded", mustCreate: false, turnSeq: TURN_SEQ_NONE, now: stamp(),
      });
      if (put.ok) {
        if (wrote != "") { wrote = wrote + ","; }
        wrote = wrote + JSON.stringify(normalScope(files[i].path));
      } else {
        if (refused != "") { refused = refused + ","; }
        refused = refused + JSON.stringify(files[i].path + ": " + put.problem);
      }
      i = i + 1;
    }
    return created("{\"template\":" + JSON.stringify(tpl.label)
      + ",\"skillName\":" + JSON.stringify(tpl.skillName)
      + ",\"wrote\":[" + wrote + "]"
      + ",\"refused\":[" + refused + "]}");
  }

  // Which versions each round produced — the join a chat client renders its
  // cards from, one query for the whole conversation. `?turn=N` narrows to one
  // round. Console uploads never appear: no round made them.
  //
  // Declared before the slot routes on purpose. "/by-turn" is a literal where
  // ":slot" is a parameter, and the router refuses at startup a table whose
  // literal is written second — the parameter would shadow it.
  @get("/by-turn")
  byTurn(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let turn = queryParam(req, "turn", "");
    let rows: TurnArtifact[] = [];
    if (turn == "") {
      rows = artifactsByTurn(this.db, param(req, "id"));
    } else {
      // A turn that is not a number reads as TURN_SEQ_NONE, which the read
      // guards against and answers with nothing — the honest reply to a
      // question about a round that does not exist.
      rows = artifactsForTurn(this.db, param(req, "id"), parseInt(turn) ?? TURN_SEQ_NONE);
    }
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"turnSeq\":" + `${rows[i].turnSeq}`
        + ",\"slot\":" + `${rows[i].slot}`
        + ",\"path\":" + JSON.stringify(rows[i].path)
        + ",\"title\":" + JSON.stringify(rows[i].title)
        + ",\"kind\":" + JSON.stringify(rows[i].kind)
        + ",\"version\":" + `${rows[i].version}` + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  @get("/:slot")
  find(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }
    return ok(artifactJson(artifact));
  }

  // One version, body included. JSON, on the console origin, whatever the
  // artifact's own type is — a caller that wants it rendered follows the
  // preview link.
  @get("/:slot/versions/:n")
  version(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }
    let row = getVersion(this.db, artifact.id, parseInt(param(req, "n")) ?? 0);
    if (row.id == "") { return notFound("version " + param(req, "n")); }
    return ok("{\"slot\":" + `${artifact.slot}`
      + ",\"path\":" + JSON.stringify(artifact.path)
      + ",\"version\":" + `${row.version}`
      + ",\"bytes\":" + `${row.bytes}`
      + ",\"origin\":" + JSON.stringify(row.origin)
      + ",\"turnSeq\":" + `${row.turnSeq}`
      + ",\"note\":" + JSON.stringify(row.note)
      + ",\"createdAt\":" + JSON.stringify(row.createdAt)
      + ",\"content\":" + JSON.stringify(row.body) + "}");
  }

  // One office document as a PDF, base64, converted by the platform.
  //
  // The console draws .docx and .pptx from this rather than laying them out
  // itself: LibreOffice is the engine those formats were written against, and
  // a JavaScript re-implementation of one can be close but never right. See
  // office-render.ts for what runs and how it is contained.
  //
  // Base64 rather than the PDF's own bytes, and that is not a preference: a
  // Lumen string is UTF-8 and a PDF is not, so binary cannot ride a Reply at
  // all. It is the same boundary every binary artifact already crosses — the
  // store holds text, the viewer holds bytes — and the browser decodes it
  // where pdf.js wants an array.
  //
  // `?v=` pins a version and no `v` means the current one, matching the
  // preview route's rule. A pinned answer is immutable and says so; the
  // unpinned one is not cached at the edge because it follows the artifact.
  // The conversion underneath is cached either way, forever, because its key
  // is a version that can never be rewritten.
  //
  // A conversion is seconds of CPU in a container, so this is deliberately
  // behind the owner guard like every other route on this controller — the
  // token-addressed preview host does not offer it. Somewhere that hands out
  // a capability URL should not also hand out an unauthenticated way to make
  // the box run LibreOffice.
  @get("/:slot/pdf")
  pdf(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }
    let asked = parseInt(queryParam(req, "v", "")) ?? 0;
    let version = asked > 0 ? asked : artifact.currentVersion;
    let row = getVersion(this.db, artifact.id, version);
    if (row.id == "") { return notFound("version " + `${version}`); }

    let ask: OfficeRenderAsk = {
      artifactId: artifact.id, version: version,
      path: artifact.path, body: row.body, now: stamp(),
    };
    let made = officeRender(this.db, ask);
    // A refusal is a sentence a reader can act on — "is the image built",
    // "this document may be corrupt" — so it is answered as one rather than
    // as a 500 the console would render as a blank panel.
    if (!made.ok) { return badRequest(made.problem); }
    let out = ok("{\"slot\":" + `${artifact.slot}`
      + ",\"path\":" + JSON.stringify(artifact.path)
      + ",\"version\":" + `${version}`
      + ",\"cached\":" + (made.cached ? "true" : "false")
      + ",\"pdf\":" + JSON.stringify(made.body) + "}");
    if (asked > 0) {
      out.headers.set("cache-control", "private, max-age=31536000, immutable");
    }
    return out;
  }

  // Mint a new preview token, so every link handed out so far stops resolving.
  //
  // The token survives saving on purpose — a link shared with a reader must
  // not break because the author edited — which leaves this as the only way to
  // take one back after it reaches somebody it was not meant for.
  //
  // `persist` is right here and wrong one table over: the identity row is a
  // pointer where the last writer wins, so an upsert on the same id is the
  // intent. The versions log is append-only and takes an explicit INSERT.
  @post("/:slot/rotate")
  rotate(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }

    // Only the two columns this route owns, by UPDATE — not the whole row.
    //
    // `persist` is an upsert of every column, so writing the row back here
    // wrote `current_version` back too, from a value read before the update.
    // A run appending version 6 between that read and this write had its
    // pointer rewound to 5: the v6 row stayed in the table with nothing
    // pointing at it, preview and read_artifact both served v5 with no error,
    // and the next write took 7 — so 6 was orphaned, invisible in the version
    // strip, and the agent's own "saved as version 6" referred to something no
    // reader could reach. `title` and `updatedAt` were clobbered the same way.
    // Every token in the thread, not just this one.
    //
    // A token resolves any artifact in its thread by path, so revoking one
    // artifact's link while its neighbours' links still reach it revokes
    // nothing: share /preview/<B>/, decide /a.html is sensitive, rotate
    // /a.html — and /preview/<B>/a.html still serves it. A control named
    // "New link" that leaves the content reachable is worse than none, because
    // it is believed.
    //
    // So rotation is thread-wide, which is the honest shape of a thread-wide
    // capability: every link previously handed out for this conversation stops
    // working together. Rotating one row alone is only correct if a token ever
    // addresses one row again.
    let now = stamp();
    // `listWhere` answers one JSON array, so the rows are scanned out of it.
    let mine = jsonList(listWhere(this.db, artifactsMapping(),
      "thread_id = " + placeholderAt(this.db, 1), [param(req, "id")]));
    let fresh = "";
    let i: int = 0;
    while (i < mine.length) {
      let each: ArtifactRow = JSON.parse<ArtifactRow>(mine[i]);
      let token = crypto.randomUUID();
      if (each.id == artifact.id) { fresh = token; }
      let turned = executeWith(this.db,
        "UPDATE artifacts SET preview_token = " + placeholderAt(this.db, 1)
        + ", updated_at = " + placeholderAt(this.db, 2)
        + " WHERE id = " + placeholderAt(this.db, 3),
        [token, now, each.id]);
      if (!turned.ok) { return badRequest("the links could not be replaced; try again"); }
      i = i + 1;
    }
    return ok("{\"slot\":" + `${artifact.slot}`
      + ",\"previewToken\":" + JSON.stringify(fresh)
      + ",\"replaced\":" + `${mine.length}` + "}");
  }

  // The artifact and every version it ever had. There is no undo.
  @del("/:slot")
  remove(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }
    let problem = deleteArtifact(this.db, param(req, "id"), artifact.path);
    if (problem != "") { return badRequest(problem); }
    return noContent();
  }
}

// Everything an artifact is allowed to do once a browser has it: run the
// script that came in the same document, style itself, draw images it carries
// inline — and reach nothing. No origin to fetch from, no form to post to, no
// base to rewrite relative URLs against, and a sandbox without same-origin, so
// the document cannot read a cookie or a storage entry belonging to the host
// it was served from even when that host is the preview host.
//
// `script-src 'unsafe-inline'` reads alarming and is the point: an artifact is
// one self-contained document, its script is part of the body an author wrote,
// and `default-src 'none'` has already removed every way to load another one.
//
// This is the policy when there is no preview host, and it is also the policy
// on every other host a preview is ever reachable from. Nothing below relaxes
// it except on the one host an operator configured for exactly that.
const PREVIEW_CSP_CLOSED: string = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

// The configured preview host, trimmed and lowercased, or "" when there is
// none. Compared as a whole string including the port — see `previewType`.
function previewHost(): string {
  let configured = process.env("AGENTS_PREVIEW_HOST") ?? "";
  let text = configured.trim().toLowerCase();
  // The variable may be given as a bare host or as a whole origin. Only the
  // host part is ever compared against the request's own Host header, which
  // never carries a scheme.
  let mark = text.indexOf("://");
  if (mark >= 0) { return text.substring(mark + 3, text.length); }
  return text;
}

// Whether this request arrived on the preview host.
//
// One predicate, because the content type and the policy have to agree about
// what "the preview host" means: a request answered text/html under the closed
// policy could not load the stylesheet it names, and a request answered
// text/plain under the relaxed one would have widened the policy for a document
// nothing can run anyway. Two copies of this comparison would eventually
// disagree about a trailing dot, a case, or a port.
//
// Fail-closed in every direction: no configuration, no Host, or any mismatch,
// and the answer is false.
function onPreviewHost(req: Request): bool {
  let configured = previewHost();
  if (configured == "") { return false; }
  let asked = header(req, "host").trim().toLowerCase();
  if (asked == "") { return false; }
  return asked == configured;
}

// The preview host as a CSP source expression: a scheme and a host.
//
// A source list needs an origin, and AGENTS_PREVIEW_HOST holds no scheme —
// it is compared against the Host header, which has none either. A bare
// `example.com:9443` in a source list is legal but parses as host:port and
// matches http and https alike, which is looser than anything here intends, so
// a scheme is supplied: https, unless the host names the loopback, where a
// developer is running plain http and demanding https would break the only
// deployment that has no certificate.
//
// Deriving it rather than adding a second environment variable keeps the origin
// that appears in the policy and the host that unlocked it from ever naming two
// different places.
function previewOrigin(): string {
  let configured = (process.env("AGENTS_PREVIEW_HOST") ?? "").trim().toLowerCase();
  if (configured == "") { return ""; }
  // Said outright when the variable carries a scheme. Guessing it is what this
  // used to do, and the guess is unrecoverable when wrong: the policy names an
  // origin the browser never asked, so every stylesheet and script the page
  // references is refused, and the only evidence is a console message inside a
  // sandboxed frame nobody has open. An operator serving previews over plain
  // http on a hostname that is not localhost had no way to say so.
  if (configured.indexOf("://") >= 0) { return configured; }
  let host = previewHost();
  let name = host;
  let colon = host.indexOf(":");
  if (colon >= 0) { name = host.substring(0, colon); }
  // Still a guess, but only for the shorthand form, and https is the guess
  // that fails closed: a page served over http against an https policy loses
  // its subresources, which is visible, rather than the reverse.
  if (name == "localhost" || name == "127.0.0.1") { return "http://" + host; }
  return "https://" + host;
}

// The policy for one request.
//
// Off the preview host, exactly the closed policy above — an artifact is one
// self-contained document and cannot reach anything at all.
//
// On the preview host, an artifact is a small site: its siblings are served
// from that same origin under the same token, so `img-src`, `style-src`,
// `script-src` and `font-src` name that origin and a relative `css/main.css`
// loads. What does not change is everything that governs where the document can
// send data or be re-pointed: `connect-src 'none'`, `form-action 'none'`,
// `base-uri 'none'`, and a sandbox without `allow-same-origin`. Reading
// siblings is the capability the token already grants; talking to the network
// is not, and widening one is not an argument for widening the other.
//
// The origin is written out because 'self' cannot work here. `sandbox
// allow-scripts` without `allow-same-origin` gives the document an opaque
// origin, and 'self' matches the document's own origin — which for an opaque
// origin is nothing at all. A policy written with 'self' would look correct,
// pass review, and block every subresource.
function previewCsp(req: Request): string {
  if (!onPreviewHost(req)) { return PREVIEW_CSP_CLOSED; }
  let origin = previewOrigin();
  return "default-src 'none'"
    + "; script-src 'unsafe-inline' " + origin
    + "; style-src 'unsafe-inline' " + origin
    // Images may come from anywhere. This is the one relaxation of
    // self-containment, and it is deliberate: a model asked for a picture
    // from the web answered that it could not, and wrote a CSS cat instead —
    // the restriction was producing worse pages, not safer ones. An <img> is
    // a passive subresource: it cannot read the page, cannot reach /api, and
    // the sandbox's opaque origin means it carries no cookie. What it does
    // cost is a request to a third party carrying the reader's address, so
    // the tool still teaches fetching-and-saving as the better habit —
    // referrer-policy: no-referrer on every preview keeps the token out of
    // that request either way. Scripts, styles and fonts stay local: those
    // can read the document.
    + "; img-src data: blob: https: http: " + origin
    + "; font-src data: " + origin
    // connect-src used to be 'none'. The live reload below polls a version
    // stamp on this same origin, and that is the one connection a preview may
    // make: the preview origin itself, nothing else.
    + "; connect-src " + origin
    + "; form-action 'none'; base-uri 'none'; sandbox allow-scripts";
}

// The content type a preview answers with.
//
// The stored mime is what the artifact *is*; sending it is only safe on an
// origin that holds nothing worth stealing. text/html on the preview host is a
// page alone in its own sandbox. The same bytes on the console origin are
// script running next to the console's session. So the request's own Host
// decides, and everything else gets text/plain and is read, not run.
//
// The comparison is against the WHOLE host, port included, and is exact.
//
// It used to strip the port, on the reasoning that moving the listener should
// not silently change the content type. That was backwards: the port is part
// of the origin, and given a deployment with one process, a second port is the
// obvious way an operator makes a "separate preview host". With the port
// stripped, a console on example.com and previews on example.com:9443 compare
// equal — so a request to the *console* origin is answered text/html, which is
// the one thing this function exists to prevent. Cookies are not partitioned
// by port, so that is the worst case available.
//
// Everything about this is fail-closed. An unset variable, a Host the proxy
// rewrote, a mismatch of any kind: text/plain. The failure mode of a
// misconfiguration is an artifact you can read but not run, never the reverse.
function previewType(req: Request, mime: string): string {
  if (!onPreviewHost(req)) { return "text/plain; charset=utf-8"; }
  return mime;
}

// A preview, with the headers that make it safe to look at.
//
// `nosniff` matters most on the text/plain path: without it a browser is free
// to sniff a leading "<html" back into markup, which undoes the Host check
// before any policy is consulted. `no-referrer` keeps the token — which is the
// entire authorisation — out of the Referer header of anything the page links
// to. No access-control-allow-origin is set, here or anywhere: a token in a
// URL is a capability, and letting another origin read the response with
// script would hand that capability to whatever page a reader had open.
//
// `artifact` is the row the body came from, which for a sibling is the sibling
// and not the artifact the token names. Every preview answer goes through here
// so a sibling cannot end up with a weaker policy or its neighbour's type — a
// stylesheet answered text/html is a script the sandbox would then run.
// The chrome a live page carries: a poller that reloads when ANY artifact of
// the conversation gains a version, and a click handler that keeps the base
// route — an author writes <a href="/menu.html"> and the browser would leave
// /preview/<token>/ for the host's own root, where nothing lives.
//
// Injected only into a CURRENT html body on the preview host. A pinned ?v= is
// history and history does not reload; a sibling stylesheet is not a document;
// off the preview host everything is text/plain and runs nothing anyway.
// `newest` and not `stamp`: `stamp()` is a function in this module, and a
// parameter that shadows it resolved to the function under some compilations —
// JSON.stringify of a function, concatenated into a string, and a type error
// pointing at the return rather than at the name.
function previewChrome(token: string, newest: string): string {
  return "\n<script>(function(){"
    + "var base='/preview/'+" + JSON.stringify(token) + ";"
    + "var was=" + JSON.stringify(newest) + ";"
    + "setInterval(function(){fetch(base+'/__version',{cache:'no-store'})"
    + ".then(function(r){return r.text()})"
    + ".then(function(v){if(v!==was){location.reload()}})"
    + ".catch(function(){})},2000);"
    + "document.addEventListener('click',function(e){"
    + "var a=e.target&&e.target.closest?e.target.closest('a'):null;"
    + "if(!a){return}var h=a.getAttribute('href');"
    + "if(h&&h.charAt(0)==='/'&&h.indexOf('/preview/')!==0){e.preventDefault();location.href=base+h}"
    + "},true);"
    + "})()</script>";
}

// One value that moves when anything in the thread's artifact log moves. The
// log is append-only and rows are never rewritten, so the row count IS the
// stamp: any write anywhere in the conversation changes it.
function previewStamp(db: Db, threadId: string): string {
  let sql = "SELECT COUNT(*) FROM artifact_versions"
    + " JOIN artifacts ON artifacts.id = artifact_versions.artifact_id"
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1);
  if (!db.query(sql, [threadId])) { return "0"; }
  if (db.rows() == 0) { return "0"; }
  return db.value(0, 0);
}

function previewIsHtml(mime: string): bool {
  return mime.startsWith("text/html");
}

// An image artifact served as a page. The stored body is base64 text; raw
// image bytes never ride a Reply (a Lumen string is UTF-8 and a PNG is not),
// so the browser gets a page whose data: URI carries them — which the CSP
// already allows (img-src data:). Off the preview host this is never called
// and the base64 text is served as the text it is.
function previewImagePage(artifact: ArtifactRow, b64: string): string {
  return "<!doctype html><html><head><title>" + artifact.path + "</title></head>"
    + "<body style=\"margin:0;display:grid;place-items:center;min-height:100vh;background:#181a1d\">"
    + "<img alt=\"" + artifact.path + "\" style=\"max-width:100%;max-height:100vh\""
    + " src=\"data:" + imageMediaType(artifact.path) + ";base64," + b64 + "\"></body></html>";
}

// The artifact, with its body as a page when it is an image on the preview
// host: the wrapper is html, so the row it is served under says html too —
// that is what previewType and the live chrome read.
function previewPresentable(req: Request, artifact: ArtifactRow, body: string): ArtifactRow {
  if (artifact.kind != "image" || !onPreviewHost(req)) { return artifact; }
  let asPage: ArtifactRow = {
    id: artifact.id, threadId: artifact.threadId, slot: artifact.slot,
    path: artifact.path, title: artifact.title, kind: artifact.kind,
    mime: "text/html; charset=utf-8", currentVersion: artifact.currentVersion,
    previewToken: artifact.previewToken, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
  };
  return asPage;
}

function previewReply(req: Request, artifact: ArtifactRow, body: string, cache: string): Reply {
  let answer = reply(200, body, previewType(req, artifact.mime));
  answer.headers.set("content-security-policy", previewCsp(req));
  answer.headers.set("x-content-type-options", "nosniff");
  answer.headers.set("referrer-policy", "no-referrer");
  answer.headers.set("cache-control", cache);
  return answer;
}

// A preview answered as bytes rather than as text.
//
// Same headers as every other preview — the CSP, nosniff, no referrer — because
// none of those stop being true for a document. What it does NOT get is the
// live chrome: that is a script appended to an HTML body, and appending it to a
// PDF would corrupt the file rather than reload it.
function previewBytes(req: Request, bytes: string, mime: string, cache: string): Reply {
  let answer = reply(200, bytes, mime);
  answer.headers.set("content-security-policy", previewCsp(req));
  answer.headers.set("x-content-type-options", "nosniff");
  answer.headers.set("referrer-policy", "no-referrer");
  answer.headers.set("cache-control", cache);
  return answer;
}

// previewReply, plus the live chrome when this body qualifies for it. An
// image is wrapped into a page first, so it reloads like any other page.
function previewLiveReply(db: Db, req: Request, artifact: ArtifactRow, body: string, cache: string): Reply {
  // A document, served as the document.
  //
  // This is the binary path, and it exists because the alternative was the
  // reported defect: a .pdf preview answered a screen of base64, because the
  // stored body IS base64 and the route served the text it found. Two things
  // had to be true for this to work, and both were checked before it was
  // written rather than assumed:
  //
  //  * A Lumen string carries arbitrary BYTES to the socket. The server writes
  //    `Content-Length: res.body.len` and `writeAll(res.body)` with no
  //    transcoding and no UTF-8 validation (lumen_runtime_net.zig), so the
  //    "a string is UTF-8 and a PDF is not" note elsewhere in this package is
  //    about string OPERATIONS, not about the wire.
  //  * `crypto.base64Decode` is in the language (spec 474 — it is
  //    NAMESPACED, which is the ten minutes this cost). office-render.ts shells
  //    out to `base64 -d` for an unrelated reason — it needs a file on disk —
  //    which is what made this look impossible at first glance.
  //
  // Only on the preview host. Off it, `previewType` still answers text/plain
  // for everything, so this cannot be used to serve a document as itself from
  // the console's own origin.
  if (onPreviewHost(req)) {
    if (artifact.kind == "pdf") {
      return previewBytes(req, crypto.base64Decode(body), "application/pdf", cache);
    }
    // An office document is converted first, through the same LibreOffice pass
    // and the same immutable cache the artifact panel and the template
    // thumbnails already use — so the first open of one pays ~2s and every
    // open after it is a database read.
    if (artifact.kind == "office" && officeRenderExt(artifact.path) != "") {
      let made = officeRender(db, { artifactId: artifact.id, version: artifact.currentVersion,
        path: artifact.path, body: body, now: stamp() });
      if (made.ok) {
        return previewBytes(req, crypto.base64Decode(made.body), "application/pdf", cache);
      }
      // A box with no converter still answers, with the sentence saying why
      // rather than with a page of base64 nobody can read.
      return previewBytes(req, made.problem, "text/plain; charset=utf-8", cache);
    }
  }
  let row = previewPresentable(req, artifact, body);
  let served = body;
  if (row.kind == "image" && row.mime.startsWith("text/html")) {
    served = previewImagePage(row, body);
  }
  if (cache == "no-store" && previewIsHtml(row.mime) && onPreviewHost(req)) {
    served = served + previewChrome(param(req, "token"), previewStamp(db, row.threadId));
  }
  return previewReply(req, row, served, cache);
}

// Artifacts as themselves, addressed by token.
//
// There is no thread id on one of these requests and nothing to check it
// against: the token is the whole of the authorisation, which is why it is a
// UUID minted per artifact and why `rotate` above exists. Nothing here reports
// which tokens are wrong — an unknown token and a deleted artifact answer
// identically, and neither answer repeats the token back into a log.
//
// A token also opens the artifact's siblings, meaning every artifact in the
// same thread, addressed by path under the token's own prefix. That is what
// makes a document with a stylesheet work at all, and it is a real widening: a
// link shared once grants read of every artifact in that conversation, not just
// the one the link names. It is the price of relative URLs resolving the way an
// author wrote them, and `rotate` is still the answer when a link gets out.
//
// Deliberately outside the owner guard, then — the one place in this file a
// `/threads/:id/...` resolution is not what decides. A token is a capability:
// whoever holds it reads the thread's artifacts, owner or not, which is the
// whole point of handing a link to a reader who has no account. Said here
// rather than left for someone to discover, because "the owner check covers
// everything" would be false and this is where it is false.
@controller("/preview")
class PreviewApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // The artifact the token names.
  //
  // `?v=3` pins a version, and a version row is never rewritten — that is what
  // append-only buys — so a pinned answer is cacheable forever. `private`
  // because the URL contains a secret and a shared cache holding it would serve
  // the artifact to whoever asks next.
  //
  // Absent, empty or unparseable `v` means the current version, never cached:
  // that URL follows the artifact, so a stored copy would keep serving a body
  // the author has already replaced. Unparseable falls to current rather than
  // 404 because `v` is a hint about which body to send, not part of the
  // addressing — a truncated link should still show the artifact.
  //
  // A number that parses but names no version is a 404, unlike an unparseable
  // one: it is a specific claim about the artifact's history that is false.
  //
  // The version moved off the path to get here. `/preview/:token/v/:n` is four
  // segments, and so is a sibling named `v/3.css`; resolving that needs a
  // best-match router, and this one matches in order on purpose.
  @get("/:token")
  preview(req: Request): Reply {
    let artifact = findByToken(this.db, param(req, "token"));
    if (artifact.id == "") { return notFound("artifact"); }
    let asked = parseInt(queryParam(req, "v", "")) ?? 0;
    if (asked < 1) {
      // Not the cached pointer: the newest row of the log itself, so the bare
      // URL follows the artifact even when the pointer is a commit stale.
      let newest = nextVersion(this.db, artifact.id) - 1;
      let current = getVersion(this.db, artifact.id, newest);
      if (current.id == "") { current = getVersion(this.db, artifact.id, artifact.currentVersion); }
      if (current.id == "") { return notFound("artifact"); }
      return previewLiveReply(this.db, req, artifact, current.body, "no-store");
    }
    let row = getVersion(this.db, artifact.id, asked);
    if (row.id == "") { return notFound("artifact"); }
    // Pinned history gets the image wrapper too — a version pill that opened
    // onto a page of base64 would read as broken — but never the live chrome:
    // a pinned version is immutable and immutable things do not reload.
    let pinnedRow = previewPresentable(req, artifact, row.body);
    let pinnedBody = row.body;
    if (pinnedRow.kind == "image" && pinnedRow.mime.startsWith("text/html")) {
      pinnedBody = previewImagePage(pinnedRow, row.body);
    }
    return previewReply(req, pinnedRow, pinnedBody, "private, max-age=31536000, immutable");
  }

  // Another artifact in the same thread, by path.
  //
  // The token's own row carries the thread id, so the token is still the whole
  // of the authorisation — nothing here reads a path from the client and trusts
  // it beyond the thread that token already opened.
  //
  // The path arrives from the router with each segment percent-decoded and the
  // separators intact, so it is a thread path missing only its leading slash.
  // `getArtifact` normalises it with `normalScope` before the lookup — the same
  // function that normalised it on the way in — so "/a/b.css" and "a/b.css"
  // find the same row, and a lookup is a primary-key read with nothing to
  // traverse. `..` needs no special case for the same reason: it is not a
  // filesystem, and `pathProblem` refuses to store a segment spelled that way,
  // so a path containing one matches nothing that exists.
  //
  // Siblings are always the current version. `?v` numbers the entry's own
  // history, and every artifact has an independent counter, so carrying that
  // number across would pin some unrelated revision of the stylesheet — which
  // is worse than not pinning, because it looks deliberate. A pinned entry can
  // therefore drift against its assets; the honest fix is a version scheme that
  // spans a thread, which does not exist yet.
  //
  // A path with no artifact answers `notFound("artifact")` — the same reply as
  // an unknown token, byte for byte. Anything that distinguished "token good,
  // path absent" from "token bad" would turn one shared link into an oracle for
  // which paths a conversation holds.
  @get("/:token/*path")
  sibling(req: Request): Reply {
    let artifact = findByToken(this.db, param(req, "token"));
    if (artifact.id == "") { return notFound("artifact"); }
    // The live-reload stamp. "__version" can never be an artifact path — an
    // underscore is outside the segment charset — so the name is unclaimable
    // and the check costs the sibling route nothing. The reply is a bare
    // number with CORS open: a sandboxed preview has an opaque origin, and a
    // fetch from one needs the header to read even its own host's answer. The
    // number is a count of stored versions, which is nothing a token holder
    // cannot already learn, and the token is still required to ask.
    if (param(req, "path") == "__version") {
      let stamp = reply(200, previewStamp(this.db, artifact.threadId), "text/plain; charset=utf-8");
      stamp.headers.set("access-control-allow-origin", "*");
      stamp.headers.set("cache-control", "no-store");
      return stamp;
    }
    let found = getArtifact(this.db, artifact.threadId, param(req, "path"));
    if (found.id == "") { return notFound("artifact"); }
    let row = getVersion(this.db, found.id, found.currentVersion);
    if (row.id == "") { return notFound("artifact"); }
    // `found`, not `artifact`: the type comes from the row whose body this is.
    // Live like the main page, so a menu page navigated to keeps the reload
    // and its own links keep the base.
    return previewLiveReply(this.db, req, found, row.body, "no-store");
  }
}

// Documents and the folders they live in.
//
// Retrieval is PostgreSQL only — pgvector has no SQLite equivalent — so every
// route here reports that rather than failing at the query. A deployment on
// SQLite is not misconfigured; it just cannot do this.
@controller("/documents")
class DocumentApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  // What one folder holds: the sources, with how many chunks and how many
  // bytes each. Chunks are grouped here rather than listed — a reader manages
  // documents, and the chunking is the index's business.
  @get("/")
  list(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    let scope = normalScope(queryParam(req, "scope", "/"));

    // Waiting and failed jobs first, then what is actually indexed. A file
    // uploaded a second ago has no chunks and no size yet, and saying so is
    // the point — otherwise it simply is not in the list and looks lost.
    let waiting = pendingJobs(this.db, scope);
    let out = "[";
    let w: int = 0;
    while (w < waiting.length) {
      if (w > 0) { out = out + ","; }
      out = out + "{\"source\":" + JSON.stringify(waiting[w].source)
        + ",\"scope\":" + JSON.stringify(waiting[w].scope)
        + ",\"chunks\":0,\"bytes\":0"
        + ",\"status\":" + JSON.stringify(waiting[w].status)
        + ",\"error\":" + JSON.stringify(waiting[w].error) + "}";
      w = w + 1;
    }

    let rows = listSources(this.db, scope);
    let i: int = 0;
    while (i < rows.length) {
      if (w + i > 0) { out = out + ","; }
      out = out + "{\"source\":" + JSON.stringify(rows[i].source)
        + ",\"scope\":" + JSON.stringify(rows[i].scope)
        + ",\"chunks\":" + `${rows[i].chunks}`
        + ",\"bytes\":" + `${rows[i].bytes}`
        + ",\"status\":\"indexed\",\"error\":\"\"}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  // Upload a document: split, embedded and filed under one scope. Re-uploading
  // the same source replaces its chunks.
  @post("/")
  upload(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: DocumentUpload = JSON.parse<DocumentUpload>(req.body);
    if (body.scope == "") { return badRequest("a document needs a scope: \"/specs/plume\""); }

    // Which model embeds is a row, and it has to be named — a document
    // embedded by the wrong model is invisible to every agent reading that
    // folder, silently.
    let modelId = queryParam(req, "model", "");
    if (modelId == "") { return badRequest("name the embedding model: ?model=e1"); }
    let embedder = embeddingModel(this.db, modelId);
    if (embedder.id == "") { return badRequest("no usable embedding model " + modelId); }
    let key = credentialFor(this.db, embedder.provider, this.master);
    if (key == "") { return badRequest("no credential for " + embedder.provider); }

    // What the worker would refuse, refused here. Moving indexing onto a
    // queue moved these checks into the worker with it, so a name that can
    // never be filed — chunk ids are built from it and must be plain — was
    // accepted with a 202 and failed minutes later in a job row. A caller
    // should learn at the moment of asking.
    let badName = sourceProblem(body.source, body.body);
    if (badName != "") { return badRequest(badName); }

    // The corpus table is made on demand, from the embedder's own width. It
    // was only ever created by an example, so a fresh deployment could queue a
    // document and watch the worker fail on a table nobody had made.
    let ready = createDocuments(this.db, embedder);
    if (ready != "") { return badRequest(ready); }

    // Queued, not indexed here. Embedding a document is one model call per
    // chunk: a large file would hold this connection past any proxy's timeout,
    // and a browser would show nothing until it finished. The worker drains
    // the queue; the job row is what the console watches.
    let jobId = enqueue(this.db, body.source, normalScope(body.scope), embedder.id, body.body, `${Date.now()}`);
    if (jobId == "") { return badRequest("the document could not be queued"); }
    return accepted("{\"job\":" + JSON.stringify(jobId)
      + ",\"source\":" + JSON.stringify(body.source)
      + ",\"scope\":" + JSON.stringify(normalScope(body.scope))
      + ",\"status\":" + JSON.stringify(JOB_QUEUED) + "}");
  }

  @del("/:source")
  remove(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    executeWith(this.db, "DELETE FROM documents WHERE source = " + this.db.placeholder, [param(req, "source")]);
    return noContent();
  }
}

// The folder tree, as the documents describe it.
//
// Derived, not stored: there is no folder table to keep in step with the rows,
// so a folder exists exactly as long as something is in it.
// What the indexer is doing, across every folder. The console polls this
// while anything is in flight.
@controller("/jobs")
class JobApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    if (this.db.name != "postgres") { return ok("[]"); }
    let rows = pendingJobs(this.db, "");
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"id\":" + JSON.stringify(rows[i].id)
        + ",\"source\":" + JSON.stringify(rows[i].source)
        + ",\"scope\":" + JSON.stringify(rows[i].scope)
        + ",\"status\":" + JSON.stringify(rows[i].status)
        + ",\"chunks\":" + `${rows[i].chunks}`
        + ",\"error\":" + JSON.stringify(rows[i].error)
        + ",\"createdAt\":" + JSON.stringify(rows[i].createdAt) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }
}

@controller("/scopes")
class ScopeApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  tree(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    // The scopes of work that is queued or failed, so a folder someone just
    // uploaded into is in the tree before the indexer has reached it.
    let waiting = pendingJobs(this.db, "");
    let pending: string[] = [];
    let w: int = 0;
    while (w < waiting.length) {
      pending.push(waiting[w].scope);
      w = w + 1;
    }
    return ok(scopesJson(scopeCounts(this.db, queryParam(req, "prefix", ""), pending)));
  }
}

// The trace side. One route, because a run is written once and read whole:
// the row and every step, one query.
@controller("/runs")
class RunApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Guarded by the run row's own owner, not by a join through the thread: a
  // run may have no thread (`POST /agents/:id/run`), and this document is the
  // whole conversation — question, answer, every tool call and result. The
  // messages POST hands `runId` straight back to whoever asked, so an id alone
  // was authorisation to read any tenant's transcript.
  @get("/:id")
  find(req: Request): Reply {
    let document = ownedRun(this.db, param(req, "id"), callerTags(req));
    if (document == "") { return notFound("run " + param(req, "id")); }
    return ok(document);
  }
}

// Whether this process is worth sending a request to, and which build it is.
//
// The one route that answers without a bearer token (`bearerRefused` below)
// and the one the gateway leaves public, because a probe that needs the
// secret cannot tell "the engine is down" from "the secret is wrong" — and
// those are different pages of the runbook.
@controller("/healthz")
class HealthApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  show(req: Request): Reply {
    return ok(healthJson(this.db, stamp()));
  }
}

// What a tenant has used, for whoever is doing the accounting.
//
// `?owner=` is a filter, never an escalation: a scoped caller may only ask
// about a tag it holds, and asking about somebody else's is the same 404 a
// thread that is not theirs gets. Unscoped — no proxy in front — any tag can
// be asked about, which is the community edition's single-tenant reading of
// the same route.
@controller("/usage")
class UsageApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  show(req: Request): Reply {
    let tags = callerTags(req);
    let want = queryParam(req, "owner", owningTag(tags));
    if (!holdsOwner(tags, want)) { return notFound("owner " + want); }
    return ok(usageJson(ownerUsage(this.db, want)));
  }
}

// What this build calls itself.
//
// Written by hand because there is no build step to stamp a commit into: the
// Dockerfile runs `lumen compile` and nothing else. It earns its place anyway
// — the answer to "did the restart take" is this number changing, and an
// operator staring at a hot binary that kept the old inode has no other way to
// tell (README, the restart note).
const API_VERSION: string = "0.2.0";

// The health document. A free function, so the suite can ask it the same
// question the probe does — the route is a method on a class and a Lumen
// module cannot export one.
//
// Three facts, and no summary `ok` field. The process refuses to start on a
// schema it could not migrate and refuses to start without a usable master
// key, so a reply at all already means the two fatal things are fine; docker
// being down degrades scripts and nothing else. A boolean over facts of
// different weights would have to lie about one of them, and a prober can
// alert on whichever of these it actually cares about.
export function healthJson(db: Db, now: string): string {
  return "{\"version\":" + JSON.stringify(API_VERSION)
    + ",\"migration\":" + JSON.stringify(appliedHighWater(db))
    + ",\"docker\":" + boolJson(envDockerUp(now)) + "}";
}

// Whether a request is turned away before it reaches any route.
//
// Off unless `AGENTS_API_TOKEN` is set, and off is what every community
// deployment gets. When it is set this is defense in depth and nothing more:
// the firewall is what isolates :8100, and this is what a missed firewall rule
// or a security-group drift runs into next — because with the trust gate on,
// reaching the port at all means choosing an identity with no forgery
// required (GATEWAY.md, top risks).
//
// Compared whole rather than in constant time on purpose: the secret is a
// fixed string shared with one proxy on the same host, and an attacker close
// enough to time this reply is already inside the boundary the firewall draws.
export function bearerRefused(configured: string, target: string, authorization: string): bool {
  if (configured == "") { return false; }
  if (publicPath(target)) { return false; }
  return presentedToken(authorization) != configured;
}

// The routes the lock never covers. Just the probe: `/preview/:token` is a
// capability and is checked by the gateway, and everything else is the API.
function publicPath(target: string): bool {
  let path = target;
  let query = path.indexOf("?");
  if (query >= 0) { path = path.substring(0, query); }
  while (path.length > 1 && path.endsWith("/")) { path = path.substring(0, path.length - 1); }
  return path == "/healthz";
}

// The token an Authorization header carries, or "".
//
// Its own function rather than rest's `bearerToken`, which takes a whole
// Request: the lock runs before there is one — the router has not matched a
// route yet, so nothing has parsed the params or the query.
function presentedToken(authorization: string): string {
  let prefix = "Bearer ";
  if (authorization.length <= prefix.length) { return ""; }
  if (authorization.substring(0, prefix.length).toLowerCase() != prefix.toLowerCase()) { return ""; }
  return authorization.substring(prefix.length, authorization.length).trim();
}

function apiToken(): string {
  return (process.env("AGENTS_API_TOKEN") ?? "").trim();
}

// Why a POST cannot be written.
//
// `persist` is an upsert -- the right default for a mapper, and the wrong one
// for a create. A POST carrying an id that already exists would edit that row
// and answer as if it had made a new one. For prompts that is not untidy but
// destructive: a prompt row is never edited *is the thing rollback depends
// on*, and a POST reusing an id was observed replacing version 3's text with
// version 4's while every agent pointing at it silently changed behaviour.
//
// So every create refuses a taken id, by name. Changing a row is what PUT is
// for, and for prompts the answer is a new version, which is a new id.




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

// What the rest of the package can actually reach. A model row naming a
// provider with no endpoint is accepted today and fails at the first run with
// a blank URL; a model row naming no width is accepted and fails when the
// corpus table is made, long after anyone connects the two.
export function modelProblem(m: ModelRow): string {
  if (m.label.trim() == "") { return "a model needs a label"; }
  if (m.apiName.trim() == "") { return "a model needs the provider's own name for it"; }
  if (m.kind != "chat" && m.kind != "embedding") {
    return "a model is chat or embedding, not \"" + m.kind + "\"";
  }
  // Vertex has no well-known endpoint: the address carries the project and
  // region, so the row must say it. Named before the generic refusals below,
  // which would otherwise reject every vertex row however complete.
  if (m.provider == "vertex" && m.baseUrl.trim() == "") {
    return "a vertex model needs its base URL — https://<region>-aiplatform.googleapis.com/v1/projects/<project>/locations/<region>/endpoints/openapi";
  }
  if (m.kind == "chat" && m.baseUrl.trim() == "" && chatEndpoint(m.provider) == "") {
    return "no chat endpoint for provider \"" + m.provider + "\"";
  }
  if (m.kind == "embedding" && m.baseUrl.trim() == "" && embeddingEndpoint(m.provider) == "") {
    return "no embedding endpoint for provider \"" + m.provider + "\"";
  }
  if (m.kind == "embedding" && m.dimensions <= 0) {
    return "an embedding model must say how wide its vectors are";
  }
  // The one field here that decides where a key is sent, and the one this
  // never read. A base URL that is not an address cannot be compared with the
  // address the key was stored for, so it is refused where it is written
  // rather than where it is used.
  if (m.baseUrl.trim() != "" && destinationOf(m.baseUrl) == "") {
    return "a base URL is an http or https address, like \"https://gateway.internal/v1\" — not \"" + m.baseUrl + "\"";
  }
  return "";
}

// --- a secret's destination --------------------------------------------------
//
// See credentials.ts for why these exist. Three routes name a secret and a
// destination in the same row, and only the secret is write-only; these are
// the three, asked the same question in the same words.

// Where a model row's calls actually land: its base URL when it has one, and
// the provider's own endpoint when it does not.
function modelDestination(m: ModelRow): string {
  if (m.kind == "embedding") { return endpointFor(m, "embeddings"); }
  return endpointFor(m, "chat/completions");
}

// Whether this model row may be written, given what is stored for its
// provider.
//
// A model row names a key — through its provider — and a destination, through
// its base URL, and only the first of those is write-only. `modelProblem`
// checks the label, the api name, the kind and the width and has never looked
// at `baseUrl`, so `PUT /models/:id {"baseUrl":"http://…"}` followed by `POST
// /models/:id/test` sends `authorization: Bearer <the stored key>` wherever
// you like. `/test` re-materialises the row with `enabled: true`, so a
// disabled row is no protection either.
//
// A row that does not exist yet is treated as one pointing at the provider's
// own endpoint: a fresh row naming someone else's host leaks precisely as much
// as an edited one, and `POST /models` is the shorter way to write it.
export function modelDestinationProblem(db: Db, row: ModelRow): string {
  let held = findById(db, modelsMapping(), row.id);
  let authorised: ModelRow = {
    id: row.id, label: row.label, apiName: row.apiName, provider: row.provider,
    kind: row.kind, dimensions: row.dimensions, baseUrl: "", enabled: row.enabled, contextTokens: 0 };
  if (held != "") { authorised = JSON.parse<ModelRow>(held); }
  let move: DestinationMove = {
    subject: "model " + row.id,
    secretName: "the " + row.provider + " key",
    clearWith: "DELETE /providers/" + row.provider + "/key",
    was: modelDestination(authorised),
    now: modelDestination(row),
    secretStored: hasCredential(db, row.provider),
  };
  return destinationProblem(move);
}

// Whether this server row may be written, given the token stored under its id.
//
// The token lives under "mcp:" + id and is not re-keyed when the endpoint
// moves, so `PUT /servers/:id` followed by a plain `GET /servers/:id/tools`
// delivers the bearer token to whatever address was just written. A server
// with no row yet has no address on record, so any endpoint is a move — which
// is what catches a recycled id whose predecessor's token is still stored.
export function serverDestinationProblem(db: Db, row: McpServerRow): string {
  let held = findById(db, mcpServersMapping(), row.id);
  let was = "";
  if (held != "") { was = JSON.parse<McpServerRow>(held).endpoint; }
  let move: DestinationMove = {
    subject: "server " + row.id,
    secretName: "its token",
    clearWith: "PUT /servers/" + row.id + "/auth with {\"authKind\":\"none\",\"authHeader\":\"\",\"token\":\"\"}",
    was: was,
    now: row.endpoint,
    secretStored: hasCredential(db, "mcp:" + row.id),
  };
  return destinationProblem(move);
}

// Whether the collector may be moved, given the secret stored for it.
//
// `PUT /tracing` sets `endpoint` freely and the langfuse backend sends
// `Authorization: Basic <public>:<secret>` to it.
export function traceDestinationProblem(db: Db, row: TraceConfigRow): string {
  let held = findById(db, traceConfigMapping(), "default");
  let was = "";
  if (held != "") { was = JSON.parse<TraceConfigRow>(held).endpoint; }
  let move: DestinationMove = {
    subject: "the trace collector",
    secretName: "its secret key",
    clearWith: "DELETE /tracing/key",
    was: was,
    now: row.endpoint,
    secretStored: hasCredential(db, "tracing"),
  };
  return destinationProblem(move);
}

// --- forgetting a row, and everything hung off it ----------------------------

// Delete a server, its token and its links.
//
// The token went unnoticed: `remove` deleted the row and the agent links and
// left `mcp:<id>` in the credential store. Ids come out of the request body
// and are short human strings, so recycling "s1" is ordinary — and the next
// run sent the old server's secret to the new server's endpoint.
export function forgetServer(db: Db, serverId: string): void {
  executeWith(db, "DELETE FROM agent_mcp_servers WHERE server_id = " + db.placeholder, [serverId]);
  deleteById(db, mcpServersMapping(), serverId);
  forgetCredential(db, "mcp:" + serverId);
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

// The document checks that used to happen inside the request, kept there now
// that the indexing itself does not. These are the ones knowable without a
// model: everything else is the worker's to report on the job.
function sourceProblem(source: string, body: string): string {
  if (source.trim() == "") { return "a document needs a source to be filed under"; }
  if (!safeIdentifier(source)) {
    return "a source must be a plain name: letters, digits, _ and -";
  }
  if (body.trim() == "") { return "an empty document has nothing to retrieve"; }
  return "";
}

// One clock for every row this API writes. Six routes wrote the four letters
// "now" into a timestamp column, which reads as a value and sorts as garbage.
// `true` or `false` for a JSON body built by hand.
// The calls of one round, as the wire carries them.
//
// Written here rather than only behind GET /steps because a card belongs to
// the message it describes: the answer carries its own calls, and so does each
// turn of a reloaded transcript. Polling is for watching a round that is still
// running; this is for the round that is over, and the two must not disagree.
function thoughtsJson(thoughts: Thought[]): string {
  let out = "[";
  let i: int = 0;
  while (i < thoughts.length) {
    if (i > 0) { out = out + ","; }
    // `seq` for the same reason a step carries one: on a reload the client is
    // handed every round at once and has to put each thought back above the
    // message it belongs to.
    out = out + "{\"seq\":" + `${thoughts[i].seq}`
      + ",\"rotation\":" + `${thoughts[i].rotation}`
      + ",\"depth\":" + `${thoughts[i].depth}`
      + ",\"text\":" + JSON.stringify(thoughts[i].text) + "}";
    i = i + 1;
  }
  return out + "]";
}

function stepsJson(live: LiveStep[]): string {
  let out = "[";
  let i: int = 0;
  while (i < live.length) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"seq\":" + `${live[i].seq}`
      + ",\"depth\":" + `${live[i].depth}`
      + ",\"rotation\":" + `${live[i].rotation}`
      + ",\"idx\":" + `${live[i].idx}`
      + ",\"kind\":" + JSON.stringify(live[i].kind)
      + ",\"name\":" + JSON.stringify(live[i].name)
      + ",\"target\":" + JSON.stringify(live[i].target)
      + ",\"args\":" + JSON.stringify(live[i].args)
      + ",\"running\":" + boolJson(live[i].endedAt == "")
      + ",\"ok\":" + boolJson(live[i].ok)
      + ",\"millis\":" + `${stepMillis(live[i])}`
      + ",\"result\":" + JSON.stringify(live[i].result) + "}";
    i = i + 1;
  }
  return out + "]";
}

function boolJson(v: bool): string {
  if (v) { return "true"; }
  return "false";
}

function stamp(): string {
  return `${Date.now()}`;
}

// The abandoned-thread sweep, on a thread of its own, and only where an
// operator asked for one.
//
// Nothing in this engine has ever deleted a thread row. This does, so it is
// off until `AGENTS_SWEEP_IDLE_MS` names an age, and then that same number is
// how long it waits between passes — an operator who says "an hour" wants a
// row an hour idle taken within about an hour, and a second knob to disagree
// with the first buys nothing.
//
// It is a background thread rather than something on `GET /threads` because a
// read must not delete rows: under scoping that is one person's sidebar
// deleting another person's conversations (GATEWAY.md). A timer would be the
// obvious home and does not work: once `listen` hands the event loop to the
// HTTP server, no `setInterval` ever fires again (verified, not assumed). A
// worker thread does work, with two conditions. Its function may not throw —
// `Worker.run` takes `() => T` and the database is typed `error{LumenThrow}!T`
// — hence the try around the whole body rather than in the caller. And it
// opens its own connection: two threads taking turns on one handle interleave
// on the wire.
//
// `idleMs` of 0 means the thread half is off — the operator named no age — and
// only the environment half runs. That split matters: deleting a conversation
// row is destructive and stays opt-in, while stopping an idle container is
// not, so the second must not be held hostage to the first. Wiring them
// together is what kept envIdle uncalled on every deployment there has ever
// been, since AGENTS_SWEEP_IDLE_MS has never been set on any of them.
function sweepLoop(idleMs: int): int {
  try {
    let db = openDatabase();
    // How long to wait between passes. The thread sweep's own age when it is
    // on (an operator who says "an hour" wants an hour), the environment
    // deadline when it is not — waiting a day to look for a fifteen-minute
    // idle container would make the deadline a fiction.
    let every = idleMs > 0 ? idleMs : ENV_IDLE_MS;
    while (true) {
      // Before the wait, so a process that is OOM-recycled hourly still sweeps
      // — with the wait first it never would.
      if (idleMs > 0) {
        try { sweepEmptyThreads(db, `${Date.now() - idleMs}`); }
        catch (e) { console.error("thread sweep: " + e.message); }
      }
      try { sweepIdleEnvironments(db); }
      catch (e) { console.error("environment sweep: " + e.message); }
      process.sleep(every);
    }
  } catch (e) {
    // Only reachable from the connect: a box that cannot be swept still serves.
    console.error("thread sweep: no connection of its own — " + e.message);
  }
  return 0;
}

// Stop the containers nobody is using.
//
// envIdle has existed, tested and documented, since environments shipped — and
// nothing called it. The consequence is visible in `docker ps`: a conversation
// that ran one script left its container up, and two of them had been running
// for forty-two hours against conversations abandoned two days earlier. Each
// holds an image version alive as well, so a rebuilt image cannot be reclaimed
// while a container from the old one is still standing.
//
// Stopped, not removed. The row stays and the container stays recreatable, so
// the next use of that environment is a start rather than a fresh image pull
// and a new workspace — envEnsure already sorts out which of the two the truth
// requires. Removal belongs to envForget, which is what deleting a
// conversation does.
//
// It rides the thread sweep's loop rather than taking a thread of its own: one
// background thread with two jobs is one connection and one place to look. But
// its deadline is its OWN — ENV_IDLE_MS, fifteen minutes — because how long an
// abandoned CONVERSATION should live and how long an idle CONTAINER should
// hold memory are unrelated questions, and an operator who sets the thread
// sweep to a day did not ask for day-old containers.
function sweepIdleEnvironments(db: Db): void {
  let s: EnvSweep = { now: `${Date.now()}`, idleMs: ENV_IDLE_MS };
  let stopped = envIdle(db, s);
  if (stopped > 0) { console.log(`stopped ${stopped} idle environment(s)`); }
}

function openDatabase(): Db {
  let pgHost = process.env("AGENTS_PG_HOST") ?? "";
  if (pgHost != "") {
    let pg = postgres();
    let server: DbConfig = {
      host: pgHost,
      database: process.env("AGENTS_PG_DATABASE") ?? "agents",
      user: process.env("AGENTS_PG_USER") ?? "agents",
      password: process.env("AGENTS_PG_PASSWORD") ?? "",
    };
    connectDatabase(pg, server);
    return pg;
  }
  let db = sqlite();
  let cfg: DbConfig = { filename: process.env("AGENTS_DB_FILE") ?? "/tmp/agents_api.db" };
  connectDatabase(db, cfg);
  return db;
}

// Bring the schema up to date, and say why it could not be. "" means every
// step this build knows about has run.
export function migrationProblem(db: Db): string {
  // One plan, extended — not two plans. A second migrate() call would be
  // handed a plan that lacks the versions already recorded, and refuse.
  let plan = schemaPlan(db);
  let extra = runLogPlan(db);
  let e: int = 0;
  while (e < extra.length) { plan.push(extra[e]); e = e + 1; }
  let traces = tracePlan(db);
  let t: int = 0;
  while (t < traces.length) { plan.push(traces[t]); t = t + 1; }
  let knowledge = knowledgePlan(db);
  let k: int = 0;
  while (k < knowledge.length) { plan.push(knowledge[k]); k = k + 1; }
  let conversations = threadPlan(db);
  let c: int = 0;
  while (c < conversations.length) { plan.push(conversations[c]); c = c + 1; }
  let files = workspacePlan(db);
  let w: int = 0;
  while (w < files.length) { plan.push(files[w]); w = w + 1; }
  let jobs = indexingPlan(db);
  let ij: int = 0;
  while (ij < jobs.length) { plan.push(jobs[ij]); ij = ij + 1; }
  let results = artifactPlan(db);
  let ar: int = 0;
  while (ar < results.length) { plan.push(results[ar]); ar = ar + 1; }
  // What a run is doing while it is still doing it, so the console can show a
  // tool running rather than a spinner with nothing behind it.
  let live = stepPlan(db);
  let lv: int = 0;
  while (lv < live.length) { plan.push(live[lv]); lv = lv + 1; }
  // Where a conversation's scripts run: one container per environment, the
  // rows here as the record and the container's workspace as cache
  // (RUN-SCRIPT.md).
  let envs = envPlan(db);
  let ev: int = 0;
  while (ev < envs.length) { plan.push(envs[ev]); ev = ev + 1; }
  let ran = migrate(db, plan);
  if (ran.ok) { return ""; }
  // Logged and carried on with, this served an API whose routes SELECT columns
  // that do not exist: every one of them answers 500, at a distance from the
  // one line that said why. The master key already refuses to start without
  // being usable, for the same reason and with the same remedy — fix it and
  // start again.
  if (ran.failedVersion != "") {
    return "the schema is not up to date: migration " + ran.failedVersion + " did not run — " + ran.error;
  }
  return "the schema is not up to date: " + ran.error;
}


function seed(db: Db): void {
  if (countWhere(db, agentsMapping(), "", []) > 0) { return; }
  let opus: ModelRow = { id: "m1", label: "Opus 5", apiName: "claude-opus-5", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  let haiku: ModelRow = { id: "m2", label: "Haiku 4.5", apiName: "claude-haiku-4-5-20251001", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  // Two embedders, exactly one enabled. Retrieval needs an active embedding
  // model to do anything at all, so a seed without one leaves the knowledge
  // base unusable until someone adds a row by hand — and leaves its tests
  // with nothing to look at. Two of them, not one, because "enabling an
  // embedder disables the others" is a rule about a set, and a set of one
  // cannot show it holds.
  let embed: ModelRow = { id: "m3", label: "Mistral Embed", apiName: "mistral-embed", provider: "mistral", kind: "embedding", dimensions: 1024, baseUrl: "", enabled: true, contextTokens: 0 };
  let embedSmall: ModelRow = { id: "m4", label: "Nomic Embed Text", apiName: "nomic-embed-text", provider: "ollama", kind: "embedding", dimensions: 768, baseUrl: "http://127.0.0.1:11434", enabled: false, contextTokens: 0 };
  persist(db, modelsMapping(), JSON.stringify(opus));
  persist(db, modelsMapping(), JSON.stringify(haiku));
  persist(db, modelsMapping(), JSON.stringify(embed));
  persist(db, modelsMapping(), JSON.stringify(embedSmall));
  let careful: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.2, maxTokens: 8192, topP: 0.95, extra: "{}", thinking: "", label: "Careful", selectable: true, rank: 1 };
  let quick: ModelConfigRow = { id: "c2", modelId: "m2", temperature: 0.7, maxTokens: 2048, topP: 1.0, extra: "{}", thinking: "", label: "Quick", selectable: true, rank: 2 };
  persist(db, modelConfigsMapping(db), JSON.stringify(careful));
  persist(db, modelConfigsMapping(db), JSON.stringify(quick));
  let p1: PromptRow = { id: "p1", promptName: "lead", version: 1, body: "You lead.", createdAt: "2026-07-25" };
  let p2: PromptRow = { id: "p2", promptName: "lead", version: 2, body: "You lead, briefly.", createdAt: "2026-07-25" };
  persist(db, promptsMapping(), JSON.stringify(p1));
  persist(db, promptsMapping(), JSON.stringify(p2));
  let fsSrv: McpServerRow = { id: "s1", serverName: "filesystem", transport: "http", endpoint: "http://127.0.0.1:8931/mcp", authKind: "none", authHeader: "", enabled: true };
  let ghSrv: McpServerRow = { id: "s2", serverName: "github", transport: "http", endpoint: "https://mcp.gh", authKind: "none", authHeader: "", enabled: true };
  persist(db, mcpServersMapping(), JSON.stringify(fsSrv));
  persist(db, mcpServersMapping(), JSON.stringify(ghSrv));
  let lead: AgentRow = { id: "a1", agentName: "lead", description: "delegates", modelConfigId: "c1", promptId: "p2", scriptImageId: "", isDefault: true, enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  let scout: AgentRow = { id: "a2", agentName: "scout", description: "searches", modelConfigId: "c2", promptId: "p1", scriptImageId: "", isDefault: false, enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  persist(db, agentsMapping(), JSON.stringify(lead));
  persist(db, agentsMapping(), JSON.stringify(scout));
  execute(db, "INSERT INTO agent_mcp_servers VALUES ('a1','s1')");
  execute(db, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");
}

// The model menu, brought up to date with the models that are actually here.
// "" when every statement ran, the first failure otherwise.
//
// Run at every start, after the seed, and NOT as a migration — which is what it
// used to be, and the reason it never worked on a new install. `migrate` runs a
// versioned statement once, at a moment fixed by the migration history, and on
// a fresh database that moment is before `seed` has written a model and long
// before an operator has configured one. The four derived statements therefore
// read an empty database, wrote nothing, recorded themselves as applied, and
// could never run again: `GET /models/choices` answered `[]` for ever and the
// composer's picker was empty on every install that was not nuraly.io.
//
// A menu is a reading of the tables and the tables keep changing, so the
// reading is re-taken. `derivedMenuStatements` carries what makes that safe to
// do repeatedly — nothing it writes is written twice, and nothing an operator
// changed is written over.
//
// Logged rather than fatal, unlike `migrationProblem`. A schema that did not
// migrate serves 500s from routes whose columns are missing; a menu that did
// not publish serves the menu it had, which on a new install is no menu — a
// feature that is not there yet, not a broken deployment.
export function publishMenu(db: Db): string {
  let statements = derivedMenuStatements(db);
  let i: int = 0;
  while (i < statements.length) {
    let ran = execute(db, statements[i]);
    if (!ran.ok) { return "the model menu could not be published: " + ran.error; }
    i = i + 1;
  }
  return "";
}

function main(): void {
  let db = openDatabase();
  let schema = migrationProblem(db);
  if (schema != "") {
    console.error(schema);
    return;
  }
  seed(db);
  let menu = publishMenu(db);
  if (menu != "") { console.error(menu); }
  let master = masterKey();
  let keyProblem = masterKeyProblem(master);
  if (keyProblem != "") {
    // Refusing to start beats serving with credentials that cannot be read:
    // every provider call would fail later, far from the cause.
    console.error(keyProblem);
    return;
  }

  // Started after the migrations, so it never sweeps against a schema that is
  // still being built — and started at all only where an operator named an age
  // for `AGENTS_SWEEP_IDLE_MS`. Unset, no thread is started and no row is ever
  // deleted, which is what every deployment has run so far.
  let sweepIdle = sweepIdleMs(process.env("AGENTS_SWEEP_IDLE_MS") ?? "");
  if (sweepIdle > 0) {
    console.log(`sweeping threads that have been empty for ${sweepIdle}ms`);
  }
  // Started either way now. The thread half still needs the operator's age and
  // stays off without it; the environment half is not destructive and runs on
  // every deployment, which is the whole point — it never ran on any of them.
  console.log(`stopping environments idle for ${ENV_IDLE_MS}ms`);
  Worker.run(() => sweepLoop(sweepIdle));

  // Nineteen controllers, handed over whole. Each one is read for its own
  // `@controller` and its methods bound (specs 477/478), so there is no table
  // to walk here, no prefix to invent so that four of these classes can all
  // have a `list`, and no binding map to keep in step with the routes. What is
  // written is what a reader needs: which controllers there are, and what each
  // one is given.
  //
  // The `try` that answers a throwing handler with a 400 lives inside `mount`,
  // once, for all of them — including the one that used to take the process
  // down: `JSON.parse<T>` throws when a PUT body omits a field the record
  // declares, and twenty-one of these routes parse a body.
  let mounts: Mount[] = [
    new AgentApi(db, master),
    new ProviderApi(db, master),
    new RunApi(db),
    new ScriptImageApi(db),
    new SkillApi(db),
    new TemplateApi(db),
    new ModelApi(db, master),
    new ConfigApi(db),
    new ChoiceApi(db),
    new RouterApi(db),
    new PromptApi(db),
    new WorkspaceApi(db, master),
    new ThreadApi(db, master),
    new DocumentApi(db, master),
    new ScopeApi(db),
    new JobApi(db),
    new TraceApi(db, master),
    new ServerApi(db, master),
    new AuthProviderApi(db, master),
    new PluginApi(db),
    new ArtifactApi(db),
    new PreviewApi(db),
    new HealthApi(db),
    new UsageApi(db),
  ];

  let table = mountedRoutes(mounts);
  let i: int = 0;
  while (i < table.length) {
    console.log("route  " + table[i].method + " " + table[i].pattern + " -> " + table[i].handler);
    i = i + 1;
  }

  let token = apiToken();
  if (token != "") { console.log("bearer token required on every route but /healthz"); }
  let problem = listenLocked(8100, mounts, token);
  if (problem != "") { console.error(problem); }
}

// `listen`, with the bearer lock in front of it.
//
// Written here rather than in `rest/server.ts` because it is this service's
// policy and not the router's: the router serves any table for anyone, and a
// generic `listen` that grew an optional token would be one deployment's
// answer baked into a package four others use. What it costs is the eight
// lines of `listen` copied — the mount check, the server, the reply shape.
//
// The refusal is answered before the router matches, so an unauthorised
// caller learns nothing about which paths exist: every one of them is 401,
// including the ones that are not there.
function listenLocked(port: int, mounts: Mount[], token: string): string {
  let problemText = mountProblem(mounts);
  if (problemText != "") { return problemText; }

  http.createServer(port, (req): HttpResponse => {
    if (bearerRefused(token, req.path, req.headers.get("authorization") ?? "")) {
      let shut = reply(401, "{\"error\":\"a bearer token is required\"}", "application/json");
      // The header a 401 owes a client, so a script gets told what kind of
      // credential to find rather than guessing from the sentence.
      shut.headers.set("www-authenticate", "Bearer");
      let refused: HttpResponse = { status: shut.status, body: shut.body, ok: true, headers: shut.headers };
      return refused;
    }
    // A proxy that says it authenticated somebody, in a document with no
    // readable `uuid`, has told this process nothing it can act on. Refusing is
    // the only answer that is not a guess about whose data to serve — and the
    // guess the code used to make was "" , the tenant holding every row written
    // before the gateway existed (owner.ts).
    if (identityUnreadable(trustsProxyAuth(), req.headers.get("x-user") ?? "")) {
      let blank = reply(401, "{\"error\":\"the X-USER document names no uuid\"}", "application/json");
      let unknown: HttpResponse = { status: blank.status, body: blank.body, ok: true, headers: blank.headers };
      return unknown;
    }
    let answer = dispatchedMounted(mounts, req.method, req.path, req.body, req.headers);
    let out: HttpResponse = { status: answer.status, body: answer.body, ok: true, headers: answer.headers };
    return out;
  });
  return "";
}

main();
