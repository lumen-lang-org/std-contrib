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

import { ApiKeyRow, apiKeysOf, apiKeysPlan, forgetApiKey, hasScope, mintApiKey, touchApiKey, verifyApiKey } from "./api-keys.ts";
import { presentedKey, upstreamBase } from "./search-gateway.ts";
import { urlEncode } from "./mcp-oauth.ts";
import { controller } from "../rest/controller.ts";
import { Request, Reply, Mount, mountedRoutes, mountProblem, dispatchedMounted, reply, ok, created, accepted, noContent, notFound, badRequest, problem, param, queryParam, header } from "../rest/server.ts";
import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { postgres } from "../plume/postgres.ts";
import { DbOrder, DbRepository, asc, desc, safeIdentifier, placeholderAt, connectDatabase, persist, findById, listOrdered, listWhere, pageOrdered, existsById, deleteById, execute, executeWith, countWhere, jsonMember } from "../plume/plume.ts";
import { migrate, appliedHighWater } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, ModelChoiceRow, ModelRouterRow, PromptRow, McpServerRow, AgentRow, ScriptImageRow, SkillRow, SkillFileRow, modelsMapping, modelConfigsMapping, modelConfigRows, configAndModel, modelChoicesMapping, modelRoutersMapping, enabledChoices, promptsMapping, mcpServersMapping, agentsMapping, agentsFull, scriptImagesMapping, skillsMapping, skillFilesMapping, AuthProviderRow, authProvidersMapping, PluginRow, PluginItemRow, pluginsMapping, pluginItemsMapping, schemaPlan, derivedMenuStatements, askCancel, clearCancel, readSetting, writeSetting } from "./schema.ts";
import { DestinationMove, destinationOf, masterKey, masterKeyProblem, storeCredential, credentialFor, providersWithCredentials, hasCredential, forgetCredential, destinationProblem } from "./credentials.ts";
import { AgentRun, runAgent, runAgentTraced } from "./run.ts";
import { ToolSpec, chatEndpoint, embeddingEndpoint, endpointFor, complete, embedText, replyText, userTurn } from "./provider.ts";
import { runsMapping, runsFull, runLogPlan, recordRun, runsOf, ownedRun } from "./runlog.ts";
import { TraceConfigRow, traceConfigMapping, tracePlan, tracerFor } from "./trace.ts";
import { jsonId, createProblem, backendOr, knownBackend, scopesJson } from "./payload.ts";
import { jsonList, jsonText, jsonFind, jsonUnescape, jsonRaw, jsonFlag } from "./scan.ts";
import { BannerApi } from "./banner-api.ts";
import { toolListing } from "./mcp.ts";
import { taskTools, callTaskTool } from "./task-tools.ts";
import { workflowTools, callWorkflowTool } from "./workflow-tools.ts";
import { triggerTools, callTriggerTool } from "./trigger-tools.ts";
import { agentTools, callAgentTool } from "./agent-tools.ts";
import { knowledgeTools, callKnowledgeTool } from "./knowledge-tools.ts";
import { projectTools, callProjectTool } from "./project-tools.ts";
import { forgetRoster, mcpRosterPlan, rememberRoster, rosterOf, rosterWithSwitches } from "./mcp-roster.ts";
import { userTokenKey, accessTokenFor, beginConnect, completeConnect, connectionOf, disconnect, forgetConnector, forgetSuppliedClient, setSuppliedClient, suppliedClientId, toolsOff, setToolOn } from "./connect.ts";
import { Manifest, manifestFrom, manifestUrl, fetchManifest, installProblem, install, uninstall, itemsOf } from "./plugins.ts";
import { ModelPick, ThreadListing, ThreadTurnRow, threadsMapping, listThreads, openThread, ownedThread, threadOwner, threadChoice, threadTitle, rememberChoice, rememberRouteKey, sweepEmptyThreads, sweepIdleMs, threadMessageRows, runInThreadWith, threadPlan, listReplayable, markReplayable, remixThread, readableThread, appendTurns, nameThread} from "./threads.ts";
import { trustsProxyAuth, tagsFromHeader, identityUnreadable, owningTag, holdsOwner } from "./owner.ts";
import { ownerUsage, usageJson, runsSince, utcDayStartText, secondsToUtcMidnight, nextUtcMidnightIso } from "./usage.ts";
import { FileToolResult, workspacePlan, putFile, getFile, listFiles, deleteFile, promoteFile, mimeOf } from "./workspace.ts";
// `mimeOf` is deliberately not taken from here: workspace.ts already owns that
// name in this file, and an artifact's type is on its row anyway.
import { ArtifactRow, ArtifactCard, TurnArtifact, TURN_SEQ_NONE, artifactPlan, artifactsMapping, imageMediaType, putArtifact, listArtifacts, libraryFor, getArtifact, findByToken, getVersion, deleteArtifact, artifactsForTurn, artifactsByTurn, utf8Length } from "./artifacts.ts";
import { scriptEnvNameProblem, scriptImage } from "./run-script.ts";
import { OfficeRenderAsk, officeRender, officeRenderExt } from "./office-render.ts";
import { stepPlan, stepsOfRound, stepsOfThread, roundRunning, latestRound, stepMillis, thoughtsOfRound, thoughtsOfThread, LiveStep, Thought, partialOf } from "./steps.ts";
import { EnvSweep, ENV_IDLE_MS, envPlan, envDockerUp, envIdle, envOwned, envDrop, envImagePresent } from "./environments.ts";
import { WireRef, wireView } from "./artifacts-fence.ts";
import { IndexJobRow, indexingPlan, enqueue, pendingJobs, JOB_QUEUED } from "./indexing.ts";
import { SourceListing, listSources, ScopeNode, AgentRetrievalRow, agentRetrievalMapping, knowledgePlan, embeddingModel, createDocuments, uploadDocument, scopeCounts, normalScope, agentScopes, grantScope, revokeScope, documentsMapping } from "./knowledge.ts";
import { AgentWebRagRow, agentWebRagMapping, webRagFor, webRagPlan } from "./webrag.ts";
import { ToolCardRow, allToolCards, toolCardsMapping, toolCardsPlan } from "./toolcards.ts";
import { DiscoverFeed, DiscoverRow, DiscoverTopic, allFeeds, asArticleContext, digest, discoverFeedsMapping, discoverPlan, discoverStoriesMapping, discoverText, discoverTextMapping, setDiscoverText, ensureGeoFeed, feedById, geoCode, refreshFeed, storiesFor, storyById } from "./discover.ts";
import { CardCaseRow, CardPluginRow, cardCasesMapping, cardPluginsMapping, cardPluginsPlan } from "./plugincards.ts";
import { TaskRow, MAX_PER_OWNER, compile, emptyTask, enabledCount, isOnce, nextFire, onceInstant, refuse, stampMs, tasksMapping, tasksOf, tasksPlan, withNextAt } from "./tasks.ts";
import { ensureBuilt } from "./script-wasm.ts";
import { MAX_WORKFLOWS_PER_OWNER, WorkflowRow, emptyWorkflow, enabledWorkflowCount, nextWorkflowFire, parseGraph, refuseWorkflow, workflowRunsOf, timingOf, withWorkflowNextAt, workflowsMapping, workflowsOf, workflowsPlan } from "./workflow-store.ts";
import { TriggerBotRow, botsOf, emptyBot, queuedFor, triggerBotsMapping, triggersPlan } from "./triggers.ts";
import { createSecret, forgetSecret, graphSecretProblem, secretsMapping, secretsOf, secretsPlan } from "./secrets.ts";
import { EnvKeyRow, createEnvKey, envKeysMapping, envKeysOf, envKeysOwnedBy, envKeysPlan, forgetEnvKey } from "./env-keys.ts";
import { UserEnvRow, createUserEnv, forgetUserEnv, userEnvById, userEnvsMapping, userEnvsOf, userEnvsPlan } from "./user-environments.ts";
import { SandboxLimits, applySandboxLimits, defaultLimits, sandboxLimits, saveSandboxLimits } from "./sandbox-limits.ts";
import { EnvTemplateRow, EnvTemplateWrite, emptyEnvTemplate, envTemplateById, envTemplatesAll, envTemplatesMapping, envTemplatesPlan, forgetEnvTemplate, saveEnvTemplate } from "./env-templates.ts";
import { PROJECT_FILES_KEY, ProjectRow, assignProject, emptyProject, projectsMapping, projectsOf, projectsPlan, releaseThreads, rememberFilesThread } from "./projects.ts";
import { DocumentFileRow, FILE_BASE64_MAX, documentFileId, documentFilesMapping, documentFilesPlan, findDocumentFile, forgetDocumentFiles, holdsSource, sourcesWithFiles } from "./document-files.ts";
import { Tracer, flush, traceId, spanCount, tracing, tracerWithMoreSpans, tracerWithSession } from "../tracing/tracing.ts";

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
// The one member PUT /servers/:id/tools/:tool reads.
type ToolSwitch = { on: bool };
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

// How many turns a guest gets in one UTC day. The window is the calendar day
// — it resets at a moment the refusal can name honestly — and the count is
// runs, failed ones included, because a failed run spent a provider call too.
const GUEST_DAILY_RUNS: int = 10;

// The caller's tag when the gateway minted this caller a guest identity, ""
// for everybody else. The gateway stamps guests `guest:<hex>`, and `:` cannot
// appear in a real user's uuid — so the prefix is the whole test. Only tags that came through `callerTags` reach here, which is what
// keeps the community deployment out of this entirely: untrusted, the tag
// list is empty and every caller is nobody's guest.
export function guestTag(tags: string[]): string {
  if (tags.length != 1) { return ""; }
  if (!tags[0].startsWith("guest:")) { return ""; }
  return tags[0];
}

