// The agents API: the schema, served.
//
//   cd packages/agents && lumen run api.ts
//   curl -s localhost:8100/agents
//   curl -s localhost:8100/agents/a1
//   curl -s -X POST localhost:8100/agents -d '{"id":"a3",...}'
//   curl -s -X PUT  localhost:8100/agents/a1/model -d '{"modelConfigId":"c2"}'
//   curl -s -X PUT  localhost:8100/agents/a1/prompt -d '{"promptId":"p1"}'
//
// Every read goes to the database. Nothing is cached and nothing is compiled
// in, so a change made through this API — or by anything else touching the
// same tables — is visible to the very next request, with no restart. That is
// the whole requirement, and it is met by not doing the thing that would break
// it rather than by machinery.

import { controller } from "../rest/controller.ts";
import { Request, Reply, Mount, mountedRoutes, listen, reply, ok, created, accepted, noContent, notFound, badRequest, param, queryParam, header } from "../rest/server.ts";
import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { postgres } from "../plume/postgres.ts";
import { DbOrder, DbRepository, asc, desc, safeIdentifier, placeholderAt, connectDatabase, persist, findById, listOrdered, listWhere, pageOrdered, existsById, deleteById, execute, executeWith, countWhere } from "../plume/plume.ts";
import { migrate } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, McpServerRow, AgentRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, agentsFull, schemaPlan } from "./schema.ts";
import { DestinationMove, destinationOf, masterKey, masterKeyProblem, storeCredential, credentialFor, providersWithCredentials, hasCredential, forgetCredential, destinationProblem } from "./credentials.ts";
import { AgentRun, runAgent, runAgentTraced } from "./run.ts";
import { chatEndpoint, embeddingEndpoint, endpointFor, complete, embedText, replyText } from "./provider.ts";
import { runsMapping, runsFull, runLogPlan, recordRun, runsOf } from "./runlog.ts";
import { TraceConfigRow, traceConfigMapping, tracePlan, tracerFor } from "./trace.ts";
import { jsonId, createProblem, backendOr, knownBackend, scopesJson } from "./payload.ts";
import { jsonList, jsonText } from "./scan.ts";
import { toolListing } from "./mcp.ts";
import { ThreadListing, ThreadTurnRow, listThreads, openThread, threadAgent, threadMessageRows, runInThread, threadPlan } from "./threads.ts";
import { workspacePlan, putFile, getFile, listFiles, deleteFile, promoteFile, mimeOf } from "./workspace.ts";
// `mimeOf` is deliberately not taken from here: workspace.ts already owns that
// name in this file, and an artifact's type is on its row anyway.
import { ArtifactRow, TurnArtifact, TURN_SEQ_NONE, artifactPlan, artifactsMapping, putArtifact, listArtifacts, getArtifact, findByToken, getVersion, deleteArtifact, artifactsForTurn, artifactsByTurn } from "./artifacts.ts";
import { WireRef, wireView } from "./artifacts-fence.ts";
import { IndexJobRow, indexingPlan, enqueue, pendingJobs, JOB_QUEUED } from "./indexing.ts";
import { SourceListing, listSources, ScopeNode, AgentRetrievalRow, agentRetrievalMapping, knowledgePlan, embeddingModel, createDocuments, uploadDocument, scopeCounts, normalScope, agentScopes, grantScope, revokeScope, documentsMapping } from "./knowledge.ts";
import { Tracer, flush, traceId, spanCount, tracing, tracerWithMoreSpans } from "../tracing/tracing.ts";

