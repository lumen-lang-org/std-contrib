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
import { stamp, callerTags, GUEST_DAILY_RUNS, guestTag, guestQuotaJson, bodyText, bodyJson, bodyBool, bodyInt, bodyNumber, bodyRank, askedChoice, boolJson, choiceProblem, forwardProduct, toolCardProblem } from "./api-core.ts";
import { HealthApi } from "./healthz-routes.ts";
import { CardPluginApi } from "./card-plugins-routes.ts";
import { ToolCardApi } from "./tool-cards-routes.ts";
import { McpServerApi } from "./mcp-server-routes.ts";
import { PlaygroundApi } from "./playground-routes.ts";
import { V1Api } from "./v1-routes.ts";
import { TaskApi } from "./tasks-routes.ts";
import { DocumentApi } from "./documents-routes.ts";
import { PreviewApi } from "./preview-routes.ts";
import { ArtifactApi } from "./threads-artifacts-routes.ts";
import { WorkspaceApi } from "./threads-files-routes.ts";
import { ConnectApi } from "./connect-routes.ts";
import { ServerApi } from "./servers-routes.ts";
import { AuthProviderApi } from "./auth-providers-routes.ts";
import { PluginApi } from "./plugins-routes.ts";
import { PromptApi } from "./prompts-routes.ts";
import { ModelApi } from "./models-routes.ts";
import { SkillApi } from "./skills-routes.ts";
import { ScriptImageApi } from "./script-images-routes.ts";
import { TraceApi } from "./tracing-routes.ts";
import { AgentApi } from "./agents-routes.ts";
import { ProviderApi } from "./providers-routes.ts";
import { WorkflowApi } from "./workflows-routes.ts";
import { DiscoverApi } from "./discover-routes.ts";
import { TemplateApi } from "./templates-routes.ts";
import { TriggerApi } from "./triggers-routes.ts";
import { ProjectApi } from "./projects-routes.ts";
import { EnvironmentApi } from "./environments-routes.ts";
import { CaptchaApi } from "./captcha-routes.ts";
import { EnvKeyApi } from "./env-keys-routes.ts";
import { EnvTemplateApi } from "./env-templates-routes.ts";
import { SecretApi } from "./secrets-routes.ts";
import { ApiKeyApi } from "./api-keys-routes.ts";
import { JobApi } from "./jobs-routes.ts";
import { SandboxLimitsApi } from "./sandbox-limits-routes.ts";
import { ScopeApi } from "./scopes-routes.ts";
import { QuotaApi } from "./quota-routes.ts";
import { LibraryApi } from "./library-routes.ts";
import { RunApi } from "./runs-routes.ts";
import { UsageApi } from "./usage-routes.ts";
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

// Who is calling, as far as this process is willing to know — an empty list
// unless a trusted proxy said otherwise, which is every deployment that has
// not turned the gate on. owner.ts holds the whole of the contract; this is
// the only line that reads it off a request, so that "did this route scope?"
// is a question about one call and not about a header check copied sixteen
// times.


// The catalog: models, model configs, prompts and MCP servers, over HTTP.
// This is the rest of "no code": with these, an agent is assembled entirely
// by API calls, and nothing was ever written in a file.
//
// One class per table would repeat the same four methods with different
// mappings; one class with the table in the path would put plume mappings
// behind a string. Four small classes, sharing shape but not machinery, is
// the least clever thing that works.


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


/* Ways of signing in that are not a password.
 *
 * The console's own auth reads this list at sign-in time and builds its
 * providers from it, so adding Google is a row and a secret rather than a
 * deploy. The secret is never returned by any route here — `configured` is
 * the only thing that can be known about it afterwards, exactly as with a
 * provider key or a connector token.
 */


/* Signing in to a connector.
 *
 * Its own controller, and not two more routes on /servers, because the
 * callback cannot live under /servers/:id: the browser comes back to a fixed
 * address that was registered with the authorization server months earlier,
 * and "fixed" rules out anything with an id in it. The server is identified by
 * the `state` instead, which is the one thing that makes the round trip.
 */


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

/** Every family a caller with no conversation can use. */

/** One call, tried against each family — the run loop's dispatch, minus the
 *  thread-bound families an MCP caller cannot hold. */


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

/** A JSON array member, or "[]" when the body omits it — an install carrying
 *  only cards is as valid as one carrying only cases. */


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


// --- a secret's destination --------------------------------------------------
//
// See credentials.ts for why these exist. Three routes name a secret and a
// destination in the same row, and only the secret is write-only; these are
// the three, asked the same question in the same words.


// --- forgetting a row, and everything hung off it ----------------------------


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