// The 429 a guest over the day's ceiling gets. `remaining` is spelled out as 0
// — the client keys its wall off `error` but shows the numbers — and
// `resetsAt` is the same instant the Retry-After header counts down to.
export function guestQuotaJson(used: int, resetsAt: string): string {
  return "{\"error\":\"guest_quota\",\"limit\":" + `${GUEST_DAILY_RUNS}`
    + ",\"used\":" + `${used}`
    + ",\"remaining\":0"
    + ",\"resetsAt\":" + JSON.stringify(resetsAt) + "}";
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
        + ",\"kind\":" + JSON.stringify(rows[i].kind == "" ? "oidc" : rows[i].kind)
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
          + ",\"kind\":" + JSON.stringify(rows[i].kind == "" ? "oidc" : rows[i].kind)
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
  let kind = row.kind == "" ? "oidc" : row.kind;
  if (kind != "oidc" && kind != "github") { return "kind is 'oidc' or 'github'"; }
  // github's endpoints are the framework's, not the row's — it carries no
  // issuer. Only an OIDC provider is discovered from one.
  if (kind == "oidc" && !row.issuer.startsWith("https://")) {
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
    // The caller's own token when they stored one — the listing should see the
    // same tools a run on their conversation will mount, through the same
    // resolver, so an OAuth connector is refreshed here too rather than
    // reporting "could not be asked" until somebody starts a conversation.
    let listed = toolListing(server, accessTokenFor(this.db, server, owningTag(callerTags(req)), this.master));
    let declined = toolsOff(this.db, server.id);

    // A listing that worked is kept, so the next caller who cannot get one —
    // not signed in, token stale, server down — still has real tool names to
    // choose from. Only on success: overwriting a good roster with an empty
    // one on a network blip is how a cache stops being worth having.
    if (listed.problem == "") {
      rememberRoster(this.db, server.id, listed.tools, `${Date.now()}`);
    } else {
      // Nothing live. Answer what it last said, dated, and keep the problem
      // in the reply — the screen shows both: the names, and why they are not
      // fresh. `listedAt` empty means it has never been listed at all, which
      // is the honest "there is nothing to show you yet".
      let held = rosterOf(this.db, server.id);
      if (held.listedAt != "") {
        return ok("{\"serverId\":" + JSON.stringify(server.id)
          + ",\"problem\":" + JSON.stringify(listed.problem)
          + ",\"stale\":true,\"listedAt\":" + JSON.stringify(held.listedAt)
          + ",\"tools\":" + rosterWithSwitches(held.tools, declined) + "}");
      }
    }

    let out = "{\"serverId\":" + JSON.stringify(server.id)
      + ",\"problem\":" + JSON.stringify(listed.problem)
      + ",\"stale\":false,\"listedAt\":\"\",\"tools\":[";
    let i: int = 0;
    while (i < listed.tools.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"name\":" + JSON.stringify(listed.tools[i].name)
        + ",\"description\":" + JSON.stringify(listed.tools[i].description)
        // Whether it is actually mounted. The listing is what the connector
        // offers; this is what this deployment does with it, and a screen that
        // showed only the first would offer switches it could not reflect.
        + ",\"on\":" + (declined.includes(listed.tools[i].name) ? "false" : "true") + "}";
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
    if (body.authKind != "none" && body.authKind != "bearer"
        && body.authKind != "header" && body.authKind != "oauth") {
      return badRequest("auth is none, bearer, header or oauth, not \"" + body.authKind + "\"");
    }
    if (body.authKind == "header" && body.authHeader.trim() == "") {
      return badRequest("a custom header needs a name");
    }
    // "oauth" is the one kind whose token cannot be typed: it is issued by the
    // connector to this person, through POST /connect/:id/start. Accepting one
    // here would be accepting a token nothing can refresh.
    if (body.authKind != "none" && body.authKind != "oauth" && body.token == "") {
      return badRequest("that auth kind needs a token");
    }
    if (body.authKind == "oauth" && body.token != "") {
      return badRequest("an OAuth connector is signed in to, not given a token — press Connect");
    }
    executeWith(this.db, "UPDATE mcp_servers SET auth_kind = " + this.db.placeholder
      + ", auth_header = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [body.authKind, body.authHeader, param(req, "id")]);
    if (body.authKind == "none") {
      // Switching a server to no auth used to leave the token in the store,
      // where nothing ever read it again and nothing ever deleted it — until
      // the kind was switched back, or the id was reused. Everybody's, not
      // just the deployment's: a per-person token for a connector that no
      // longer authenticates is a secret with nothing left to send it to.
      forgetConnector(this.db, param(req, "id"), this.master);
      return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
    }
    if (body.authKind == "oauth") {
      // Nothing to store yet — this only says HOW the connector signs in. The
      // tokens arrive when somebody presses Connect.
      return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
    }
    let stored = storeCredential(this.db, { provider: "mcp:" + param(req, "id"),
      apiKey: body.token, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
  }

  /* Switch one of this connector's tools on or off.
   *
   * Deployment-wide rather than per-person, unlike the token: a tool being
   * mounted decides what every conversation's model is told it can do, and two
   * people on one deployment disagreeing about that would make the same agent
   * behave differently depending on who asked.
   *
   * It exists because tool specs are spent context. Linear offers 52, each
   * with a JSON Schema, and mounting all of them put more in the prompt than a
   * small local model could hold — it refused the request outright rather than
   * answering badly. Switching some off is what makes such a connector usable
   * at all on a model that is not enormous.
   */
  @put("/:id/tools/:tool")
  setTool(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: ToolSwitch = JSON.parse<ToolSwitch>(req.body);
    if (param(req, "tool").trim() == "") { return badRequest("a tool needs a name"); }
    setToolOn(this.db, param(req, "id"), param(req, "tool"), body.on);
    return noContent();
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
    // Every token anyone stored for it, and the registration behind them.
    forgetConnector(this.db, param(req, "id"), this.master);
    // And what it last said it could do — a roster outliving its server is a
    // list of tools nothing can call, and would be handed to the next server
    // that happened to reuse the id.
    forgetRoster(this.db, param(req, "id"));
    return noContent();
  }

  // (The tools listing lives at 2401 — another hand had already built
  // GET /:id/tools when this controller grew a second copy, and the router
  // refuses a route that can never match rather than letting it shadow.)

  // Whether each connector is connected, for whoever is asking.
  //
  // Its own route rather than a field on GET /servers because the answer is
  // per-caller: the same connector is "connected" for the person who signed in
  // to it and "not connected" for everybody else, and a listing that cached
  // would be wrong for one of them.
  @get("/connections")
  connections(req: Request): Reply {
    let owner = owningTag(callerTags(req));
    let keys: DbOrder[] = [asc("server_name")];
    let rows = JSON.parse<McpServerRow[]>(listOrdered(this.db, mcpServersMapping(), "", [], keys));
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      let held = connectionOf(this.db, rows[i].id, owner);
      out = out + "{\"serverId\":" + JSON.stringify(rows[i].id)
        + ",\"authKind\":" + JSON.stringify(rows[i].authKind)
        + ",\"state\":" + JSON.stringify(held.state)
        + ",\"whose\":" + JSON.stringify(held.whose)
        // Whether an operator gave this connector an OAuth client of its own,
        // so the console can say "an app is needed" before somebody presses a
        // button that cannot finish. The client id is not a secret — it rides
        // in the consent URL the browser visits — and the secret beside it is
        // answered by nothing.
        + ",\"clientId\":" + JSON.stringify(suppliedClientId(this.db, rows[i].id, this.master))
        + ",\"connectedAt\":" + JSON.stringify(held.connectedAt) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }
}

/* Signing in to a connector.
 *
 * Its own controller, and not two more routes on /servers, because the
 * callback cannot live under /servers/:id: the browser comes back to a fixed
 * address that was registered with the authorization server months earlier,
 * and "fixed" rules out anything with an id in it. The server is identified by
 * the `state` instead, which is the one thing that makes the round trip.
 */
// The two halves of an OAuth client, as PUT /connect/:id/client is given them.
type SuppliedClientAsk = {
  clientId: string,
  clientSecret: string,
};

@controller("/connect")
class ConnectApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  // Where the browser should go to approve this connector.
  @post("/:id/start")
  start(req: Request): Reply {
    let document = findById(this.db, mcpServersMapping(), param(req, "id"));
    if (document == "") { return notFound("server " + param(req, "id")); }
    let server: McpServerRow = JSON.parse<McpServerRow>(document);
    let began = beginConnect(this.db, server, owningTag(callerTags(req)), this.master, callbackUri());
    if (began.problem != "") { return badRequest(began.problem); }
    return ok("{\"url\":" + JSON.stringify(began.url) + "}");
  }

  // Where the connector sends the browser back to.
  //
  // Answers HTML rather than JSON, uniquely in this file, because the reader
  // is a browser window a person is looking at and not a program. It closes
  // itself; the console notices through the opener and reloads.
  @get("/callback")
  callback(req: Request): Reply {
    let refused = req.query.get("error") ?? "";
    if (refused != "") {
      let said = req.query.get("error_description") ?? "";
      return connectPage(false, said == "" ? refused : said);
    }
    let done = completeConnect(this.db, this.master,
      req.query.get("state") ?? "", req.query.get("code") ?? "");
    if (done.problem != "") { return connectPage(false, done.problem); }
    return connectPage(true, done.serverName);
  }

  // Give this connector an OAuth client created by hand in the vendor's own
  // developer console.
  //
  // For the connectors that do not register clients automatically — Asana's v2
  // server, Slack, Box — which is most of the ones people actually ask for.
  // Deployment-wide and not per person, because the connector row it hangs off
  // is deployment-wide: the app belongs to whoever runs Joule, and each person
  // then signs in to it with their own account.
  //
  // Answered back is the client id only, and only because it is not a secret:
  // it travels in the consent URL every browser visits. The secret goes in and
  // never comes out, like every other credential here.
  @put("/:id/client")
  setClient(req: Request): Reply {
    let id = param(req, "id");
    if (!existsById(this.db, mcpServersMapping(), id)) { return notFound("server " + id); }
    let ask: SuppliedClientAsk = JSON.parse<SuppliedClientAsk>(req.body);
    let refused = setSuppliedClient(this.db, id, ask.clientId, ask.clientSecret, this.master);
    if (refused != "") { return badRequest(refused); }
    return ok("{\"clientId\":" + JSON.stringify(suppliedClientId(this.db, id, this.master)) + "}");
  }

  // Take it away again. The connector goes back to registering itself, which
  // works where the vendor allows it and says so plainly where it does not.
  @del("/:id/client")
  dropClient(req: Request): Reply {
    let id = param(req, "id");
    if (!existsById(this.db, mcpServersMapping(), id)) { return notFound("server " + id); }
    forgetSuppliedClient(this.db, id);
    return noContent();
  }

  // Hand a connection back. The caller's own, never anybody else's — the owner
  // is read from the verified header, exactly as DELETE /servers/:id/mine is.
  @del("/:id")
  drop(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    disconnect(this.db, param(req, "id"), owningTag(callerTags(req)));
    return noContent();
  }
}

// The address a connector sends the browser back to, or "" when this
// deployment does not know its own public name.
//
// It has to be absolute and it has to match what was registered, so it cannot
// be derived from the request: behind the console's proxy and the gateway, the
// Host this process sees is an internal one. One variable, set once.
function callbackUri(): string {
  let origin = (process.env("AGENTS_PUBLIC_ORIGIN") ?? "").trim();
  if (origin == "") { return ""; }
  while (origin.endsWith("/")) { origin = origin.slice(0, origin.length - 1); }
  return origin + "/api/connect/callback";
}

// The page the browser lands on after a consent screen.
//
// Deliberately plain and deliberately self-closing. A person who pressed
// Connect is looking at a popup over the console, and the useful outcome is
// that it goes away and the page behind it knows to refresh.
function connectPage(worked: bool, detail: string): Reply {
  let title = worked ? "Connected" : "Not connected";
  let line = worked
    ? "You can close this window."
    : jsonSafe(detail);
  let body = "<!doctype html><html><head><meta charset=\"utf-8\"><title>"
    + title + "</title><style>"
    + "body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;"
    + "height:100vh;background:#fafafa;color:#17171a}"
    + "div{text-align:center;max-width:32rem;padding:0 1.5rem}"
    + "h1{font-size:17px;margin:0 0 .35rem}p{margin:0;color:#6b6b70}"
    + "</style></head><body><div><h1>" + title + (worked ? " to " + jsonSafe(detail) : "")
    + "</h1><p>" + line + "</p></div>"
    // The opener is told which way it went, so the console can reload the one
    // list that changed rather than everything. `postMessage` is targeted at
    // this deployment's own origin; a popup that shouted at "*" would tell any
    // page that happened to open it.
    + "<script>try{if(window.opener){window.opener.postMessage("
    + "{joule:\"connector\",ok:" + (worked ? "true" : "false") + "},window.location.origin)}}catch(e){}"
    + "setTimeout(function(){window.close()}," + (worked ? "900" : "4000") + ")</script>"
    + "</body></html>";
  return reply(200, body, "text/html; charset=utf-8");
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
    // `?project=` narrows the page to one project's conversations. The filter
    // rides the SQL beside the owner clause (threads.ts says why), so a
    // guessed id from another tenant is an empty page, not a leak.
    let rows = listThreads(this.db, { tags: callerTags(req), limit: limit, offset: offset, project: queryParam(req, "project", "") });
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"id\":" + JSON.stringify(rows[i].id)
        + ",\"agentId\":" + JSON.stringify(rows[i].agentId)
        + ",\"createdAt\":" + JSON.stringify(rows[i].createdAt)
        + ",\"title\":" + JSON.stringify(rows[i].title)
        + ",\"replayable\":" + (rows[i].replayable ? "true" : "false")
        + ",\"projectId\":" + JSON.stringify(rows[i].projectId) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  /* A conversation about a Discover article.
   *
   * Under `/threads` and not under `/discover`, and that placement is the
   * whole reason this route works for the reader it is for. The console's
   * middleware admits a guest to exactly one write path — `/api/threads` —
   * and refuses every write under `/api/discover`. An anonymous visitor
   * reading the front page is precisely who asks the first question about an
   * article, so the route has to live where they are allowed to knock.
   *
   * Declared before the "/:id" routes below. The router refuses at startup a
   * table whose literal is written after the parameter that would shadow it —
   * `GET /threads/replayable` carries the same note.
   *
   * The body names a STORY and an agent, and nothing else. The context that
   * goes into the thread is built here from the stored row, because a client
   * that could supply it could write an invisible instruction — see
   * `asArticleContext`.
   */
  @post("/from-story")
  fromStory(req: Request): Reply {
    if (req.body == "") {
      return badRequest("a body is required: {\"storyId\":\"tech-en:ab12cd34\",\"agentId\":\"a1\"}");
    }
    let storyId = jsonText(req.body, "storyId");
    let agentId = jsonText(req.body, "agentId");
    if (storyId == "" || agentId == "") {
      return badRequest("a storyId and an agentId are required");
    }
    if (!existsById(this.db, agentsMapping(), agentId)) {
      return badRequest("no agent " + agentId);
    }
    let story = storyById(this.db, storyId);
    if (story.id == "") { return notFound("story " + storyId); }

    let id = openThread(this.db, { agentId: agentId, owner: owningTag(callerTags(req)), now: stamp() });
    if (id == "") { return badRequest("the thread could not be opened"); }

    // The picker, when the console had one showing. Same optional field the
    // ordinary door takes, refused the same way.
    let chosen = askedChoice(req.body);
    if (chosen != "" && choiceProblem(this.db, chosen) == "") {
      if (rememberChoice(this.db, id, chosen) != "") { chosen = ""; }
    } else {
      chosen = "";
    }

    // The article, as the first turn. Stored as CHUNK_ROLE — see
    // `isRetrievedContext` — so the model reads it and the transcript never
    // shows it as something the person typed.
    let feed = feedById(this.db, story.feedId);
    let seed = [userTurn(asArticleContext(story, feed.topic))];
    let wrote = appendTurns(this.db, id, seed, 0);
    if (wrote != "") { return badRequest("the article could not be attached: " + wrote); }

    // Named from the headline, which also means the naming call never runs:
    // `titleThread` returns early on a thread that already has a title, so
    // this saves a completion on every article somebody asks about.
    nameThread(this.db, id, story.headline);

    return created("{\"id\":" + JSON.stringify(id)
      + ",\"agentId\":" + JSON.stringify(agentId)
      + ",\"modelChoiceId\":" + JSON.stringify(chosen)
      + ",\"title\":" + JSON.stringify(story.headline) + "}");
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
    // The project, optional, and the same second-statement shape as the
    // choice above: `openThread` deliberately takes no extra arguments, so
    // the stamp is one UPDATE with one home (`assignProject`). Checked here
    // rather than trusted — a project id names somebody's standing
    // instructions, so only its owner may file conversations under it — and
    // an id that fails the check is dropped silently for the reason the
    // choice UPDATE is not a 400: the thread already exists, and the reply
    // saying "" is a disagreement the console can see.
    let filed = jsonText(req.body, "projectId");
    if (filed != "") {
      let held = findById(this.db, projectsMapping(), filed);
      if (held == "" || !holdsOwner(callerTags(req), jsonText(held, "owner"))) {
        filed = "";
      } else if (assignProject(this.db, id, filed) != "") {
        filed = "";
      }
    }
    return created("{\"id\":" + JSON.stringify(id) + ",\"agentId\":" + JSON.stringify(agentId)
      + ",\"modelChoiceId\":" + JSON.stringify(kept)
      + ",\"projectId\":" + JSON.stringify(filed) + "}");
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
    // The streamed answer, while there is a round to belong to. "" the rest
    // of the time — the reply itself takes over the moment the turn lands.
    let partialText = "";
    if (asked != "all") { partialText = partialOf(this.db, param(req, "id"), round); }
    return ok("{\"seq\":" + `${round}`
      + ",\"running\":" + boolJson(roundRunning(live))
      + ",\"partial\":" + JSON.stringify(partialText)
      + ",\"thoughts\":" + thoughtsJson(thoughts)
      + ",\"steps\":" + stepsJson(live) + "}");
  }

  // Ask the thread. The reply is this turn's answer; the transcript is a GET.
  // Ask the running turn to stop. It stops at the next boundary — before
  // the next provider call or the next tool call — because a model cannot be
  // interrupted mid-sentence and pretending otherwise would just hide where
  // the money went. Answering 200 does not mean stopped; it means asked. The
  // messages POST already in flight is what reports how the turn ended (its
  // reply says "Stopped at your request"), so this route has nothing more to
  // say than "heard".
  @post("/:id/cancel")
  cancel(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let problem = askCancel(this.db, param(req, "id"));
    if (problem != "") { return badRequest(problem); }
    return ok("{\"asked\":true}");
  }

  @post("/:id/messages")
  say(req: Request): Reply {
    let tags = callerTags(req);
    let agentId = ownedThread(this.db, param(req, "id"), tags);
    if (agentId == "") {
      return notFound("thread " + param(req, "id"));
    }
    // A stop asked during the LAST turn must not kill this one: the flag is
    // per-thread, so each turn starts by wiping what an earlier finger left.
    clearCancel(this.db, param(req, "id"));
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

    // The slot's second occupant: a choice priced "premium" is announced in
    // the menu and refused at the door — the row exists so the console can
    // say what is coming, and nothing anywhere bills for it yet, so applying
    // it would spend the expensive model on any caller who typed the id. The
    // sentence says "coming soon" because that is the truth of the row.
    if (pick.choiceId != "") {
      let pickedRow = findById(this.db, modelChoicesMapping(), pick.choiceId);
      if (pickedRow != "") {
        let picked: ModelChoiceRow = JSON.parse<ModelChoiceRow>(pickedRow);
        if (picked.tier == "premium") {
          return badRequest(picked.label + " is coming soon — it is announced, not offered yet");
        }
      }
    }

    // The slot's first occupant, and the same shape that check will have: a
    // guest — a caller the gateway minted an anonymous identity for — gets
    // GUEST_DAILY_RUNS turns per UTC day, counted off the runs table, and the
    // refusal lands before a run row is written or a provider call is spent.
    // Two guest sends racing at nine-of-ten can both pass; the accepted cost
    // is one extra turn, never an extra 429.
    let guest = guestTag(tags);
    if (guest != "") {
      let atGate = Date.now();
      let used = runsSince(this.db, guest, utcDayStartText(atGate));
      if (used >= GUEST_DAILY_RUNS) {
        let refusal = reply(429, guestQuotaJson(used, nextUtcMidnightIso(atGate)), "application/json");
        refusal.headers.set("retry-after", `${secondsToUtcMidnight(atGate)}`);
        return refusal;
      }
    }

    // Stamped with the conversation it belongs to, which is what makes a trace
    // findable afterwards. Without it every turn this engine has ever traced
    // sits in one undifferentiated list: the collector groups by session, and
    // a trace with no session groups under nothing.
    //
    // The thread id is the session because that is the identifier a person
    // actually holds — it is in the console's own address bar at /c/<id>, on
    // the workflow run that spawned the turn (`workflow_runs.thread_id`), and
    // on the run row written below. One id, so a trace can be reached from any
    // of them.
    //
    // The owner rides along as the user for the same reason and with the same
    // caution the run row takes: it is the owning tag, not the raw header.
    let tracer = tracerWithSession(
      tracerFor(this.db, this.master), param(req, "id"), owningTag(callerTags(req)));
    // Handed to the turn rather than written here first. Applying the choice
    // and remembering it are one act, and `runInThreadWith` is where that act
    // lives — it resolves the precedence, keeps the pick only if it survived
    // resolution, and hands back what was in force. A door that wrote the
    // column itself would be a second writer of one field, and the two would
    // disagree the first time a rule was added to only one of them.
    let answered = runInThreadWith(this.db, param(req, "id"), {
      userText: text, master: this.master, tracer: tracer, pick: pick,
      // The composer's Think toggle, per message like the picker beside it.
      // Absent — every caller written before the toggle — reads as false,
      // which is the same request those callers were already making.
      think: jsonText(req.body, "think") == "true",
      // Which screen this was typed on. Absent — the console's own chat, and
      // every caller written before surfaces existed — reads as "", which is
      // the whole product, exactly as before.
      scope: jsonText(req.body, "scope"),
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
    // What the guest has left after this turn, re-counted rather than
    // decremented: the run row above is already filed, so the count is the
    // server's own answer and the strip that shows it never drifts from what
    // the gate will decide next send. "" for everybody else — a member that is
    // simply absent from a signed-in caller's reply.
    let guestLeft = "";
    if (guest != "") {
      let left = GUEST_DAILY_RUNS - runsSince(this.db, guest, utcDayStartText(Date.now()));
      if (left < 0) { left = 0; }
      guestLeft = ",\"guestRemaining\":" + `${left}`;
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
      + ",\"error\":" + JSON.stringify(run.error) + guestLeft + "}");
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
/* Every artifact this caller owns, across every conversation.
 *
 * The per-thread route below answers "what does THIS conversation hold";
 * this answers "what have I made", which is a different question and the one
 * somebody asks when they cannot remember which conversation a document came
 * out of. Scoped by the same ownership the thread routes use, so it can never
 * be a way to read somebody else's files.
 */
/* Discover: what the digest job wrote.
 *
 * A table read. The model call is in the background pass (digestLoop), so
 * this route is as fast as any other list and cannot fail on a model being
 * down — a visitor gets the last good digest rather than a spinner.
 *
 * Feeds are per topic per language per country, so the answer is scoped to
 * what the caller asked for and falls back to the worldwide feeds when their
 * own pair has none: an empty page for a language nobody has crawled yet is
 * worse than the same stories everybody else is reading.
 */
@controller("/discover")
class DiscoverApi {
  /* The digest prompt, as text an operator may edit.
   *
   * Under /discover and operator-only: this wording decides what every reader of
   * every feed is shown, which is not a public control. GET answers the override
   * or "" when the compiled default stands; PUT replaces it; DELETE returns to
   * the built-in. The tokens {topic}, {count} and {language} are substituted.
   */
  @get("/prompt")
  readPrompt(req: Request): Reply {
    let held = discoverText(this.db, "digest-prompt");
    return ok("{\"prompt\":" + JSON.stringify(held)
      + ",\"usingDefault\":" + (held.trim() == "" ? "true" : "false") + "}");
  }

  /* Writes here are operator-only by the console's own middleware, which admits a
   * guest to exactly one write path (/api/threads) and refuses every write under
   * /api/discover — the same gate the feed editor beside this route trusts. */
  @put("/prompt")
  writePrompt(req: Request): Reply {
    let asked = jsonText(req.body, "prompt");
    // A prompt that names none of its tokens still works; one that is blank is a
    // request for the default, and is answered as one rather than as an empty prompt
    // — the digest must never run with nothing to follow.
    if (asked.trim() == "") {
      deleteById(this.db, discoverTextMapping(), "digest-prompt");
      return ok("{\"prompt\":\"\",\"usingDefault\":true}");
    }
    if (asked.length > 20000) { return badRequest("a prompt over 20000 characters is refused"); }
    let problem = setDiscoverText(this.db, "digest-prompt", asked, stamp());
    if (problem != "") { return badRequest(problem); }
    return ok("{\"prompt\":" + JSON.stringify(asked) + ",\"usingDefault\":false}");
  }

  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  read(req: Request): Reply {
    let lang = req.query.get("lang") ?? "";
    let country = geoCode(req.query.get("country") ?? "");
    // The first reader from a place creates its feed; the digest job fills it
    // on its next pass, from the index filtered to that country. Until then
    // they read the worldwide feeds like everybody else.
    if (country != "") { ensureGeoFeed(this.db, country); }
    let feeds = allFeeds(this.db);

    let out = "[";
    let wrote: int = 0;
    let i: int = 0;
    while (i < feeds.length) {
      let feed = feeds[i];
      // A feed matches when it names the caller's language, or no language —
      // the worldwide fallback. A PLACE is stricter: a feed that names a
      // country is only for callers who reported that country, so a reader
      // who said nothing about where they are never gets somebody's local
      // feed mixed into worldwide news.
      let langOk = feed.lang == "" || lang == "" || feed.lang == lang;
      let placeOk = feed.country == "" || feed.country == country;
      // `?all=1` drops both filters and the has-stories rule.
      //
      // The filters above are right for a READER: a feed naming a country belongs to
      // callers from there, and an empty feed is not a page. They are exactly wrong for
      // whoever runs the thing, because the feeds that need attention are the empty ones
      // and the ones for places the operator is not sitting in. The admin panel read
      // this route and concluded there were three feeds and no countries, while six
      // existed.
      //
      // A flag on the existing route rather than a route of its own: adding a method to
      // this controller makes the built binary panic in plume's migrate at startup,
      // reproducibly and before any request is served, which is a code-generation
      // problem in the compiler this deployment builds with and not something to work
      // around by guessing. Nothing here is sensitive — a feed is a topic, a place and
      // a query — so the flag costs no secrecy.
      let all = req.query.get("all") == "1";
      if (feed.enabled && (all || (langOk && placeOk))) {
        let rows = storiesFor(this.db, feed.id);
        if (all || rows.length > 0) {
          if (wrote > 0) { out = out + ","; }
          out = out + "{\"id\":" + JSON.stringify(feed.id)
            + ",\"topic\":" + JSON.stringify(feed.topic)
            // The query and the enabled flag: what this feed ASKS the index for, which
            // is the one setting that decides whether it can find anything. A reader has
            // no use for it; an operator has nothing without it — the admin panel drew
            // an empty column and could not compute how many stories were available,
            // because that check re-sends the feed's own query.
            + ",\"query\":" + JSON.stringify(feed.query)
            + ",\"enabled\":" + (feed.enabled ? "true" : "false")
            + ",\"lang\":" + JSON.stringify(feed.lang)
            + ",\"country\":" + JSON.stringify(feed.country)
            + ",\"digestedAt\":" + JSON.stringify(feed.digestedAt)
            + ",\"stories\":[";
          let r: int = 0;
          while (r < rows.length) {
            if (r > 0) { out = out + ","; }
            /* Field by field, and NOT `JSON.stringify(rows[r])`, which is what
               stood here before a story had a body. The body is up to twelve
               thousand characters; the feed draws six of them per topic across
               every topic that matches, so shipping it here would put a
               megabyte of article text into a page that shows two-sentence
               summaries. It travels on `/discover/story/:id`, where it is the
               point. */
            out = out + "{\"id\":" + JSON.stringify(rows[r].id)
              + ",\"feedId\":" + JSON.stringify(rows[r].feedId)
              + ",\"rank\":" + `${rows[r].rank}`
              + ",\"headline\":" + JSON.stringify(rows[r].headline)
              + ",\"summary\":" + JSON.stringify(rows[r].summary)
              + ",\"sources\":" + JSON.stringify(rows[r].sources)
              // Beside `sources` and read by position against it: what each of those
              // outlets called the story. Small — a few headlines — and it travels here
              // rather than being fetched per card so the console can render it on the
              // server, which a browser lookup after mount cannot do.
              + ",\"sourceTitles\":" + JSON.stringify(rows[r].sourceTitles)
              + ",\"fetchedAt\":" + JSON.stringify(rows[r].fetchedAt)
              + ",\"why\":" + JSON.stringify(rows[r].why)
              + ",\"madeAt\":" + JSON.stringify(rows[r].madeAt)
              + ",\"image\":" + JSON.stringify(rows[r].image)
              + ",\"readMinutes\":" + `${rows[r].readMinutes}`
              // Whether there is anything to open. A card that links to an
              // empty article is worse than one that does not link.
              + ",\"hasBody\":" + (rows[r].body == "" ? "false" : "true") + "}";
            r = r + 1;
          }
          out = out + "]}";
          wrote = wrote + 1;
        }
      }
      i = i + 1;
    }
    return ok(out + "]");
  }

  /* One story, in full, for its own page.
   *
   * Public, like the feed it came off: `GUEST_GETS` in the console's
   * middleware holds "/api/discover" and matches by prefix, so this needs no
   * entry of its own.
   *
   * A missing row is answered with a SENTENCE and a 404 rather than a bare
   * one, because a missing row is the ordinary case here and not a fault. A
   * refresh replaces a feed's stories, so a link somebody sent this morning
   * outlives what it points at by design; the page turns this into "that
   * story has rolled off the feed" and offers the feed, which is a true and
   * useful thing to say. A blank error screen would suggest the site broke.
   */
  @get("/story/:id")
  story(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    let row = storyById(this.db, id);
    if (row.id == "") {
      return notFound("story " + id + " has rolled off its feed");
    }
    let feed = feedById(this.db, row.feedId);

    /* Made readable on first open, then kept.
     *
     * Once per story, not once per reader: the second visitor gets the stored
     * column and no model call at all. That is the same argument the digest
     * loop makes for working on a schedule rather than per request — an
     * identical answer for everyone, so paying for it more than once buys
     * nothing but a spinner.
     *
     * It is done HERE and not where the digest writes the story because the
     * digest is off wherever AGENTS_DISCOVER_EVERY_MS is unset, which is every
     * deployment serving this page today. A column filled by a job that does
     * not run is a column that stays empty.
     *
     * A failure is silent by design: `readable` answers "" and the article
     * falls back to the raw body, which is what it showed before this existed. */
    /* Whatever is stored, and no model call on this path.
     *
     * The reflowed body is written by the scheduler's pass (scheduler.ts),
     * not here. It was here first, filled on first open, and the measurement
     * is the reason it moved: the first reader of a story waited 53 seconds
     * for a page that already had text to show. Nobody waits for a
     * presentation improvement.
     *
     * So a story opened before the sweep reaches it shows the raw body — what
     * this page showed before the column existed — and reads cleanly a minute
     * later. */
    return ok("{\"story\":" + JSON.stringify(row)
      + ",\"topic\":" + JSON.stringify(feed.topic)
      + ",\"feedId\":" + JSON.stringify(feed.id) + "}");
  }

  /** The feeds themselves, for whoever maintains them. */
  @get("/feeds")
  feeds(req: Request): Reply {
    return ok(listOrdered(this.db, discoverFeedsMapping(), "", [], [asc("topic")]));
  }

  /** The places that have a local feed with stories on it — what a country
   *  picker can honestly offer. Public like the feed, and only countries
   *  whose digest has produced something: a menu entry that opens an empty
   *  page is a broken promise, so a feed still waiting on its first pass is
   *  not listed. */
  @get("/places")
  places(req: Request): Reply {
    let feeds = allFeeds(this.db);
    let out = "[";
    let wrote: int = 0;
    let i: int = 0;
    while (i < feeds.length) {
      let feed = feeds[i];
      if (feed.enabled && feed.country != ""
          && storiesFor(this.db, feed.id).length > 0) {
        if (wrote > 0) { out = out + ","; }
        out = out + "{\"country\":" + JSON.stringify(feed.country) + "}";
        wrote = wrote + 1;
      }
      i = i + 1;
    }
    return ok(out + "]");
  }

  /** Add one. A feed is a deliberate "this topic, in this language, for this
   *  place, has enough material to be worth digesting" — never a cross
   *  product, which for fifty thousand domains would be tens of thousands of
   *  model calls an hour to fill feeds nobody reads. */
  @post("/feeds")
  addFeed(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let row: DiscoverFeed = JSON.parse<DiscoverFeed>(req.body);
    if (row.id == "" || row.topic == "" || row.query == "") {
      return badRequest("a feed needs an id, a topic and a query");
    }
    persist(this.db, discoverFeedsMapping(), JSON.stringify(row));
    return ok(JSON.stringify(row));
  }

  @del("/feeds/:id")
  dropFeed(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    deleteWhere(this.db, discoverStoriesMapping(), "feed_id = " + this.db.placeholder, [id]);
    deleteById(this.db, discoverFeedsMapping(), id);
    return ok("{\"deleted\":" + JSON.stringify(id) + "}");
  }
}

@controller("/artifacts")
class LibraryApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(req: Request): Reply {
    let cards = libraryFor(this.db, callerTags(req), 240);
    let out = "[";
    let i: int = 0;
    while (i < cards.length) {
      if (i > 0) { out = out + ","; }
      out = out + JSON.stringify(cards[i]);
      i = i + 1;
    }
    return ok(out + "]");
  }
}

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

    // Which of them kept their original bytes, in one query for the folder
    // rather than one per row — document-files.ts says why. Read before either
    // loop so a queued document and an indexed one answer the same way: the
    // file is stored at upload, before the indexer has looked at it, so a row
    // that is still waiting can already have one to preview.
    let originals = sourcesWithFiles(this.db, scope);

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
        + ",\"error\":" + JSON.stringify(waiting[w].error)
        + ",\"hasFile\":" + boolJson(holdsSource(originals, waiting[w].source)) + "}";
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
        + ",\"status\":\"indexed\",\"error\":\"\""
        // Appended, never in place of anything above: the console reads every
        // member that was already here.
        + ",\"hasFile\":" + boolJson(holdsSource(originals, rows[i].source)) + "}";
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

  // Keep the file itself, not just what was read out of it.
  //
  // A second door rather than a field on the upload above, and the two are
  // independent on purpose: indexing is queued and can fail on a provider,
  // storing bytes is one row and cannot. Sending them together would mean a
  // failed embedding lost the original as well, which is the exact loss this
  // table exists to stop. The console PUTs both and neither waits on the
  // other.
  //
  // Idempotent: the id is derived from (scope, source), so re-uploading the
  // same document REPLACES its kept copy. A second attempt after a browser
  // retry leaves one row, not two.
  //
  // Before "/:source" — the router matches literals first, and a PUT is not a
  // DELETE, but the house rule is the ordering and it costs nothing to keep.
  @put("/file")
  keepFile(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"source\":\"...\",\"scope\":\"...\",\"filename\":\"...\",\"mime\":\"...\",\"contentBase64\":\"...\"}");
    }
    // Member by member, never JSON.parse<T> of a request body: a record type
    // refuses a key it does not name, so a console that sends one extra field
    // — or the same field spelled for a later build — would have the whole
    // upload rejected over something nobody reads.
    let source = jsonText(req.body, "source").trim();
    if (source == "") { return badRequest("a document needs a source to be filed under"); }
    let scope = jsonText(req.body, "scope").trim();
    if (scope == "") { return badRequest("a document needs a scope: \"/specs/plume\""); }
    let content = jsonText(req.body, "contentBase64");
    if (content == "") { return badRequest("there are no bytes to keep"); }
    if (content.length > FILE_BASE64_MAX) {
      return badRequest("that file is too large to keep");
    }
    // No allowlist of types. This is the owner's own corpus and their own
    // file; the engine never opens it, and hands it back exactly as it
    // arrived. What is refused is size, above, and nothing else.
    let filed = normalScope(scope);
    let row: DocumentFileRow = {
      id: documentFileId(filed, source),
      source: source,
      scope: filed,
      // The name to hand back. Falls back to the source, so a caller that
      // omits it still gets something to put on a download rather than a
      // browser inventing "download".
      filename: firstText(jsonText(req.body, "filename"), source),
      mime: firstText(jsonText(req.body, "mime"), "application/octet-stream"),
      bytes: content,
      // Decoded length, computed from the base64 rather than decoded to be
      // measured: four characters carry three bytes, and the one or two "="
      // at the end each stand for one byte that is not there.
      size: decodedSize(content),
      createdAt: stamp(),
    };
    let written = persist(this.db, documentFilesMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return ok("{\"stored\":true}");
  }

  // Hand the original back, as JSON with the bytes base64 inside it.
  //
  // JSON and not the raw bytes with a content type: the console builds a blob
  // URL from this to show in a viewer, so it wants the bytes in hand rather
  // than a navigation, and one shape covers every type without the response
  // path having to carry binary at all. The cost is the third that base64 adds
  // to the wire, paid once per preview.
  @get("/file")
  file(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    let source = queryParam(req, "source", "");
    let scope = queryParam(req, "scope", "/");
    if (source == "") { return badRequest("name the document: ?source=notes&scope=/specs"); }
    let kept = findDocumentFile(this.db, scope, source);
    // A document indexed before this table existed has text and no original,
    // and so does one uploaded by anything that does not PUT here. Absent, not
    // broken — the listing's `hasFile` is what a caller checks first.
    if (kept.id == "") { return notFound("no kept file for " + source); }
    return ok("{\"filename\":" + JSON.stringify(kept.filename)
      + ",\"mime\":" + JSON.stringify(kept.mime)
      + ",\"size\":" + `${kept.size}`
      + ",\"contentBase64\":" + JSON.stringify(kept.bytes) + "}");
  }

  @del("/:source")
  remove(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    let source = param(req, "source");
    executeWith(this.db, "DELETE FROM documents WHERE source = " + this.db.placeholder, [source]);
    // And the original with it. A file whose text is gone is unreachable —
    // nothing lists it, nothing can ask for it, and nothing would ever delete
    // it — so leaving it behind is not caution, it is a leak that grows by the
    // size of every document anybody removes.
    forgetDocumentFiles(this.db, source);
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

// Things that run without anybody asking.
//
// The rows only. Nothing here fires a task: `scheduler.ts` does, as a separate
// process on a timer, for the reasons tasks.ts records. That is why even
// "run now" is a write — it moves the task's next firing to now and lets the
// runner pick it up — rather than a second path into `runAgent`. One firing
// path means one place where a claim, a failure count and a transcript are
// written, and no chance of the two drifting apart.
@controller("/tasks")
class TaskApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  // This caller's tasks, soonest first.
  //
  // Scoped by owner and not merely filtered in the console: a task carries an
  // instruction that runs against somebody's connectors on their schedule, and
  // a list that leaked would be a list of what a stranger has automated.
  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(tasksOf(this.db, owningTag(tags)));
  }

  // Create one. The words a person typed arrive as `schedule`; the cron
  // expression is compiled here and never sent by a client — a client that
  // could send its own expression could schedule a task per second, and a
  // client that could send its own `nextAt` could schedule one in the past and
  // have it fire on every tick forever.
  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    // Nobody unnamed may schedule. A guest already runs under a daily cap, and
    // a task is a standing instruction — a scheduler for callers nobody can
    // name is an open tap on a provider bill that nobody can turn off either.
    //
    // Two shapes of "not signed in" and both are refused: a guest carries
    // `guest:<hex>`, while a signed-out visitor behind a trusted proxy carries
    // `[""]`, the unowned bucket. The first version of this line tested only
    // the second and so refused the unowned bucket while waving guests
    // through, which is precisely backwards.
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes a task yours to run");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"agentId\":\"a1\",\"instruction\":\"...\",\"schedule\":\"every weekday at 08:00\"}");
    }

    let agentId = jsonText(req.body, "agentId");
    if (!existsById(this.db, agentsMapping(), agentId)) { return badRequest("no agent " + agentId); }
    let chosen = askedChoice(req.body);
    let refusedChoice = choiceProblem(this.db, chosen);
    if (refusedChoice != "") { return badRequest(refusedChoice); }

    if (enabledCount(this.db, owner) >= MAX_PER_OWNER) {
      return badRequest("that is " + `${MAX_PER_OWNER}` + " tasks already — pause one before adding another");
    }

    // "every ..." compiles; a one-off carries the instant instead. The instant
    // comes from the client because the wall-clock intent lives where the
    // calendar is, and it is checked here because a time in the past is a task
    // that fires on the next tick and every tick after it.
    let said = jsonText(req.body, "schedule");
    let zone = jsonText(req.body, "tz");
    let kind = said == "" || isOnce(said) ? "once" : "every";
    let expr = "";
    let at = "";
    if (kind == "every") {
      let compiled = compile(said);
      if (!compiled.ok) { return badRequest(compiled.error); }
      expr = compiled.expr;
    } else if (isOnce(said)) {
      // A date said in words rather than an instant computed by a client.
      // Same grammar the task tools use, resolved server-side for the same
      // reason cron is: a browser that worked out "2026-08-06 09:00 in
      // Europe/Paris" itself would be wrong twice a year and believed anyway.
      let once = onceInstant(said, zone == "" ? "UTC" : zone, Date.now() as number);
      if (!once.ok) { return badRequest(once.error); }
      at = once.at;
    } else {
      at = jsonText(req.body, "at");
      if (stampMs(at) <= (Date.now() as number)) {
        return badRequest("a one-off task needs an instant in the future: {\"at\":\"<epoch ms>\"}");
      }
    }

    let now = stamp();
    let row: TaskRow = {
      id: crypto.randomUUID(),
      owner: owner,
      agentId: agentId,
      modelChoiceId: chosen,
      title: jsonText(req.body, "title"),
      instruction: jsonText(req.body, "instruction"),
      kind: kind,
      cronExpr: expr,
      tz: zone,
      nextAt: at,
      runningSince: "",
      enabled: true,
      failures: 0,
      pausedReason: "",
      lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    let wrong = refuse(row);
    if (wrong != "") { return badRequest(wrong); }

    // The first firing, computed here and not by whoever asked.
    let ready = row;
    if (kind == "every") {
      let first = nextFire(row, Date.now() as number);
      if (!first.ok) { return badRequest(first.error); }
      ready = withNextAt(row, first.at);
    }

    let written = persist(this.db, tasksMapping(), JSON.stringify(ready));
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, tasksMapping(), ready.id));
  }

  // Pause, resume, retitle, reschedule. One PUT of the whole row, as agents
  // do — and the schedule is recompiled rather than trusted, for the same
  // reason it is compiled on the way in.
  @put("/:id")
  update(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("task " + param(req, "id")); }
    if (req.body == "") { return badRequest("a body is required"); }

    let said = jsonText(req.body, "schedule");
    let expr = mine.cronExpr;
    let kind = mine.kind;
    let when = mine.nextAt;
    if (said != "" && isOnce(said)) {
      let once = onceInstant(said, mine.tz == "" ? "UTC" : mine.tz, Date.now() as number);
      if (!once.ok) { return badRequest(once.error); }
      // A repeating task rescheduled onto a date becomes a one-off, which is
      // what "actually, just do it once, on Thursday" means.
      kind = "once";
      expr = "";
      when = once.at;
    } else if (said != "") {
      let compiled = compile(said);
      if (!compiled.ok) { return badRequest(compiled.error); }
      kind = "every";
      expr = compiled.expr;
    }
    let title = jsonText(req.body, "title");
    let instruction = jsonText(req.body, "instruction");
    let tz = jsonText(req.body, "tz");
    let on = jsonFlag(req.body, "enabled", mine.enabled);

    let edited: TaskRow = {
      id: mine.id, owner: mine.owner, agentId: mine.agentId,
      modelChoiceId: mine.modelChoiceId,
      title: title == "" ? mine.title : title,
      instruction: instruction == "" ? mine.instruction : instruction,
      kind: kind, cronExpr: expr,
      tz: tz == "" ? mine.tz : tz,
      nextAt: when, runningSince: mine.runningSince,
      enabled: on,
      // Switching a paused task back on is what clears its failures. Leaving
      // them would pause it again on the next failure rather than the fifth,
      // which reads as "it will not stay on" to the person who just fixed it.
      failures: on && !mine.enabled ? 0 : mine.failures,
      pausedReason: on ? "" : mine.pausedReason,
      lastRunAt: mine.lastRunAt, lastRunId: mine.lastRunId,
      lastStatus: mine.lastStatus, lastError: mine.lastError,
      runCount: mine.runCount, createdAt: mine.createdAt, updatedAt: stamp(),
    };
    let wrong = refuse(edited);
    if (wrong != "") { return badRequest(wrong); }
    let stored = edited;
    if (edited.kind == "every") {
      let ahead = nextFire(edited, Date.now() as number);
      if (!ahead.ok) { return badRequest(ahead.error); }
      stored = withNextAt(edited, ahead.at);
    }

    let written = persist(this.db, tasksMapping(), JSON.stringify(stored));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, tasksMapping(), stored.id));
  }

  // Fire it on the next tick.
  //
  // A write, not a run: moving `next_at` to now is how this door reaches the
  // one firing path instead of building a second one. Whoever asked waits up
  // to a tick, which is the price of there being exactly one place a task can
  // be claimed, counted and recorded.
  @post("/:id/run-now")
  runNow(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("task " + param(req, "id")); }
    let now = stamp();
    executeWith(this.db,
      "UPDATE scheduled_tasks SET next_at = " + this.db.placeholder
      + ", running_since = '', enabled = true, updated_at = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [now, now, mine.id]);
    return accepted(findById(this.db, tasksMapping(), mine.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("task " + param(req, "id")); }
    let gone = deleteById(this.db, tasksMapping(), mine.id);
    if (!gone.ok) { return badRequest(gone.error); }
    return noContent();
  }

  // The row this caller is allowed to touch, or an empty one. Every write goes
  // through here rather than checking the owner in four places — three of them
  // would be right and the fourth would be the interesting one.
  private owned(req: Request): TaskRow {
    let document = findById(this.db, tasksMapping(), param(req, "id"));
    if (document == "") { return emptyTask(); }
    let row: TaskRow = JSON.parse<TaskRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) { return emptyTask(); }
    return row;
  }
}

