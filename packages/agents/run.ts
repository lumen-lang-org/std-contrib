import { Db } from "../plume/driver.ts";
import { findById } from "../plume/plume.ts";
import { AgentRow, PromptRow, ModelRow, ModelConfigRow, modelsMapping, modelConfigsMapping, promptsMapping, agentsMapping, cancelAsked } from "./schema.ts";
import { credentialFor } from "./credentials.ts";
import { Completion, ToolSpec, ToolCall, Turn, toolSpec, complete, completeTurns, streamTurns, replyText, assistantText, assistantThinking, toolCallsFrom, truncationFault, userTurn, assistantTurn, toolTurn } from "./provider.ts";
import { Mounted, mountTools, mountedIndex, toolSpecs, callMounted, serverOf, findTools, findToolsSpec, stillWaiting, deferredBriefing, NO_PLACEHOLDER_ARGS, TEXT_CARD, agentChildren, delegateToolName, delegateDescription, delegateSchema, artifactTools, callArtifactTool, scriptTools, envBriefing, callScriptTool, skillTools, callSkillTool, skillBriefing, FILE_FENCE } from "./tools.ts";
import { taskTools, callTaskTool, maySchedule } from "./task-tools.ts";
import { workflowTools, callWorkflowTool } from "./workflow-tools.ts";
import { triggerTools, callTriggerTool } from "./trigger-tools.ts";
import { agentTools, callAgentTool } from "./agent-tools.ts";
import { projectTools, callProjectTool } from "./project-tools.ts";
import { knowledgeTools, callKnowledgeTool } from "./knowledge-tools.ts";
import { TURN_SEQ_NONE, artifactBriefing } from "./artifacts.ts";
import { projectBriefing } from "./projects.ts";
import { StepStart, StepClose, beginStep, endStep, endStepAt, recordThought, recordPartial, clearPartial } from "./steps.ts";
import { jsonText } from "./scan.ts";
import { Retrieved, embeddingModel, agentScopes, retrievalFor, retrieve, retrieveExcluding, asContext } from "./knowledge.ts";
import { WebPassage, webRagFor, generateQuery, retrieveWeb, asWebContext, webSummary, webSearchTools, callWebSearchTool, callReadLinkTool } from "./webrag.ts";
import { cardHintFor } from "./toolcards.ts";
import { casesBriefing } from "./plugincards.ts";
import { FileToolResult, workspaceTools, callWorkspaceTool } from "./workspace.ts";
import { GenerationCall, Tracer, TraceSpan, RecordedSpan, startSpan, endSpan, endSpanFailed, endGeneration, endTool, tracerSpans, tracerWithMoreSpans, tracerForCallee, noTracer, tracing, TRACE_AGENT, TRACE_GENERATION, TRACE_TOOL, TRACE_RETRIEVER } from "../tracing/tracing.ts";

const MAX_TOOL_STEPS: int = maxToolSteps();
const FIND_TOOLS_CAP: int = 8;

const CANCELLED_TEXT: string = "Stopped at your request.";

function maxToolSteps(): int {
  let said = process.env["AGENTS_MAX_TOOL_STEPS"] ?? "";
  if (said == "") {
    return 18;
  }
  let n = parseInt(said, 10) ?? 18;
  if (n < 1) {
    return 18;
  }
  return n;
}

const MAX_DEPTH: int = 3;

function stamp(): string {
  return `${Date.now()}`;
}

type NestedModel = { id: string, label: string, apiName: string, provider: string, enabled: bool };
type ConfigWithModel = {
  id: string, modelId: string, temperature: number, maxTokens: int, topP: number, extra: string, thinking: string,
  label: string, selectable: bool, rank: int,
  model: NestedModel,
};

export type AgentStep = {
  index: int,
  tool: string,
  server: string,
  args: string,
  result: string,
  ok: bool,
};

export type AgentRun = {
  ok: bool,
  text: string,
  body: string,
  status: int,
  agentName: string,
  promptVersion: int,
  modelApiName: string,
  error: string,
  context: Turn[],
  retrieved: Retrieved[],
  steps: AgentStep[],
  stopReason: string,
  rounds: int,
  inputTokens: int,
  outputTokens: int,
  notes: string[],
  calledTools: string[],
  calledAgents: string[],
  spans: RecordedSpan[],
};

