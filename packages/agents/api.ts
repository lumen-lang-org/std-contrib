import { Request, Reply, Mount, mount, mountedRoutes, mountFault, dispatchedMounted, Respond, Ok, Created, OkJson, CreatedJson, NoContent, NotFound, BadRequest, Refused } from "../rest/server.ts";
import { openApiDocument, openApiHandlerInfoOf, openApiOperations, openApiSchemaOf } from "../openapi/openapi.ts";
import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { postgres } from "../plume/postgres.ts";
import { DbOrder, placeholderAt, connectDatabase, databaseConnected, persist, findById, listOrdered, existsById, deleteById, execute, countWhere, jsonMember } from "../plume/plume.ts";
import { migrate } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, ModelChoiceRow, ModelRouterRow, PromptRow, McpServerRow, AgentRow, ScriptImageRow, scriptImagesMapping, modelsMapping, modelConfigsMapping, modelConfigRows, configAndModel, modelChoicesMapping, modelRoutersMapping, promptsMapping, mcpServersMapping, agentsMapping, schemaPlan, derivedMenuStatements, askCancel, clearCancel } from "./schema.ts";
import { masterKey, masterKeyFault } from "./credentials.ts";
import { AgentRun } from "./run.ts";
import { userTurn } from "./provider.ts";
import { runLogPlan, recordRun } from "./runlog.ts";
import { tracePlan, tracerFor } from "./trace.ts";
import { shipTraces, traceOutboxPlan } from "./trace-outbox.ts";
import { feedbackPlan } from "./feedback.ts";
import { jsonId, createFault } from "./payload.ts";
import { jsonList, jsonText, jsonFind, jsonRaw } from "./scan.ts";
import { stamp, callerTags, GUEST_DAILY_RUNS, guestTag, guestQuotaJson, bodyText, bodyJson, bodyBool, bodyInt, bodyNumber, bodyRank, askedChoice, choiceFault } from "./api-core.ts";
import { CardPluginApi } from "./routes/extensions/card-plugins/card-plugin.controller.ts";
import { ToolCardApi } from "./routes/authoring/tool-cards/tool-card.controller.ts";
import { McpServerApi } from "./routes/connectivity/mcp-server/mcp-server.controller.ts";
import { CompletionApi } from "./routes/inference/completions/completion.controller.ts";
import { TaskApi } from "./routes/automation/tasks/task.controller.ts";
import { DocumentApi } from "./routes/knowledge/documents/document.controller.ts";
import { PreviewApi } from "./routes/conversations/preview/preview.controller.ts";
import { ArtifactApi } from "./routes/conversations/threads-artifacts/artifact.controller.ts";
import { WorkspaceApi } from "./routes/conversations/threads-files/file.controller.ts";
import { ConnectApi } from "./routes/connectivity/connect/connect.controller.ts";
import { ServerApi } from "./routes/connectivity/servers/server.controller.ts";
import { AuthProviderApi } from "./routes/identity/auth-providers/auth-provider.controller.ts";
import { PluginApi } from "./routes/extensions/plugins/plugin.controller.ts";
import { PromptApi } from "./routes/authoring/prompts/prompt.controller.ts";
import { ModelApi } from "./routes/inference/models/model.controller.ts";
import { ConfigApi } from "./routes/inference/model-configs/model-config.controller.ts";
import { ChoiceApi } from "./routes/inference/model-choices/model-choice.controller.ts";
import { RouterApi } from "./routes/inference/model-routers/model-router.controller.ts";
import { ThreadApi } from "./routes/conversations/threads/thread.controller.ts";
import { chatConfigFault } from "./routes/inference/model-configs/model-config.utils.ts";
import { SkillApi } from "./routes/authoring/skills/skill.controller.ts";
import { ScriptImageApi } from "./routes/authoring/script-images/script-image.controller.ts";
import { TraceApi } from "./routes/ops/tracing/trace.controller.ts";
import { EvalApi } from "./routes/ops/evals/eval.controller.ts";
import { AgentApi } from "./routes/authoring/agents/agent.controller.ts";
import { AgentBody } from "./routes/authoring/agents/dtos/agent-body.dto.ts";
import { RetrievalSetup } from "./routes/authoring/agents/dtos/retrieval-setup.dto.ts";
import { ScopeGrant } from "./routes/authoring/agents/dtos/scope-grant.dto.ts";
import { OpenApiDocApi } from "./routes/ops/openapi-doc/openapi-doc.controller.ts";
import { ProviderApi } from "./routes/inference/providers/provider.controller.ts";
import { WorkflowApi } from "./routes/automation/workflows/workflow.controller.ts";
import { TemplateApi } from "./routes/extensions/templates/template.controller.ts";
import { TriggerApi } from "./routes/automation/triggers/trigger.controller.ts";
import { ProjectApi } from "./routes/conversations/projects/project.controller.ts";
import { EnvironmentApi } from "./routes/sandbox/environments/environment.controller.ts";
import { CaptchaApi } from "./routes/identity/captcha/captcha.controller.ts";
import { EnvKeyApi } from "./routes/sandbox/env-keys/env-key.controller.ts";
import { EnvTemplateApi } from "./routes/sandbox/env-templates/env-template.controller.ts";
import { SecretApi } from "./routes/identity/secrets/secret.controller.ts";
import { JobApi } from "./routes/knowledge/jobs/job.controller.ts";
import { SandboxLimitsApi } from "./routes/sandbox/sandbox-limits/sandbox-limits.controller.ts";
import { ScopeApi } from "./routes/authoring/scopes/scope.controller.ts";
import { QuotaApi } from "./routes/identity/quota/quota.controller.ts";
import { LibraryApi } from "./routes/conversations/library/library.controller.ts";
import { RunApi } from "./routes/conversations/runs/run.controller.ts";
import { UsageApi } from "./routes/identity/usage/usage.controller.ts";
import { BannerApi } from "./routes/ops/banner/banner.controller.ts";
import { FeedbackApi } from "./routes/ops/feedback/feedback.controller.ts";
import { HealthApi } from "./routes/ops/healthz/health.controller.ts";
import { mcpRosterPlan } from "./mcp-roster.ts";
import { ModelPick, ThreadTurnRow, threadsMapping, listThreads, openThread, ownedThread, threadOwner, threadChoice, threadTitle, rememberChoice, sweepEmptyThreads, sweepIdleMs, threadMessageRows, runInThreadWith, threadPlan, listReplayable, markReplayable, remixThread, readableThread, appendTurns, nameThread } from "./threads.ts";
import { trustsProxyAuth, identityUnreadable, owningTag, holdsOwner } from "./owner.ts";
import { runsSince, utcDayStartText, secondsToUtcMidnight, nextUtcMidnightIso } from "./usage.ts";
import { workspacePlan } from "./workspace.ts";
import { TURN_SEQ_NONE, artifactPlan } from "./artifacts.ts";
import { stepPlan, stepsOfRound, stepsOfThread, roundRunning, latestRound, stepMillis, thoughtsOfRound, thoughtsOfThread, LiveStep, Thought, partialOf } from "./steps.ts";
import { EnvSweep, ENV_IDLE_MS, envEnsure, envList, envPlan, envIdle, envNetworkReap, envMarkSynced, envReforward, envServing } from "./environments.ts";
import { envGrantsPlan, envGrantSweep } from "./env-grants.ts";
import { envMaterialise, envSyncClock, envSyncOut } from "./env-sync.ts";
import { JOULE_PROGRESS_MS, jouleProgress } from "./joule-progress.ts";

