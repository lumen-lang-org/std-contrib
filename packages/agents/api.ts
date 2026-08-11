import { apiKeysPlan } from "./api-keys.ts";
import { bindings, controller } from "../rest/controller.ts";
import { Request, Reply, Mount, mountedRoutes, mountFault, dispatchedMounted, Respond, Ok, Created, OkJson, CreatedJson, NoContent, NotFound, BadRequest, Refused } from "../rest/server.ts";
import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { postgres } from "../plume/postgres.ts";
import { DbOrder, placeholderAt, connectDatabase, persist, findById, listOrdered, existsById, deleteById, execute, countWhere, jsonMember } from "../plume/plume.ts";
import { migrate } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, ModelChoiceRow, ModelRouterRow, PromptRow, McpServerRow, AgentRow, modelsMapping, modelConfigsMapping, modelConfigRows, configAndModel, modelChoicesMapping, modelRoutersMapping, promptsMapping, mcpServersMapping, agentsMapping, schemaPlan, derivedMenuStatements, askCancel, clearCancel } from "./schema.ts";
import { masterKey, masterKeyFault } from "./credentials.ts";
import { AgentRun } from "./run.ts";
import { userTurn } from "./provider.ts";
import { runLogPlan, recordRun } from "./runlog.ts";
import { tracePlan, tracerFor } from "./trace.ts";
import { jsonId, createFault } from "./payload.ts";
import { jsonList, jsonText, jsonFind, jsonRaw } from "./scan.ts";
import { stamp, callerTags, GUEST_DAILY_RUNS, guestTag, guestQuotaJson, bodyText, bodyJson, bodyBool, bodyInt, bodyNumber, bodyRank, askedChoice, choiceFault } from "./api-core.ts";
import { CardPluginApi } from "./routes/card-plugins/card-plugin.controller.ts";
import { ToolCardApi } from "./routes/tool-cards/tool-card.controller.ts";
import { McpServerApi } from "./routes/mcp-server/mcp-server.controller.ts";
import { PlaygroundApi } from "./routes/playground/playground.controller.ts";
import { V1Api } from "./routes/v1/v1.controller.ts";
import { TaskApi } from "./routes/tasks/task.controller.ts";
import { DocumentApi } from "./routes/documents/document.controller.ts";
import { PreviewApi } from "./routes/preview/preview.controller.ts";
import { ArtifactApi } from "./routes/threads-artifacts/artifact.controller.ts";
import { WorkspaceApi } from "./routes/threads-files/file.controller.ts";
import { ConnectApi } from "./routes/connect/connect.controller.ts";
import { ServerApi } from "./routes/servers/server.controller.ts";
import { AuthProviderApi } from "./routes/auth-providers/auth-provider.controller.ts";
import { PluginApi } from "./routes/plugins/plugin.controller.ts";
import { PromptApi } from "./routes/prompts/prompt.controller.ts";
import { ModelApi } from "./routes/models/model.controller.ts";
import { SkillApi } from "./routes/skills/skill.controller.ts";
import { ScriptImageApi } from "./routes/script-images/script-image.controller.ts";
import { TraceApi } from "./routes/tracing/trace.controller.ts";
import { AgentApi } from "./routes/agents/agent.controller.ts";
import { ProviderApi } from "./routes/providers/provider.controller.ts";
import { WorkflowApi } from "./routes/workflows/workflow.controller.ts";
import { DiscoverApi } from "./routes/discover/discover.controller.ts";
import { TemplateApi } from "./routes/templates/template.controller.ts";
import { TriggerApi } from "./routes/triggers/trigger.controller.ts";
import { ProjectApi } from "./routes/projects/project.controller.ts";
import { EnvironmentApi } from "./routes/environments/environment.controller.ts";
import { CaptchaApi } from "./routes/captcha/captcha.controller.ts";
import { EnvKeyApi } from "./routes/env-keys/env-key.controller.ts";
import { EnvTemplateApi } from "./routes/env-templates/env-template.controller.ts";
import { SecretApi } from "./routes/secrets/secret.controller.ts";
import { ApiKeyApi } from "./routes/api-keys/api-key.controller.ts";
import { JobApi } from "./routes/jobs/job.controller.ts";
import { SandboxLimitsApi } from "./routes/sandbox-limits/sandbox-limits.controller.ts";
import { ScopeApi } from "./routes/scopes/scope.controller.ts";
import { QuotaApi } from "./routes/quota/controller.ts";
import { LibraryApi } from "./routes/library/library.controller.ts";
import { RunApi } from "./routes/runs/run.controller.ts";
import { UsageApi } from "./routes/usage/usage.controller.ts";
import { BannerApi } from "./routes/banner/banner.controller.ts";
import { HealthApi } from "./routes/healthz/health.controller.ts";
import { mcpRosterPlan } from "./mcp-roster.ts";
import { ModelPick, ThreadTurnRow, threadsMapping, listThreads, openThread, ownedThread, threadOwner, threadChoice, threadTitle, rememberChoice, sweepEmptyThreads, sweepIdleMs, threadMessageRows, runInThreadWith, threadPlan, listReplayable, markReplayable, remixThread, readableThread, appendTurns, nameThread } from "./threads.ts";
import { trustsProxyAuth, identityUnreadable, owningTag, holdsOwner } from "./owner.ts";
import { runsSince, utcDayStartText, secondsToUtcMidnight, nextUtcMidnightIso } from "./usage.ts";
import { workspacePlan } from "./workspace.ts";
import { TURN_SEQ_NONE, artifactPlan } from "./artifacts.ts";
import { stepPlan, stepsOfRound, stepsOfThread, roundRunning, latestRound, stepMillis, thoughtsOfRound, thoughtsOfThread, LiveStep, Thought, partialOf } from "./steps.ts";
import { EnvSweep, ENV_IDLE_MS, envPlan, envIdle } from "./environments.ts";
import { WireRef, wireView } from "./artifacts-fence.ts";
import { indexingPlan } from "./indexing.ts";
import { knowledgePlan } from "./knowledge.ts";
import { webRagPlan } from "./webrag.ts";
import { toolCardsPlan } from "./toolcards.ts";
import { allFeeds, asArticleContext, discoverPlan, feedById, refreshFeed, storyById } from "./discover.ts";
import { cardPluginsPlan } from "./plugincards.ts";
import { tasksPlan } from "./tasks.ts";
import { workflowsPlan } from "./workflow-store.ts";
import { triggersPlan } from "./triggers.ts";
import { secretsPlan } from "./secrets.ts";
import { envKeysPlan } from "./env-keys.ts";
import { userEnvsPlan } from "./user-environments.ts";
import { applySandboxLimits } from "./sandbox-limits.ts";
import { EnvTemplateWrite, envTemplatesMapping, envTemplatesPlan, saveEnvTemplate } from "./env-templates.ts";
import { assignProject, projectsMapping, projectsPlan } from "./projects.ts";
import { documentFilesPlan } from "./document-files.ts";
import { flush, traceId, tracing, tracerWithMoreSpans, tracerWithSession } from "../tracing/tracing.ts";

