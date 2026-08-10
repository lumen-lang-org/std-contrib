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
import { stamp, callerTags, GUEST_DAILY_RUNS, guestTag, guestQuotaJson, bodyText, bodyJson, bodyBool, bodyInt, bodyNumber, bodyRank, askedChoice, boolJson, choiceProblem, forwardProduct, toolCardProblem } from "./api-core.ts";
import { HealthApi } from "./routes/healthz/controller.ts";
import { CardPluginApi } from "./routes/card-plugins/controller.ts";
import { ToolCardApi } from "./routes/tool-cards/controller.ts";
import { McpServerApi } from "./routes/mcp-server/controller.ts";
import { PlaygroundApi } from "./routes/playground/controller.ts";
import { V1Api } from "./routes/v1/controller.ts";
import { TaskApi } from "./routes/tasks/controller.ts";
import { DocumentApi } from "./routes/documents/controller.ts";
import { PreviewApi } from "./routes/preview/controller.ts";
import { ArtifactApi } from "./routes/threads-artifacts/controller.ts";
import { WorkspaceApi } from "./routes/threads-files/controller.ts";
import { ConnectApi } from "./routes/connect/controller.ts";
import { ServerApi } from "./routes/servers/controller.ts";
import { AuthProviderApi } from "./routes/auth-providers/controller.ts";
import { PluginApi } from "./routes/plugins/controller.ts";
import { PromptApi } from "./routes/prompts/controller.ts";
import { ModelApi } from "./routes/models/controller.ts";
import { SkillApi } from "./routes/skills/controller.ts";
import { ScriptImageApi } from "./routes/script-images/controller.ts";
import { TraceApi } from "./routes/tracing/controller.ts";
import { AgentApi } from "./routes/agents/controller.ts";
import { ProviderApi } from "./routes/providers/controller.ts";
import { WorkflowApi } from "./routes/workflows/controller.ts";
import { DiscoverApi } from "./routes/discover/controller.ts";
import { TemplateApi } from "./routes/templates/controller.ts";
import { TriggerApi } from "./routes/triggers/controller.ts";
import { ProjectApi } from "./routes/projects/controller.ts";
import { EnvironmentApi } from "./routes/environments/controller.ts";
import { CaptchaApi } from "./routes/captcha/controller.ts";
import { EnvKeyApi } from "./routes/env-keys/controller.ts";
import { EnvTemplateApi } from "./routes/env-templates/controller.ts";
import { SecretApi } from "./routes/secrets/controller.ts";
import { ApiKeyApi } from "./routes/api-keys/controller.ts";
import { JobApi } from "./routes/jobs/controller.ts";
import { SandboxLimitsApi } from "./routes/sandbox-limits/controller.ts";
import { ScopeApi } from "./routes/scopes/controller.ts";
import { QuotaApi } from "./routes/quota/controller.ts";
import { LibraryApi } from "./routes/library/controller.ts";
import { RunApi } from "./routes/runs/controller.ts";
import { UsageApi } from "./routes/usage/controller.ts";
import { BannerApi } from "./routes/banner/controller.ts";
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