// A change to which model or prompt an agent uses, as a body.
type ModelChange = { modelConfigId: string };
type PromptChange = { promptId: string };
type ServerLink = { serverId: string };
type ChildLink = { childId: string };
type KeyBody = { apiKey: string };
type RunBody = { text: string };
type TraceSecret = { secretKey: string };
type ScopeGrant = { scope: string };
type ServerAuth = { authKind: string, authHeader: string, token: string };
type ThreadStart = { agentId: string };
type FileUpload = { name: string, content: string };
// Every field is required, `note` included — JSON.parse refuses a body missing
// one, so "no note" is spelled "note":"" rather than left out.
type ArtifactPost = { path: string, title: string, content: string, note: string };
type FilePromote = { scope: string, modelId: string };
type FilePull = { name: string, documentId: string };
type DocumentUpload = { source: string, scope: string, body: string };
type RetrievalSetup = { embeddingModelId: string, topK: int, maxDistance: number, enabled: bool };


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
    // ones that went wrong.
    let runId = recordRun(this.db, param(req, "id"), body.text, answered);

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
  @get("/:id/runs")
  runs(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    return ok(runsOf(this.db, param(req, "id"), 50));
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
      baseUrl: stored.baseUrl, enabled: true,
    };

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

    let config: ModelConfigRow = { id: "probe", modelId: model.id, temperature: 0, maxTokens: 16, topP: 1, extra: "" };
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
    let body: ModelConfigRow = JSON.parse<ModelConfigRow>(req.body);
    if (!existsById(this.db, modelsMapping(), body.modelId)) {
      return badRequest("no model " + body.modelId + "; create it first");
    }
    let written = persist(this.db, modelConfigsMapping(this.db), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, modelConfigsMapping(this.db), jsonId(req.body)));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, modelConfigsMapping(this.db), param(req, "id"))) {
      return notFound("model config " + param(req, "id"));
    }
    if (countWhere(this.db, agentsMapping(), "model_config_id = " + this.db.placeholder, [param(req, "id")]) > 0) {
      return badRequest("config " + param(req, "id") + " is used by an agent; repoint it first");
    }
    deleteById(this.db, modelConfigsMapping(this.db), param(req, "id"));
    return noContent();
  }
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
      token = credentialFor(this.db, "mcp:" + server.id, this.master);
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
  @get("/")
  list(req: Request): Reply {
    let limit = parseInt(queryParam(req, "limit", "50")) ?? 50;
    let offset = parseInt(queryParam(req, "offset", "0")) ?? 0;
    let rows = listThreads(this.db, limit, offset);
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"id\":" + JSON.stringify(rows[i].id)
        + ",\"agentId\":" + JSON.stringify(rows[i].agentId)
        + ",\"createdAt\":" + JSON.stringify(rows[i].createdAt)
        + ",\"title\":" + JSON.stringify(rows[i].title) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  @post("/")
  open(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required: {\"agentId\":\"a1\"}"); }
    let body: ThreadStart = JSON.parse<ThreadStart>(req.body);
    if (!existsById(this.db, agentsMapping(), body.agentId)) {
      return badRequest("no agent " + body.agentId);
    }
    let id = openThread(this.db, body.agentId, stamp());
    if (id == "") { return badRequest("the thread could not be opened"); }
    return created("{\"id\":" + JSON.stringify(id) + ",\"agentId\":" + JSON.stringify(body.agentId) + "}");
  }

  // Ask the thread. The reply is this turn's answer; the transcript is a GET.
  @post("/:id/messages")
  say(req: Request): Reply {
    if (threadAgent(this.db, param(req, "id")) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required: {\"text\":\"...\"}"); }
    let body: RunBody = JSON.parse<RunBody>(req.body);
    if (body.text == "") { return badRequest("nothing to ask: \"text\" is empty"); }

    let tracer = tracerFor(this.db, this.master);
    let answered = runInThread(this.db, param(req, "id"), body.text, this.master, tracer);
    let run = answered.run;
    // The run log keeps the RAW reply — `run.text`, fences and bodies intact —
    // because the log is the audit trail of what the model actually said.
    // Extraction's notes fold in beside the run's own, so a refused fence is
    // read where an operator reads every other warning about the run.
    let runId = recordRun(this.db, threadAgent(this.db, param(req, "id")), body.text, withNotes(run, answered.notes));

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
      + ",\"toolCalls\":" + `${run.steps.length}`
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
  @get("/:id")
  transcript(req: Request): Reply {
    if (threadAgent(this.db, param(req, "id")) == "") {
      return notFound("thread " + param(req, "id"));
    }
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
    return ok(out + "]");
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
    if (threadAgent(this.db, param(req, "id")) == "") {
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
    if (threadAgent(this.db, param(req, "id")) == "") {
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
    let file = getFile(this.db, param(req, "id"), param(req, "name"));
    if (file.id == "") { return notFound("file " + param(req, "name")); }
    return ok("{\"name\":" + JSON.stringify(file.fileName)
      + ",\"mime\":" + JSON.stringify(file.mime)
      + ",\"origin\":" + JSON.stringify(file.origin)
      + ",\"content\":" + JSON.stringify(file.body) + "}");
  }

  @del("/:name")
  remove(req: Request): Reply {
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
    if (this.db.name != "postgres") {
      return badRequest("the corpus needs PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    if (threadAgent(this.db, param(req, "id")) == "") {
      return notFound("thread " + param(req, "id"));
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
    if (threadAgent(this.db, param(req, "id")) == "") {
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
    if (threadAgent(this.db, param(req, "id")) == "") {
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

  // Which versions each round produced — the join a chat client renders its
  // cards from, one query for the whole conversation. `?turn=N` narrows to one
  // round. Console uploads never appear: no round made them.
  //
  // Declared before the slot routes on purpose. "/by-turn" is a literal where
  // ":slot" is a parameter, and the router refuses at startup a table whose
  // literal is written second — the parameter would shadow it.
  @get("/by-turn")
  byTurn(req: Request): Reply {
    if (threadAgent(this.db, param(req, "id")) == "") {
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
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }
    return ok(artifactJson(artifact));
  }

  // One version, body included. JSON, on the console origin, whatever the
  // artifact's own type is — a caller that wants it rendered follows the
  // preview link.
  @get("/:slot/versions/:n")
  version(req: Request): Reply {
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
    + "; img-src data: " + origin
    + "; font-src data: " + origin
    + "; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";
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
function previewReply(req: Request, artifact: ArtifactRow, body: string, cache: string): Reply {
  let answer = reply(200, body, previewType(req, artifact.mime));
  answer.headers.set("content-security-policy", previewCsp(req));
  answer.headers.set("x-content-type-options", "nosniff");
  answer.headers.set("referrer-policy", "no-referrer");
  answer.headers.set("cache-control", cache);
  return answer;
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
      let current = getVersion(this.db, artifact.id, artifact.currentVersion);
      if (current.id == "") { return notFound("artifact"); }
      return previewReply(req, artifact, current.body, "no-store");
    }
    let row = getVersion(this.db, artifact.id, asked);
    if (row.id == "") { return notFound("artifact"); }
    return previewReply(req, artifact, row.body, "private, max-age=31536000, immutable");
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
    let found = getArtifact(this.db, artifact.threadId, param(req, "path"));
    if (found.id == "") { return notFound("artifact"); }
    let row = getVersion(this.db, found.id, found.currentVersion);
    if (row.id == "") { return notFound("artifact"); }
    // `found`, not `artifact`: the type comes from the row whose body this is.
    return previewReply(req, found, row.body, "no-store");
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

  @get("/:id")
  find(req: Request): Reply {
    let document = findById(this.db, runsFull(this.db), param(req, "id"));
    if (document == "") { return notFound("run " + param(req, "id")); }
    return ok(document);
  }
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
  if (m.kind == "chat" && chatEndpoint(m.provider) == "") {
    return "no chat endpoint for provider \"" + m.provider + "\"";
  }
  if (m.kind == "embedding" && embeddingEndpoint(m.provider) == "") {
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
    kind: row.kind, dimensions: row.dimensions, baseUrl: "", enabled: row.enabled,
  };
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
function stamp(): string {
  return `${Date.now()}`;
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
  let opus: ModelRow = { id: "m1", label: "Opus 5", apiName: "claude-opus-5", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true };
  let haiku: ModelRow = { id: "m2", label: "Haiku 4.5", apiName: "claude-haiku-4-5-20251001", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true };
  // Two embedders, exactly one enabled. Retrieval needs an active embedding
  // model to do anything at all, so a seed without one leaves the knowledge
  // base unusable until someone adds a row by hand — and leaves its tests
  // with nothing to look at. Two of them, not one, because "enabling an
  // embedder disables the others" is a rule about a set, and a set of one
  // cannot show it holds.
  let embed: ModelRow = { id: "m3", label: "Mistral Embed", apiName: "mistral-embed", provider: "mistral", kind: "embedding", dimensions: 1024, baseUrl: "", enabled: true };
  let embedSmall: ModelRow = { id: "m4", label: "Nomic Embed Text", apiName: "nomic-embed-text", provider: "ollama", kind: "embedding", dimensions: 768, baseUrl: "http://127.0.0.1:11434", enabled: false };
  persist(db, modelsMapping(), JSON.stringify(opus));
  persist(db, modelsMapping(), JSON.stringify(haiku));
  persist(db, modelsMapping(), JSON.stringify(embed));
  persist(db, modelsMapping(), JSON.stringify(embedSmall));
  let careful: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.2, maxTokens: 8192, topP: 0.95, extra: "{}" };
  let quick: ModelConfigRow = { id: "c2", modelId: "m2", temperature: 0.7, maxTokens: 2048, topP: 1.0, extra: "{}" };
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
  let lead: AgentRow = { id: "a1", agentName: "lead", description: "delegates", modelConfigId: "c1", promptId: "p2", isDefault: true, enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  let scout: AgentRow = { id: "a2", agentName: "scout", description: "searches", modelConfigId: "c2", promptId: "p1", isDefault: false, enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  persist(db, agentsMapping(), JSON.stringify(lead));
  persist(db, agentsMapping(), JSON.stringify(scout));
  execute(db, "INSERT INTO agent_mcp_servers VALUES ('a1','s1')");
  execute(db, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");
}

function main(): void {
  let db = openDatabase();
  let schema = migrationProblem(db);
  if (schema != "") {
    console.error(schema);
    return;
  }
  seed(db);
  let master = masterKey();
  let keyProblem = masterKeyProblem(master);
  if (keyProblem != "") {
    // Refusing to start beats serving with credentials that cannot be read:
    // every provider call would fail later, far from the cause.
    console.error(keyProblem);
    return;
  }

  // Fifteen controllers, handed over whole. Each one is read for its own
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
    new ModelApi(db, master),
    new ConfigApi(db),
    new PromptApi(db),
    new WorkspaceApi(db, master),
    new ThreadApi(db, master),
    new DocumentApi(db, master),
    new ScopeApi(db),
    new JobApi(db),
    new TraceApi(db, master),
    new ServerApi(db, master),
    new ArtifactApi(db),
    new PreviewApi(db),
  ];

  let table = mountedRoutes(mounts);
  let i: int = 0;
  while (i < table.length) {
    console.log("route  " + table[i].method + " " + table[i].pattern + " -> " + table[i].handler);
    i = i + 1;
  }

  let problem = listen(8100, mounts);
  if (problem != "") { console.error(problem); }
}

main();