function failed(agentName: string, why: string): AgentRun {
  let noContext: Turn[] = [];
  let noSteps: AgentStep[] = [];
  let noNotes: string[] = [];
  let noSpans: RecordedSpan[] = [];
  let noTools: string[] = [];
  let noAgents: string[] = [];
  let noPassages: Retrieved[] = [];
  let r: AgentRun = {
    ok: false, text: "", body: "", status: 0,
    agentName: agentName, promptVersion: 0, modelApiName: "", error: why,
    inputTokens: 0, outputTokens: 0,
    context: noContext, steps: noSteps, stopReason: "refused", rounds: 0, notes: noNotes,
    calledTools: noTools, calledAgents: noAgents, retrieved: noPassages, spans: noSpans,
  };
  return r;
}

export type RunContext = {
  depth: int,
  path: string[],
  tracer: Tracer,
  parentSpan: string,
  prior: Turn[],
  threadId: string,
  excludeChunks: string[],
  modelConfigId: string,
  baseSeq: int,
  owner: string,
  think: bool,
  scope: string,
};

export function runAgent(db: Db, agentId: string, userText: string, master: string): AgentRun {
  let path: string[] = [];
  let fresh: Turn[] = [];
  let noChunks: string[] = [];
  let top: RunContext = {
    depth: 0,
    path: path,
    tracer: noTracer(),
    parentSpan: "",
    prior: fresh,
    threadId: "",
    excludeChunks: noChunks,
    modelConfigId: "",
    baseSeq: TURN_SEQ_NONE,
    owner: "",
    think: false,
    scope: "",
  };
  return runAgentAt(db, agentId, userText, master, top);
}

export function runAgentTraced(db: Db, agentId: string, userText: string, master: string, tracer: Tracer): AgentRun {
  let path: string[] = [];
  let fresh: Turn[] = [];
  let noChunks: string[] = [];
  let top: RunContext = {
    depth: 0,
    path: path,
    tracer: tracer,
    parentSpan: "",
    prior: fresh,
    threadId: "",
    excludeChunks: noChunks,
    modelConfigId: "",
    baseSeq: TURN_SEQ_NONE,
    owner: "",
    think: false,
    scope: "",
  };
  return runAgentAt(db, agentId, userText, master, top);
}