type ModelChange = { modelConfigId: string };
type PromptChange = { promptId: string };



@controller("/model-configs")
@bindings
class ConfigApi {
  db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  list(): Reply {
    let keys: DbOrder[] = [{ column: "id" }];
    return Ok(listOrdered(this.db, modelConfigsMapping(this.db), { order: keys }));
  }

  @Post("/")
  create(req: Request): Reply {
    let fault = createFault(this.db, modelConfigsMapping(this.db), req.body);
    if (fault != "") {
      return BadRequest(fault);
    }
    let body: ModelConfigRow = JSON.parse<ModelConfigRow>(req.body);
    let wrong = configFault(this.db, body);
    if (wrong != "") {
      return BadRequest(wrong);
    }
    let written = persist(this.db, modelConfigsMapping(this.db), req.body);
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, modelConfigsMapping(this.db), jsonId(req.body)));
  }

  @Put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    let stored = findById(this.db, modelConfigRows(this.db), id);
    if (stored == "") {
      return NotFound("model config " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    if (bodyText(req.body, "id", id) != id) {
      return BadRequest("the id in the body must match the path");
    }
    let row = mergedConfig(JSON.parse<ModelConfigRow>(stored), req.body);
    let wrong = configFault(this.db, row);
    if (wrong != "") {
      return BadRequest(wrong);
    }
    let written = persist(this.db, modelConfigsMapping(this.db), JSON.stringify(row));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(findById(this.db, modelConfigsMapping(this.db), id));
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, modelConfigsMapping(this.db), id)) {
      return NotFound("model config " + id);
    }
    let used = configInUse(this.db, id);
    if (used != "") {
      return BadRequest(used);
    }
    deleteById(this.db, modelConfigsMapping(this.db), id);
    return NoContent();
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

export function configFault(db: Db, row: ModelConfigRow): string {
  if (row.modelId == "") {
    return "a modelId is required";
  }
  if (!existsById(db, modelsMapping(), row.modelId)) {
    return "no model " + row.modelId + "; create it first";
  }
  if (row.maxTokens < 1) {
    return "maxTokens must be at least 1; a config that asks for no tokens cannot answer";
  }
  if (row.rank < 0) {
    return "menuRank cannot be negative";
  }
  return "";
}