// Projects: conversations grouped under one name and one set of standing
// instructions (projects.ts).
//
// The rows only, on TaskApi's posture throughout: lists scoped by owner so a
// stranger's project is absent rather than forbidden, creation refused to
// callers nobody can name, and every write through one private `owned` that
// answers strangers and missing ids identically. The instructions themselves
// reach the model in run.ts (`projectBriefing`), never through this class.
@controller("/projects")
class ProjectApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  // This caller's projects, newest first — scoped for the reason TaskApi's
  // list is: a project's instructions are what somebody standing-orders every
  // conversation in it, and a list that leaked would be a list of those.
  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(projectsOf(this.db, owningTag(tags)));
  }

  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    // The task rule, for the task reason: a project is a standing instruction
    // block that rides every conversation filed under it, and it has to
    // belong to somebody. Both spellings of "not signed in" refused —
    // TaskApi.create records how testing only one waved guests through.
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes a project yours");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"instructions\":\"...\"}");
    }
    let name = jsonText(req.body, "name");
    if (name == "") { return badRequest("a project needs a name"); }
    let row: ProjectRow = {
      id: crypto.randomUUID(),
      owner: owner,
      name: name,
      instructions: jsonText(req.body, "instructions"),
      // No workspace thread yet — `POST /:id/files-thread` opens it on the
      // first ask, so a project that only groups pays for no thread row.
      filesThreadId: "",
      createdAt: stamp(),
    };
    let written = persist(this.db, projectsMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, projectsMapping(), row.id));
  }

  // Rename, or rewrite the instructions. Both fields are read verbatim from
  // the body: an empty `name` keeps the old one — a project with no name
  // cannot be told apart in a sidebar — while `instructions` is taken as
  // sent, because "" is a meaningful value here (a project that only groups)
  // and a keep-on-empty rule would make the instructions impossible to clear.
  @put("/:id")
  update(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("project " + param(req, "id")); }
    if (req.body == "") { return badRequest("a body is required"); }
    let name = jsonText(req.body, "name");
    let edited: ProjectRow = {
      id: mine.id, owner: mine.owner,
      name: name == "" ? mine.name : name,
      instructions: jsonText(req.body, "instructions"),
      // Never editable from a body: which hidden thread holds the files is
      // the engine's fact, and a caller who could write it could point a
      // project at any thread whose artifacts would then brief every round.
      filesThreadId: mine.filesThreadId,
      createdAt: mine.createdAt,
    };
    let written = persist(this.db, projectsMapping(), JSON.stringify(edited));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, projectsMapping(), mine.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("project " + param(req, "id")); }
    // The threads first, so they fall back to "no project" rather than
    // pointing at a row that is gone; projects.ts says what a dangling stamp
    // would cost. The conversations themselves are untouched — deleting the
    // folder is not deleting the letters.
    releaseThreads(this.db, mine.id);
    // The workspace thread, when there is one, stays behind as an orphan —
    // deliberately, not as an oversight. Nothing in the engine deletes a
    // thread row (the sweep only takes EMPTY ones, and a workspace with files
    // is not empty), and building a thread-delete for this one caller would
    // be a bigger change than the junk it clears. The orphan is invisible:
    // its route_key is 'project-files', which `listThreads` excludes.
    let gone = deleteById(this.db, projectsMapping(), mine.id);
    if (!gone.ok) { return badRequest(gone.error); }
    return noContent();
  }

  // The project's files, or rather where they live: the id of the hidden
  // workspace thread whose artifacts they are. Opens the thread on the first
  // ask and answers the same id ever after, so the console can PUT files
  // through the ordinary `/threads/:id/artifacts` door without a second
  // wire shape for "a project file".
  //
  // No ordering worry with the "/:id" routes above: the router matches on
  // segment count, and nothing else in this class is two segments deep.
  @post("/:id/files-thread")
  filesThread(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("project " + param(req, "id")); }
    if (mine.filesThreadId != "") {
      // Answered from the row, but only while the thread is really there: an
      // operator's sweep could have taken a workspace opened and never
      // uploaded to (it is exactly the "empty thread" the sweep collects),
      // and answering a dead id would 404 every upload after.
      if (existsById(this.db, threadsMapping(), mine.filesThreadId)) {
        return ok("{\"threadId\":" + JSON.stringify(mine.filesThreadId) + "}");
      }
    }
    // The owner is the project's, never the caller's whole tag set — the same
    // one-owner rule `POST /threads` records. PROJECT_FILES_KEY as the agent
    // id because `ownedThread` reads an empty agent id as "no such thread";
    // projects.ts says so where the constant lives. No round ever runs here.
    let id = openThread(this.db, { agentId: PROJECT_FILES_KEY, owner: mine.owner, now: stamp() });
    if (id == "") { return badRequest("the files thread could not be opened"); }
    // The stamp that keeps it out of every sidebar (`listThreads` excludes
    // this key). Written before the project row points at the thread: a
    // half-done state must fail invisible, not visible.
    let stamped = rememberRouteKey(this.db, id, PROJECT_FILES_KEY);
    if (stamped != "") { return badRequest(stamped); }
    let noted = rememberFilesThread(this.db, mine.id, id);
    if (noted != "") { return badRequest(noted); }
    return ok("{\"threadId\":" + JSON.stringify(id) + "}");
  }

  // The row this caller may touch, or an empty one — TaskApi's helper, for
  // TaskApi's reason: every write goes through here rather than checking the
  // owner per route, and a stranger's project 404s exactly as a missing one.
  private owned(req: Request): ProjectRow {
    let document = findById(this.db, projectsMapping(), param(req, "id"));
    if (document == "") { return emptyProject(); }
    let row: ProjectRow = JSON.parse<ProjectRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) { return emptyProject(); }
    return row;
  }
}