// How often a serving environment's workspace is read back. Its own cadence,
// far shorter than the idle sweep: a person editing a file wants it recorded in
// seconds, not at the end of a session.
const WORKSPACE_SWEEP_MS: int = 15000;
import { WireRef, wireView } from "./artifacts-fence.ts";
import { indexingPlan } from "./indexing.ts";
import { knowledgePlan } from "./knowledge.ts";
import { toolCardsPlan } from "./toolcards.ts";
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




function sweepLoop(idleMs: int): int {
  try {
    let db = openDatabase();
    let every = idleMs > 0 ? idleMs : ENV_IDLE_MS;
    // Before the first sleep, because every forward died with the last process.
    try {
      let carried = envReforward(db, `${Date.now()}`);
      if (carried > 0) {
        console.log(`carried ${carried} serving environment(s) back`);
      }
    }
    catch (e) {
      console.error("environment forwards: " + e.message);
    }
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
      // Three cadences, nested, and the innermost one is the tick. The idle
      // sweep decides what to stop every fifteen minutes; a person editing a
      // file wants it recorded in seconds rather than at the end of a session;
      // a delegated turn's tool calls want to appear in the thread while it is
      // running, which is faster still.
      //
      // In one loop body rather than in a worker of its own, deliberately.
      // Both of these harvest a workspace, and envServing's comment is why
      // that has to be one reader: the stamp is taken, the find is run, the
      // stamp is written, and a second pass overlapping the first would move
      // the stamp it is comparing against. Sequential calls cannot overlap.
      let waited: int = 0;
      let sinceSweep: int = WORKSPACE_SWEEP_MS;
      while (waited < every) {
        if (sinceSweep >= WORKSPACE_SWEEP_MS) {
          try {
            sweepWorkspaces(db);
          }
          catch (e) {
            console.error("workspace sweep: " + e.message);
          }
          sinceSweep = 0;
        }
        try {
          jouleProgress(db, `${Date.now()}`);
        }
        catch (e) {
          console.error("delegated progress: " + e.message);
        }
        process.sleep(JOULE_PROGRESS_MS);
        waited = waited + JOULE_PROGRESS_MS;
        sinceSweep = sinceSweep + JOULE_PROGRESS_MS;
      }
    }
  } catch (e) {
    console.error("thread sweep: no connection of its own — " + e.message);
  }
  return 0;
}