export function chatConfigFault(db: Db, configId: string, role: string): string {
  if (configId == "") {
    return role + " is required";
  }
  let pair = configAndModel(db, configId);
  if (pair.fault != "") {
    return role + ": " + pair.fault;
  }
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

export function choiceRowFault(db: Db, row: ModelChoiceRow): string {
  if (row.label == "") {
    return "a choice needs a label; it is the word in the menu";
  }
  if (row.tier != "" && row.tier != "premium") {
    return "tier is \"\" or \"premium\", not \"" + row.tier + "\"";
  }
  if (row.rank < 0) {
    return "menuRank cannot be negative";
  }
  if (row.kind == "config") {
    if (row.routerId != "") {
      return "a \"config\" choice carries no routerId; clear it, or set kind to \"router\"";
    }
    return chatConfigFault(db, row.configId, "configId");
  }
  if (row.kind == "router") {
    if (row.configId != "") {
      return "a \"router\" choice carries no configId; clear it, or set kind to \"config\"";
    }
    if (row.routerId == "") {
      return "routerId is required";
    }
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
@bindings
class ChoiceApi {
  db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  list(): Reply {
    let keys: DbOrder[] = [{ column: "menu_rank" }, { column: "label" }];
    return Ok(listOrdered(this.db, modelChoicesMapping(), { order: keys }));
  }

  @Post("/")
  create(req: Request): Reply {
    let fault = createFault(this.db, modelChoicesMapping(), req.body);
    if (fault != "") {
      return BadRequest(fault);
    }
    let row = mergedChoice(blankChoice(jsonId(req.body)), req.body);
    let wrong = choiceRowFault(this.db, row);
    if (wrong != "") {
      return BadRequest(wrong);
    }
    let written = persist(this.db, modelChoicesMapping(), JSON.stringify(row));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, modelChoicesMapping(), row.id));
  }

  @Put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    let stored = findById(this.db, modelChoicesMapping(), id);
    if (stored == "") {
      return NotFound("model choice " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    if (bodyText(req.body, "id", id) != id) {
      return BadRequest("the id in the body must match the path");
    }
    let row = mergedChoice(JSON.parse<ModelChoiceRow>(stored), req.body);
    let wrong = choiceRowFault(this.db, row);
    if (wrong != "") {
      return BadRequest(wrong);
    }
    let written = persist(this.db, modelChoicesMapping(), JSON.stringify(row));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(findById(this.db, modelChoicesMapping(), id));
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, modelChoicesMapping(), id)) {
      return NotFound("model choice " + id);
    }
    let used = choiceInUse(this.db, id);
    if (used != "") {
      return BadRequest(used);
    }
    deleteById(this.db, modelChoicesMapping(), id);
    return NoContent();
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
  if (raw == "") {
    return fallback;
  }
  return raw;
}

export function preEncodedCandidates(body: string): string {
  if (jsonMember(body, "candidatesJson") == "") {
    return "";
  }
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

export function candidatesFault(db: Db, candidatesJson: string): string {
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
    if (!item.startsWith("{")) {
      return at + " is not an object";
    }
    let key = jsonText(item, "key").trim();
    if (key == "") {
      return at + " has no \"key\"";
    }
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
    let unusable = chatConfigFault(db, jsonText(item, "configId").trim(), named + " configId");
    if (unusable != "") {
      return unusable;
    }
    i = i + 1;
  }
  return "";
}

export function routerRowFault(db: Db, row: ModelRouterRow): string {
  if (row.label == "") {
    return "a router needs a label";
  }
  if (row.routeEvery != "turn" && row.routeEvery != "thread") {
    return "routeEvery is \"turn\" or \"thread\", not \"" + row.routeEvery + "\"";
  }
  let routing = chatConfigFault(db, row.routerConfigId, "routerConfigId");
  if (routing != "") {
    return routing;
  }
  let landing = chatConfigFault(db, row.fallbackConfigId, "fallbackConfigId");
  if (landing != "") {
    return landing;
  }
  if (!row.enabled) {
    return "";
  }
  return candidatesFault(db, row.candidatesJson);
}

type CandidateView = {
  key: string,
  configId: string,
  when: string,
};

function candidateView(item: string): CandidateView {
  let out: CandidateView = {
    key: jsonText(item, "key").trim(),
    configId: jsonText(item, "configId").trim(),
    when: jsonText(item, "when").trim(),
  };
  return out;
}

export function withCanonicalCandidates(row: ModelRouterRow): ModelRouterRow {
  let items = jsonList(row.candidatesJson.trim());
  let out: ModelRouterRow = {
    id: row.id, label: row.label, routerConfigId: row.routerConfigId,
    candidatesJson: JSON.stringify(items.map(candidateView)), fallbackConfigId: row.fallbackConfigId,
    routeEvery: row.routeEvery, escalateOnly: row.escalateOnly, enabled: row.enabled,
  };
  return out;
}

function candidateArray(candidatesJson: string): string {
  let text = candidatesJson.trim();
  if (text.startsWith("[")) {
    return text;
  }
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
    if (i > 0) {
      out = out + ",";
    }
    out = out + routerJson(rows[i]);
    i = i + 1;
  }
  return out + "]";
}