export function runAgentAt(db: Db, agentId: string, userText: string, master: string, where: RunContext): AgentRun {
  let depth = where.depth;
  let path = where.path;
  let tracer = where.tracer;
  let parentSpan = where.parentSpan;
  let prior = where.prior;
  let threadId = where.threadId;
  let excludeChunks = where.excludeChunks;
  let agentDoc = findById(db, agentsMapping(), agentId);
  if (agentDoc == "") {
    return failed("", "no agent " + agentId);
  }
  let agent: AgentRow = JSON.parse<AgentRow>(agentDoc);
  if (!agent.enabled) {
    return failed(agent.agentName, agent.agentName + " is disabled");
  }

  let promptDoc = findById(db, promptsMapping(), agent.promptId);
  if (promptDoc == "") {
    return failed(agent.agentName, "no prompt " + agent.promptId);
  }
  let prompt: PromptRow = JSON.parse<PromptRow>(promptDoc);

  let configId = agent.modelConfigId;
  if (where.modelConfigId != "") {
    configId = where.modelConfigId;
  }
  let configDoc = findById(db, modelConfigsMapping(db), configId);
  if (configDoc == "") {
    return failed(agent.agentName, "no model config " + configId);
  }
  let parsed: ConfigWithModel = JSON.parse<ConfigWithModel>(configDoc);
  let asks = parsed.thinking;
  if (!where.think) {
    asks = "off";
  }
  let config: ConfigWithModel = {
    id: parsed.id, modelId: parsed.modelId, temperature: parsed.temperature,
    maxTokens: parsed.maxTokens, topP: parsed.topP, extra: parsed.extra, thinking: asks,
    label: parsed.label, selectable: parsed.selectable, rank: parsed.rank, model: parsed.model,
  };

  let modelDoc = findById(db, modelsMapping(), config.modelId);
  if (modelDoc == "") {
    return failed(agent.agentName, "no model " + config.modelId);
  }
  let model: ModelRow = JSON.parse<ModelRow>(modelDoc);
  if (!model.enabled) {
    return failed(agent.agentName, model.label + " is disabled");
  }

  let configRow: ModelConfigRow = {
    id: config.id, modelId: config.modelId, temperature: config.temperature,
    maxTokens: config.maxTokens, topP: config.topP, extra: config.extra, thinking: config.thinking,
    label: config.label, selectable: config.selectable, rank: config.rank,
  };

  let key = credentialFor(db, model.provider, master);
  if (key == "") {
    return failed(agent.agentName, "no usable credential for " + model.provider);
  }

  let mounted = mountTools(db, agent.id, master, where.owner);
  if (stillWaiting(mounted) > 0) {
    let named = userText.toLowerCase();
    let sv: int = 0;
    while (sv < mounted.servers.length) {
      if (named.includes(mounted.servers[sv].serverName.toLowerCase())) {
        let warm = findTools(mounted, userText, FIND_TOOLS_CAP);
        mounted = warm.mounted;
        break;
      }
      sv = sv + 1;
    }
  }
  let specs = toolSpecs(mounted);
  let webSpecs = webSearchTools();
  let ws: int = 0;
  while (ws < webSpecs.length) {
    specs.push(webSpecs[ws]);
    ws = ws + 1;
  }
  if (stillWaiting(mounted) > 0) {
    specs.push(findToolsSpec(mounted));
  }

  if (threadId != "") {
    let ws = workspaceTools();
    let w: int = 0;
    while (w < ws.length) {
      specs.push(toolSpec(ws[w].name, ws[w].description, ws[w].schema));
      w = w + 1;
    }
    let arts = artifactTools();
    let a: int = 0;
    while (a < arts.length) {
      specs.push(arts[a]);
      a = a + 1;
    }
    let scripts = scriptTools(db);
    let sc: int = 0;
    while (sc < scripts.length) {
      specs.push(scripts[sc]);
      sc = sc + 1;
    }
    if (maySchedule(where.owner)) {
      let anywhere = where.scope == "";
      let sched = taskTools();
      let td: int = 0;
      while (td < sched.length && (anywhere || where.scope == "tasks")) {
        specs.push(sched[td]);
        td = td + 1;
      }
      let flows = workflowTools();
      let wf: int = 0;
      while (wf < flows.length && (anywhere || where.scope == "workflows")) {
        specs.push(flows[wf]);
        wf = wf + 1;
      }
      let bots = triggerTools();
      let bt: int = 0;
      while (bt < bots.length && (anywhere || where.scope == "workflows")) {
        specs.push(bots[bt]);
        bt = bt + 1;
      }
      let selves = agentTools();
      let ag: int = 0;
      while (ag < selves.length && anywhere) {
        specs.push(selves[ag]);
        ag = ag + 1;
      }
      let groups = projectTools();
      let pj: int = 0;
      while (pj < groups.length && (anywhere || where.scope == "projects")) {
        specs.push(groups[pj]);
        pj = pj + 1;
      }
      let knowing = knowledgeTools();
      let kn: int = 0;
      while (kn < knowing.length && (anywhere || where.scope == "knowledge")) {
        specs.push(knowing[kn]);
        kn = kn + 1;
      }
    }
  }

  let skills = skillTools(db, agent.id);
  let sk: int = 0;
  while (sk < skills.length) {
    specs.push(skills[sk]);
    sk = sk + 1;
  }

  let notes: string[] = [];
  let n: int = 0;
  while (n < mounted.faults.length) {
    notes.push(mounted.faults[n]);
    n = n + 1;
  }

  let children: AgentRow[] = [];
  let deeper = depth + 1;
  if (depth < MAX_DEPTH) {
    let offered = agentChildren(db, agent.id);
    let c: int = 0;
    while (c < offered.length) {
      let child = offered[c];
      let name = delegateToolName(child.agentName);
      if (!child.enabled) {
        notes.push(child.agentName + " is disabled, so it cannot be delegated to");
      } else if (onPath(path, child.id) || child.id == agent.id) {
        notes.push("delegating to " + child.agentName + " would go back to an agent already in this chain");
      } else if (nameTaken(specs, name)) {
        notes.push("a tool is already called \"" + name + "\", so " + child.agentName + " was not offered");
      } else {
        specs.push(toolSpec(name, delegateDescription(child), delegateSchema()));
        children.push(child);
      }
      c = c + 1;
    }
  } else if (agentChildren(db, agent.id).length > 0) {
    notes.push("at depth " + `${depth}` + " this agent runs alone: its children are past the delegation limit");
  }

  let below = path;
  below.push(agent.id);

  let trace = tracer;
  let on = tracing(tracer);
  let agentSpan = startSpan(agent.agentName, TRACE_AGENT, parentSpan);

  clearPartial(db, threadId, stamp());

  let retrieved: Retrieved[] = [];
  let want = retrievalFor(db, agent.id);
  let retrieveSpan = startSpan("retrieve", TRACE_RETRIEVER, agentSpan.id);
  if (want.embeddingModelId != "") {
    if (!want.enabled) {
      notes.push("retrieval is switched off for " + agent.agentName);
    } else if (db.name != "postgres") {
      notes.push("retrieval needs PostgreSQL (pgvector); this runs on " + db.name + ", so " + agent.agentName + " answered without its documents");
    } else {
      let embedder = embeddingModel(db, want.embeddingModelId);
      let granted = agentScopes(db, agent.id);
      if (embedder.id == "") {
        notes.push("no usable embedding model " + want.embeddingModelId + " — it must exist and be an embedding model, not a chat one");
      } else if (granted.length == 0) {
        notes.push(agent.agentName + " has no scopes granted, so it read nothing");
      } else {
        let embedKey = credentialFor(db, embedder.provider, master);
        if (embedKey == "") {
          notes.push("no credential for " + embedder.provider + ", so nothing was retrieved");
        } else {
          let found = retrieveExcluding(db, embedder, granted, excludeChunks, userText, want.topK, embedKey);
          if (!found.ok) {
            notes.push("retrieval failed: " + found.error);
          } else {
            retrieved = withinDistance(found.found, want.maxDistance);
            if (retrieved.length == 0) {
              notes.push("nothing within " + `${want.maxDistance}` + " of the question in " + granted.join(", "));
            }
          }
        }
      }
    }
  }

  if (on && want.embeddingModelId != "") {
    trace = endSpan(trace, retrieveSpan, { input: userText, output: passageSummary(retrieved) });
  }

  let webFound: WebPassage[] = [];
  let webWant = webRagFor(db, agent.id);
  if (webWant.enabled) {
    let webSpan = startSpan("web-retrieve", TRACE_RETRIEVER, agentSpan.id);
    let webQuery = generateQuery(db, webWant, userText, master);
    let webGot = retrieveWeb(webQuery, webWant.topK, webWant.maxChars);
    if (!webGot.ok) {
      notes.push("web retrieval failed: " + webGot.error);
    } else {
      webFound = webGot.found;
      if (webFound.length == 0) {
        notes.push("the web index had nothing for \"" + webQuery + "\"");
      } else {
        notes.push(webSummary(webQuery, webFound));
      }
    }
    if (on) {
      trace = endSpan(trace, webSpan, {
        input: webQuery,
        output: `${webFound.length}` + " passages",
      });
    }
  }

  let context: Turn[] = [];
  let carried: int = 0;
  while (carried < prior.length) {
    context.push(prior[carried]);
    carried = carried + 1;
  }
  if (retrieved.length > 0) {
    context.push(userTurn(asContext(retrieved)));
  }
  if (webFound.length > 0) {
    context.push(userTurn(asWebContext(webFound)));
  }
  context.push(userTurn(userText));
  let steps: AgentStep[] = [];
  let calledTools: string[] = [];
  let calledAgents: string[] = [];
  let answer = "";
  let system = prompt.body;
  let skillLines = skillBriefing(db, agent.id);
  if (skillLines != "") {
    system = system + "\n\n" + skillLines;
  }
  let envLines = envBriefing(db);
  if (envLines != "") {
    system = system + "\n\n" + envLines;
  }

  let waitingLines = deferredBriefing(mounted);
  if (waitingLines != "") {
    system = system + "\n\n" + waitingLines;
  }

  let cases = casesBriefing(db);
  if (cases != "") {
    system = system + "\n\n" + cases;
  }

  if (mounted.tools.length > 0 || stillWaiting(mounted) > 0) {
    system = system + "\n\n" + NO_PLACEHOLDER_ARGS;
  }

  if (threadId != "") {
    system = system + "\n\n" + FILE_FENCE;
    let briefing = artifactBriefing(db, threadId);
    if (briefing != "") {
      system = system + "\n\n" + briefing;
    }
    let project = projectBriefing(db, threadId);
    if (project != "") {
      system = system + "\n\n" + project;
    }
  }

  system = system + "\n\n" + TEXT_CARD;

  let last: Completion = {
    ok: false,
    text: "",
    status: 0,
    error: "",
    inputTokens: 0,
    outputTokens: 0,
    counted: false,
  };
  let inputTokens: int = 0;
  let outputTokens: int = 0;
  let rounds: int = 0;


  while (rounds < MAX_TOOL_STEPS) {
    if (cancelAsked(db, threadId)) {
      if (on) {
        trace = endSpan(trace, agentSpan, { input: userText, output: CANCELLED_TEXT });
      }
      return report(agent, prompt, model, notes, context, steps, last, CANCELLED_TEXT, "cancelled", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
    }
    let modelSpan = startSpan(model.apiName, TRACE_GENERATION, agentSpan.id);
    let thinkingSeq = where.baseSeq;
    let thinkingDepth = where.depth;
    let thinkingRotation = rounds;
    if (model.provider == "anthropic") {
      last = completeTurns(model, configRow, system, context, specs, key);
    } else {
      last = streamTurns(model, configRow, system, context, specs, key, (soFar: string, saidSoFar: string) => {
        recordThought(db, threadId, thinkingSeq, thinkingDepth, thinkingRotation, soFar, stamp());
        if (thinkingDepth == 0) {
          recordPartial(db, threadId, thinkingSeq, saidSoFar, stamp());
        }
      }, () => cancelAsked(db, threadId));
      if (cancelAsked(db, threadId)) {
        if (on) {
          trace = endSpan(trace, agentSpan, { input: userText, output: CANCELLED_TEXT });
        }
        return report(agent, prompt, model, notes, context, steps, last, CANCELLED_TEXT, "cancelled", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
      }
    }
    rounds = rounds + 1;
    if (!last.ok) {
      if (on) {
        trace = endSpanFailed(trace, modelSpan, { input: userText, message: last.error });
        trace = endSpanFailed(trace, agentSpan, { input: userText, message: last.error });
      }
      let refused = report(agent, prompt, model, notes, context, steps, last, "", "refused", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
      return refused;
    }
    if (on) {
      let call: GenerationCall = {
        model: model.apiName,
        temperature: configRow.temperature,
        maxTokens: configRow.maxTokens,
        input: userText,
        output: replyText(model.provider, last.text),
        inputTokens: last.inputTokens,
        outputTokens: last.outputTokens,
      };
      trace = endGeneration(trace, modelSpan, call);
    }

    inputTokens = inputTokens + last.inputTokens;
    outputTokens = outputTokens + last.outputTokens;

    let cut = truncationFault(model.provider, last.text, configRow.maxTokens);
    if (cut != "") {
      if (on) {
        trace = endSpanFailed(trace, agentSpan, { input: userText, message: cut });
      }
      let stopped: Completion = {
        ok: false, text: last.text, status: last.status, error: cut,
        inputTokens: last.inputTokens, outputTokens: last.outputTokens, counted: last.counted,
      };
      return report(agent, prompt, model, notes, context, steps, stopped, "", "refused", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
    }

    let calls = toolCallsFrom(model.provider, last.text);
    let said = assistantText(model.provider, last.text);
    recordThought(db, threadId, where.baseSeq, where.depth, rounds - 1,
      assistantThinking(model.provider, last.text), stamp());

    if (calls.length == 0) {
      answer = replyText(model.provider, last.text);
      if (on) {
        trace = endSpan(trace, agentSpan, { input: userText, output: answer });
      }
      return report(agent, prompt, model, notes, context, steps, last, answer, "final", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
    }

    context.push(assistantTurn(said.text, calls));

    let i: int = 0;
    while (i < calls.length) {
      if (cancelAsked(db, threadId)) {
        if (on) {
          trace = endSpan(trace, agentSpan, { input: userText, output: CANCELLED_TEXT });
        }
        return report(agent, prompt, model, notes, context, steps, last, CANCELLED_TEXT, "cancelled", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
      }
      if (steps.length >= MAX_TOOL_STEPS) {
        let cutSaid = said.text;
        if (cutSaid == "") {
          cutSaid = closingWord(model, configRow, system, context, key);
        }
        if (on) {
          trace = endSpan(trace, agentSpan, { input: userText, output: cutSaid });
        }
        return report(agent, prompt, model, notes, context, steps, last, cutSaid, "max_steps", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
      }
      let child = childFor(children, calls[i].name);
      let resultText = "";
      let resultOk = false;
      let from = serverOf(mounted, calls[i].name);
      let callSpan = startSpan(calls[i].name, TRACE_TOOL, agentSpan.id);
      let now = stamp();
      let liveKind = "tool";
      if (child.id != "") {
        liveKind = "agent";
      }
      let live: StepStart = {
        threadId: threadId, seq: where.baseSeq, depth: where.depth,
        rotation: rounds - 1, idx: steps.length,
        kind: liveKind, name: calls[i].name, target: child.id,
        args: calls[i].args, now: now,
      };
      let startedMs = Date.now();
      if (threadId != "") {
        beginStep(db, live);
      }
      let sameBefore: int = 0;
      let priorStep: int = 0;
      while (priorStep < steps.length) {
        if (steps[priorStep].tool == calls[i].name && steps[priorStep].args == calls[i].args) {
          sameBefore = sameBefore + 1;
        }
        priorStep = priorStep + 1;
      }
      let repeatCap: int = 2;
      if (calls[i].name == "use_skill") {
        repeatCap = 1;
      }
      if (sameBefore >= repeatCap) {
        let stuck = "You already made this exact call this turn"
          + (sameBefore > 1 ? " " + `${sameBefore}` + " times" : "")
          + ", and the result has not changed. Do not repeat it. Act on the result you"
          + " already have: follow the instructions above, or answer the person with"
          + " what you know. If the call failed, change something about it before"
          + " trying again.";
        let stuckStep: AgentStep = { index: steps.length, tool: calls[i].name,
          server: "loop-guard", args: calls[i].args, result: stuck, ok: false };
        steps.push(stuckStep);
        if (threadId != "") {
          let stuckTook = parseInt(`${Date.now() - startedMs}`, 10) ?? -1;
          let stuckClose: StepClose = { ok: false, endedAt: stamp(),
            millis: stuckTook, line: 0, changed: "", result: stuck };
          endStepAt(db, live, stuckClose);
        }
        context.push(toolTurn(calls[i].id, calls[i].name, stuck));
        i = i + 1;
        continue;
      }
      let fileAnswer = callWorkspaceTool(db, threadId, calls[i].name,
        jsonText(calls[i].args, "name"), jsonText(calls[i].args, "content"), now);
      let artifactAnswer = callArtifactTool(db, {
        threadId: threadId, agentId: agentId, name: calls[i].name, args: calls[i].args,
        turnSeq: where.baseSeq, now: now,
      });
      let scripted = callScriptTool(db, {
        threadId: threadId, agentId: agentId, name: calls[i].name, args: calls[i].args,
        turnSeq: where.baseSeq, now: now,
      });
      let skilled = callSkillTool(db, {
        agentId: agentId, name: calls[i].name, args: calls[i].args,
      });
      let scheduled = callTaskTool(db, {
        owner: where.owner, agentId: agentId, modelChoiceId: "",
        name: calls[i].name, args: calls[i].args, nowMs: Date.now() as number,
      });
      let flowed = callWorkflowTool(db, {
        owner: where.owner, agentId: agentId,
        name: calls[i].name, args: calls[i].args, nowMs: Date.now() as number,
      });
      let botted = callTriggerTool(db, {
        owner: where.owner, name: calls[i].name, args: calls[i].args,
        nowMs: Date.now() as number,
      });
      let selfed = callAgentTool(db, {
        owner: where.owner, name: calls[i].name, args: calls[i].args,
        nowMs: Date.now() as number,
      });
      let grouped = callProjectTool(db, {
        owner: where.owner, threadId: threadId,
        name: calls[i].name, args: calls[i].args, nowMs: Date.now() as number,
      });
      let known = callKnowledgeTool(db, {
        owner: where.owner, name: calls[i].name, args: calls[i].args,
        nowMs: Date.now() as number,
      });
      let websearched = callWebSearchTool(calls[i].name, calls[i].args);
      let linkread = callReadLinkTool(calls[i].name, calls[i].args);
      if (calls[i].name == "find_tools") {
        let query = jsonText(calls[i].args, "query");
        if (query == "") {
          resultText = "Say what you are trying to do: find_tools takes {\"query\":\"list issues\"}.";
          resultOk = false;
        } else {
          let got = findTools(mounted, query, FIND_TOOLS_CAP);
          mounted = got.mounted;
          if (got.found.length == 0) {
            resultText = "Nothing matched \"" + query + "\". "
              + `${stillWaiting(mounted)}` + " tools are still waiting; try other words "
              + "for what you want to do.";
            resultOk = false;
          } else {
            let f: int = 0;
            let named: string[] = [];
            while (f < got.found.length) {
              specs.push(toolSpec(got.found[f].name, got.found[f].description, got.found[f].schema));
              named.push(got.found[f].name);
              f = f + 1;
            }
            resultText = "You can now call: " + named.join(", ") + ".";
            resultOk = true;
          }
        }
        from = "tools";
        calledTools.push(calls[i].name);
      } else if (fileAnswer.handled) {
        resultOk = fileAnswer.ok;
        resultText = fileAnswer.text;
        from = "workspace";
        calledTools.push(calls[i].name);
      } else if (artifactAnswer.handled) {
        resultOk = artifactAnswer.ok;
        resultText = artifactAnswer.text;
        from = "artifacts";
        calledTools.push(calls[i].name);
      } else if (scripted.handled) {
        resultOk = scripted.ok;
        resultText = scripted.text;
        from = "scripts";
        calledTools.push(calls[i].name);
      } else if (scheduled.handled) {
        resultOk = scheduled.ok;
        resultText = scheduled.text;
        from = "tasks";
        calledTools.push(calls[i].name);
      } else if (flowed.handled) {
        resultOk = flowed.ok;
        resultText = flowed.text;
        from = "workflows";
        calledTools.push(calls[i].name);
      } else if (botted.handled) {
        resultOk = botted.ok;
        resultText = botted.text;
        from = "triggers";
        calledTools.push(calls[i].name);
      } else if (selfed.handled) {
        resultOk = selfed.ok;
        resultText = selfed.text;
        from = "agents";
        calledTools.push(calls[i].name);
      } else if (grouped.handled) {
        resultOk = grouped.ok;
        resultText = grouped.text;
        from = "projects";
        calledTools.push(calls[i].name);
      } else if (known.handled) {
        resultOk = known.ok;
        resultText = known.text;
        from = "knowledge";
        calledTools.push(calls[i].name);
      } else if (linkread != "") {
        resultOk = true;
        resultText = linkread;
        from = "web-index";
        calledTools.push(calls[i].name);
      } else if (websearched != "") {
        resultOk = true;
        resultText = websearched;
        from = "web-index";
        calledTools.push(calls[i].name);
      } else if (skilled.handled) {
        resultOk = skilled.ok;
        resultText = skilled.text;
        from = "skills";
        calledTools.push(calls[i].name);
      } else if (child.id != "") {
        let question = jsonText(calls[i].args, "question");
        if (question == "") {
          resultText = "Ask a question: this agent takes {\"question\":\"...\"} and cannot see your conversation.";
        } else {
          let childPrior: Turn[] = [];
          let noChildChunks: string[] = [];
          let below2: RunContext = {
            depth: deeper, path: below, tracer: tracerForCallee(trace),
            parentSpan: callSpan.id, prior: childPrior, threadId: threadId,
            excludeChunks: noChildChunks,
            modelConfigId: "",
            baseSeq: where.baseSeq,
            owner: where.owner,
            think: where.think,
            scope: where.scope,
          };
          let asked = runAgentAt(db, child.id, question, master, below2);
          if (on) {
            trace = tracerWithMoreSpans(trace, asked.spans);
          }
          inputTokens = inputTokens + asked.inputTokens;
          outputTokens = outputTokens + asked.outputTokens;
          calledAgents.push(child.agentName);
          calledAgents = withAll(calledAgents, asked.calledAgents);
          calledTools = withAll(calledTools, asked.calledTools);
          resultOk = asked.ok;
          resultText = asked.text;
          if (!asked.ok) {
            resultText = child.agentName + " could not answer: " + asked.error;
          }
          let broke = failedSteps(asked.steps);
          if (broke > 0) {
            notes.push(child.agentName + " answered after " + `${broke}` + " of its own tool calls failed; its answer may not be grounded");
          }
          let cn: int = 0;
          while (cn < asked.notes.length) {
            notes.push(child.agentName + ": " + asked.notes[cn]);
            cn = cn + 1;
          }
          from = child.agentName;
        }
      } else {
        if (mountedIndex(mounted.tools, calls[i].name) < 0) {
          let recalled = findTools(mounted, calls[i].name, 1);
          if (recalled.found.length > 0) {
            mounted = recalled.mounted;
            specs = toolSpecs(mounted);
            if (stillWaiting(mounted) > 0) {
              specs.push(findToolsSpec(mounted));
            }
          }
        }
        let answered = callMounted(mounted, calls[i].name, calls[i].args);
        resultOk = answered.ok;
        resultText = answered.text;
        if (!resultOk && stillWaiting(mounted) > 0) {
          resultText = resultText + "\n\nIf this failed because an id or name "
            + "was missing or guessed, do not ask the person for it: call "
            + "find_tools for a tool that lists those (\"list teams\", \"list "
            + "projects\"), call it, take the id from its answer, and retry "
            + "this tool.";
        }
        if (resultOk) {
          resultText = resultText + cardHintFor(db, calls[i].name);
        }
        calledTools.push(calls[i].name);
      }
      if (on) {
        trace = endTool(trace, callSpan, { input: calls[i].args, output: resultText }, resultOk);
      }
      if (threadId != "") {
        let done: StepStart = {
          threadId: live.threadId, seq: live.seq, depth: live.depth,
          rotation: live.rotation, idx: live.idx, kind: live.kind,
          name: live.name, target: from, args: live.args, now: live.now,
        };
        let took = parseInt(`${Date.now() - startedMs}`, 10) ?? -1;
        let editLine = artifactAnswer.handled && artifactAnswer.ok ? artifactAnswer.line : 0;
        let scriptChanged = scripted.handled ? scripted.changed : "";
        let close: StepClose = {
          ok: resultOk, endedAt: stamp(), millis: took,
          line: editLine, changed: scriptChanged, result: resultText,
        };
        endStepAt(db, done, close);
      }
      let step: AgentStep = {
        index: steps.length,
        tool: calls[i].name,
        server: from,
        args: calls[i].args,
        result: resultText,
        ok: resultOk,
      };
      steps.push(step);
      context.push(toolTurn(calls[i].id, calls[i].name, resultText));
      i = i + 1;
    }
  }

  if (answer == "") {
    answer = closingWord(model, configRow, system, context, key);
  }
  if (on) {
    trace = endSpan(trace, agentSpan, { input: userText, output: answer });
  }
  return report(agent, prompt, model, notes, context, steps, last, answer, "max_steps", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
}

function spansOf(on: bool, t: Tracer): RecordedSpan[] {
  if (!on) {
    let none: RecordedSpan[] = [];
    return none;
  }
  return tracerSpans(t);
}

function withAll(into: string[], more: string[]): string[] {
  let out = into;
  let i: int = 0;
  while (i < more.length) {
    if (!hasName(out, more[i])) {
      out.push(more[i]);
    }
    i = i + 1;
  }
  return out;
}

export function hasName(names: string[], name: string): bool {
  let i: int = 0;
  while (i < names.length) {
    if (names[i] == name) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

function passageSummary(found: Retrieved[]): string {
  if (found.length == 0) {
    return "nothing retrieved";
  }
  let out = "";
  let i: int = 0;
  while (i < found.length) {
    if (i > 0) {
      out = out + "\n";
    }
    out = out + found[i].scope + "/" + found[i].source + "  distance " + `${found[i].distance}`;
    i = i + 1;
  }
  return out;
}

function withinDistance(found: Retrieved[], maxDistance: number): Retrieved[] {
  let out: Retrieved[] = [];
  let i: int = 0;
  while (i < found.length) {
    if (found[i].distance <= maxDistance) {
      out.push(found[i]);
    }
    i = i + 1;
  }
  return out;
}

function failedSteps(steps: AgentStep[]): int {
  let n: int = 0;
  let i: int = 0;
  while (i < steps.length) {
    if (!steps[i].ok) {
      n = n + 1;
    }
    i = i + 1;
  }
  return n;
}

function onPath(path: string[], agentId: string): bool {
  let i: int = 0;
  while (i < path.length) {
    if (path[i] == agentId) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

function nameTaken(specs: ToolSpec[], name: string): bool {
  let i: int = 0;
  while (i < specs.length) {
    if (specs[i].name == name) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

function childFor(children: AgentRow[], name: string): AgentRow {
  let i: int = 0;
  while (i < children.length) {
    if (delegateToolName(children[i].agentName) == name) {
      return children[i];
    }
    i = i + 1;
  }
  let none: AgentRow = {
    id: "",
    agentName: "",
    description: "",
    modelConfigId: "",
    promptId: "",
    scriptImageId: "",
    isDefault: false,
    enabled: false,
    updatedAt: "",
  };
  return none;
}

function closingWord(model: ModelRow, configRow: ModelConfigRow, system: string, context: Turn[], key: string): string {
  let asked: Turn[] = [...context, userTurn(
    "You have used every available tool step for this round. Do not call any tool. "
    + "Tell the user plainly what you changed, what the validator still refuses if anything, "
    + "and what you would do next.")];
  let noTools: ToolSpec[] = [];
  let said = completeTurns(model, configRow, system, asked, noTools, key);
  if (!said.ok) {
    return "";
  }
  return assistantText(model.provider, said.text).text;
}

function report(agent: AgentRow, prompt: PromptRow, model: ModelRow, notes: string[], context: Turn[], steps: AgentStep[], last: Completion, answer: string, stopReason: string, rounds: int, spans: RecordedSpan[], calledTools: string[], calledAgents: string[], retrieved: Retrieved[], inputTokens: int, outputTokens: int): AgentRun {
  let why = last.error;
  if (stopReason == "max_steps" && why == "") {
    why = "stopped after " + `${MAX_TOOL_STEPS}` + " tool steps without a final answer";
  }
  let out: AgentRun = {
    ok: stopReason == "cancelled"
      || (last.ok && (stopReason == "final" || (stopReason == "max_steps" && answer != ""))),
    text: answer,
    body: last.text,
    status: last.status,
    agentName: agent.agentName,
    promptVersion: prompt.version,
    modelApiName: model.apiName,
    error: why,
    context: context,
    steps: steps,
    stopReason: stopReason,
    rounds: rounds,
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    notes: notes,
    calledTools: calledTools,
    calledAgents: calledAgents,
    retrieved: retrieved,
    spans: spans,
  };
  return out;
}