/** Everything a serving environment has written since the last sweep, brought
 *  back as artifact versions. The stamp is taken before the find and recorded
 *  after, so a file written while the sweep runs is caught by the next one
 *  rather than missed by both. */
function sweepWorkspaces(db: Db): void {
  let rows = envServing(db);
  if (rows.length == 0) {
    return;
  }
  let i: int = 0;
  while (i < rows.length) {
    let row = rows[i];
    i = i + 1;
    let stamp = envSyncClock(row);
    if (stamp == "") {
      // Silent skips are how the last two bugs hid. If the container will not
      // say what time it is, the sync cannot run and somebody should know.
      console.error(`workspace ${row.threadId}:${row.name} — its clock did not answer`);
      continue;
    }
    let carried = envSyncOut(db, row, row.syncAt, `${Date.now()}`);
    envMarkSynced(db, row, stamp);
    if (carried.changed.length > 0) {
      console.log(`brought ${carried.changed.length} file(s) back from ${row.threadId}:${row.name}`);
    }
  }
}

function sweepIdleEnvironments(db: Db): void {
  let now = `${Date.now()}`;
  let s: EnvSweep = { now: now, idleMs: ENV_IDLE_MS };
  let stopped = envIdle(db, s);
  if (stopped > 0) {
    console.log(`stopped ${stopped} idle environment(s)`);
  }
  // What the stop above could not hand back, because whatever made it is no
  // longer running to be asked. Rare, and cheap to be sure of.
  let reaped = envNetworkReap(db);
  if (reaped > 0) {
    console.log(`released ${reaped} leftover environment network(s)`);
  }
  // A grant lives a minute; its row should not outlive the day, and this is
  // the sweep that is already running.
  let lapsed = envGrantSweep(db, now);
  if (lapsed > 0) {
    console.log(`cleared ${lapsed} lapsed environment grant(s)`);
  }
}