export function allRouters(db: Db): ModelRouterRow[] {
  let none: ModelRouterRow[] = [];
  let keys: DbOrder[] = [{ column: "label" }, { column: "id" }];
  let listed = listOrdered(db, modelRoutersMapping(), { order: keys });
  if (listed == "" || listed == "[]") {
    return none;
  }
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
@bindings
class RouterApi {
  db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  list(): Reply {
    return Ok(routersJson(allRouters(this.db)));
  }

  @Get("/:id")
  find(@PathVariable("id") id: string): Reply {
    let document = findById(this.db, modelRoutersMapping(), id);
    if (document == "") {
      return NotFound("model router " + id);
    }
    return Ok(routerJson(JSON.parse<ModelRouterRow>(document)));
  }

  @Post("/")
  create(req: Request): Reply {
    let fault = createFault(this.db, modelRoutersMapping(), req.body);
    if (fault != "") {
      return BadRequest(fault);
    }
    let blob = preEncodedCandidates(req.body);
    if (blob != "") {
      return BadRequest(blob);
    }
    let row = mergedRouter(blankRouter(jsonId(req.body)), req.body);
    let wrong = routerRowFault(this.db, row);
    if (wrong != "") {
      return BadRequest(wrong);
    }
    let written = persist(this.db, modelRoutersMapping(), JSON.stringify(withCanonicalCandidates(row)));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(routerJson(JSON.parse<ModelRouterRow>(findById(this.db, modelRoutersMapping(), row.id))));
  }

  @Put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    let stored = findById(this.db, modelRoutersMapping(), id);
    if (stored == "") {
      return NotFound("model router " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    if (bodyText(req.body, "id", id) != id) {
      return BadRequest("the id in the body must match the path");
    }
    let blob = preEncodedCandidates(req.body);
    if (blob != "") {
      return BadRequest(blob);
    }
    let row = mergedRouter(JSON.parse<ModelRouterRow>(stored), req.body);
    let wrong = routerRowFault(this.db, row);
    if (wrong != "") {
      return BadRequest(wrong);
    }
    let written = persist(this.db, modelRoutersMapping(), JSON.stringify(withCanonicalCandidates(row)));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(routerJson(JSON.parse<ModelRouterRow>(findById(this.db, modelRoutersMapping(), id))));
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, modelRoutersMapping(), id)) {
      return NotFound("model router " + id);
    }
    let used = routerInUse(this.db, id);
    if (used != "") {
      return BadRequest(used);
    }
    deleteById(this.db, modelRoutersMapping(), id);
    return NoContent();
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
  if (body == "") {
    return false;
  }
  return jsonFind(body, "modelChoiceId") >= 0;
}

export function askedPick(body: string): ModelPick {
  let pick: ModelPick = { choiceId: askedChoice(body), sent: choiceWasSent(body) };
  return pick;
}


type ReplayableThreadView = {
  id: string,
  agentId: string,
  createdAt: string,
  title: string,
  replayable: bool,
};

type ReplayableSetView = {
  id: string,
  replayable: bool,
};

type RemixedView = {
  id: string,
  files: int,
};

type ThreadRowView = {
  id: string,
  agentId: string,
  createdAt: string,
  title: string,
  replayable: bool,
  projectId: string,
};

type ThreadFromStoryView = {
  id: string,
  agentId: string,
  modelChoiceId: string,
  title: string,
};

type ThreadOpenedView = {
  id: string,
  agentId: string,
  modelChoiceId: string,
  projectId: string,
};

type ThoughtView = {
  seq: int,
  rotation: int,
  depth: int,
  text: string,
};

type StepView = {
  seq: int,
  depth: int,
  rotation: int,
  idx: int,
  kind: string,
  name: string,
  target: string,
  args: string,
  running: bool,
  ok: bool,
  millis: int,
  result: string,
};

type RoundView = {
  seq: int,
  running: bool,
  partial: string,
  thoughts: ThoughtView[],
  steps: StepView[],
};

type CancelAskedView = {
  asked: bool,
};

type RefView = {
  slot: int,
  version: int,
  path: string,
};

type AnsweredView = {
  runId: string,
  ok: bool,
  text: string,
  refs: RefView[],
  seq: int,
  modelChoiceId: string,
  routeNote: string,
  toolCalls: int,
  steps: StepView[],
  thoughts: ThoughtView[],
  inputTokens: int,
  outputTokens: int,
  traceId: string,
  error: string,
};

type GuestAnsweredView = {
  runId: string,
  ok: bool,
  text: string,
  refs: RefView[],
  seq: int,
  modelChoiceId: string,
  routeNote: string,
  toolCalls: int,
  steps: StepView[],
  thoughts: ThoughtView[],
  inputTokens: int,
  outputTokens: int,
  traceId: string,
  error: string,
  guestRemaining: int,
};

type MessageView = {
  role: string,
  seq: int,
  text: string,
  refs: RefView[],
};

type TranscriptView = {
  modelChoiceId: string,
  title: string,
  mine: bool,
  messages: MessageView[],
};

@controller("/threads")
@bindings
class ThreadApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @Get("/replayable")
  replayable(@RequestParam("limit", "50") asked: string): Reply {
    let limit = parseInt(asked) ?? 50;
    let rows = listReplayable(this.db, limit);
    let out: ReplayableThreadView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let one: ReplayableThreadView = {
        id: rows[i].id, agentId: rows[i].agentId, createdAt: rows[i].createdAt,
        title: rows[i].title, replayable: true,
      };
      out.push(one);
      i = i + 1;
    }
    return OkJson(out);
  }

  @Put("/:id/replayable")
  offer(req: Request, @PathVariable("id") id: string): Reply {
    if (ownedThread(this.db, id, callerTags(req)) == "") {
      return NotFound("thread " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required: {\"replayable\":true}");
    }
    let on = jsonRaw(req.body, "replayable") == "true";
    let wrong = markReplayable(this.db, id, on);
    if (wrong != "") {
      return BadRequest(wrong);
    }
    let v: ReplayableSetView = { id: id, replayable: on };
    return OkJson(v);
  }

  @Post("/:id/remix")
  remix(req: Request, @PathVariable("id") id: string): Reply {
    let made = remixThread(this.db, { sourceId: id,
      owner: owningTag(callerTags(req)), now: stamp() });
    if (made.threadId == "") {
      return NotFound(made.fault);
    }
    let v: RemixedView = { id: made.threadId, files: made.files };
    return CreatedJson(v);
  }

  @Get("/")
  list(req: Request,
       @RequestParam("limit", "50") asked: string,
       @RequestParam("offset", "0") offset: int,
       @RequestParam("project", "") project: string): Reply {
    let limit = parseInt(asked) ?? 50;
    let rows = listThreads(this.db, {
      tags: callerTags(req),
      limit: limit,
      offset: offset,
      project: project,
    });
    let out: ThreadRowView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let one: ThreadRowView = {
        id: rows[i].id, agentId: rows[i].agentId, createdAt: rows[i].createdAt,
        title: rows[i].title, replayable: rows[i].replayable, projectId: rows[i].projectId,
      };
      out.push(one);
      i = i + 1;
    }
    return OkJson(out);
  }

  @Post("/from-story")
  fromStory(req: Request): Reply {
    if (req.body == "") {
      return BadRequest("a body is required: {\"storyId\":\"tech-en:ab12cd34\",\"agentId\":\"a1\"}");
    }
    let storyId = jsonText(req.body, "storyId");
    let agentId = jsonText(req.body, "agentId");
    if (storyId == "" || agentId == "") {
      return BadRequest("a storyId and an agentId are required");
    }
    if (!existsById(this.db, agentsMapping(), agentId)) {
      return BadRequest("no agent " + agentId);
    }
    let story = storyById(this.db, storyId);
    if (story.id == "") {
      return NotFound("story " + storyId);
    }

    let id = openThread(this.db, {
      agentId: agentId,
      owner: owningTag(callerTags(req)),
      now: stamp(),
    });
    if (id == "") {
      return BadRequest("the thread could not be opened");
    }

    let chosen = askedChoice(req.body);
    if (chosen != "" && choiceFault(this.db, chosen) == "") {
      if (rememberChoice(this.db, id, chosen) != "") {
        chosen = "";
      }
    } else {
      chosen = "";
    }

    let feed = feedById(this.db, story.feedId);
    let seed = [userTurn(asArticleContext(story, feed.topic))];
    let wrote = appendTurns(this.db, id, seed, 0);
    if (wrote != "") {
      return BadRequest("the article could not be attached: " + wrote);
    }

    nameThread(this.db, id, story.headline);

    let v: ThreadFromStoryView = {
      id: id, agentId: agentId, modelChoiceId: chosen, title: story.headline,
    };
    return CreatedJson(v);
  }

  @Post("/")
  open(req: Request): Reply {
    if (req.body == "") {
      return BadRequest("a body is required: {\"agentId\":\"a1\"}");
    }
    let agentId = jsonText(req.body, "agentId");
    if (agentId == "") {
      return BadRequest("a body is required: {\"agentId\":\"a1\"}");
    }
    if (!existsById(this.db, agentsMapping(), agentId)) {
      return BadRequest("no agent " + agentId);
    }
    let chosen = askedChoice(req.body);
    let refused = choiceFault(this.db, chosen);
    if (refused != "") {
      return BadRequest(refused);
    }
    let id = openThread(this.db, {
      agentId: agentId,
      owner: owningTag(callerTags(req)),
      now: stamp(),
    });
    if (id == "") {
      return BadRequest("the thread could not be opened");
    }

    let kept = chosen;
    if (chosen != "") {
      if (rememberChoice(this.db, id, chosen) != "") {
        kept = "";
      }
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
    let v: ThreadOpenedView = {
      id: id, agentId: agentId, modelChoiceId: kept, projectId: filed,
    };
    return CreatedJson(v);
  }

  @Get("/:id/steps")
  steps(req: Request, @PathVariable("id") id: string,
        @RequestParam("seq", "") asked: string): Reply {
    if (ownedThread(this.db, id, callerTags(req)) == "") {
      return NotFound("thread " + id);
    }
    let round = latestRound(this.db, id);
    let live: LiveStep[] = [];
    let thoughts: Thought[] = [];
    if (asked == "all") {
      round = TURN_SEQ_NONE;
      live = stepsOfThread(this.db, id);
      thoughts = thoughtsOfThread(this.db, id);
    } else {
      if (asked != "") {
        round = parseInt(asked, 10) ?? -1;
      }
      if (round >= 0) {
        live = stepsOfRound(this.db, id, round);
        thoughts = thoughtsOfRound(this.db, id, round);
      }
    }
    let partialText = "";
    if (asked != "all") {
      partialText = partialOf(this.db, id, round);
    }
    let v: RoundView = {
      seq: round, running: roundRunning(live), partial: partialText,
      thoughts: thoughtViews(thoughts), steps: stepViews(live),
    };
    return OkJson(v);
  }

  @Post("/:id/cancel")
  cancel(req: Request, @PathVariable("id") id: string): Reply {
    if (ownedThread(this.db, id, callerTags(req)) == "") {
      return NotFound("thread " + id);
    }
    let fault = askCancel(this.db, id);
    if (fault != "") {
      return BadRequest(fault);
    }
    let v: CancelAskedView = { asked: true };
    return OkJson(v);
  }

  @Post("/:id/messages")
  say(req: Request, @PathVariable("id") id: string): Reply {
    let tags = callerTags(req);
    let agentId = ownedThread(this.db, id, tags);
    if (agentId == "") {
      return NotFound("thread " + id);
    }
    clearCancel(this.db, id);
    if (req.body == "") {
      return BadRequest("a body is required: {\"text\":\"...\"}");
    }
    let text = jsonText(req.body, "text");
    if (text == "") {
      return BadRequest("nothing to ask: \"text\" is empty");
    }

    let pick = askedPick(req.body);
    let noSuchChoice = choiceFault(this.db, pick.choiceId);
    if (noSuchChoice != "") {
      return BadRequest(noSuchChoice);
    }

    if (pick.choiceId != "") {
      let pickedRow = findById(this.db, modelChoicesMapping(), pick.choiceId);
      if (pickedRow != "") {
        let picked: ModelChoiceRow = JSON.parse<ModelChoiceRow>(pickedRow);
        if (picked.tier == "premium") {
          return BadRequest(picked.label + " is coming soon — it is announced, not offered yet");
        }
      }
    }

    let guest = guestTag(tags);
    if (guest != "") {
      let atGate = Date.now();
      let used = runsSince(this.db, guest, utcDayStartText(atGate));
      if (used >= GUEST_DAILY_RUNS) {
        let refusal = Respond(429, guestQuotaJson(used, nextUtcMidnightIso(atGate)), "application/json");
        refusal.headers.set("retry-after", `${secondsToUtcMidnight(atGate)}`);
        return refusal;
      }
    }

    let tracer = tracerWithSession(
      tracerFor(this.db, this.master), id, owningTag(callerTags(req)));
    let answered = runInThreadWith(this.db, id, {
      userText: text, master: this.master, tracer: tracer, pick: pick,
      think: jsonText(req.body, "think") == "true",
      scope: jsonText(req.body, "scope"),
    });
    let run = answered.run;
    let runId = recordRun(this.db, {
      agentId: agentId, threadId: id,
      owner: threadOwner(this.db, id),
      question: text, run: withNotes(run, answered.notes),
      modelChoiceId: answered.modelChoiceId, routeNote: answered.routeNote,
    });

    let traced = "";
    if (tracing(tracer) && run.spans.length > 0) {
      if (flush(tracerWithMoreSpans(tracer, run.spans)).ok) {
        traced = traceId(tracer);
      }
    }
    let view = wireView(answered.text);
    let said: AnsweredView = {
      runId: runId,
      ok: run.ok,
      text: view.text,
      refs: refViews(view.refs),
      seq: answered.baseSeq,
      modelChoiceId: answered.modelChoiceId,
      routeNote: answered.routeNote,
      toolCalls: run.steps.length,
      steps: stepViews(stepsOfRound(this.db, id, answered.baseSeq)),
      thoughts: thoughtViews(thoughtsOfRound(this.db, id, answered.baseSeq)),
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      traceId: traced,
      error: run.error,
    };
    if (guest == "") {
      return OkJson(said);
    }
    let left = GUEST_DAILY_RUNS - runsSince(this.db, guest, utcDayStartText(Date.now()));
    if (left < 0) {
      left = 0;
    }
    let counted: GuestAnsweredView = {
      runId: said.runId,
      ok: said.ok,
      text: said.text,
      refs: said.refs,
      seq: said.seq,
      modelChoiceId: said.modelChoiceId,
      routeNote: said.routeNote,
      toolCalls: said.toolCalls,
      steps: said.steps,
      thoughts: said.thoughts,
      inputTokens: said.inputTokens,
      outputTokens: said.outputTokens,
      traceId: said.traceId,
      error: said.error,
      guestRemaining: left,
    };
    return OkJson(counted);
  }

  @Get("/:id")
  transcript(req: Request, @PathVariable("id") id: string): Reply {
    if (readableThread(this.db, id, callerTags(req)) == "") {
      return NotFound("thread " + id);
    }
    let mine = ownedThread(this.db, id, callerTags(req)) != "";
    let said: ThreadTurnRow[] = threadMessageRows(this.db, id);
    let out: MessageView[] = [];
    let i: int = 0;
    while (i < said.length) {
      if (said[i].role == "assistant") {
        let view = wireView(said[i].text);
        let one: MessageView = {
          role: said[i].role, seq: said[i].seq, text: view.text, refs: refViews(view.refs),
        };
        out.push(one);
      } else {
        let none: WireRef[] = [];
        let one: MessageView = {
          role: said[i].role, seq: said[i].seq, text: said[i].text, refs: refViews(none),
        };
        out.push(one);
      }
      i = i + 1;
    }
    let v: TranscriptView = {
      modelChoiceId: threadChoice(this.db, id),
      title: threadTitle(this.db, id),
      mine: mine,
      messages: out,
    };
    return OkJson(v);
  }
}

