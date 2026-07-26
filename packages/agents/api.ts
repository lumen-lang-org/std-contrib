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
import { Route, route } from "../rest/router.ts";
import { Request, Reply, Handler, serve, ok, created, noContent, notFound, badRequest, param, queryParam } from "../rest/server.ts";
import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { postgres } from "../plume/postgres.ts";
import { DbOrder, DbRepository, asc, desc, placeholderAt, connectDatabase, persist, findById, listOrdered, pageOrdered, existsById, deleteById, execute, executeWith, countWhere } from "../plume/plume.ts";
import { migrate } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, McpServerRow, AgentRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, agentsFull, credentialsMapping, schemaPlan } from "./schema.ts";
import { masterKey, masterKeyProblem, storeCredential, credentialFor, providersWithCredentials } from "./credentials.ts";
import { AgentRun, runAgent, runAgentTraced } from "./run.ts";
import { runsMapping, runsFull, runLogPlan, recordRun, runsOf } from "./runlog.ts";
import { TraceConfigRow, traceConfigMapping, tracePlan, tracerFor } from "./trace.ts";
import { jsonId, createProblem, backendOr, knownBackend, scopesJson } from "./payload.ts";
import { jsonText } from "./scan.ts";
import { ThreadListing, listThreads, openThread, threadAgent, threadMessages, runInThread, threadPlan } from "./threads.ts";
import { workspacePlan, putFile, getFile, listFiles, deleteFile, promoteFile, mimeOf } from "./workspace.ts";
import { SourceListing, listSources, ScopeNode, AgentRetrievalRow, agentRetrievalMapping, knowledgePlan, embeddingModel, uploadDocument, scopeCounts, normalScope, agentScopes, grantScope, revokeScope, documentsMapping } from "./knowledge.ts";
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
type ThreadStart = { agentId: string };
type FileUpload = { name: string, content: string };
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
    let stored = storeCredential(this.db, { provider: param(req, "provider"), apiKey: body.apiKey, masterKey: this.master, now: "now" });
    if (stored != "") { return badRequest(stored); }
    return ok("{\"provider\":" + JSON.stringify(param(req, "provider")) + ",\"configured\":true}");
  }

  @del("/:provider/key")
  clearKey(req: Request): Reply {
    if (!existsById(this.db, credentialsMapping(), "cred-" + param(req, "provider"))) {
      return notFound("no key for " + param(req, "provider"));
    }
    deleteById(this.db, credentialsMapping(), "cred-" + param(req, "provider"));
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
    let written = persist(this.db, this.flat, req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  // Moving an agent to a different model is an update to one column, which is
  // the point of keeping the model name in a row.
  @put("/:id/model")
  setModel(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    let change: ModelChange = JSON.parse<ModelChange>(req.body);
    if (!existsById(this.db, modelConfigsMapping(this.db), change.modelConfigId)) {
      return badRequest("no model config " + change.modelConfigId);
    }
    executeWith(this.db, "UPDATE agents SET model_config_id = " + this.db.placeholder
      + " WHERE id = " + placeholderAt(this.db, 2), [change.modelConfigId, param(req, "id")]);
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  // Rolling a prompt back is pointing at an earlier version, which is why a
  // prompt row is never edited.
  @put("/:id/prompt")
  setPrompt(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    let change: PromptChange = JSON.parse<PromptChange>(req.body);
    if (!existsById(this.db, promptsMapping(), change.promptId)) {
      return badRequest("no prompt " + change.promptId);
    }
    executeWith(this.db, "UPDATE agents SET prompt_id = " + this.db.placeholder
      + " WHERE id = " + placeholderAt(this.db, 2), [change.promptId, param(req, "id")]);
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
    executeWith(this.db, "DELETE FROM agent_sub_agents WHERE parent_id = " + this.db.placeholder, [param(req, "id")]);
    executeWith(this.db, "DELETE FROM agent_mcp_servers WHERE agent_id = " + this.db.placeholder, [param(req, "id")]);
    deleteById(this.db, this.flat, param(req, "id"));
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
    let stored = storeCredential(this.db, { provider: "tracing", apiKey: body.secretKey, masterKey: this.master, now: "now" });
    if (stored != "") { return badRequest(stored); }
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
  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("label")];
    return ok(listOrdered(this.db, modelsMapping(), "", [], keys));
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, modelsMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let written = persist(this.db, modelsMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, modelsMapping(), jsonId(req.body)));
  }

  // Enabled is the kill switch: flipping it refuses the next call to every
  // agent on this model, which is the point of it being a column.
  @put("/:id/enabled")
  setEnabled(req: Request): Reply {
    if (!existsById(this.db, modelsMapping(), param(req, "id"))) {
      return notFound("model " + param(req, "id"));
    }
    let flag = "0";
    if (req.body.indexOf("true") >= 0) { flag = "1"; }

    // At most one embedding model is enabled at a time, enforced here rather
    // than asked of a caller. Two enabled embedders is not a preference, it is
    // a corpus split down the middle: a document embedded by one is invisible
    // to every agent retrieving through the other, and nothing reports it —
    // the query simply comes back with fewer passages than it should.
    let row: ModelRow = JSON.parse<ModelRow>(findById(this.db, modelsMapping(), param(req, "id")));
    if (flag == "1" && row.kind == "embedding") {
      executeWith(this.db, "UPDATE models SET enabled = " + this.db.placeholder
        + " WHERE kind = " + placeholderAt(this.db, 2)
        + " AND id <> " + placeholderAt(this.db, 3), ["0", "embedding", param(req, "id")]);
    }

    executeWith(this.db, "UPDATE models SET enabled = " + this.db.placeholder
      + " WHERE id = " + placeholderAt(this.db, 2), [flag, param(req, "id")]);
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
  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("server_name")];
    return ok(listOrdered(this.db, mcpServersMapping(), "", [], keys));
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, mcpServersMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let body: McpServerRow = JSON.parse<McpServerRow>(req.body);
    if (body.transport != "http" && body.transport != "stdio") {
      return badRequest("transport must be \"http\" or \"stdio\", not \"" + body.transport + "\"");
    }
    let written = persist(this.db, mcpServersMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, mcpServersMapping(), jsonId(req.body)));
  }

  @put("/:id/enabled")
  setEnabled(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    let flag = "0";
    if (req.body.indexOf("true") >= 0) { flag = "1"; }
    executeWith(this.db, "UPDATE mcp_servers SET enabled = " + this.db.placeholder
      + " WHERE id = " + placeholderAt(this.db, 2), [flag, param(req, "id")]);
    return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    executeWith(this.db, "DELETE FROM agent_mcp_servers WHERE server_id = " + this.db.placeholder, [param(req, "id")]);
    deleteById(this.db, mcpServersMapping(), param(req, "id"));
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
    let id = openThread(this.db, body.agentId, "now");
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
    let runId = recordRun(this.db, threadAgent(this.db, param(req, "id")), body.text, answered);

    let traced = "";
    if (tracing(tracer) && answered.spans.length > 0) {
      if (flush(tracerWithMoreSpans(tracer, answered.spans)).ok) { traced = traceId(tracer); }
    }
    return ok("{\"runId\":" + JSON.stringify(runId)
      + ",\"ok\":" + `${answered.ok}`
      + ",\"text\":" + JSON.stringify(answered.text)
      + ",\"toolCalls\":" + `${answered.steps.length}`
      + ",\"inputTokens\":" + `${answered.inputTokens}`
      + ",\"outputTokens\":" + `${answered.outputTokens}`
      + ",\"traceId\":" + JSON.stringify(traced)
      + ",\"error\":" + JSON.stringify(answered.error) + "}");
  }

  // What a person reads: the questions and the answers. The tool calls and the
  // passages are in the trace, which is where somebody debugging looks.
  @get("/:id")
  transcript(req: Request): Reply {
    if (threadAgent(this.db, param(req, "id")) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let said = threadMessages(this.db, param(req, "id"));
    let out = "[";
    let i: int = 0;
    while (i < said.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"role\":" + JSON.stringify(said[i].role)
        + ",\"text\":" + JSON.stringify(said[i].text) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }
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
    let problem = putFile(this.db, { threadId: param(req, "id"), fileName: body.name, mime: mimeOf(body.name), origin: "uploaded", body: body.content, documentId: "", now: "now" });
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
    let problem = putFile(this.db, { threadId: param(req, "id"), fileName: body.name, mime: mimeOf(body.name), origin: "retrieved", body: content, documentId: body.documentId, now: "now" });
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

    let stored = promoteFile(this.db, embedder, param(req, "id"), param(req, "name"), body.scope, key, "now");
    if (!stored.ok) { return badRequest(stored.error); }
    return ok("{\"name\":" + JSON.stringify(param(req, "name"))
      + ",\"scope\":" + JSON.stringify(normalScope(body.scope))
      + ",\"chunks\":" + `${stored.chunks}` + "}");
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
    let rows = listSources(this.db, queryParam(req, "scope", "/"));
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"source\":" + JSON.stringify(rows[i].source)
        + ",\"scope\":" + JSON.stringify(rows[i].scope)
        + ",\"chunks\":" + `${rows[i].chunks}`
        + ",\"bytes\":" + `${rows[i].bytes}` + "}";
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

    let stored = uploadDocument(this.db, embedder, body.source, body.scope, body.body, key);
    if (!stored.ok) { return badRequest(stored.error); }
    return created("{\"source\":" + JSON.stringify(body.source)
      + ",\"scope\":" + JSON.stringify(normalScope(body.scope))
      + ",\"chunks\":" + `${stored.chunks}` + "}");
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
@controller("/scopes")
class ScopeApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  tree(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    return ok(scopesJson(scopeCounts(this.db, queryParam(req, "prefix", ""))));
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
    return migrated(pg);
  }
  let db = sqlite();
  let cfg: DbConfig = { filename: process.env("AGENTS_DB_FILE") ?? "/tmp/agents_api.db" };
  connectDatabase(db, cfg);
  return migrated(db);
}

function migrated(db: Db): Db {
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
  let ran = migrate(db, plan);
  if (!ran.ok) { console.error(ran.error); }
  return db;
}


function seed(db: Db): void {
  if (countWhere(db, agentsMapping(), "", []) > 0) { return; }
  let opus: ModelRow = { id: "m1", label: "Opus 5", apiName: "claude-opus-5", provider: "anthropic", kind: "chat", dimensions: 0, enabled: true };
  let haiku: ModelRow = { id: "m2", label: "Haiku 4.5", apiName: "claude-haiku-4-5-20251001", provider: "anthropic", kind: "chat", dimensions: 0, enabled: true };
  persist(db, modelsMapping(), JSON.stringify(opus));
  persist(db, modelsMapping(), JSON.stringify(haiku));
  let careful: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.2, maxTokens: 8192, topP: 0.95, extra: "{}" };
  let quick: ModelConfigRow = { id: "c2", modelId: "m2", temperature: 0.7, maxTokens: 2048, topP: 1.0, extra: "{}" };
  persist(db, modelConfigsMapping(db), JSON.stringify(careful));
  persist(db, modelConfigsMapping(db), JSON.stringify(quick));
  let p1: PromptRow = { id: "p1", promptName: "lead", version: 1, body: "You lead.", createdAt: "2026-07-25" };
  let p2: PromptRow = { id: "p2", promptName: "lead", version: 2, body: "You lead, briefly.", createdAt: "2026-07-25" };
  persist(db, promptsMapping(), JSON.stringify(p1));
  persist(db, promptsMapping(), JSON.stringify(p2));
  let fsSrv: McpServerRow = { id: "s1", serverName: "filesystem", transport: "stdio", endpoint: "mcp-fs", enabled: true };
  let ghSrv: McpServerRow = { id: "s2", serverName: "github", transport: "http", endpoint: "https://mcp.gh", enabled: true };
  persist(db, mcpServersMapping(), JSON.stringify(fsSrv));
  persist(db, mcpServersMapping(), JSON.stringify(ghSrv));
  let lead: AgentRow = { id: "a1", agentName: "lead", description: "delegates", modelConfigId: "c1", promptId: "p2", enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  let scout: AgentRow = { id: "a2", agentName: "scout", description: "searches", modelConfigId: "c2", promptId: "p1", enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  persist(db, agentsMapping(), JSON.stringify(lead));
  persist(db, agentsMapping(), JSON.stringify(scout));
  execute(db, "INSERT INTO agent_mcp_servers VALUES ('a1','s1')");
  execute(db, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");
}

function main(): void {
  let db = openDatabase();
  seed(db);
  let master = masterKey();
  let keyProblem = masterKeyProblem(master);
  if (keyProblem != "") {
    // Refusing to start beats serving with credentials that cannot be read:
    // every provider call would fail later, far from the cause.
    console.error(keyProblem);
    return;
  }
  let api = new AgentApi(db, master);
  let providers = new ProviderApi(db, master);
  let traces = new RunApi(db);

  let bound = new Map<string, Handler>();
  // Every binding catches, and the try is inside the lambda because that is
  // the only place it works: spec 245 propagates a throw through direct calls,
  // but a handler is reached through a function value, and the fixpoint pass
  // cannot see through one — so a throw inside a handler lambda escapes any
  // try in `serve` and kills the process.
  //
  // It did. `JSON.parse<T>` throws when the body is missing a field the record
  // declares, and one PUT with a partial body stopped the whole API for
  // everyone. Twenty-one routes parse a body.
  bound.set("list", (req: Request) => {
    try { return api.list(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("find", (req: Request) => {
    try { return api.find(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("update", (req: Request) => {
    try { return api.update(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("create", (req: Request) => {
    try { return api.create(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("setModel", (req: Request) => {
    try { return api.setModel(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("setPrompt", (req: Request) => {
    try { return api.setPrompt(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("addServer", (req: Request) => {
    try { return api.addServer(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("removeServer", (req: Request) => {
    try { return api.removeServer(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("addChild", (req: Request) => {
    try { return api.addChild(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("removeChild", (req: Request) => {
    try { return api.removeChild(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("run", (req: Request) => {
    try { return api.run(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("scopes", (req: Request) => {
    try { return api.scopes(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("grant", (req: Request) => {
    try { return api.grant(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("revoke", (req: Request) => {
    try { return api.revoke(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("setRetrieval", (req: Request) => {
    try { return api.setRetrieval(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("runs", (req: Request) => {
    try { return api.runs(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("remove", (req: Request) => {
    try { return api.remove(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  bound.set("plist", (req: Request) => {
    try { return providers.list(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("pstatus", (req: Request) => {
    try { return providers.status(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("psetKey", (req: Request) => {
    try { return providers.setKey(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("pclearKey", (req: Request) => {
    try { return providers.clearKey(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  bound.set("rfind", (req: Request) => {
    try { return traces.find(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  let workspace = new WorkspaceApi(db, master);
  bound.set("wlist", (req: Request) => {
    try { return workspace.list(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("wupload", (req: Request) => {
    try { return workspace.upload(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("wread", (req: Request) => {
    try { return workspace.read(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("wremove", (req: Request) => {
    try { return workspace.remove(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("wpull", (req: Request) => {
    try { return workspace.pull(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("wpromote", (req: Request) => {
    try { return workspace.promote(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  let threads = new ThreadApi(db, master);
  bound.set("hlist", (req: Request) => {
    try { return threads.list(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("hopen", (req: Request) => {
    try { return threads.open(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("hsay", (req: Request) => {
    try { return threads.say(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("htranscript", (req: Request) => {
    try { return threads.transcript(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  let documents = new DocumentApi(db, master);
  bound.set("dlist", (req: Request) => {
    try { return documents.list(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("dupload", (req: Request) => {
    try { return documents.upload(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("dremove", (req: Request) => {
    try { return documents.remove(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  let scopeApi = new ScopeApi(db);
  bound.set("kstree", (req: Request) => {
    try { return scopeApi.tree(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  let tracingApi = new TraceApi(db, master);
  bound.set("tstatus", (req: Request) => {
    try { return tracingApi.status(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("tconfigure", (req: Request) => {
    try { return tracingApi.configure(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("tsetKey", (req: Request) => {
    try { return tracingApi.setKey(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  let models = new ModelApi(db);
  bound.set("mlist", (req: Request) => {
    try { return models.list(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("mcreate", (req: Request) => {
    try { return models.create(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("msetEnabled", (req: Request) => {
    try { return models.setEnabled(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("mremove", (req: Request) => {
    try { return models.remove(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  let configs = new ConfigApi(db);
  bound.set("clist", (req: Request) => {
    try { return configs.list(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("ccreate", (req: Request) => {
    try { return configs.create(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("cremove", (req: Request) => {
    try { return configs.remove(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  let prompts = new PromptApi(db);
  bound.set("promptlist", (req: Request) => {
    try { return prompts.list(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("promptcreate", (req: Request) => {
    try { return prompts.create(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  let servers = new ServerApi(db);
  bound.set("slist", (req: Request) => {
    try { return servers.list(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("screate", (req: Request) => {
    try { return servers.create(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("ssetEnabled", (req: Request) => {
    try { return servers.setEnabled(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });
  bound.set("sremove", (req: Request) => {
    try { return servers.remove(req); }
    catch (e) { return badRequest("the request could not be handled: " + e.message); }
  });

  // Three controllers, one table. The provider and run handlers are prefixed
  // because a table is keyed by handler name and the classes share a `find`
  // and a `list`.
  let table: Route[] = [];
  let a: int = 0;
  while (a < controllerAgentApi.length) { table.push(controllerAgentApi[a]); a = a + 1; }
  let p: int = 0;
  while (p < controllerProviderApi.length) {
    let r = controllerProviderApi[p];
    table.push(route(r.method, r.pattern, "p" + r.handler));
    p = p + 1;
  }
  let t: int = 0;
  while (t < controllerRunApi.length) {
    let r = controllerRunApi[t];
    table.push(route(r.method, r.pattern, "r" + r.handler));
    t = t + 1;
  }
  let m: int = 0;
  while (m < controllerModelApi.length) {
    let r = controllerModelApi[m];
    table.push(route(r.method, r.pattern, "m" + r.handler));
    m = m + 1;
  }
  let c: int = 0;
  while (c < controllerConfigApi.length) {
    let r = controllerConfigApi[c];
    table.push(route(r.method, r.pattern, "c" + r.handler));
    c = c + 1;
  }
  let pr: int = 0;
  while (pr < controllerPromptApi.length) {
    let r = controllerPromptApi[pr];
    table.push(route(r.method, r.pattern, "prompt" + r.handler));
    pr = pr + 1;
  }
  let wf: int = 0;
  while (wf < controllerWorkspaceApi.length) {
    let r = controllerWorkspaceApi[wf];
    table.push(route(r.method, r.pattern, "w" + r.handler));
    wf = wf + 1;
  }
  let th: int = 0;
  while (th < controllerThreadApi.length) {
    let r = controllerThreadApi[th];
    table.push(route(r.method, r.pattern, "h" + r.handler));
    th = th + 1;
  }
  let dc: int = 0;
  while (dc < controllerDocumentApi.length) {
    let r = controllerDocumentApi[dc];
    table.push(route(r.method, r.pattern, "d" + r.handler));
    dc = dc + 1;
  }
  let sc: int = 0;
  while (sc < controllerScopeApi.length) {
    let r = controllerScopeApi[sc];
    table.push(route(r.method, r.pattern, "ks" + r.handler));
    sc = sc + 1;
  }
  let tr: int = 0;
  while (tr < controllerTraceApi.length) {
    let r = controllerTraceApi[tr];
    table.push(route(r.method, r.pattern, "t" + r.handler));
    tr = tr + 1;
  }
  let sv: int = 0;
  while (sv < controllerServerApi.length) {
    let r = controllerServerApi[sv];
    table.push(route(r.method, r.pattern, "s" + r.handler));
    sv = sv + 1;
  }

  let i: int = 0;
  while (i < table.length) {
    console.log("route  " + table[i].method + " " + table[i].pattern + " -> " + table[i].handler);
    i = i + 1;
  }

  let problem = serve(8100, table, bound);
  if (problem != "") { console.error(problem); }
}

main();