// Workflows: graphs of steps, drawn on the console's canvas or drafted in a
// conversation (workflow-tools.ts), fired by the scheduler.
//
// The same posture as TaskApi throughout: owner-scoped so a stranger's row is
// absent rather than forbidden, schedules compiled server-side from the words
// on the START step, and even "run now" a write that moves `next_at` — the
// scheduler stays the only place a workflow is claimed, walked and recorded.
@controller("/workflows")
class WorkflowApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(workflowsOf(this.db, owningTag(tags)));
  }

  // Create one from a whole document: name, description, graph. The schedule
  // is never a field of its own — it is the words on the graph's START step,
  // compiled here, so the canvas and the conversation cannot disagree about
  // where a schedule lives.
  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    // The task rule, for the task reason: a workflow is a standing instruction
    // with a provider's bill attached, and it has to belong to somebody.
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes a workflow yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"agentId\":\"a1\",\"graph\":{...}}");
    }
    let agentId = jsonText(req.body, "agentId");
    if (!existsById(this.db, agentsMapping(), agentId)) { return badRequest("no agent " + agentId); }
    if (enabledWorkflowCount(this.db, owner) >= MAX_WORKFLOWS_PER_OWNER) {
      return badRequest("that is " + `${MAX_WORKFLOWS_PER_OWNER}` + " workflows already — pause one before adding another");
    }
    let graphText = jsonRaw(req.body, "graph");
    if (graphText == "") { return badRequest("a workflow needs a graph: nodes, edges and a view"); }
    let parsed = parseGraph(graphText);
    if (!parsed.ok) { return badRequest(parsed.error); }
    // The scalars are read from the body with the graph's bytes cut out.
    // jsonText scans flat and answers the FIRST occurrence of a key anywhere
    // in the document — and a graph is full of nodes carrying "name", so a
    // create whose graph preceded its name would call every workflow after
    // its first node. Four rows named "Start" found this on the PUT below.
    let bare = req.body;
    let graphAt = req.body.indexOf(graphText);
    if (graphAt >= 0) { bare = req.body.slice(0, graphAt) + "\"\"" + req.body.slice(graphAt + graphText.length); }
    let zone = jsonText(bare, "tz");
    let timing = timingOf(parsed.graph, zone == "" ? "UTC" : zone, Date.now() as number);
    if (!timing.ok) { return badRequest(timing.error); }

    let now = stamp();
    let row: WorkflowRow = {
      id: crypto.randomUUID(), owner: owner, agentId: agentId,
      modelChoiceId: "",
      name: jsonText(bare, "name"),
      description: jsonText(bare, "description"),
      graph: graphText,
      kind: timing.kind, cronExpr: timing.expr, tz: zone,
      nextAt: timing.kind == "once" ? timing.at : "",
      runningSince: "", enabled: true, failures: 0, pausedReason: "",
      lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
      runCount: 0,
      // Born published: the graph was just validated whole, and a workflow
      // that runs nothing until a second button is pressed is a surprise.
      // The first DIVERGENCE is the first unpublished edit.
      publishedGraph: graphText, publishedAt: now,
      createdAt: now, updatedAt: now,
    };
    let wrong = refuseWorkflow(row);
    if (wrong != "") { return badRequest(wrong); }
    let secretWrong = graphSecretProblem(this.db, parsed.graph, owner);
    if (secretWrong != "") { return badRequest(secretWrong); }
    let ready = row;
    if (row.kind == "every") {
      let first = nextWorkflowFire(row, Date.now() as number);
      if (!first.ok) { return badRequest(first.error); }
      ready = withWorkflowNextAt(row, first.at);
    }
    let written = persist(this.db, workflowsMapping(), JSON.stringify(ready));
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, workflowsMapping(), ready.id));
  }

  @get("/:id")
  one(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    return ok(JSON.stringify(mine));
  }

  // The whole document again: the canvas saves what it is showing — graph,
  // name, description, enabled — and the schedule half is recompiled from the
  // START step it just drew. An `updatedAt` precondition refuses the stale
  // save instead of burying the newer one, which is what two tabs on one
  // workflow would otherwise silently do.
  @put("/:id")
  update(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    if (req.body == "") { return badRequest("a body is required"); }
    // The same flat-scanner discipline as create: everything scalar is read
    // from the body with the graph's bytes cut out, because the first "name"
    // in a body whose graph comes first is a NODE's name — and this route
    // was quietly renaming every canvas-saved workflow to "Start".
    let sentGraph = jsonRaw(req.body, "graph");
    let bare = req.body;
    if (sentGraph != "") {
      let graphAt = req.body.indexOf(sentGraph);
      if (graphAt >= 0) { bare = req.body.slice(0, graphAt) + "\"\"" + req.body.slice(graphAt + sentGraph.length); }
    }
    let expected = jsonText(bare, "updatedAt");
    if (expected != "" && expected != mine.updatedAt) {
      return badRequest("this workflow changed while you were editing — reload it and redo the change");
    }
    let graphText = sentGraph == "" ? mine.graph : sentGraph;
    let parsed = parseGraph(graphText);
    if (!parsed.ok) { return badRequest(parsed.error); }
    let zone = jsonText(bare, "tz");
    let tz = zone == "" ? mine.tz : zone;
    let timing = timingOf(parsed.graph, tz == "" ? "UTC" : tz, Date.now() as number);
    if (!timing.ok) { return badRequest(timing.error); }
    let name = jsonText(bare, "name");
    let description = jsonText(bare, "description");
    let on = jsonFlag(bare, "enabled", mine.enabled);

    let edited: WorkflowRow = {
      id: mine.id, owner: mine.owner, agentId: mine.agentId,
      modelChoiceId: mine.modelChoiceId,
      name: name == "" ? mine.name : name,
      description: description == "" ? mine.description : description,
      graph: graphText,
      kind: timing.kind, cronExpr: timing.expr, tz: tz,
      // A manual workflow KEEPS its next_at: the only way one gets a firing
      // is run-now, and the canvas PUTs the document on mount — so a save
      // that zeroed it was cancelling every "Run soon" within a second of
      // the button being pressed, and the spec caught it as a run that never
      // happened.
      nextAt: timing.kind == "once" ? timing.at
        : timing.kind == "manual" ? mine.nextAt : "",
      runningSince: mine.runningSince,
      enabled: on,
      failures: on && !mine.enabled ? 0 : mine.failures,
      pausedReason: on ? "" : mine.pausedReason,
      lastRunAt: mine.lastRunAt, lastRunId: mine.lastRunId,
      lastStatus: mine.lastStatus, lastError: mine.lastError,
      runCount: mine.runCount,
      // The autosave never touches what production runs. Only /publish does.
      publishedGraph: mine.publishedGraph ?? "", publishedAt: mine.publishedAt ?? "",
      createdAt: mine.createdAt, updatedAt: stamp(),
    };
    let wrong = refuseWorkflow(edited);
    if (wrong != "") { return badRequest(wrong); }
    let secretWrong = graphSecretProblem(this.db, parsed.graph, mine.owner);
    if (secretWrong != "") { return badRequest(secretWrong); }
    let stored = edited;
    if (edited.kind == "every") {
      let ahead = nextWorkflowFire(edited, Date.now() as number);
      if (!ahead.ok) { return badRequest(ahead.error); }
      stored = withWorkflowNextAt(edited, ahead.at);
    }
    let written = persist(this.db, workflowsMapping(), JSON.stringify(stored));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, workflowsMapping(), stored.id));
  }

  // Compile a step's script and say whether it is sound, without running
  // anything.
  //
  // The console calls this a moment after the editor goes quiet, so a person
  // learns their script does not compile while they are looking at it —
  // rather than by running the workflow and reading the failure off the step.
  // It is the SAME call the run makes (`ensureBuilt`, keyed by the hash of
  // the source), so this is not a second compiler path and the check is not
  // wasted work: the module it builds is the one the run will use, which is
  // also why the first run stops being the slow one.
  //
  // Signed in only. Compiling is the one thing here that spends real time on
  // this machine, and an anonymous caller with a loop could spend all of it.
  @post("/script-check")
  scriptCheck(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" || guestTag(tags) != "") {
      return badRequest("signing in is what makes a script yours to compile");
    }
    if (req.body == "") { return badRequest("a body is required: {\"source\":\"...\"}"); }
    let source = jsonText(req.body, "source");
    if (source.trim() == "") {
      return ok("{\"ok\":false,\"error\":\"there is no script to compile\"}");
    }
    let built = ensureBuilt(source);
    if (!built.ok) {
      return ok("{\"ok\":false,\"error\":" + JSON.stringify(built.error) + "}");
    }
    return ok("{\"ok\":true,\"error\":\"\",\"fresh\":" + (built.fresh ? "true" : "false") + "}");
  }

  // The draft becomes what production runs — the one write site for
  // published_graph, which is what makes "publish" a word rather than a
  // hope. Messages and the clock walk this; the canvas keeps autosaving the
  // draft without touching it.
  @post("/:id/publish")
  publish(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    // Re-validated at the door even though every save validates: publish is
    // the moment the graph starts serving people, and a cheap second check
    // beats trusting that nothing ever wrote the column another way.
    let parsed = parseGraph(mine.graph);
    if (!parsed.ok) { return badRequest(parsed.error); }
    let wrong = refuseWorkflow(mine);
    if (wrong != "") { return badRequest(wrong); }
    let secretWrong = graphSecretProblem(this.db, parsed.graph, mine.owner);
    if (secretWrong != "") { return badRequest(secretWrong); }
    let now = stamp();
    executeWith(this.db,
      "UPDATE workflows SET published_graph = graph, published_at = " + this.db.placeholder
      + ", updated_at = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [now, now, mine.id]);
    return ok(findById(this.db, workflowsMapping(), mine.id));
  }

  // Fire it on the next tick — the task door's "run now", word for word.
  @post("/:id/run-now")
  runNow(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    let now = stamp();
    executeWith(this.db,
      "UPDATE workflows SET next_at = " + this.db.placeholder
      + ", running_since = '', enabled = true, updated_at = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [now, now, mine.id]);
    return accepted(findById(this.db, workflowsMapping(), mine.id));
  }

  // What happened when it ran, newest first — the canvas replays a run's
  // steps as node statuses straight off these rows.
  @get("/:id/runs")
  runs(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    return ok(workflowRunsOf(this.db, mine.id, mine.owner));
  }

  @del("/:id")
  remove(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    executeWith(this.db, "DELETE FROM workflow_runs WHERE workflow_id = " + this.db.placeholder, [mine.id]);
    let gone = deleteById(this.db, workflowsMapping(), mine.id);
    if (!gone.ok) { return badRequest(gone.error); }
    return noContent();
  }

  private owned(req: Request): WorkflowRow {
    let document = findById(this.db, workflowsMapping(), param(req, "id"));
    if (document == "") { return emptyWorkflow(); }
    let row: WorkflowRow = JSON.parse<WorkflowRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) { return emptyWorkflow(); }
    return row;
  }
}