type ModelChange = { modelConfigId: string };
type PromptChange = { promptId: string };



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
    let wrong = configProblem(this.db, body);
    if (wrong != "") { return badRequest(wrong); }
    let written = persist(this.db, modelConfigsMapping(this.db), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, modelConfigsMapping(this.db), jsonId(req.body)));
  }

  @put("/:id")
  update(req: Request): Reply {
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


export function mergedConfig(stored: ModelConfigRow, body: string): ModelConfigRow {
  let out: ModelConfigRow = {
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

export function blankRouter(id: string): ModelRouterRow {
  let out: ModelRouterRow = {
    id: id, label: "", routerConfigId: "", candidatesJson: "[]",
    fallbackConfigId: "", routeEvery: "turn", escalateOnly: false, enabled: true,
  };
  return out;
}

export function bodyCandidates(body: string, fallback: string): string {
  let raw = jsonMember(body, "candidates");
  if (raw == "") { return fallback; }
  return raw;
}

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

export function routerRowProblem(db: Db, row: ModelRouterRow): string {
  if (row.label == "") { return "a router needs a label"; }
  if (row.routeEvery != "turn" && row.routeEvery != "thread") {
    return "routeEvery is \"turn\" or \"thread\", not \"" + row.routeEvery + "\"";
  }
  let routing = chatConfigProblem(db, row.routerConfigId, "routerConfigId");
  if (routing != "") { return routing; }
  let landing = chatConfigProblem(db, row.fallbackConfigId, "fallbackConfigId");
  if (landing != "") { return landing; }
  if (!row.enabled) { return ""; }
  return candidatesProblem(db, row.candidatesJson);
}

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

function candidateArray(candidatesJson: string): string {
  let text = candidatesJson.trim();
  if (text.startsWith("[")) { return text; }
  return "[]";
}

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





export function choiceWasSent(body: string): bool {
  if (body == "") { return false; }
  return jsonFind(body, "modelChoiceId") >= 0;
}

export function askedPick(body: string): ModelPick {
  let pick: ModelPick = { choiceId: askedChoice(body), sent: choiceWasSent(body) };
  return pick;
}


@controller("/threads")
class ThreadApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

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

  @put("/:id/replayable")
  offer(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required: {\"replayable\":true}"); }
    let on = jsonRaw(req.body, "replayable") == "true";
    let wrong = markReplayable(this.db, param(req, "id"), on);
    if (wrong != "") { return badRequest(wrong); }
    return ok("{\"id\":" + JSON.stringify(param(req, "id"))
      + ",\"replayable\":" + (on ? "true" : "false") + "}");
  }

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

    let chosen = askedChoice(req.body);
    if (chosen != "" && choiceProblem(this.db, chosen) == "") {
      if (rememberChoice(this.db, id, chosen) != "") { chosen = ""; }
    } else {
      chosen = "";
    }

    let feed = feedById(this.db, story.feedId);
    let seed = [userTurn(asArticleContext(story, feed.topic))];
    let wrote = appendTurns(this.db, id, seed, 0);
    if (wrote != "") { return badRequest("the article could not be attached: " + wrote); }

    nameThread(this.db, id, story.headline);

    return created("{\"id\":" + JSON.stringify(id)
      + ",\"agentId\":" + JSON.stringify(agentId)
      + ",\"modelChoiceId\":" + JSON.stringify(chosen)
      + ",\"title\":" + JSON.stringify(story.headline) + "}");
  }

  @post("/")
  open(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required: {\"agentId\":\"a1\"}"); }
    let agentId = jsonText(req.body, "agentId");
    if (agentId == "") { return badRequest("a body is required: {\"agentId\":\"a1\"}"); }
    if (!existsById(this.db, agentsMapping(), agentId)) {
      return badRequest("no agent " + agentId);
    }
    let chosen = askedChoice(req.body);
    let refused = choiceProblem(this.db, chosen);
    if (refused != "") { return badRequest(refused); }
    let id = openThread(this.db, { agentId: agentId, owner: owningTag(callerTags(req)), now: stamp() });
    if (id == "") { return badRequest("the thread could not be opened"); }

    let kept = chosen;
    if (chosen != "") {
      if (rememberChoice(this.db, id, chosen) != "") { kept = ""; }
    }
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
    let partialText = "";
    if (asked != "all") { partialText = partialOf(this.db, param(req, "id"), round); }
    return ok("{\"seq\":" + `${round}`
      + ",\"running\":" + boolJson(roundRunning(live))
      + ",\"partial\":" + JSON.stringify(partialText)
      + ",\"thoughts\":" + thoughtsJson(thoughts)
      + ",\"steps\":" + stepsJson(live) + "}");
  }

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
    clearCancel(this.db, param(req, "id"));
    if (req.body == "") { return badRequest("a body is required: {\"text\":\"...\"}"); }
    let text = jsonText(req.body, "text");
    if (text == "") { return badRequest("nothing to ask: \"text\" is empty"); }

    let pick = askedPick(req.body);
    let noSuchChoice = choiceProblem(this.db, pick.choiceId);
    if (noSuchChoice != "") { return badRequest(noSuchChoice); }

    if (pick.choiceId != "") {
      let pickedRow = findById(this.db, modelChoicesMapping(), pick.choiceId);
      if (pickedRow != "") {
        let picked: ModelChoiceRow = JSON.parse<ModelChoiceRow>(pickedRow);
        if (picked.tier == "premium") {
          return badRequest(picked.label + " is coming soon — it is announced, not offered yet");
        }
      }
    }

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

    let tracer = tracerWithSession(
      tracerFor(this.db, this.master), param(req, "id"), owningTag(callerTags(req)));
    let answered = runInThreadWith(this.db, param(req, "id"), {
      userText: text, master: this.master, tracer: tracer, pick: pick,
      think: jsonText(req.body, "think") == "true",
      scope: jsonText(req.body, "scope"),
    });
    let run = answered.run;
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
    let guestLeft = "";
    if (guest != "") {
      let left = GUEST_DAILY_RUNS - runsSince(this.db, guest, utcDayStartText(Date.now()));
      if (left < 0) { left = 0; }
      guestLeft = ",\"guestRemaining\":" + `${left}`;
    }

    let view = wireView(answered.text);
    return ok("{\"runId\":" + JSON.stringify(runId)
      + ",\"ok\":" + `${run.ok}`
      + ",\"text\":" + JSON.stringify(view.text)
      + ",\"refs\":" + refsJson(view.refs)
      + ",\"seq\":" + `${answered.baseSeq}`
      + ",\"modelChoiceId\":" + JSON.stringify(answered.modelChoiceId)
      + ",\"routeNote\":" + JSON.stringify(answered.routeNote)
      + ",\"toolCalls\":" + `${run.steps.length}`
      + ",\"steps\":" + stepsJson(stepsOfRound(this.db, param(req, "id"), answered.baseSeq))
      + ",\"thoughts\":" + thoughtsJson(thoughtsOfRound(this.db, param(req, "id"), answered.baseSeq))
      + ",\"inputTokens\":" + `${run.inputTokens}`
      + ",\"outputTokens\":" + `${run.outputTokens}`
      + ",\"traceId\":" + JSON.stringify(traced)
      + ",\"error\":" + JSON.stringify(run.error) + guestLeft + "}");
  }

  @get("/:id")
  transcript(req: Request): Reply {
    if (readableThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let mine = ownedThread(this.db, param(req, "id"), callerTags(req)) != "";
    let said: ThreadTurnRow[] = threadMessageRows(this.db, param(req, "id"));
    let out = "[";
    let i: int = 0;
    while (i < said.length) {
      if (i > 0) { out = out + ","; }
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





function injectSource(manifest: string, url: string, rendererUrl: string, rendererSource: string): string {
  let trimmed = manifest.trim();
  if (!trimmed.startsWith("{")) { return trimmed; }
  return "{\"sourceUrl\":" + JSON.stringify(url)
    + ",\"rendererUrl\":" + JSON.stringify(rendererUrl)
    + ",\"rendererSource\":" + JSON.stringify(rendererSource)
    + "," + trimmed.slice(1);
}

function resolveAgainst(base: string, ref: string): string {
  if (ref.startsWith("https://") || ref.startsWith("http://")) { return ref; }
  let cut = base.lastIndexOf("/");
  if (cut < 0) { return ref; }
  let dir = base.slice(0, cut);
  if (ref.startsWith("./")) { return dir + ref.slice(1); }
  return dir + "/" + ref;
}



export function bearerRefused(configured: string, target: string, authorization: string): bool {
  if (configured == "") { return false; }
  if (publicPath(target)) { return false; }
  return presentedToken(authorization) != configured;
}

function publicPath(target: string): bool {
  let path = target;
  let query = path.indexOf("?");
  if (query >= 0) { path = path.substring(0, query); }
  while (path.length > 1 && path.endsWith("/")) { path = path.substring(0, path.length - 1); }
  if (path == "/healthz") { return true; }
  if (path == "/v1") { return true; }
  if (path.length >= 4 && path.substring(0, 4) == "/v1/") { return true; }
  return false;
}

function presentedToken(authorization: string): string {
  let prefix = "Bearer ";
  if (authorization.length <= prefix.length) { return ""; }
  if (authorization.substring(0, prefix.length).toLowerCase() != prefix.toLowerCase()) { return ""; }
  return authorization.substring(prefix.length, authorization.length).trim();
}

function apiToken(): string {
  return (process.env("AGENTS_API_TOKEN") ?? "").trim();
}




function thoughtsJson(thoughts: Thought[]): string {
  let out = "[";
  let i: int = 0;
  while (i < thoughts.length) {
    if (i > 0) { out = out + ","; }
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


function digestLoop(master: string, everyMs: int): int {
  try {
    let db = openDatabase();
    while (true) {
      let feeds = allFeeds(db);
      let i: int = 0;
      while (i < feeds.length) {
        if (feeds[i].enabled) {
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
    console.error("discover: the digest pass stopped");
  }
  return 0;
}

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
    let every = idleMs > 0 ? idleMs : ENV_IDLE_MS;
    while (true) {
      if (idleMs > 0) {
        try { sweepEmptyThreads(db, `${Date.now() - idleMs}`); }
        catch (e) { console.error("thread sweep: " + e.message); }
      }
      try { sweepIdleEnvironments(db); }
      catch (e) { console.error("environment sweep: " + e.message); }
      process.sleep(every);
    }
  } catch (e) {
    console.error("thread sweep: no connection of its own — " + e.message);
  }
  return 0;
}

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

export function migrationProblem(db: Db): string {
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
  let cards = toolCardsPlan(db);
  let tc: int = 0;
  while (tc < cards.length) { knowledge.push(cards[tc]); tc = tc + 1; }
  let discover = discoverPlan(db);
  let dc: int = 0;
  while (dc < discover.length) { knowledge.push(discover[dc]); dc = dc + 1; }
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
  let live = stepPlan(db);
  let lv: int = 0;
  while (lv < live.length) { plan.push(live[lv]); lv = lv + 1; }
  let envs = envPlan(db);
  let ev: int = 0;
  while (ev < envs.length) { plan.push(envs[ev]); ev = ev + 1; }
  let scheduled = tasksPlan(db);
  let st: int = 0;
  while (st < scheduled.length) { plan.push(scheduled[st]); st = st + 1; }
  let flows = workflowsPlan(db);
  let fl: int = 0;
  while (fl < flows.length) { plan.push(flows[fl]); fl = fl + 1; }
  let grouped = projectsPlan(db);
  let pj: int = 0;
  while (pj < grouped.length) { plan.push(grouped[pj]); pj = pj + 1; }
  let originals = documentFilesPlan(db);
  let df: int = 0;
  while (df < originals.length) { plan.push(originals[df]); df = df + 1; }
  let arriving = triggersPlan(db);
  let tg: int = 0;
  while (tg < arriving.length) { plan.push(arriving[tg]); tg = tg + 1; }
  let sealed = secretsPlan(db);
  let sk: int = 0;
  while (sk < sealed.length) { plan.push(sealed[sk]); sk = sk + 1; }
  let vars = envKeysPlan(db);
  let ek: int = 0;
  while (ek < vars.length) { plan.push(vars[ek]); ek = ek + 1; }
  let uenv = userEnvsPlan(db);
  let ue: int = 0;
  while (ue < uenv.length) { plan.push(uenv[ue]); ue = ue + 1; }
  let tmpl = envTemplatesPlan(db);
  let tp: int = 0;
  while (tp < tmpl.length) { plan.push(tmpl[tp]); tp = tp + 1; }
  let roster = mcpRosterPlan(db);
  let ro: int = 0;
  while (ro < roster.length) { plan.push(roster[ro]); ro = ro + 1; }
  let keys = apiKeysPlan(db);
  let kp: int = 0;
  while (kp < keys.length) { plan.push(keys[kp]); kp = kp + 1; }
  let ran = migrate(db, plan);
  if (ran.ok) {
    applySandboxLimits(db);
    seedEnvTemplates(db);
    return "";
  }
  if (ran.failedVersion != "") {
    return "the schema is not up to date: migration " + ran.failedVersion + " did not run — " + ran.error;
  }
  return "the schema is not up to date: " + ran.error;
}


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
    console.error(keyProblem);
    return;
  }

  let sweepIdle = sweepIdleMs(process.env("AGENTS_SWEEP_IDLE_MS") ?? "");
  if (sweepIdle > 0) {
    console.log(`sweeping threads that have been empty for ${sweepIdle}ms`);
  }
  console.log(`stopping environments idle for ${ENV_IDLE_MS}ms`);
  Worker.run(() => sweepLoop(sweepIdle));
  let discoverEvery = discoverEveryMs();
  if (discoverEvery > 0) { Worker.run(() => digestLoop(master, discoverEvery)); }

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

function listenLocked(port: int, mounts: Mount[], token: string): string {
  let problemText = mountProblem(mounts);
  if (problemText != "") { return problemText; }

  http.createServer(port, (req): HttpResponse => {
    if (bearerRefused(token, req.path, req.headers.get("authorization") ?? "")) {
      let shut = reply(401, "{\"error\":\"a bearer token is required\"}", "application/json");
      shut.headers.set("www-authenticate", "Bearer");
      let refused: HttpResponse = { status: shut.status, body: shut.body, ok: true, headers: shut.headers };
      return refused;
    }
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