/** The database this deployment runs on, opened.
 *
 *  A connection that does not open is said so here, naming the address it was
 *  tried at. Left unsaid it surfaces as whatever the first query happens to
 *  fail with — for main() that is "the schema is not up to date", which sends
 *  the reader looking at migrations over a wrong password. The two worker
 *  loops that call this have no such reader at all, so the line in the log is
 *  the only sign they are turning without a database. */
const TRACE_SHIP_MS: int = 2000;

/** Ships queued traces, forever. The same contract as sweepLoop and for the
 *  same reason: nothing crosses the worker boundary but the closure itself,
 *  the connection is this thread's own, and a collector outage costs retries
 *  in a table rather than seconds in somebody's reply. */
function traceShipLoop(): int {
  try {
    let db = openDatabase();
    let master = masterKey();
    console.log("trace outbox: shipping every " + `${TRACE_SHIP_MS}` + "ms");
    while (true) {
      try {
        shipTraces(db, master);
      }
      catch (e) {
        console.error("trace outbox: " + e.message);
      }
      process.sleep(TRACE_SHIP_MS);
    }
  } catch (e) {
    console.error("trace outbox: no connection of its own — " + e.message);
  }
  return 0;
}

function openDatabase(): Db {
  let pgHost = process.env("AGENTS_PG_HOST") ?? "";
  if (pgHost != "") {
    let pg = postgres();
    let named = process.env("AGENTS_PG_DATABASE") ?? "agents";
    let asUser = process.env("AGENTS_PG_USER") ?? "agents";
    let server: DbConfig = {
      host: pgHost,
      database: named,
      user: asUser,
      password: process.env("AGENTS_PG_PASSWORD") ?? "",
    };
    let reached = connectDatabase(pg, server);
    if (!reached.ok) {
      console.error("the database did not open: postgres " + named + " at "
        + pgHost + " as " + asUser + " — " + reached.error);
    }
    return pg;
  }
  let db = sqlite();
  let file = process.env("AGENTS_DB_FILE") ?? "/tmp/agents_api.db";
  let cfg: DbConfig = { filename: file };
  let opened = connectDatabase(db, cfg);
  if (!opened.ok) {
    console.error("the database did not open: sqlite at " + file + " — " + opened.error);
  }
  return db;
}

/** Every plan this deployment runs, composed into one.
 *
 *  Its own function so a test can ask how far the schema should get without
 *  holding a copy of the number: migrate refuses a plan that is missing steps
 *  the history holds, so there is exactly one of these and nobody may pass a
 *  subset. */