// Secrets: values a workflow step may send but never hold (secrets.ts).
//
// Write-only by construction: POST takes the value and nothing answers one —
// the list is names, headers and destinations, and DELETE is the only other
// verb. There is deliberately no PUT: a secret's destination is authorised
// the moment its value is stored, and editing either half alone is the
// exfiltration this table exists to refuse. Change means delete and add
// again, with the value in hand.
// The one place a query leaves for the real search service. Both doors — the
// keyed /v1 and the signed-in playground — authenticate on their own and then
// come here, so the address, the allowed parameters and the "did it answer"
// check live once. Only the three named products build a path; a caller never
// names an upstream path of its own.
function forwardProduct(req: Request, product: string): Reply {
  let q = queryParam(req, "q", "");
  if (q.trim() == "") { return badRequest("a query is required: ?q=..."); }
  let url = upstreamBase() + "/" + product + "?q=" + urlEncode(q);
  // suggest takes only q; the other two take a result count and hybrid toggle.
  if (product != "suggest") {
    let k = queryParam(req, "k", "");
    if (k != "") { url = url + "&k=" + urlEncode(k); }
    let hybrid = queryParam(req, "hybrid", "");
    if (hybrid != "") { url = url + "&hybrid=" + urlEncode(hybrid); }
  }
  if (product == "retrieve") {
    let mc = queryParam(req, "max_chars", "");
    if (mc != "") { url = url + "&max_chars=" + urlEncode(mc); }
  }
  // Filters the search API already understands, passed through when present.
  let site = queryParam(req, "site", "");
  if (site != "") { url = url + "&site=" + urlEncode(site); }
  let lang = queryParam(req, "lang", "");
  if (lang != "") { url = url + "&lang=" + urlEncode(lang); }
  let country = queryParam(req, "country", "");
  if (country != "") { url = url + "&country=" + urlEncode(country); }
  let res = http.request(url, "GET", "", new Map<string, string>());
  if (!res.ok) { return problem(502, "the search service did not answer"); }
  // The upstream's own JSON and its own status, verbatim — the gateway adds a
  // door, not a shape.
  return reply(res.status, res.body, "application/json");
}

// The public product API, reached with an API key. Its own front-door
// exemption (publicPath) lets a jl_ key past the internal token and the proxy
// identity check, because this door authenticates the key itself and nothing
// else. Scopes gate which product a key may call; a use is stamped after a
// forward so the key list can say a key is alive.
@controller("/v1")
class V1Api {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/search")
  search(req: Request): Reply { return this.gated(req, "search"); }

  @get("/retrieve")
  retrieve(req: Request): Reply { return this.gated(req, "retrieve"); }

  @get("/suggest")
  suggest(req: Request): Reply { return this.gated(req, "suggest"); }

  gated(req: Request, product: string): Reply {
    let secret = presentedKey(header(req, "authorization"), header(req, "x-api-key"));
    let auth = verifyApiKey(this.db, secret);
    if (!auth.ok) {
      return problem(401, "a valid API key is required — send it as \"Authorization: Bearer jl_...\" or an X-API-Key header");
    }
    if (!hasScope(auth.scopes, product)) {
      return problem(403, "this key is not scoped for " + product + " — mint one with that scope on the Platform page");
    }
    let out = forwardProduct(req, product);
    touchApiKey(this.db, auth.keyId, stamp());
    return out;
  }
}

// The same forward, for a signed-in person trying it from the console. No key:
// the playground is a person at a keyboard, authenticated by the proxy the way
// every other console route is, and the key-scoped door is /v1. A guest is
// asked to sign in rather than served.
@controller("/playground")
class PlaygroundApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/search")
  search(req: Request): Reply { return this.run(req, "search"); }

  @get("/retrieve")
  retrieve(req: Request): Reply { return this.run(req, "retrieve"); }

  @get("/suggest")
  suggest(req: Request): Reply { return this.run(req, "suggest"); }

  run(req: Request, product: string): Reply {
    if (owningTag(callerTags(req)) == "") {
      return problem(401, "sign in to use the playground");
    }
    return forwardProduct(req, product);
  }
}

// The keys a person mints to call Joule's public products from their own code
// (api-keys.ts). Management only — list, mint, revoke — behind the same proxy
// identity every user route trusts. The secret itself is answered once, by
// create, and by nothing else: the store keeps a hash, and so does this API.
@controller("/api-keys")
class ApiKeyApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  // This owner's keys — named and prefixed, never the secret, never the hash.
  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(apiKeysOf(this.db, owningTag(tags)));
  }

  // Mint one. The response carries the secret ONCE — the only time any route
  // returns it — so the console can show it and then forget it, exactly as the
  // row already has.
  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    // A key is a standing credential someone's code will carry: it has to
    // belong to a signed-in person, never a guest.
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes a key yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"scopes\":\"search,retrieve\"}");
    }
    let made = mintApiKey(this.db, owner,
      jsonText(req.body, "name"),
      jsonText(req.body, "scopes"),
      stamp());
    if (made.problem != "") { return badRequest(made.problem); }
    // The secret, this once. Every character is [a-z0-9_-], so it needs no
    // JSON escaping — the id is a uuid, the secret and prefix are "jl_" and
    // hex. Shaped so the console has the id to list by and the prefix it keeps
    // showing after the secret is dismissed.
    let body = "{\"id\":\"" + made.id + "\",\"secret\":\"" + made.secret + "\",\"keyPrefix\":\"" + made.prefix + "\"}";
    return created(body);
  }

  @del("/:id")
  remove(req: Request): Reply {
    // Owner-scoped inside forgetApiKey: somebody else's key is absent, not
    // forbidden.
    if (!forgetApiKey(this.db, param(req, "id"), owningTag(callerTags(req)))) {
      return notFound("key " + param(req, "id"));
    }
    return noContent();
  }
}

