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
import { DbOrder, DbRepository, asc, desc, placeholderAt, connectDatabase, persist, findById, listOrdered, pageOrdered, existsById, deleteById, execute, executeWith, countWhere } from "../plume/plume.ts";
import { migrate } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, McpServerRow, AgentRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, agentsFull, credentialsMapping, schemaPlan } from "./schema.ts";
import { masterKey, masterKeyProblem, storeCredential, credentialFor, providersWithCredentials } from "./credentials.ts";
import { AgentRun, runAgent, runAgentTraced } from "./run.ts";
import { runsMapping, runsFull, runLogPlan, recordRun, runsOf } from "./runlog.ts";
import { TraceConfigRow, traceConfigMapping, tracePlan, tracerFor } from "./trace.ts";
import { Tracer, flush, traceId, spanCount, tracing, tracerWithMoreSpans } from "../tracing/tracing.ts";

// A change to which model or prompt an agent uses, as a body.
type ModelChange = { modelConfigId: string };
type PromptChange = { promptId: string };
type ServerLink = { serverId: string };
type ChildLink = { childId: string };
type KeyBody = { apiKey: string };
type RunBody = { text: string };
type TraceSecret = { secretKey: string };

// The backends this API will write into a trace_config row. Checked here
// rather than at the tracer, because a typo should be refused when it is set
// and not silently turn tracing off later.
function backendOr(name: string): string {
  if (name == "") { return "langfuse"; }
  return name;
}

function knownBackend(name: string): bool {
  return name == "langfuse" || name == "otlp" || name == "phoenix"
    || name == "braintrust" || name == "langsmith" || name == "arize";
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
    let stored = storeCredential(this.db, param(req, "provider"), body.apiKey, this.master, "now");
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
    let stored = storeCredential(this.db, "tracing", body.secretKey, this.master, "now");
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
function createProblem(db: Db, repo: DbRepository, document: string): string {
  if (document == "") { return "a body is required"; }
  let id = jsonId(document);
  if (id == "") { return "an \"id\" is required"; }
  if (existsById(db, repo, id)) {
    return "\"" + id + "\" already exists; a POST creates, and changing a row is a PUT";
  }
  return "";
}

// An id read out of a posted document, so a create can answer with the whole
// agent rather than the fragment it was given.
function jsonId(document: string): string {
  let at = document.indexOf("\"id\"");
  if (at < 0) { return ""; }
  let rest = document.substring(at + 4, document.length);
  let open = rest.indexOf("\"");
  if (open < 0) { return ""; }
  let value = rest.substring(open + 1, rest.length);
  return value.substring(0, value.indexOf("\""));
}


function openDatabase(): Db {
  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/agents_api.db" };
  connectDatabase(db, cfg);
  // One plan, extended — not two plans. A second migrate() call would be
  // handed a plan that lacks the versions already recorded, and refuse.
  let plan = schemaPlan(db);
  let extra = runLogPlan(db);
  let e: int = 0;
  while (e < extra.length) { plan.push(extra[e]); e = e + 1; }
  let traces = tracePlan(db);
  let t: int = 0;
  while (t < traces.length) { plan.push(traces[t]); t = t + 1; }
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
  bound.set("list", (req: Request) => { return api.list(req); });
  bound.set("find", (req: Request) => { return api.find(req); });
  bound.set("create", (req: Request) => { return api.create(req); });
  bound.set("setModel", (req: Request) => { return api.setModel(req); });
  bound.set("setPrompt", (req: Request) => { return api.setPrompt(req); });
  bound.set("addServer", (req: Request) => { return api.addServer(req); });
  bound.set("removeServer", (req: Request) => { return api.removeServer(req); });
  bound.set("addChild", (req: Request) => { return api.addChild(req); });
  bound.set("removeChild", (req: Request) => { return api.removeChild(req); });
  bound.set("run", (req: Request) => { return api.run(req); });
  bound.set("runs", (req: Request) => { return api.runs(req); });
  bound.set("remove", (req: Request) => { return api.remove(req); });

  bound.set("plist", (req: Request) => { return providers.list(req); });
  bound.set("pstatus", (req: Request) => { return providers.status(req); });
  bound.set("psetKey", (req: Request) => { return providers.setKey(req); });
  bound.set("pclearKey", (req: Request) => { return providers.clearKey(req); });

  bound.set("rfind", (req: Request) => { return traces.find(req); });

  let tracingApi = new TraceApi(db, master);
  bound.set("tstatus", (req: Request) => { return tracingApi.status(req); });
  bound.set("tconfigure", (req: Request) => { return tracingApi.configure(req); });
  bound.set("tsetKey", (req: Request) => { return tracingApi.setKey(req); });

  let models = new ModelApi(db);
  bound.set("mlist", (req: Request) => { return models.list(req); });
  bound.set("mcreate", (req: Request) => { return models.create(req); });
  bound.set("msetEnabled", (req: Request) => { return models.setEnabled(req); });
  bound.set("mremove", (req: Request) => { return models.remove(req); });

  let configs = new ConfigApi(db);
  bound.set("clist", (req: Request) => { return configs.list(req); });
  bound.set("ccreate", (req: Request) => { return configs.create(req); });
  bound.set("cremove", (req: Request) => { return configs.remove(req); });

  let prompts = new PromptApi(db);
  bound.set("promptlist", (req: Request) => { return prompts.list(req); });
  bound.set("promptcreate", (req: Request) => { return prompts.create(req); });

  let servers = new ServerApi(db);
  bound.set("slist", (req: Request) => { return servers.list(req); });
  bound.set("screate", (req: Request) => { return servers.create(req); });
  bound.set("ssetEnabled", (req: Request) => { return servers.setEnabled(req); });
  bound.set("sremove", (req: Request) => { return servers.remove(req); });

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