export function wholePlan(db: Db): Migration[] {
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
  let saidPlan = feedbackPlan(db);
  let sp: int = 0;
  while (sp < saidPlan.length) {
    plan.push(saidPlan[sp]);
    sp = sp + 1;
  }
  let outbox = traceOutboxPlan(db);
  let ob: int = 0;
  while (ob < outbox.length) {
    plan.push(outbox[ob]);
    ob = ob + 1;
  }
  let knowledge = knowledgePlan(db);
  let cards = toolCardsPlan(db);
  let tc: int = 0;
  while (tc < cards.length) {
    knowledge.push(cards[tc]);
    tc = tc + 1;
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
  let grants = envGrantsPlan(db);
  let gr: int = 0;
  while (gr < grants.length) {
    plan.push(grants[gr]);
    gr = gr + 1;
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
  return plan;
}

export function migrationFault(db: Db): string {
  let plan = wholePlan(db);
  let ran = migrate(db, plan);
  if (ran.ok) {
    applySandboxLimits(db);
    seedEnvTemplates(db);
    seedJouleImage(db);
    return "";
  }
  if (ran.failedVersion != "") {
    return "the schema is not up to date: migration " + ran.failedVersion + " did not run — " + ran.error;
  }
  return "the schema is not up to date: " + ran.error;
}


/** The image a delegated joule agent runs in, and the name it answers to.
 *
 *  packages/agents/joule.Dockerfile builds it. The tag is the contract
 *  between the two: change one and change the other.
 */
export const JOULE_IMAGE: string = "agents-joule:1";
export const JOULE_IMAGE_ID: string = "img-joule";

/** Register that image the way office and search are registered.
 *
 *  A curated script image row is the whole mechanism: scriptImageForEnv folds
 *  an environment's name and looks for the enabled row whose label folds the
 *  same way, which is how "office" resolves to the office image and refuses
 *  rather than falling back when no row matches. Office and search got their
 *  rows from an operator through POST /script-images. This one is seeded,
 *  because the engine reaches for it by name itself rather than waiting to be
 *  told it exists — an operator step nobody performed would look like
 *  delegation being broken, and it would look that way on a fresh deployment
 *  every time.
 *
 *  Seeded by id and not, like seedEnvTemplates, by the table being empty: a
 *  deployment that already has office and search rows has a table that is not
 *  empty and still has no joule row. Going by id also leaves an operator's own
 *  decision alone — a row disabled or repointed here still exists, so nothing
 *  puts the original back on the next boot.
 */
function seedJouleImage(db: Db): void {
  if (findById(db, scriptImagesMapping(), JOULE_IMAGE_ID) != "") {
    return;
  }
  let row: ScriptImageRow = {
    id: JOULE_IMAGE_ID,
    label: "joule",
    image: JOULE_IMAGE,
    enabled: true,
    summary: "joule and joule-daemon on python 3.12, with node, npm and git",
  };
  persist(db, scriptImagesMapping(), JSON.stringify(row));
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
    {
      id: "",
      name: "Joule",
      summary: "joule and joule-daemon, for handing a task to an agent working inside the environment",
      tags: "joule,agent,delegation",
      image: JOULE_IMAGE,
      dockerfile: "",
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
  // Before the migrations, so a connection that never opened is not reported
  // as a schema that is behind. openDatabase has already named the address.
  if (!databaseConnected(db)) {
    console.error("the engine cannot start without its database");
    return;
  }
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
  Worker.run(() => traceShipLoop());

  // Built from the same @openapi/@schema decorators AgentApi's own routes
  // and DTOs already carry — a second AgentApi instance, alongside the one
  // in the mounts list below, since Mount erases which controller it was
  // once built and openApiOperations needs AgentApi's own Route[] by name.
  let agentDoc = mount(new AgentApi(db, master));
  let agentInfo = openApiHandlerInfoOf(new AgentApi(db, master));
  let agentOps = openApiOperations(agentDoc.routes, agentDoc.controller, agentInfo);
  let agentSchemas = [
    openApiSchemaOf(new AgentBody("", "", "", "", "", false, false, "", "")),
    openApiSchemaOf(new RetrievalSetup("", 0, 0.0, false)),
    openApiSchemaOf(new ScopeGrant("")),
  ];
  let openApiDoc = openApiDocument("Agents API", "0.1.0", agentOps, agentSchemas);

  let mounts: Mount[] = [
    new AgentApi(db, master),
    new OpenApiDocApi(openApiDoc),
    new ProviderApi(db, master),
    new ThreadApi(db, master),
    new RunApi(db),
    new TaskApi(db),
    new ProjectApi(db),
    new WorkflowApi(db),
    new SecretApi(db, master),
    new CompletionApi(db),
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
    new DocumentApi(db, master),
    new ScopeApi(db),
    new JobApi(db),
    new TraceApi(db, master),
    new EvalApi(db, master),
    new ServerApi(db, master),
    new ConnectApi(db, master),
    new AuthProviderApi(db, master),
    new PluginApi(db),
    new ArtifactApi(db),
    new PreviewApi(db),
    new LibraryApi(db),
    new ToolCardApi(db),
    new CardPluginApi(db),
    new BannerApi(db),
    new FeedbackApi(db),
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