@controller("/secrets")
class SecretApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(secretsOf(this.db, owningTag(tags)));
  }

  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    // The workflow rule, for the workflow reason: a secret is a standing key
    // somebody else's API honours, and it has to belong to somebody.
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes a secret yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"value\":\"...\",\"destination\":\"https://api.example.com\",\"header\":\"Authorization\",\"category\":\"Payments\"}");
    }
    let made = createSecret(this.db, {
      owner: owner,
      name: jsonText(req.body, "name"),
      value: jsonText(req.body, "value"),
      destination: jsonText(req.body, "destination"),
      header: jsonText(req.body, "header"),
      category: jsonText(req.body, "category"),
      master: this.master,
      now: stamp(),
    });
    if (made.problem != "") { return badRequest(made.problem); }
    // The row, never the value — the secrets table has no value column to
    // leak; the envelope lives with the credentials and no route reads it.
    return created(findById(this.db, secretsMapping(), made.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    // Owner-scoped inside forgetSecret: somebody else's secret is absent,
    // not forbidden.
    if (!forgetSecret(this.db, param(req, "id"), owningTag(callerTags(req)))) {
      return notFound("secret " + param(req, "id"));
    }
    return noContent();
  }
}

// The environments themselves, as their users see them.
//
// /script-images is the operator's table: image references, admin-tier,
// where rows are made. This is the same catalog read from the other side —
// what a signed-in person may run scripts IN, plus the containers their own
// conversations already hold. Two doors to one table, because "curate the
// deployment" and "manage my environments" are different permissions that
// happen to meet at the same rows.
@controller("/environments")
class EnvironmentApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  // The choosable environments: the caller's own first, then the
  // deployment's. Label and summary, which is what choosing needs — never
  // the image reference for curated rows, which is how the operator spells
  // it; a person's own row shows its source, because they wrote it.
  // `present` is whether the daemon holds the image already; a person's own
  // are present by construction — created means built or pulled.
  @get("/")
  catalog(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    let out = "[";
    let mine = userEnvsOf(this.db, owningTag(tags));
    let m: int = 0;
    while (m < mine.length) {
      if (m > 0) { out = out + ","; }
      out = out + "{\"id\":" + JSON.stringify(mine[m].id)
        + ",\"label\":" + JSON.stringify(mine[m].name)
        + ",\"summary\":" + JSON.stringify(mine[m].source == "dockerfile" ? "built from your Dockerfile" : mine[m].image)
        + ",\"mine\":true,\"present\":" + `${envImagePresent(mine[m].image)}` + "}";
      m = m + 1;
    }
    let rows = JSON.parse<ScriptImageRow[]>(listWhere(this.db, scriptImagesMapping(), "enabled = " + placeholderAt(this.db, 1), ["1"]));
    let i: int = 0;
    while (i < rows.length) {
      if (m + i > 0) { out = out + ","; }
      out = out + "{\"id\":" + JSON.stringify(rows[i].id)
        + ",\"label\":" + JSON.stringify(rows[i].label)
        + ",\"summary\":" + JSON.stringify(rows[i].summary)
        + ",\"mine\":false,\"present\":" + `${envImagePresent(rows[i].image)}` + "}";
      i = i + 1;
    }
    // The deployment default rides along under the id the env-keys door
    // already uses for it, so the two screens name one thing one way.
    if (m + i > 0) { out = out + ","; }
    out = out + "{\"id\":\"default\",\"label\":\"Default\",\"summary\":"
      + "\"the image an agent gets when nobody chose one\""
      + ",\"mine\":false,\"present\":" + `${envImagePresent(scriptImage())}` + "}";
    return ok(out + "]");
  }

  // Make an environment: a name and an image to pull, a name and a Dockerfile
  // to build, or a name and a `templateId` from the catalog — in which case
  // the image or Dockerfile is the operator's, copied from the template. The
  // reply is the row or the build's own last lines; a create that returns is
  // an environment that starts.
  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes an environment yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"image\":\"...\"}, {\"name\":\"...\",\"dockerfile\":\"FROM ...\"}, or {\"name\":\"...\",\"templateId\":\"...\"}");
    }
    // From a catalog template: the recipe is the operator's, so the model on
    // the model's side of the wire still never names an image — it named a
    // template id, and the image or Dockerfile behind it was written here.
    // A name defaults to the template's when the person did not give one.
    let image = jsonText(req.body, "image");
    let dockerfile = jsonText(req.body, "dockerfile");
    let name = jsonText(req.body, "name");
    let templateId = jsonText(req.body, "templateId");
    if (templateId != "") {
      let t = envTemplateById(this.db, templateId);
      if (t.id == "") { return badRequest("no template has the id \"" + templateId + "\" — the catalog says which exist"); }
      image = t.image;
      dockerfile = t.dockerfile;
      if (name.trim() == "") { name = t.name; }
    }
    let made = createUserEnv(this.db, {
      owner: owner, name: name, image: image, dockerfile: dockerfile, now: stamp(),
    });
    if (made.problem != "") { return badRequest(made.problem); }
    return created(findById(this.db, userEnvsMapping(), made.id));
  }

  // Forget one of mine: the row, the image when we built it, and every key
  // stored against it — a key scoped to an environment that no longer exists
  // is unreachable by construction, so keeping its envelope keeps nothing.
  @del("/:id")
  remove(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    let id = param(req, "id");
    if (!forgetUserEnv(this.db, id, owner)) {
      return notFound("environment " + id);
    }
    let keys = JSON.parse<EnvKeyRow[]>(envKeysOf(this.db, owner, id));
    let k: int = 0;
    while (k < keys.length) { forgetEnvKey(this.db, keys[k].id, owner); k = k + 1; }
    return noContent();
  }

  // The containers this person's conversations hold, joined to the titles
  // that make them recognisable. Names and states, never anybody else's.
  @get("/mine")
  mine(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(JSON.stringify(envOwned(this.db, owningTag(tags))));
  }

  // Drop one: the container, its row, and — when it was the conversation's
  // last — the shared workspace volume. The next run_script naming this
  // environment rebuilds it fresh, so this is "start me over", never "break
  // the conversation". Owner-checked the way every thread route is: somebody
  // else's is absent, not forbidden.
  @del("/mine/:threadId/:name")
  drop(req: Request): Reply {
    let tags = callerTags(req);
    let threadId = param(req, "threadId");
    if (!holdsOwner(tags, threadOwner(this.db, threadId))) {
      return notFound("environment " + param(req, "name"));
    }
    if (!envDrop(this.db, threadId, param(req, "name"))) {
      return notFound("environment " + param(req, "name"));
    }
    return noContent();
  }
}

// The operator's catalog of environment recipes (env-templates.ts).
//
// Two audiences, one table. Anyone signed in reads it — that is browsing the
// catalog, and the console proxy tiers a GET here as user. Only an operator
// writes it, because a template carries a Dockerfile that builds as root, and
// the proxy default-denies the writes to admin the same way it does the
// script_images table. The engine keeps no auth of its own here for the same
// reason every admin route does not: :8100 is never directly reachable, which
// is the launch gate that makes the proxy's tiering the boundary.
@controller("/env-templates")
class EnvTemplateApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  // The whole catalog, featured first. Read by anyone signed in, to browse.
  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(JSON.stringify(envTemplatesAll(this.db)));
  }

  // Create or update, keyed by id — an empty id mints one. Operator only.
  @post("/")
  save(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required: {\"name\":\"...\",\"summary\":\"...\",\"image\":\"...\"} or a dockerfile instead of image"); }
    // featuredRank is a number token, hand-parsed: parseInt answers i32|null
    // here, and a bare digit walk is the codebase's habit for reading one off
    // a request. Anything non-numeric reads as 0 — not featured.
    let rankRaw = jsonRaw(req.body, "featuredRank");
    let rank: int = 0;
    let ri: int = 0;
    while (ri < rankRaw.length) {
      let c = rankRaw.charCodeAt(ri);
      if (c < 48 || c > 57) { rank = 0; break; }
      rank = rank * 10 + (c - 48);
      ri = ri + 1;
    }
    let t: EnvTemplateWrite = {
      id: jsonText(req.body, "id"),
      name: jsonText(req.body, "name"),
      summary: jsonText(req.body, "summary"),
      tags: jsonText(req.body, "tags"),
      image: jsonText(req.body, "image"),
      dockerfile: jsonText(req.body, "dockerfile"),
      featuredRank: rank,
      now: stamp(),
    };
    let problem = saveEnvTemplate(this.db, t);
    if (problem != "") { return badRequest(problem); }
    return ok(JSON.stringify(envTemplatesAll(this.db)));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!forgetEnvTemplate(this.db, param(req, "id"))) {
      return notFound("template " + param(req, "id"));
    }
    return noContent();
  }
}

// The variables a person's scripts run with (env-keys.ts).
//
// A sibling of /secrets and deliberately so: same ownership rule, same
// write-only value, same refusal to tell an unsigned caller anything. What
// differs is where the value goes — a secret rides a workflow's HTTP step to
// one pinned origin, an environment key is put in the process environment of a
// container the person's own conversation runs.
//
// There is no route here that answers with a value, and there is no route that
// updates one. Changing a key is deleting it and storing it again, which is
// the same shape credentials.ts gives a provider key and for the same reason:
// a value that can be read back is a value that leaks through whoever can call
// this API, and an update path is a second way in to get it wrong.
@controller("/env-keys")
class EnvKeyApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  // Every key of this person's, across environments; the settings screen
  // groups them by image. Names, never values.
  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(envKeysOwnedBy(this.db, owningTag(tags)));
  }

  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    // The secrets rule, for the secrets reason: a standing key has to belong
    // to somebody, and a guest is nobody the next session will recognise.
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes an environment key yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"imageId\":\"...\",\"name\":\"OPENAI_API_KEY\",\"value\":\"...\"}");
    }
    // Refused here rather than stored and never read: a key against an image
    // this deployment does not offer would sit in the list looking configured
    // while no script could ever see it. "default" is the deployment's own
    // image, which has no row by definition.
    let imageId = jsonText(req.body, "imageId");
    if (imageId != "default"
        && !existsById(this.db, scriptImagesMapping(), imageId)
        && userEnvById(this.db, imageId, owner).id == "") {
      return badRequest("no environment has the id \"" + imageId + "\" — one of yours, one this deployment offers, or \"default\" for the one an agent gets when nobody chose");
    }
    let made = createEnvKey(this.db, {
      owner: owner,
      imageId: imageId,
      name: jsonText(req.body, "name"),
      value: jsonText(req.body, "value"),
      master: this.master,
      now: stamp(),
    });
    if (made.problem != "") { return badRequest(made.problem); }
    // The row, never the value — the table has no column for one.
    return created(findById(this.db, envKeysMapping(), made.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    // Owner-scoped inside forgetEnvKey: somebody else's key is absent, not
    // forbidden.
    if (!forgetEnvKey(this.db, param(req, "id"), owningTag(callerTags(req)))) {
      return notFound("environment key " + param(req, "id"));
    }
    return noContent();
  }
}

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
class TriggerApi {
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

/* Joule, exported as an MCP server.
 *
 * POST /mcp-server speaks the protocol's JSON-RPC over plain HTTP:
 * initialize, tools/list, tools/call. What it serves is EXACTLY the
 * sentence surface — the same specs the chat mounts, dispatched through the
 * same callXTool functions with the same owner gate — so an external agent
 * connecting here can do precisely what a person's sentence can do, no
 * more. That equivalence is the security argument: nothing is exported that
 * a signed-in chat could not already say, and the deliberate exclusions
 * (credentials, operator keys) are excluded here by construction because no
 * tool for them exists.
 *
 * Identity rides the same two headers as every other door: the bearer that
 * admits the caller to the engine, and X-USER for whose rows these are. An
 * MCP client is configured with both, the way any API client is.
 *
 * Tool families that need a conversation (workspace files, artifacts) are
 * not served — an MCP caller has no thread. What remains is everything that
 * acts on the deployment's own nouns: tasks, workflows, bots, agents,
 * projects, skills, the corpus.
 */
@controller("/mcp-server")
class McpServerApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @post("/")
  rpc(req: Request): Reply {
    let id = jsonRaw(req.body, "id");
    if (id == "") { id = "null"; }
    let method = jsonText(req.body, "method");

    if (method == "initialize") {
      return ok("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{"
        + "\"protocolVersion\":\"2024-11-05\","
        + "\"capabilities\":{\"tools\":{}},"
        + "\"serverInfo\":{\"name\":\"joule\",\"version\":\"1\"}}}");
    }
    if (method == "notifications/initialized" || method == "ping") {
      return ok("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{}}");
    }

    if (method == "tools/list") {
      let specs = mcpExportedTools();
      let out = "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{\"tools\":[";
      let i: int = 0;
      while (i < specs.length) {
        if (i > 0) { out = out + ","; }
        out = out + "{\"name\":" + JSON.stringify(specs[i].name)
          + ",\"description\":" + JSON.stringify(specs[i].description)
          + ",\"inputSchema\":" + specs[i].schema + "}";
        i = i + 1;
      }
      return ok(out + "]}}");
    }

    if (method == "tools/call") {
      let params = jsonRaw(req.body, "params");
      let name = jsonText(params, "name");
      let args = jsonRaw(params, "arguments");
      if (args == "") { args = "{}"; }
      let owner = owningTag(callerTags(req));
      let answered = mcpDispatch(this.db, owner, name, args);
      if (!answered.handled) {
        return ok("{\"jsonrpc\":\"2.0\",\"id\":" + id
          + ",\"error\":{\"code\":-32601,\"message\":" + JSON.stringify("no tool named " + name) + "}}");
      }
      // The protocol's own failure shape: a result with isError, so the
      // calling agent reads the sentence instead of a transport fault.
      return ok("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{"
        + "\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(answered.text) + "}],"
        + "\"isError\":" + (answered.ok ? "false" : "true") + "}}");
    }

    return ok("{\"jsonrpc\":\"2.0\",\"id\":" + id
      + ",\"error\":{\"code\":-32601,\"message\":\"unknown method\"}}");
  }
}

/** Every family a caller with no conversation can use. */
function mcpExportedTools(): ToolSpec[] {
  let out: ToolSpec[] = [];
  let families: ToolSpec[][] = [
    taskTools(), workflowTools(), triggerTools(), agentTools(),
    knowledgeTools(), projectTools(),
  ];
  let f: int = 0;
  while (f < families.length) {
    let one = families[f];
    let i: int = 0;
    while (i < one.length) {
      // The banner is the deployment's voice above every visitor's page,
      // not one owner's noun — console chat only, never a foreign agent.
      if (one[i].name != "set_banner") { out.push(one[i]); }
      i = i + 1;
    }
    f = f + 1;
  }
  return out;
}

/** One call, tried against each family — the run loop's dispatch, minus the
 *  thread-bound families an MCP caller cannot hold. */