function withNotes(run: AgentRun, more: string[]): AgentRun {
  let notes: string[] = [];
  let i: int = 0;
  while (i < run.notes.length) {
    notes.push(run.notes[i]);
    i = i + 1;
  }
  let m: int = 0;
  while (m < more.length) {
    notes.push(more[m]);
    m = m + 1;
  }
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

function refViews(refs: WireRef[]): RefView[] {
  let out: RefView[] = [];
  let i: int = 0;
  while (i < refs.length) {
    let one: RefView = { slot: refs[i].slot, version: refs[i].version, path: refs[i].path };
    out.push(one);
    i = i + 1;
  }
  return out;
}









export function bearerRefused(configured: string, target: string, authorization: string): bool {
  if (configured == "") {
    return false;
  }
  if (publicPath(target)) {
    return false;
  }
  return presentedToken(authorization) != configured;
}

function publicPath(target: string): bool {
  let path = target;
  let query = path.indexOf("?");
  if (query >= 0) {
    path = path.substring(0, query);
  }
  while (path.length > 1 && path.endsWith("/")) {
    path = path.substring(0, path.length - 1);
  }
  if (path == "/healthz") {
    return true;
  }
  if (path == "/v1") {
    return true;
  }
  if (path.length >= 4 && path.substring(0, 4) == "/v1/") {
    return true;
  }
  return false;
}

function presentedToken(authorization: string): string {
  let prefix = "Bearer ";
  if (authorization.length <= prefix.length) {
    return "";
  }
  if (authorization.substring(0, prefix.length).toLowerCase() != prefix.toLowerCase()) {
    return "";
  }
  return authorization.substring(prefix.length, authorization.length).trim();
}

function apiToken(): string {
  return (process.env("AGENTS_API_TOKEN") ?? "").trim();
}




function thoughtViews(thoughts: Thought[]): ThoughtView[] {
  let out: ThoughtView[] = [];
  let i: int = 0;
  while (i < thoughts.length) {
    let one: ThoughtView = {
      seq: thoughts[i].seq, rotation: thoughts[i].rotation,
      depth: thoughts[i].depth, text: thoughts[i].text,
    };
    out.push(one);
    i = i + 1;
  }
  return out;
}

function stepViews(live: LiveStep[]): StepView[] {
  let out: StepView[] = [];
  let i: int = 0;
  while (i < live.length) {
    let one: StepView = {
      seq: live[i].seq,
      depth: live[i].depth,
      rotation: live[i].rotation,
      idx: live[i].idx,
      kind: live[i].kind,
      name: live[i].name,
      target: live[i].target,
      args: live[i].args,
      running: live[i].endedAt == "",
      ok: live[i].ok,
      millis: stepMillis(live[i]),
      result: live[i].result,
    };
    out.push(one);
    i = i + 1;
  }
  return out;
}


function digestLoop(master: string, everyMs: int): int {
  try {
    let db = openDatabase();
    while (true) {
      let feeds = allFeeds(db);
      let i: int = 0;
      while (i < feeds.length) {
        if (feeds[i].enabled) {
          let fault = refreshFeed(db, feeds[i], master);
          if (fault != "") {
            console.error("discover: " + feeds[i].id + ": " + fault);
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
  if (said == "") {
    return 0;
  }
  let n = parseInt(said, 10) ?? 0;
  if (n > 0 && n < 60000) {
    return 60000;
  }
  return n;
}

function sweepLoop(idleMs: int): int {
  try {
    let db = openDatabase();
    let every = idleMs > 0 ? idleMs : ENV_IDLE_MS;
    while (true) {
      if (idleMs > 0) {
        try {
          sweepEmptyThreads(db, `${Date.now() - idleMs}`);
        }
        catch (e) {
          console.error("thread sweep: " + e.message);
        }
      }
      try {
        sweepIdleEnvironments(db);
      }
      catch (e) {
        console.error("environment sweep: " + e.message);
      }
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
  if (stopped > 0) {
    console.log(`stopped ${stopped} idle environment(s)`);
  }
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

export function migrationFault(db: Db): string {
  let plan = schemaPlan(db);
  let extra = runLogPlan(db);
  let e: int = 0;
  while (e < extra.length) {
    plan.push(extra[e]);
    e = e + 1;
  }
  let traces = tracePlan(db);
  let t: int = 0;
  while (t < traces.length) {
    plan.push(traces[t]);
    t = t + 1;
  }
  let knowledge = knowledgePlan(db);
  let webRag = webRagPlan(db);
  let wr: int = 0;
  while (wr < webRag.length) {
    knowledge.push(webRag[wr]);
    wr = wr + 1;
  }
  let cards = toolCardsPlan(db);
  let tc: int = 0;
  while (tc < cards.length) {
    knowledge.push(cards[tc]);
    tc = tc + 1;
  }
  let discover = discoverPlan(db);
  let dc: int = 0;
  while (dc < discover.length) {
    knowledge.push(discover[dc]);
    dc = dc + 1;
  }
  let cardPlugins = cardPluginsPlan(db);
  let cp: int = 0;
  while (cp < cardPlugins.length) {
    knowledge.push(cardPlugins[cp]);
    cp = cp + 1;
  }
  let k: int = 0;
  while (k < knowledge.length) {
    plan.push(knowledge[k]);
    k = k + 1;
  }
  let conversations = threadPlan(db);
  let c: int = 0;
  while (c < conversations.length) {
    plan.push(conversations[c]);
    c = c + 1;
  }
  let files = workspacePlan(db);
  let w: int = 0;
  while (w < files.length) {
    plan.push(files[w]);
    w = w + 1;
  }
  let jobs = indexingPlan(db);
  let ij: int = 0;
  while (ij < jobs.length) {
    plan.push(jobs[ij]);
    ij = ij + 1;
  }
  let results = artifactPlan(db);
  let ar: int = 0;
  while (ar < results.length) {
    plan.push(results[ar]);
    ar = ar + 1;
  }
  let live = stepPlan(db);
  let lv: int = 0;
  while (lv < live.length) {
    plan.push(live[lv]);
    lv = lv + 1;
  }
  let envs = envPlan(db);
  let ev: int = 0;
  while (ev < envs.length) {
    plan.push(envs[ev]);
    ev = ev + 1;
  }
  let scheduled = tasksPlan(db);
  let st: int = 0;
  while (st < scheduled.length) {
    plan.push(scheduled[st]);
    st = st + 1;
  }
  let flows = workflowsPlan(db);
  let fl: int = 0;
  while (fl < flows.length) {
    plan.push(flows[fl]);
    fl = fl + 1;
  }
  let grouped = projectsPlan(db);
  let pj: int = 0;
  while (pj < grouped.length) {
    plan.push(grouped[pj]);
    pj = pj + 1;
  }
  let originals = documentFilesPlan(db);
  let df: int = 0;
  while (df < originals.length) {
    plan.push(originals[df]);
    df = df + 1;
  }
  let arriving = triggersPlan(db);
  let tg: int = 0;
  while (tg < arriving.length) {
    plan.push(arriving[tg]);
    tg = tg + 1;
  }
  let sealed = secretsPlan(db);
  let sk: int = 0;
  while (sk < sealed.length) {
    plan.push(sealed[sk]);
    sk = sk + 1;
  }
  let vars = envKeysPlan(db);
  let ek: int = 0;
  while (ek < vars.length) {
    plan.push(vars[ek]);
    ek = ek + 1;
  }
  let uenv = userEnvsPlan(db);
  let ue: int = 0;
  while (ue < uenv.length) {
    plan.push(uenv[ue]);
    ue = ue + 1;
  }
  let tmpl = envTemplatesPlan(db);
  let tp: int = 0;
  while (tp < tmpl.length) {
    plan.push(tmpl[tp]);
    tp = tp + 1;
  }
  let roster = mcpRosterPlan(db);
  let ro: int = 0;
  while (ro < roster.length) {
    plan.push(roster[ro]);
    ro = ro + 1;
  }
  let keys = apiKeysPlan(db);
  let kp: int = 0;
  while (kp < keys.length) {
    plan.push(keys[kp]);
    kp = kp + 1;
  }
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
  if (countWhere(db, envTemplatesMapping(), "", []) > 0) {
    return;
  }
  let now = stamp();
  let starters: EnvTemplateWrite[] = [
    {
      id: "",
      name: "Python",
      summary: "python 3.12, pip and the standard library — the everyday scripting environment",
      tags: "python,scripting",
      image: "python:3.12-slim",
      dockerfile: "",
      featuredRank: 1,
      now: now,
    },
    {
      id: "",
      name: "Node.js",
      summary: "node 20 and npm — for a JavaScript or TypeScript script",
      tags: "node,javascript",
      image: "node:20-slim",
      dockerfile: "",
      featuredRank: 2,
      now: now,
    },
    {
      id: "",
      name: "Data science",
      summary: "python with pandas, numpy and matplotlib installed — for shaping and charting data",
      tags: "python,data,pandas",
      image: "",
      dockerfile: "FROM python:3.12-slim\nRUN pip install --no-cache-dir pandas numpy matplotlib",
      featuredRank: 3,
      now: now,
    },
    {
      id: "",
      name: "Web scraping",
      summary: "python with requests, beautifulsoup4 and lxml — fetch a page and pull data out of it",
      tags: "python,web,scraping",
      image: "",
      dockerfile: "FROM python:3.12-slim\nRUN pip install --no-cache-dir requests beautifulsoup4 lxml",
      featuredRank: 0,
      now: now,
    },
  ];
  let i: int = 0;
  while (i < starters.length) {
    saveEnvTemplate(db, starters[i]);
    i = i + 1;
  }
}

function seed(db: Db): void {
  if (countWhere(db, agentsMapping(), "", []) > 0) {
    return;
  }
  let opus: ModelRow = {
    id: "m1",
    label: "Opus 5",
    apiName: "claude-opus-5",
    provider: "anthropic",
    kind: "chat",
    dimensions: 0,
    baseUrl: "",
    enabled: true,
    contextTokens: 0,
  };
  let haiku: ModelRow = {
    id: "m2",
    label: "Haiku 4.5",
    apiName: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    kind: "chat",
    dimensions: 0,
    baseUrl: "",
    enabled: true,
    contextTokens: 0,
  };
  let embed: ModelRow = {
    id: "m3",
    label: "Mistral Embed",
    apiName: "mistral-embed",
    provider: "mistral",
    kind: "embedding",
    dimensions: 1024,
    baseUrl: "",
    enabled: true,
    contextTokens: 0,
  };
  let embedSmall: ModelRow = {
    id: "m4",
    label: "Nomic Embed Text",
    apiName: "nomic-embed-text",
    provider: "ollama",
    kind: "embedding",
    dimensions: 768,
    baseUrl: "http://127.0.0.1:11434",
    enabled: false,
    contextTokens: 0,
  };
  persist(db, modelsMapping(), JSON.stringify(opus));
  persist(db, modelsMapping(), JSON.stringify(haiku));
  persist(db, modelsMapping(), JSON.stringify(embed));
  persist(db, modelsMapping(), JSON.stringify(embedSmall));
  let careful: ModelConfigRow = {
    id: "c1",
    modelId: "m1",
    temperature: 0.2,
    maxTokens: 8192,
    topP: 0.95,
    extra: "{}",
    thinking: "",
    label: "Careful",
    selectable: true,
    rank: 1,
  };
  let quick: ModelConfigRow = {
    id: "c2",
    modelId: "m2",
    temperature: 0.7,
    maxTokens: 2048,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "Quick",
    selectable: true,
    rank: 2,
  };
  persist(db, modelConfigsMapping(db), JSON.stringify(careful));
  persist(db, modelConfigsMapping(db), JSON.stringify(quick));
  let p1: PromptRow = {
    id: "p1",
    promptName: "lead",
    version: 1,
    body: "You lead.",
    createdAt: "2026-07-25",
  };
  let p2: PromptRow = {
    id: "p2",
    promptName: "lead",
    version: 2,
    body: "You lead, briefly.",
    createdAt: "2026-07-25",
  };
  persist(db, promptsMapping(), JSON.stringify(p1));
  persist(db, promptsMapping(), JSON.stringify(p2));
  let fsSrv: McpServerRow = {
    id: "s1",
    serverName: "filesystem",
    transport: "http",
    endpoint: "http://127.0.0.1:8931/mcp",
    authKind: "none",
    authHeader: "",
    enabled: true,
  };
  let ghSrv: McpServerRow = {
    id: "s2",
    serverName: "github",
    transport: "http",
    endpoint: "https://mcp.gh",
    authKind: "none",
    authHeader: "",
    enabled: true,
  };
  persist(db, mcpServersMapping(), JSON.stringify(fsSrv));
  persist(db, mcpServersMapping(), JSON.stringify(ghSrv));
  let lead: AgentRow = {
    id: "a1",
    agentName: "lead",
    description: "delegates",
    modelConfigId: "c1",
    promptId: "p2",
    scriptImageId: "",
    isDefault: true,
    enabled: true,
    updatedAt: "2026-07-25T10:00:00Z",
  };
  let scout: AgentRow = {
    id: "a2",
    agentName: "scout",
    description: "searches",
    modelConfigId: "c2",
    promptId: "p1",
    scriptImageId: "",
    isDefault: false,
    enabled: true,
    updatedAt: "2026-07-25T10:00:00Z",
  };
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
    if (!ran.ok) {
      return "the model menu could not be published: " + ran.error;
    }
    i = i + 1;
  }
  return "";
}

function main(): void {
  let db = openDatabase();
  let schema = migrationFault(db);
  if (schema != "") {
    console.error(schema);
    return;
  }
  seed(db);
  let menu = publishMenu(db);
  if (menu != "") {
    console.error(menu);
  }
  let master = masterKey();
  let keyFault = masterKeyFault(master);
  if (keyFault != "") {
    console.error(keyFault);
    return;
  }

  let sweepIdle = sweepIdleMs(process.env("AGENTS_SWEEP_IDLE_MS") ?? "");
  if (sweepIdle > 0) {
    console.log(`sweeping threads that have been empty for ${sweepIdle}ms`);
  }
  console.log(`stopping environments idle for ${ENV_IDLE_MS}ms`);
  Worker.run(() => sweepLoop(sweepIdle));
  let discoverEvery = discoverEveryMs();
  if (discoverEvery > 0) {
    Worker.run(() => digestLoop(master, discoverEvery));
  }

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
  if (token != "") {
    console.log("bearer token required on every route but /healthz");
  }
  let fault = listenLocked(8100, mounts, token);
  if (fault != "") {
    console.error(fault);
  }
}

function listenLocked(port: int, mounts: Mount[], token: string): string {
  let faultText = mountFault(mounts);
  if (faultText != "") {
    return faultText;
  }

  http.createServer(port, (req): HttpResponse => {
    if (bearerRefused(token, req.path, req.headers.get("authorization") ?? "")) {
      let shut = Respond(401, "{\"error\":\"a bearer token is required\"}", "application/json");
      shut.headers.set("www-authenticate", "Bearer");
      let refused: HttpResponse = {
        status: shut.status,
        body: shut.body,
        ok: true,
        headers: shut.headers,
      };
      return refused;
    }
    if (identityUnreadable(trustsProxyAuth(), req.headers.get("x-user") ?? "")) {
      let blank = Respond(401, "{\"error\":\"the X-USER document names no uuid\"}", "application/json");
      let unknown: HttpResponse = {
        status: blank.status,
        body: blank.body,
        ok: true,
        headers: blank.headers,
      };
      return unknown;
    }
    let answer = dispatchedMounted(mounts, req.method, req.path, req.body, req.headers);
    let out: HttpResponse = {
      status: answer.status,
      body: answer.body,
      ok: true,
      headers: answer.headers,
    };
    return out;
  });
  return "";
}

main();