function mcpDispatch(db: Db, owner: string, name: string, args: string): FileToolResult {
  let nowMs = Date.now() as number;
  let scheduled = callTaskTool(db, { owner: owner, agentId: "", modelChoiceId: "", name: name, args: args, nowMs: nowMs });
  if (scheduled.handled) { return scheduled; }
  let flowed = callWorkflowTool(db, { owner: owner, agentId: "", name: name, args: args, nowMs: nowMs });
  if (flowed.handled) { return flowed; }
  let botted = callTriggerTool(db, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (botted.handled) { return botted; }
  let selfed = callAgentTool(db, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (selfed.handled) { return selfed; }
  if (name == "set_banner") {
    // Unlisted above, and barred here too — an unlisted name is a hint, a
    // refusal is a wall.
    let barred: FileToolResult = { handled: true, ok: false, text: "the site banner is set from the console's own chat, not over MCP.", line: 0, changed: "" };
    return barred;
  }
  let known = callKnowledgeTool(db, { owner: owner, name: name, args: args, nowMs: nowMs });
  if (known.handled) { return known; }
  // Projects, threadless: list and create work anywhere; move_to_project
  // refuses with its own sentence, since an MCP caller holds no conversation.
  let grouped = callProjectTool(db, { owner: owner, threadId: "", name: name, args: args, nowMs: nowMs });
  if (grouped.handled) { return grouped; }
  let none: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  return none;
}

// Whether this process is worth sending a request to, and which build it is.
//
// The one route that answers without a bearer token (`bearerRefused` below)
// and the one the gateway leaves public, because a probe that needs the
// secret cannot tell "the engine is down" from "the secret is wrong" — and
// those are different pages of the runbook.
// The announcement banner: one sentence the operator can put above every
// visitor's page — maintenance tonight, a new capability, a holiday notice —
// and take down again, all without a deploy.
// Which tool results the console draws as cards, as rows anybody can add.
//
// The engine's half of a card plugin. A row names a tool, a marker and the
// short payload the model should emit; run.ts appends the hint to that tool's
// successful results and knows nothing else about it. The console's half is
// the renderer, looked up by marker — so adding a card for a connector this
// package has never heard of is a POST here plus a renderer the console can
// find, and no change to either codebase.
@controller("/tool-cards")
class ToolCardApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Read by the console on load, so it knows which markers to expect and can
  // brief a prompt with them. Carries no secret and names no person.
  @get("/")
  list(req: Request): Reply {
    return ok(listOrdered(this.db, toolCardsMapping(), "", [], [asc("tool_name")]));
  }

  @post("/")
  add(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let row: ToolCardRow = JSON.parse<ToolCardRow>(req.body);
    let problem = toolCardProblem(row);
    if (problem != "") { return badRequest(problem); }
    if (findById(this.db, toolCardsMapping(), row.id) != "") {
      return badRequest("tool card " + row.id + " already exists; PUT it to change it");
    }
    persist(this.db, toolCardsMapping(), JSON.stringify(row));
    return ok(JSON.stringify(row));
  }

  @put("/:id")
  change(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    if (findById(this.db, toolCardsMapping(), id) == "") {
      return notFound("no tool card " + id);
    }
    let row: ToolCardRow = JSON.parse<ToolCardRow>(req.body);
    let problem = toolCardProblem(row);
    if (problem != "") { return badRequest(problem); }
    if (row.id != id) { return badRequest("the body's id must match the path"); }
    persist(this.db, toolCardsMapping(), JSON.stringify(row));
    return ok(JSON.stringify(row));
  }

  @del("/:id")
  remove(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    if (findById(this.db, toolCardsMapping(), id) == "") {
      return notFound("no tool card " + id);
    }
    deleteById(this.db, toolCardsMapping(), id);
    return ok("{\"deleted\":" + JSON.stringify(id) + "}");
  }
}

/** The manifest with the install's own facts injected: where it was actually
 *  fetched from, and the renderer source that was actually fetched.
 *
 *  Rewritten rather than trusted: a manifest may carry any sourceUrl it likes,
 *  including one pointing at a plugin somebody else published, and the row is
 *  meant to answer "where did this come from" for whoever is debugging it. */
function injectSource(manifest: string, url: string, rendererUrl: string, rendererSource: string): string {
  let trimmed = manifest.trim();
  if (!trimmed.startsWith("{")) { return trimmed; }
  return "{\"sourceUrl\":" + JSON.stringify(url)
    + ",\"rendererUrl\":" + JSON.stringify(rendererUrl)
    + ",\"rendererSource\":" + JSON.stringify(rendererSource)
    + "," + trimmed.slice(1);
}

/** A reference resolved against the url it was found in — "./renderer.js"
 *  beside the manifest, an absolute url as itself. The two forms a manifest
 *  actually writes; anything else is refused by the fetch that follows. */
function resolveAgainst(base: string, ref: string): string {
  if (ref.startsWith("https://") || ref.startsWith("http://")) { return ref; }
  let cut = base.lastIndexOf("/");
  if (cut < 0) { return ref; }
  let dir = base.slice(0, cut);
  if (ref.startsWith("./")) { return dir + ref.slice(1); }
  return dir + "/" + ref;
}

/* What an install POSTs, which is NOT what gets stored.
 *
 * A record parse here is exact: a body carrying {"toolName","marker",...}
 * cannot be read as a ToolCardRow, because that row also has an id, a
 * plugin_id and an enabled flag — and the parse answering "no rows" rather
 * than complaining is how an install first appeared to succeed while storing
 * a plugin with nothing under it. The ids and the ownership are the SERVER's
 * to assign anyway: a plugin that could choose its cards' ids could overwrite
 * another plugin's. */
type CardInput = { toolName: string, marker: string, payload: string, hint: string };
type CaseInput = { when: string, then: string };

/** A JSON array member, or "[]" when the body omits it — an install carrying
 *  only cards is as valid as one carrying only cases. */
function rawListOr(body: string, member: string): string {
  let raw = jsonRaw(body, member);
  if (raw == "") { return "[]"; }
  return raw;
}

// What a card row has to say to be usable.
//
// The marker is the strict one: it becomes [MARKER]…[/MARKER] in a reply, so a
// marker carrying a bracket or a space would produce a block nothing can
// parse — and the failure would look like a model that ignored instructions.
function toolCardProblem(row: ToolCardRow): string {
  if (row.id.trim() == "") { return "a tool card needs an id"; }
  if (row.toolName.trim() == "") { return "a tool card needs the tool whose result it draws"; }
  if (row.marker.trim() == "") { return "a tool card needs a marker"; }
  if (row.marker.length > 32) { return "a marker is at most 32 characters"; }
  let i: int = 0;
  while (i < row.marker.length) {
    let c = row.marker[i];
    let okChar = (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "_";
    if (!okChar) {
      return "a marker is upper-case letters, digits and underscores — got \"" + row.marker + "\"";
    }
    i = i + 1;
  }
  return "";
}

// Card plugins: install, list, disable, remove.
//
// A plugin is the unit somebody actually manages — it owns its cards
// (/tool-cards, plugin_id) and its cases (below), so switching one off makes
// its markers stop being taught and its lines stop being briefed without
// deleting anything. See plugincards.ts for why that is a table rather than
// three unrelated rows.
//
// Install is deliberately one POST carrying the whole plugin: a plugin that
// arrives as four requests can half-arrive, and a half-installed plugin is a
// model told to emit a marker nothing draws.
@controller("/card-plugins")
class CardPluginApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(req: Request): Reply {
    return ok(listOrdered(this.db, cardPluginsMapping(), "", [], [asc("plugin_name")]));
  }

  // Everything the plugin is, in one body:
  //   {"id","pluginName","description","sourceUrl","version",
  //    "cards":[{"toolName","marker","payload","hint"}],
  //    "cases":[{"when","then"}]}
  @post("/")
  install(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let id = jsonText(req.body, "id");
    let name = jsonText(req.body, "pluginName");
    if (id == "") { return badRequest("a plugin needs an id"); }
    if (name == "") { return badRequest("a plugin needs a name"); }
    if (findById(this.db, cardPluginsMapping(), id) != "") {
      return badRequest("plugin " + id + " is already installed");
    }

    let plugin: CardPluginRow = {
      id: id, pluginName: name,
      description: jsonText(req.body, "description"),
      sourceUrl: jsonText(req.body, "sourceUrl"),
      version: jsonText(req.body, "version"),
      rendererUrl: jsonText(req.body, "rendererUrl"),
      rendererSource: jsonText(req.body, "rendererSource"),
      enabled: true, installedAt: stamp(),
    };

    // The cards first, so a refused marker refuses the whole install rather
    // than leaving a plugin row with nothing under it.
    let cards = JSON.parse<CardInput[]>(rawListOr(req.body, "cards"));
    let c: int = 0;
    while (c < cards.length) {
      let card: ToolCardRow = {
        id: id + ":" + `${c}`, pluginId: id,
        toolName: cards[c].toolName, marker: cards[c].marker,
        payload: cards[c].payload, hint: cards[c].hint, enabled: true,
      };
      let problem = toolCardProblem(card);
      if (problem != "") { return badRequest(problem); }
      c = c + 1;
    }

    persist(this.db, cardPluginsMapping(), JSON.stringify(plugin));
    let w: int = 0;
    while (w < cards.length) {
      let card: ToolCardRow = {
        id: id + ":" + `${w}`, pluginId: id,
        toolName: cards[w].toolName, marker: cards[w].marker,
        payload: cards[w].payload, hint: cards[w].hint, enabled: true,
      };
      persist(this.db, toolCardsMapping(), JSON.stringify(card));
      w = w + 1;
    }
    let cases = JSON.parse<CaseInput[]>(rawListOr(req.body, "cases"));
    let k: int = 0;
    while (k < cases.length) {
      let one: CardCaseRow = {
        id: id + ":case:" + `${k}`, pluginId: id,
        when: cases[k].when, then: cases[k].then,
      };
      persist(this.db, cardCasesMapping(), JSON.stringify(one));
      k = k + 1;
    }
    return ok(JSON.stringify(plugin));
  }

  // Off rather than gone. The rows stay and nothing is briefed — the state
  // for working out whether a plugin is what is making a model behave oddly.
  @put("/:id")
  change(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    let held = findById(this.db, cardPluginsMapping(), id);
    if (held == "") { return notFound("no plugin " + id); }
    let row: CardPluginRow = JSON.parse<CardPluginRow>(held);
    let after: CardPluginRow = {
      id: row.id, pluginName: row.pluginName, description: row.description,
      sourceUrl: row.sourceUrl, version: row.version,
      rendererUrl: row.rendererUrl, rendererSource: row.rendererSource,
      // Same trap as the captcha row, one controller over: a JSON boolean
      // false read as "" through jsonText, and "" != "false" is true — so
      // switching a plugin off with {"enabled":false} switched it ON. The
      // default when the member is absent is unchanged.
      enabled: jsonFlag(req.body, "enabled", true),
      installedAt: row.installedAt,
    };
    persist(this.db, cardPluginsMapping(), JSON.stringify(after));
    return ok(JSON.stringify(after));
  }

  // Uninstall takes exactly what the install created, by plugin_id — a card
  // somebody added by hand carries no plugin and survives, which is what the
  // person who added it expects.
  @del("/:id")
  remove(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    if (findById(this.db, cardPluginsMapping(), id) == "") {
      return notFound("no plugin " + id);
    }
    deleteWhere(this.db, toolCardsMapping(), "plugin_id = " + this.db.placeholder, [id]);
    deleteWhere(this.db, cardCasesMapping(), "plugin_id = " + this.db.placeholder, [id]);
    deleteById(this.db, cardPluginsMapping(), id);
    return ok("{\"uninstalled\":" + JSON.stringify(id) + "}");
  }


  // Install from where the plugin lives, rather than from a body somebody
  // pasted. The url is fetched, and what comes back is the same manifest the
  // POST above takes — so a plugin is publishable as one JSON file, and the
  // row records where it came from, which is the first question when a card
  // draws wrongly.
  //
  // Nothing executable is fetched, and that is deliberate rather than
  // unfinished. A manifest names markers and cases; the RENDERER stays in the
  // console, looked up by marker. A plugin that could ship its own drawing
  // code would be a way to put markup of somebody else's choosing inside a
  // transcript, and no amount of sandboxing makes that a good trade for a
  // cycle chart. A marker with no renderer degrades to the model's own line.
  @post("/from-source")
  fromSource(req: Request): Reply {
    let url = jsonText(req.body, "sourceUrl");
    if (url == "") { return badRequest("a sourceUrl is required"); }
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      return badRequest("a plugin source is an http(s) url");
    }
    let res = http.request(url, "GET", "", new Map<string, string>());
    if (!res.ok) { return badRequest("could not reach " + url); }
    if (res.status != 200) {
      return badRequest(url + " answered " + `${res.status}`);
    }
    // The manifest decides everything except where it came from: that is this
    // deployment's record of the install, not the publisher's claim about it.
    let manifest = res.body;
    if (jsonText(manifest, "id") == "") {
      return badRequest("that url did not answer a plugin manifest (no id)");
    }

    // The renderer, snapshotted NOW — the whole reason installs go through
    // this route. "./renderer.js" resolves against the manifest's own url, so
    // a repo can hold many plugins as folders. An install whose renderer
    // cannot be fetched is refused whole: a plugin row whose markers nothing
    // will ever draw is exactly the half-install this route exists to
    // prevent. A manifest that names no renderer installs fine — its markers
    // may be ones the console already draws.
    let rendererUrl = "";
    let rendererSource = "";
    let renderer = jsonText(manifest, "renderer");
    if (renderer != "") {
      rendererUrl = resolveAgainst(url, renderer);
      let fetched = http.request(rendererUrl, "GET", "", new Map<string, string>());
      if (!fetched.ok || fetched.status != 200) {
        return badRequest("the manifest names a renderer at " + rendererUrl
          + " and it could not be fetched — refusing a half-install");
      }
      rendererSource = fetched.body;
    }

    let withSource = injectSource(manifest, url, rendererUrl, rendererSource);
    let forward: Request = {
      method: "POST", path: "/card-plugins", body: withSource,
      params: req.params, query: req.query, headers: req.headers,
    };
    return this.install(forward);
  }

  // The snapshot, as the module the console's sandbox imports. Served from
  // this database rather than from the CDN it came from — see rendererSource
  // in plugincards.ts for the three reasons in order.
  @get("/:id/renderer")
  renderer(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    let held = findById(this.db, cardPluginsMapping(), id);
    if (held == "") { return notFound("no plugin " + id); }
    let row: CardPluginRow = JSON.parse<CardPluginRow>(held);
    if (row.rendererSource == "") { return notFound("plugin " + id + " ships no renderer"); }
    let reply: Reply = {
      status: 200, body: row.rendererSource,
      headers: new Map<string, string>([["Content-Type", "text/javascript; charset=utf-8"]]),
    };
    return reply;
  }

  // The cases, listed and edited on their own — a plugin's behaviour is
  // mostly these lines, and tuning one should not be a reinstall.
  @get("/:id/cases")
  cases(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    return ok(listWhere(this.db, cardCasesMapping(), "plugin_id = " + this.db.placeholder, [id]));
  }
}


// The sandbox's limits, operator-set. The numbers a script container is
// bounded by, and the counts that bound how many environments and keys pile
// up — every one of which used to be a constant that needed a rebuild to
// change. Admin-tier like every other configuration surface (the console
// proxy tiers it; a bare :8100 is the launch gate's problem, not this
// route's). The reply always carries `defaults` too, so the screen can show
// what a field left at 0 will fall back to.
@controller("/sandbox-limits")
class SandboxLimitsApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  show(req: Request): Reply {
    return ok("{\"limits\":" + JSON.stringify(sandboxLimits(this.db))
      + ",\"defaults\":" + JSON.stringify(defaultLimits()) + "}");
  }

  // Written whole, like the tracing connection and for the same reason: these
  // numbers are one policy, and a partial update is how a box ends with a
  // memory cap from one intention and a wall clock from another.
  @put("/")
  change(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required: the seven limits, 0 for any that should keep the default"); }
    let l: SandboxLimits = JSON.parse<SandboxLimits>(req.body);
    let problem = saveSandboxLimits(this.db, l);
    if (problem != "") { return badRequest(problem); }
    // saveSandboxLimits already applied them to the running process.
    return this.show(req);
  }
}

// The bot challenge on the sign-in form, configured rather than deployed.
//
// Same bargain as /auth-providers, and for the same reason: a site key and a
// secret are a per-deployment fact that an operator should be able to change at
// 2am without a rebuild, and baking either into an image or a unit file makes
// rotating one an engineering task. So the public half is a settings row and
// the secret goes in the encrypted store beside every other secret this
// deployment holds.
//
// Only the CONSOLE ever verifies a token. This route is storage: it knows what
// a site key is, and it does not know what Turnstile is.

@controller("/captcha")
class CaptchaApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  // The operator's view: everything except the secret, which is never read
  // back. `configured` is the question the form actually asks — "is there a
  // secret stored" — answered without opening it.
  @get("/")
  show(req: Request): Reply {
    let held = readSetting(this.db, "captcha");
    let provider = held == "" ? "turnstile" : jsonText(held, "provider");
    let siteKey = held == "" ? "" : jsonText(held, "siteKey");
    let enabled = held != "" && jsonText(held, "enabled") == "true";
    return ok("{\"provider\":" + JSON.stringify(provider)
      + ",\"siteKey\":" + JSON.stringify(siteKey)
      + ",\"enabled\":" + (enabled ? "true" : "false")
      + ",\"configured\":" + (hasCredential(this.db, "captcha") ? "true" : "false") + "}");
  }

  // What the console's own server needs to verify a token: the secret. Its own
  // route because it is the one place this secret leaves the process, exactly
  // as /auth-providers/resolved is for OAuth — and it answers the enabled and
  // fully-configured case only, so a half-set-up challenge cannot lock anybody
  // out of a login form.
  @get("/resolved")
  resolved(req: Request): Reply {
    let held = readSetting(this.db, "captcha");
    if (held == "") { return ok("{\"enabled\":false}"); }
    let enabled = jsonText(held, "enabled") == "true";
    let siteKey = jsonText(held, "siteKey");
    let secret = credentialFor(this.db, "captcha", this.master);
    if (!enabled || siteKey == "" || secret == "") { return ok("{\"enabled\":false}"); }
    return ok("{\"enabled\":true,\"provider\":" + JSON.stringify(jsonText(held, "provider"))
      + ",\"siteKey\":" + JSON.stringify(siteKey)
      + ",\"secret\":" + JSON.stringify(secret) + "}");
  }

  @put("/")
  change(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let provider = jsonText(req.body, "provider");
    if (provider == "") { provider = "turnstile"; }
    if (provider != "turnstile" && provider != "hcaptcha" && provider != "recaptcha") {
      return badRequest("provider must be turnstile, hcaptcha or recaptcha");
    }
    let siteKey = jsonText(req.body, "siteKey");
    if (utf8Length(siteKey) > 200) { return badRequest("that is not a site key"); }
    let enabled = jsonFlag(req.body, "enabled", false);
    // Refusing here rather than at the console: turning the challenge on with
    // no secret stored would mean every verification fails, which locks the
    // login form for everybody including the operator who just did it.
    if (enabled && (siteKey == "" || !hasCredential(this.db, "captcha"))) {
      return badRequest("store a site key and a secret before turning the challenge on");
    }
    let value = "{\"provider\":" + JSON.stringify(provider)
      + ",\"siteKey\":" + JSON.stringify(siteKey)
      + ",\"enabled\":" + (enabled ? "\"true\"" : "\"false\"") + "}";
    let problem = writeSetting(this.db, "captcha", value);
    if (problem != "") { return badRequest(problem); }
    return ok(value);
  }

  @put("/secret")
  setSecret(req: Request): Reply {
    let secret = jsonText(req.body, "secret");
    if (secret == "") { return badRequest("a secret is required"); }
    let stored = storeCredential(this.db, { provider: "captcha",
      apiKey: secret, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return ok("{\"configured\":true}");
  }
}

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

// What the day's ceiling looks like from where this caller stands — read once
// at console boot; every send after that carries `guestRemaining` in its own
// reply, so nothing polls this.
//
// A signed-in caller (and the community deployment, which has no gateway and
// no guests) gets `{"limit":0}`: 0 is "no ceiling", and answering it here
// rather than 404ing keeps the console's one boot call unconditional.
@controller("/quota")
class QuotaApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  show(req: Request): Reply {
    let guest = guestTag(callerTags(req));
    if (guest == "") { return ok("{\"limit\":0}"); }
    let now = Date.now();
    let used = runsSince(this.db, guest, utcDayStartText(now));
    let left = GUEST_DAILY_RUNS - used;
    if (left < 0) { left = 0; }
    return ok("{\"limit\":" + `${GUEST_DAILY_RUNS}`
      + ",\"used\":" + `${used}`
      + ",\"remaining\":" + `${left}`
      + ",\"resetsAt\":" + JSON.stringify(nextUtcMidnightIso(now)) + "}");
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
  if (path == "/healthz") { return true; }
  // The keyed gateway carries its own credential; a jl_ key on Authorization
  // must not be measured against the internal token, and an external caller
  // sends no x-user for the proxy check to read.
  if (path == "/v1") { return true; }
  if (path.length >= 4 && path.substring(0, 4) == "/v1/") { return true; }
  return false;
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

// The first of two spellings that is not blank. For the kept-file door, where
// a missing filename or mime is a caller that did not bother rather than a
// caller that means "none" — and storing "" would put an empty name on a
// download.
function firstText(said: string, fallback: string): string {
  let text = said.trim();
  if (text == "") { return fallback; }
  return text;
}

// How many bytes a base64 string stands for, without decoding it.
//
// Four characters carry three bytes; each "=" at the end is a byte that is not
// there. Computed rather than measured because the whole point of keeping the
// bytes as base64 is never having to hold a decoded copy — decoding eighteen
// megabytes to learn a number the arithmetic already knows would double the
// memory of every upload.
export function decodedSize(base64: string): int {
  let text = base64.trim();
  if (text.length == 0) { return 0; }
  let padding: int = 0;
  if (text.endsWith("==")) {
    padding = 2;
  } else if (text.endsWith("=")) {
    padding = 1;
  }
  let whole = (text.length / 4) * 3;
  return whole - padding;
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
/* The Discover digest, on a schedule rather than on a visitor.
 *
 * A worker thread for the reason sweepLoop states below: once `listen` hands
 * over the event loop no setInterval in this process fires again. Its body
 * may not throw — Worker.run takes `() => T` — so the whole loop is inside
 * one try.
 *
 * On a schedule and NOT per request, which is the design decision worth
 * writing down. A digest asked for on page load costs a model call per topic
 * per visitor, produces identical answers for all of them, waits sixty
 * seconds while somebody watches a spinner, and never digests a topic nobody
 * happens to open. On a timer the cost is topics x passes-per-day, fixed,
 * whatever the traffic — and the page becomes a table read.
 *
 * Feeds go one at a time: the local model serves one request at a time, so a
 * burst would queue anyway while holding every feed's snippets in memory.
 */
function digestLoop(master: string, everyMs: int): int {
  try {
    let db = openDatabase();
    while (true) {
      let feeds = allFeeds(db);
      let i: int = 0;
      while (i < feeds.length) {
        if (feeds[i].enabled) {
          // Said out loud, because it was not and that cost an afternoon: a
          // pass whose every feed failed — model down, credential missing, a
          // query the index mangled — looked exactly like a pass that had not
          // run yet, and the only way to tell them apart was to guess.
          let problem = refreshFeed(db, feeds[i], master);
          if (problem != "") {
            console.error("discover: " + feeds[i].id + ": " + problem);
          }
        }
        i = i + 1;
      }
      process.sleep(everyMs);
    }
  } catch (e) {
    // A background pass that dies must not take the process with it: it is
    // logged, the thread ends, and the page keeps serving what was last
    // written until a restart starts it again.
    console.error("discover: the digest pass stopped");
  }
  return 0;
}

/* How often the digest runs, and whether it runs at all.
 *
 * Unset means OFF: Discover is a deployment's choice, and a box that has not
 * asked for it should not be calling a model every half hour forever. Thirty
 * minutes is the value to set — the crawl's own cadence, and often enough
 * that a feed is never more than one pass stale. */
function discoverEveryMs(): int {
  let said = process.env["AGENTS_DISCOVER_EVERY_MS"] ?? "";
  if (said == "") { return 0; }
  let n = parseInt(said, 10) ?? 0;
  if (n > 0 && n < 60000) { return 60000; }
  return n;
}

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
  let webRag = webRagPlan(db);
  let wr: int = 0;
  while (wr < webRag.length) { knowledge.push(webRag[wr]); wr = wr + 1; }
  // Which tool results the console draws as cards. A table rather than names
  // in run.ts — see toolcards.ts.
  let cards = toolCardsPlan(db);
  let tc: int = 0;
  while (tc < cards.length) { knowledge.push(cards[tc]); tc = tc + 1; }
  // The Discover feeds and the stories the digest job writes.
  let discover = discoverPlan(db);
  let dc: int = 0;
  while (dc < discover.length) { knowledge.push(discover[dc]); dc = dc + 1; }
  // The plugin that owns cards and cases — installable as one thing.
  let cardPlugins = cardPluginsPlan(db);
  let cp: int = 0;
  while (cp < cardPlugins.length) { knowledge.push(cardPlugins[cp]); cp = cp + 1; }
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
  // What runs without anybody asking (tasks.ts). The firing lives in
  // scheduler.ts, a separate process; the engine only owns the rows.
  let scheduled = tasksPlan(db);
  let st: int = 0;
  while (st < scheduled.length) { plan.push(scheduled[st]); st = st + 1; }
  // And the graphs of steps beside them (workflow-store.ts), fired by the
  // same process.
  let flows = workflowsPlan(db);
  let fl: int = 0;
  while (fl < flows.length) { plan.push(flows[fl]); fl = fl + 1; }
  // Projects (projects.ts): the table, plus the threads column that points at
  // it — the ALTER rides that plan because threadPlan's numbers are history.
  let grouped = projectsPlan(db);
  let pj: int = 0;
  while (pj < grouped.length) { plan.push(grouped[pj]); pj = pj + 1; }
  // The original bytes of an uploaded document (document-files.ts), beside the
  // text the corpus keeps. Its own plan rather than an addition to
  // knowledgePlan, whose numbers are history and top out at 18.
  let originals = documentFilesPlan(db);
  let df: int = 0;
  while (df < originals.length) { plan.push(originals[df]); df = df + 1; }
  // Triggers (triggers.ts): the bots polled by joule-trigger@id, and what
  // arrived from them. Its own plan for the reason above — workflowsPlan's
  // numbers are history — and the highest in this file, at 106.
  let arriving = triggersPlan(db);
  let tg: int = 0;
  while (tg < arriving.length) { plan.push(arriving[tg]); tg = tg + 1; }
  // Secrets a workflow step may send but never hold (secrets.ts). Its own
  // plan, numbered above triggers' 108.
  let sealed = secretsPlan(db);
  let sk: int = 0;
  while (sk < sealed.length) { plan.push(sealed[sk]); sk = sk + 1; }
  // The variables a person's scripts run with (env-keys.ts). Its own plan,
  // numbered above secrets' 109.
  let vars = envKeysPlan(db);
  let ek: int = 0;
  while (ek < vars.length) { plan.push(vars[ek]); ek = ek + 1; }
  // The environments people define themselves (user-environments.ts), above
  // env-keys' 110.
  let uenv = userEnvsPlan(db);
  let ue: int = 0;
  while (ue < uenv.length) { plan.push(uenv[ue]); ue = ue + 1; }
  // The operator's catalog of environment recipes (env-templates.ts), above
  // user environments' 111.
  let tmpl = envTemplatesPlan(db);
  let tp: int = 0;
  while (tp < tmpl.length) { plan.push(tmpl[tp]); tp = tp + 1; }
  // What each connector last said it offers (mcp-roster.ts), above
  // env-templates' 112.
  let roster = mcpRosterPlan(db);
  let ro: int = 0;
  while (ro < roster.length) { plan.push(roster[ro]); ro = ro + 1; }
  // A standing credential for the public /v1 products (api-keys.ts),
  // above mcp-roster's 113.
  let keys = apiKeysPlan(db);
  let kp: int = 0;
  while (kp < keys.length) { plan.push(keys[kp]); kp = kp + 1; }
  let ran = migrate(db, plan);
  if (ran.ok) {
    // The schema is up: push any stored sandbox limits into the enforcing
    // modules, so a box that set them keeps them across a restart. On an
    // unconfigured box this sets every override to 0, which is the default.
    applySandboxLimits(db);
    // And put a few recipes in the catalog if it is empty — separately from
    // seed(), which only runs on a box with no agents. Production has agents
    // and no templates, so the catalog needs its own "is it empty" gate.
    seedEnvTemplates(db);
    return "";
  }
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


// A starting catalog, put down once. Guarded on the table being empty rather
// than on the deployment being fresh, because an existing box has agents but
// no templates and would otherwise show an empty catalog forever. An operator
// deletes or edits these like any other row; they are a starting point, not a
// fixture, so this never re-adds one that was removed.
function seedEnvTemplates(db: Db): void {
  if (countWhere(db, envTemplatesMapping(), "", []) > 0) { return; }
  let now = stamp();
  let starters: EnvTemplateWrite[] = [
    { id: "", name: "Python", summary: "python 3.12, pip and the standard library — the everyday scripting environment", tags: "python,scripting", image: "python:3.12-slim", dockerfile: "", featuredRank: 1, now: now },
    { id: "", name: "Node.js", summary: "node 20 and npm — for a JavaScript or TypeScript script", tags: "node,javascript", image: "node:20-slim", dockerfile: "", featuredRank: 2, now: now },
    { id: "", name: "Data science", summary: "python with pandas, numpy and matplotlib installed — for shaping and charting data", tags: "python,data,pandas", image: "", dockerfile: "FROM python:3.12-slim\nRUN pip install --no-cache-dir pandas numpy matplotlib", featuredRank: 3, now: now },
    { id: "", name: "Web scraping", summary: "python with requests, beautifulsoup4 and lxml — fetch a page and pull data out of it", tags: "python,web,scraping", image: "", dockerfile: "FROM python:3.12-slim\nRUN pip install --no-cache-dir requests beautifulsoup4 lxml", featuredRank: 0, now: now },
  ];
  let i: int = 0;
  while (i < starters.length) { saveEnvTemplate(db, starters[i]); i = i + 1; }
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
  // The Discover digest. Off unless a deployment names an interval, so a box
  // that has not configured Discover pays nothing for it.
  let discoverEvery = discoverEveryMs();
  if (discoverEvery > 0) { Worker.run(() => digestLoop(master, discoverEvery)); }

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
    new TaskApi(db),
    new ProjectApi(db),
    new WorkflowApi(db),
    new SecretApi(db, master),
    new ApiKeyApi(db),
    new V1Api(db),
    new PlaygroundApi(db),
    new EnvironmentApi(db),
    new EnvTemplateApi(db),
    new EnvKeyApi(db, master),
    new TriggerApi(db, master),
    new McpServerApi(db),
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
    new ConnectApi(db, master),
    new AuthProviderApi(db, master),
    new PluginApi(db),
    new ArtifactApi(db),
    new PreviewApi(db),
    new DiscoverApi(db),
    new LibraryApi(db),
    new ToolCardApi(db),
    new CardPluginApi(db),
    new BannerApi(db),
    new SandboxLimitsApi(db),
    new CaptchaApi(db, master),
    new HealthApi(db),
    new UsageApi(db),
    new QuotaApi(db),
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
