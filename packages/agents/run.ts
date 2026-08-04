// Running an agent: everything about it comes out of the database.
//
//   let answer = runAgent(db, "a1", "What is 2+40?", masterKey());
//
// The prompt, the model, the wire name, the temperature, the key and the tools
// are all rows. Nothing here names a model or holds a credential, so changing
// which model an agent runs on, rolling its prompt back a version, or giving
// it another MCP server is an UPDATE or an INSERT and takes effect on the next
// call.
//
// A run has two kinds of state and they are kept apart deliberately:
//
//   - the *context*, which is what the model was shown — every turn, every
//     tool call, every tool result;
//   - the *answer*, which is what a person reads.
//
// They are not the same thing and one is not a filtered view of the other: the
// context holds a tool's 4,000-line output that nobody wants to read, and a
// transcript holds nothing about the six calls that produced one sentence.
// Conflating them is how a chat window ends up showing JSON, and how a model
// ends up being re-sent a summary of its own tool calls instead of the calls.

import { Db } from "../plume/driver.ts";
import { findById } from "../plume/plume.ts";
import { AgentRow, PromptRow, ModelRow, ModelConfigRow, modelsMapping, modelConfigsMapping, promptsMapping, agentsMapping, cancelAsked } from "./schema.ts";
import { credentialFor } from "./credentials.ts";
import { Completion, ToolSpec, ToolCall, Turn, toolSpec, complete, completeTurns, streamTurns, replyText, assistantText, assistantThinking, toolCallsFrom, truncationProblem, userTurn, assistantTurn, toolTurn } from "./provider.ts";
import { Mounted, mountTools, toolSpecs, callMounted, serverOf, findTools, findToolsSpec, stillWaiting, deferredBriefing, TEXT_CARD, agentChildren, delegateToolName, delegateDescription, delegateSchema, artifactTools, callArtifactTool, scriptTools, envBriefing, callScriptTool, skillTools, callSkillTool, skillBriefing, FILE_FENCE } from "./tools.ts";
import { TURN_SEQ_NONE, artifactBriefing } from "./artifacts.ts";
import { StepStart, StepClose, beginStep, endStep, endStepAt, recordThought, recordPartial } from "./steps.ts";
import { jsonText } from "./scan.ts";
import { Retrieved, embeddingModel, agentScopes, retrievalFor, retrieve, retrieveExcluding, asContext } from "./knowledge.ts";
import { FileToolResult, workspaceTools, callWorkspaceTool } from "./workspace.ts";
import { GenerationCall, Tracer, TraceSpan, RecordedSpan, startSpan, endSpan, endSpanFailed, endGeneration, endTool, tracerSpans, tracerWithMoreSpans, tracerForCallee, noTracer, tracing, TRACE_AGENT, TRACE_GENERATION, TRACE_TOOL, TRACE_RETRIEVER } from "../tracing/tracing.ts";

// How many times a run may go back to the model after calling tools.
//
// A constant, and it should be a column: it is exactly the kind of knob this
// package exists to keep in the database. It is not one yet because the agents
// table is created from its mapping, so adding a field rewrites an applied
// migration and the checksum refuses it — a real question about how the schema
// evolves, and not one to answer silently in passing.
//
// Eight stood here until a real repair spent exactly eight — load the skill,
// fix the syntax an upload arrived with (three edits), read, validate,
// validate again — and had none left for the answer, twice, on the task this
// package is for. Twelve fitted that pipeline with an answer to spare.
//
// Twelve then proved too few for the shape this package exists for: inserting
// a step into a graph — validate, read the schema, compose, edit, revalidate,
// repair what the validator refuses, revalidate again — spends every one of
// them and answers with an apology. Eighteen is that pipeline with room for
// two rounds of repair. Read from the environment because the ceiling is a
// deployment's call, not a constant: a cloud tier may want more, a demo box
// fewer, and neither should need a rebuild.
const MAX_TOOL_STEPS: int = maxToolSteps();
/* How many tools one find_tools call may mount.
 *
 * Eight. The point of deferring is that a model gets what it needs and not a
 * roster, and a query broad enough to match forty tools has undone the saving
 * it was called to make — better that it asks twice. */
const FIND_TOOLS_CAP: int = 8;

// What a cancelled turn says. A sentence rather than silence, because the
// transcript keeps the turn: the person pressed stop, and the row that
// records it should read as that.
const CANCELLED_TEXT: string = "Stopped at your request.";

function maxToolSteps(): int {
  let said = process.env["AGENTS_MAX_TOOL_STEPS"] ?? "";
  if (said == "") { return 18; }
  let n = parseInt(said, 10) ?? 18;
  if (n < 1) { return 18; }
  return n;
}

// How deep delegation may go. A parent asking a specialist which asks another
// is reasonable; a chain longer than this is a graph the builder should look
// at rather than a plan.
//
// This is a bound, not the cycle check. `agent_sub_agents` accepts a cycle —
// the schema's own suite inserts one to prove it — so a run also refuses to
// enter an agent already on its path, which stops A→B→A immediately rather
// than three levels later.
const MAX_DEPTH: int = 3;

// One clock for every row a run writes.
//
// The tool dispatch below passed the literal string "now" for a workspace
// write, so every file the model wrote carried four letters in `updated_at`.
// Nothing failed: the column is text, the row stored, the listing rendered —
// and every sort by recency put the model's own files in an order that meant
// nothing, because "now" compares against a millisecond count as a word. The
// API had already grown its own `stamp()` after six routes did the same thing;
// this is the last call site, and the one a person never touches.
//
// Private to each file for now. A run and an API request writing timestamps
// through two copies of one line is a shared helper waiting to be written, but
// not one to introduce from inside a bug fix.
function stamp(): string { return `${Date.now()}`; }

// model_configs declares a hasOne("model") relation, so its document carries
// the model nested. Named here because a record type must declare every key
// the document has, even one this path reads separately.
type NestedModel = { id: string, label: string, apiName: string, provider: string, enabled: bool };
type ConfigWithModel = {
  id: string, modelId: string, temperature: number, maxTokens: int, topP: number, extra: string, thinking: string,
  // The menu's three columns (82.1–82.3). Nothing on this path reads them —
  // what a config is called and whether it is offered has no bearing on a
  // completion — but the document carries them, and a record that does not
  // declare a key the document has is a parse failure.
  label: string, selectable: bool, rank: int,
  model: NestedModel,
};

// One tool call and what came back. This is context, not conversation: it is
// what a run did, for whoever has to work out why it answered as it did.
export type AgentStep = {
  index: int,
  tool: string,
  // Which MCP server answered, so a wrong answer can be traced to the thing
  // that gave it.
  server: string,
  args: string,
  result: string,
  ok: bool,
};

export type AgentRun = {
  ok: bool,
  // The assistant's text — the one field a user is meant to read.
  text: string,
  // The provider's whole last reply, for token counts and finish reasons.
  body: string,
  status: int,
  // Which agent, prompt version and model actually served the call, so a
  // caller can record what answered rather than what it assumed.
  agentName: string,
  promptVersion: int,
  modelApiName: string,
  error: string,
  // Everything the model was shown, in order. Not for display.
  context: Turn[],
  // The passages retrieved for this run, if it retrieves. Returned so a caller
  // can show sources and an evaluation can check which folder an answer came
  // off — the answer alone cannot tell you.
  retrieved: Retrieved[],
  // Every tool call the run made.
  steps: AgentStep[],
  // "final", "max_steps" or "refused".
  stopReason: string,
  // How many times the model was asked, and what it cost — this run and
  // everything it delegated to. Zero when the provider did not say.
  rounds: int,
  inputTokens: int,
  outputTokens: int,
  // What could not be mounted. An agent whose server is down still answers,
  // and whoever reads the run should know it answered with one hand tied.
  notes: string[],
  // Every tool actually dispatched anywhere in this run, including inside
  // sub-agents, and every sub-agent actually asked. `steps` holds only what
  // *this* agent did; a tool called by a child appears in neither its steps
  // nor its trace-free callers, and "did it call the stock tool" is a
  // question about the tree, not about the top of it.
  //
  // Names, not calls: what an evaluation asks is which tools were reached,
  // and the arguments are already in the steps and the trace.
  calledTools: string[],
  calledAgents: string[],
  // The trace this run recorded, encoded, including everything its children
  // recorded below it. Empty when tracing is off, which is the default.
  //
  // Spans rather than a tracer because records are immutable: a child cannot
  // hand its tracer back, so it hands back what it recorded and the caller
  // folds it in. The top of the run flushes.
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

// Run a user's text through an agent. Every refusal names what was missing,
// because "it did not answer" is the least useful thing a caller can be told.
// Where a run sits: how deep, under which span, in which thread, with what
// already said and what has already been shown.
//
// These were seven more positional parameters on the end of an eleven-argument
// call. `parentSpan` and `threadId` are both ids, both "" at the top, and only
// a Turn[] apart — swapped, spans hang off a thread id while the workspace
// tools scope to a span id, so the agent silently loses its file tools and the
// trace silently reparents. Neither reports anything.
export type RunContext = {
  depth: int,
  // The chain of agent ids from the top down, so a child that would re-enter
  // one is refused by name.
  path: string[],
  tracer: Tracer,
  parentSpan: string,
  prior: Turn[],
  threadId: string,
  excludeChunks: string[],
  // The model_configs row this turn must run on, or "" for the agent's own —
  // which is what every run that chose nothing means, so nothing below has to
  // know the feature exists.
  //
  // A config and not a choice id: precedence between the message, the thread
  // and the agent is a conversation's question and threads.ts answers it
  // (`chooseModel`). What reaches here is the row that won, so there is one
  // resolution rather than one per door.
  //
  // A delegated child does NOT inherit it — the literal below passes "". A
  // sub-agent is a different agent running a model its operator chose for it,
  // and pushing the user's pick down the tree would silently re-price every
  // delegation: "Thinking" on the lead would put every scout on the expensive
  // model too, which is not what the person picking it asked for.
  modelConfigId: string,
  // The thread's turn seq at this round's base — the number every artifact
  // write of the round is stamped with, whichever door and whichever agent
  // makes it. A delegated child inherits its parent's, because the child's
  // writes belong to the round that delegated. TURN_SEQ_NONE for a run no
  // thread holds, where the artifact tools are not offered anyway.
  baseSeq: int,
  // Whose conversation this run answers — the thread's owner tag, "" for a
  // bare run or an unowned deployment. What it buys is per-person connector
  // tokens: a server whose caller stored their own credential calls out as
  // that person rather than as the deployment. Set by threads.ts, which is
  // the door that knows; a delegated child inherits it, because the child is
  // doing the same person's work on the same person's connectors.
  owner: string,
  // Whether this turn asked the model to think out loud before answering.
  //
  // False is not "no opinion": a reasoning model reasons unless told not to,
  // and the thinking is charged to the same token budget the answer comes out
  // of. A local 8B with the switch left on spent its whole budget deliberating
  // and re-read the same skill five rounds running, which reads as a hang. So
  // a turn that did not ask says so, and `thinkingJson` turns that into the
  // provider's own spelling.
  //
  // A delegated child inherits it: a person asking for care wants it from the
  // agents the answer actually passes through, not only the first one.
  think: bool,
};

export function runAgent(db: Db, agentId: string, userText: string, master: string): AgentRun {
  let path: string[] = [];
  let fresh: Turn[] = [];
  let noChunks: string[] = [];
  let top: RunContext = { depth: 0, path: path, tracer: noTracer(), parentSpan: "", prior: fresh, threadId: "", excludeChunks: noChunks, modelConfigId: "", baseSeq: TURN_SEQ_NONE, owner: "", think: false };
  return runAgentAt(db, agentId, userText, master, top);
}

// The same run, traced. The tracer carries the collector's address and the
// trace id; every span this run and its children open hangs under `parentSpan`,
// which is "" at the top. The caller flushes — a run does not decide when a
// trace is sent, and a child must not send half of one.
export function runAgentTraced(db: Db, agentId: string, userText: string, master: string, tracer: Tracer): AgentRun {
  let path: string[] = [];
  let fresh: Turn[] = [];
  let noChunks: string[] = [];
  let top: RunContext = { depth: 0, path: path, tracer: tracer, parentSpan: "", prior: fresh, threadId: "", excludeChunks: noChunks, modelConfigId: "", baseSeq: TURN_SEQ_NONE, owner: "", think: false };
  return runAgentAt(db, agentId, userText, master, top);
}

// The same run, at a depth, knowing which agents are already above it.
//
// `path` is the chain of agent ids from the top down, so a child that would
// re-enter one is refused by name. Passed rather than tracked in a global: a
// server runs handlers on many threads, and one run's path is nothing to do
// with another's.
export function runAgentAt(db: Db, agentId: string, userText: string, master: string, where: RunContext): AgentRun {
  let depth = where.depth;
  let path = where.path;
  let tracer = where.tracer;
  let parentSpan = where.parentSpan;
  let prior = where.prior;
  let threadId = where.threadId;
  let excludeChunks = where.excludeChunks;
  // Read each row on its own rather than through agentsFull. A relation that
  // matches nothing is null, and a run needs its prompt, config and model to
  // exist — so a dangling reference should be named, not turned into a parse
  // failure against a type that declares them present.
  let agentDoc = findById(db, agentsMapping(), agentId);
  if (agentDoc == "") { return failed("", "no agent " + agentId); }
  let agent: AgentRow = JSON.parse<AgentRow>(agentDoc);
  if (!agent.enabled) { return failed(agent.agentName, agent.agentName + " is disabled"); }

  let promptDoc = findById(db, promptsMapping(), agent.promptId);
  if (promptDoc == "") { return failed(agent.agentName, "no prompt " + agent.promptId); }
  let prompt: PromptRow = JSON.parse<PromptRow>(promptDoc);

  // The agent's own config unless this turn was told otherwise. Refused by
  // name when the chosen one is not there, exactly as the agent's own is: a
  // menu row whose target config was deleted must stop the run rather than
  // quietly answer on a different model, because the only symptom of the
  // silent version is that "Thinking" stopped thinking (schema.ts,
  // `configForChoice`, which deliberately does not check this).
  let configId = agent.modelConfigId;
  if (where.modelConfigId != "") { configId = where.modelConfigId; }
  let configDoc = findById(db, modelConfigsMapping(db), configId);
  if (configDoc == "") { return failed(agent.agentName, "no model config " + configId); }
  let parsed: ConfigWithModel = JSON.parse<ConfigWithModel>(configDoc);
  // A turn that did not ask to think says so, rather than leaving the model to
  // its own default — which for a reasoning model is to think, at the expense
  // of the same budget the answer is drawn from. The config still decides HOW
  // much thinking (a budget, an effort); this decides whether any was asked
  // for at all, and only ever narrows: a config that never asks stays silent.
  let asks = parsed.thinking;
  if (!where.think) { asks = "off"; }
  let config: ConfigWithModel = {
    id: parsed.id, modelId: parsed.modelId, temperature: parsed.temperature,
    maxTokens: parsed.maxTokens, topP: parsed.topP, extra: parsed.extra, thinking: asks,
    label: parsed.label, selectable: parsed.selectable, rank: parsed.rank, model: parsed.model,
  };

  let modelDoc = findById(db, modelsMapping(), config.modelId);
  if (modelDoc == "") { return failed(agent.agentName, "no model " + config.modelId); }
  let model: ModelRow = JSON.parse<ModelRow>(modelDoc);
  // Refused here rather than at the provider, alongside the other refusals and
  // for the same reason mounting waits: a run that cannot happen should cost
  // no network call to find that out.
  if (!model.enabled) { return failed(agent.agentName, model.label + " is disabled"); }

  let configRow: ModelConfigRow = {
    id: config.id, modelId: config.modelId, temperature: config.temperature,
    maxTokens: config.maxTokens, topP: config.topP, extra: config.extra, thinking: config.thinking,
    label: config.label, selectable: config.selectable, rank: config.rank,
  };

  let key = credentialFor(db, model.provider, master);
  if (key == "") {
    return failed(agent.agentName, "no usable credential for " + model.provider);
  }

  // Only now, once the run is going to happen: mounting asks every linked
  // server what it offers, and a refused run should not have made a network
  // call to work out what it was refusing.
  let mounted = mountTools(db, agent.id, master, where.owner);
  let specs = toolSpecs(mounted);
  // One spec instead of a connector's whole roster. `mounted` and `specs` are
  // both rebuilt as the model asks for tools, which is why neither is const.
  if (stillWaiting(mounted) > 0) { specs.push(findToolsSpec(mounted)); }

  // In a thread, the conversation's files are tools like any others: a write
  // is a tool span in the trace and an expectation an eval can check. A bare
  // run has no workspace and offering tools that answer "no thread" is noise.
  if (threadId != "") {
    let ws = workspaceTools();
    let w: int = 0;
    while (w < ws.length) {
      specs.push(toolSpec(ws[w].name, ws[w].description, ws[w].schema));
      w = w + 1;
    }
    // The conversation's artifacts, on the same condition and for the same
    // reason: they are addressed within a thread, and a bare run has none to
    // write to. Already ToolSpecs, so nothing to re-wrap.
    let arts = artifactTools();
    let a: int = 0;
    while (a < arts.length) {
      specs.push(arts[a]);
      a = a + 1;
    }
    // Scripts, on the same thread-only condition plus one more: run_script
    // exists only where docker answers. scriptTools() probes the daemon once
    // per process and returns nothing when it is absent or broken, so the
    // tool is never offered where it could only fail — a model cannot call a
    // tool it was never told about (RUN-SCRIPT.md's last rule).
    let scripts = scriptTools(db);
    let sc: int = 0;
    while (sc < scripts.length) {
      specs.push(scripts[sc]);
      sc = sc + 1;
    }
  }

  // Skills ride the agent, not the thread — a bare run still has them, so
  // this sits outside the thread-gated block. Empty when the agent has none:
  // absent, not offered-and-failing.
  let skills = skillTools(db, agent.id);
  let sk: int = 0;
  while (sk < skills.length) {
    specs.push(skills[sk]);
    sk = sk + 1;
  }

  // Mounting's problems, plus delegation's, in one list. Copied rather than
  // appended to in place: a record's field is not a place to accumulate.
  let notes: string[] = [];
  let n: int = 0;
  while (n < mounted.problems.length) { notes.push(mounted.problems[n]); n = n + 1; }

  // The children, as tools beside the servers' — one loop covers both, so a
  // delegation shows up in the same trace and against the same budget as a
  // file read.
  //
  // At the depth limit an agent still runs; it just runs alone. Refusing the
  // whole run because a child was out of reach would turn a bounded plan into
  // no answer at all.
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
        // A cycle. Naming it beats descending until the depth limit stops it,
        // because the limit would report the wrong cause.
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

  // One span for the whole agent, and everything below hangs off it — the
  // model calls, the tool calls, and a delegated child's entire tree. That is
  // the shape the run log cannot hold: a row has no parent.
  let trace = tracer;
  let on = tracing(tracer);
  let agentSpan = startSpan(agent.agentName, TRACE_AGENT, parentSpan);

  // What this agent knows, fetched once and put in front of the question.
  //
  // Once, on the user's text: re-retrieving each round would need a query the
  // model has not written, and re-embedding after every tool result is cost
  // with no signal.
  //
  // Every way this can come up short leaves the run going and lands in `notes`.
  // An agent that answers without its documents looks exactly like one that
  // answered from them, which is the failure this package keeps meeting.
  let retrieved: Retrieved[] = [];
  let want = retrievalFor(db, agent.id);
  // The span opens before the work and closes after it whether or not anything
  // came back: a retrieval that found nothing is exactly the one somebody wants
  // to look at, and a missing span reads as a step that never ran.
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
          // Not what the thread already shows: those passages are in the
          // replay, and fetching them again would put them in the context
          // twice at full price. Excluded in the query so topK still means
          // "this many new ones".
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

  // Everything the thread already holds, then this question's passages, then
  // the question. The prior turns come first because they are what happened
  // first — a model handed its own tool calls out of order is being told a
  // different story than the one it took part in.
  let context: Turn[] = [];
  let carried: int = 0;
  while (carried < prior.length) { context.push(prior[carried]); carried = carried + 1; }
  if (retrieved.length > 0) {
    // Before the question, and in the context rather than the conversation:
    // the model reads it, the transcript does not.
    context.push(userTurn(asContext(retrieved)));
  }
  context.push(userTurn(userText));
  let steps: AgentStep[] = [];
  let calledTools: string[] = [];
  let calledAgents: string[] = [];
  let answer = "";
  // The prompt the model actually sees: the agent's own, plus what this
  // conversation has already produced. The briefing is references only — the
  // model asks for a body with read_artifact when it wants one — and it is
  // what lets a revision land on the existing path instead of forking a new
  // file: the model can only choose a file it has been shown exists.
  let system = prompt.body;
  // Skills before the thread block: they ride the agent, and a bare run is
  // briefed on them too. One line per skill — the body arrives only through
  // use_skill.
  let skillLines = skillBriefing(db, agent.id);
  if (skillLines != "") { system = system + "\n\n" + skillLines; }
  // And what it can run them IN. Beside the skills for the same reason they
  // are here rather than in a tool description: both answer "what can this
  // agent do", which a model settles before it picks a tool.
  let envLines = envBriefing(db);
  if (envLines != "") { system = system + "\n\n" + envLines; }

  // Tools the model has but has not been shown.
  //
  // The spec for find_tools describes itself perfectly well and a small model
  // still will not reach for it: asked to list Linear teams with 52 Linear
  // tools one call away, Qwen 3 8B answered "I cannot access your Linear
  // account" and made no tool call at all. It is not a wording problem in the
  // tool — a model decides what it CAN do from the system prompt, and nothing
  // there said its abilities were larger than the list in front of it.
  let waitingLines = deferredBriefing(mounted);
  if (waitingLines != "") { system = system + "\n\n" + waitingLines; }

  // How to hand back a passage somebody will want to copy.
  system = system + "\n\n" + TEXT_CARD;
  if (threadId != "") {
    // The fence convention rides the system prompt, not a tool description:
    // a model decides how to answer before it considers any particular tool,
    // and a fence is not a tool call. Same condition as the artifact tools —
    // a fence saves into the thread they address.
    system = system + "\n\n" + FILE_FENCE;
    let briefing = artifactBriefing(db, threadId);
    if (briefing != "") { system = system + "\n\n" + briefing; }
  }

  let last: Completion = { ok: false, text: "", status: 0, error: "", inputTokens: 0, outputTokens: 0, counted: false };
  // Summed across rounds and across children: what the whole run cost, which
  // is the only figure a budget can act on.
  let inputTokens: int = 0;
  let outputTokens: int = 0;
  let rounds: int = 0;


  while (rounds < MAX_TOOL_STEPS) {
    // Asked to stop, before spending a provider call. The flag is on the
    // thread (schema.ts explains why), set by POST /threads/:id/cancel and
    // cleared as each turn begins — so a hit here is always THIS turn's
    // person changing their mind, never a stale request from an old round.
    // Checked at the two spending points and nowhere else: a cancel lands at
    // the next boundary, which is honest about what stopping a model
    // mid-sentence can be.
    if (cancelAsked(db, threadId)) {
      if (on) { trace = endSpan(trace, agentSpan, { input: userText, output: CANCELLED_TEXT }); }
      return report(agent, prompt, model, notes, context, steps, last, CANCELLED_TEXT, "cancelled", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
    }
    let modelSpan = startSpan(model.apiName, TRACE_GENERATION, agentSpan.id);
    // Streamed, so the rotation's thinking is written while the model is still
    // writing it rather than when the reply lands. What comes back is the same
    // whole body the buffered path returns — the deltas are reassembled in
    // provider.ts — so nothing below this line knows or cares which path fetched
    // it. Anthropic keeps the buffered path: its stream is a different shape and
    // reassembling it is its own piece of work.
    //
    // The callback writes straight through to the row the console polls. It
    // cannot throw, and it must not: a throw does not cross a function value
    // here, so it would escape every `try` between this and the handler.
    let thinkingSeq = where.baseSeq;
    let thinkingDepth = where.depth;
    let thinkingRotation = rounds;
    if (model.provider == "anthropic") {
      last = completeTurns(model, configRow, system, context, specs, key);
    } else {
      last = streamTurns(model, configRow, system, context, specs, key, (soFar: string, saidSoFar: string) => {
        recordThought(db, threadId, thinkingSeq, thinkingDepth, thinkingRotation, soFar, stamp());
        // The answer-so-far, only from the agent the person is talking to: a
        // child streams under the same thread, and its half-written delegate
        // answer must not flash up as the reply.
        if (thinkingDepth == 0) {
          recordPartial(db, threadId, thinkingSeq, saidSoFar, stamp());
        }
      }, () => cancelAsked(db, threadId));
      // The stream may have been cut by the halt above, and it may also have
      // finished normally a moment after the person pressed stop — either
      // way the press wins over whatever arrived. Without this re-check a
      // reply with no tool calls would return as "final" and a cut-off
      // sentence would stand as the answer.
      if (cancelAsked(db, threadId)) {
        if (on) { trace = endSpan(trace, agentSpan, { input: userText, output: CANCELLED_TEXT }); }
        return report(agent, prompt, model, notes, context, steps, last, CANCELLED_TEXT, "cancelled", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
      }
    }
    rounds = rounds + 1;
    if (!last.ok) {
      // Token counts are not read back: a failed call has none, and inventing
      // zeroes would put a real-looking number on a request that never ran.
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

    // A reply the model did not finish writing is not an answer, and the
    // provider's own finish reason is the only thing that says so.
    //
    // Read here rather than inferred from an empty call list further down: a
    // reply cut mid-tool-call loses that call to `jsonComplete` and arrives
    // with none, which is exactly how a model says it has finished — so the
    // round below stored the provider's raw JSON as the assistant's answer
    // where `content` was null, and stored the question with no answer at all
    // where it was "", with `run.ok` true either way, so asking again
    // duplicated the round. The reason also catches a reply cut mid-text,
    // which the call list cannot see at all.
    //
    // The counts above are kept: the request happened and it cost what it
    // cost, whatever came back.
    let cut = truncationProblem(model.provider, last.text, configRow.maxTokens);
    if (cut != "") {
      if (on) { trace = endSpanFailed(trace, agentSpan, { input: userText, message: cut }); }
      // The reply is still carried as `body` for the run log — what a
      // truncated round actually received is the first thing anyone reading
      // it will want — but it is not an answer and `ok` says so.
      let stopped: Completion = {
        ok: false, text: last.text, status: last.status, error: cut,
        inputTokens: last.inputTokens, outputTokens: last.outputTokens, counted: last.counted,
      };
      return report(agent, prompt, model, notes, context, steps, stopped, "", "refused", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
    }

    let calls = toolCallsFrom(model.provider, last.text);
    let said = assistantText(model.provider, last.text);
    // What it thought on this rotation, if it says. Written before the calls
    // are dispatched, so it is readable while they run.
    recordThought(db, threadId, where.baseSeq, where.depth, rounds - 1,
      assistantThinking(model.provider, last.text), stamp());

    if (calls.length == 0) {
      // No calls is how a model says it has finished. `replyText` rather than
      // `said.text` so a reply in an unrecognised shape is handed back whole
      // instead of as an empty answer.
      answer = replyText(model.provider, last.text);
      if (on) { trace = endSpan(trace, agentSpan, { input: userText, output: answer }); }
      return report(agent, prompt, model, notes, context, steps, last, answer, "final", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
    }

    context.push(assistantTurn(said.text, calls));

    let i: int = 0;
    while (i < calls.length) {
      // The step budget bounds tool calls as well as rounds: one reply can ask
      // for an unbounded number of them, so without this a single round could
      // run arbitrarily many side effects.
      if (cancelAsked(db, threadId)) {
        if (on) { trace = endSpan(trace, agentSpan, { input: userText, output: CANCELLED_TEXT }); }
        return report(agent, prompt, model, notes, context, steps, last, CANCELLED_TEXT, "cancelled", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
      }
      if (steps.length >= MAX_TOOL_STEPS) {
        let cutSaid = said.text;
        if (cutSaid == "") { cutSaid = closingWord(model, configRow, system, context, key); }
        if (on) { trace = endSpan(trace, agentSpan, { input: userText, output: cutSaid }); }
        return report(agent, prompt, model, notes, context, steps, last, cutSaid, "max_steps", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
      }
      // A child first: a delegation and a tool call are the same thing to the
      // model, and they should be the same thing to the trace.
      let child = childFor(children, calls[i].name);
      let resultText = "";
      let resultOk = false;
      let from = serverOf(mounted, calls[i].name);
      let callSpan = startSpan(calls[i].name, TRACE_TOOL, agentSpan.id);
      // The workspace first: its three names are fixed and a thread that has
      // one wants them answered here, not sent to an MCP server that happens
      // to share a name.
      //
      // One timestamp for the whole call, taken once so a file write and an
      // artifact write made in the same call carry the same instant rather
      // than two readings a query apart.
      let now = stamp();
      // What this call is, said out loud before it is dispatched.
      //
      // The row lands where `POST /threads/:id/messages` cannot: that request
      // answers once, at the end, and a round can take a minute. A second
      // request reads this while the first is still inside the loop, which is
      // only possible because the server runs handlers on a thread pool.
      //
      // A run with no thread has nobody to tell, so it writes nothing.
      let liveKind = "tool";
      if (child.id != "") { liveKind = "agent"; }
      let live: StepStart = {
        threadId: threadId, seq: where.baseSeq, depth: where.depth,
        rotation: rounds - 1, idx: steps.length,
        kind: liveKind, name: calls[i].name, target: child.id,
        args: calls[i].args, now: now,
      };
      let startedMs = Date.now();
      if (threadId != "") { beginStep(db, live); }
      // The loop guard. A model that gets the same result for the same call
      // makes the same call again — observed as use_skill("make-site")
      // fifteen times in one round, and eighteen identical run_scripts in
      // another, each burning a step to learn nothing. Re-executing an
      // identical call cannot help; what breaks the attractor is a DIFFERENT
      // answer. use_skill is refused on its first repeat (the briefing is
      // already in context, rereading it is worth nothing); every other tool
      // gets one honest retry — a flaky call retried identically is
      // legitimate — and is refused on the second.
      let sameBefore: int = 0;
      let priorStep: int = 0;
      while (priorStep < steps.length) {
        if (steps[priorStep].tool == calls[i].name && steps[priorStep].args == calls[i].args) {
          sameBefore = sameBefore + 1;
        }
        priorStep = priorStep + 1;
      }
      let repeatCap: int = 2;
      if (calls[i].name == "use_skill") { repeatCap = 1; }
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
      // Artifacts beside the workspace and ahead of MCP, for the same reason.
      // Both dispatchers are asked about every call and each answers only its
      // own fixed names, so asking both costs two string comparisons and
      // cannot write twice: no name belongs to both.
      let artifactAnswer = callArtifactTool(db, {
        threadId: threadId, agentId: agentId, name: calls[i].name, args: calls[i].args,
        turnSeq: where.baseSeq, now: now,
      });
      // Scripts third, same convention: every dispatcher is asked, each
      // answers only its own fixed name, and run_script belongs to no one
      // else — so the eager ask costs a string comparison.
      let scripted = callScriptTool(db, {
        threadId: threadId, agentId: agentId, name: calls[i].name, args: calls[i].args,
        turnSeq: where.baseSeq, now: now,
      });
      // Skills fourth, ahead of delegation and MCP: use_skill belongs to the
      // package, and a server that happens to export a tool of that name must
      // never answer it.
      let skilled = callSkillTool(db, {
        agentId: agentId, name: calls[i].name, args: calls[i].args,
      });
      // find_tools before everything: it is this package's own, it takes no
      // side effect, and a connector that happened to export a tool of that
      // name must never answer it.
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
            // The specs, appended to the list the NEXT rotation is sent. This
            // is the whole mechanism: the tools were always callable, they had
            // simply not been described yet.
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
          // The child opens its own agent span under this call's span, so its
          // model calls and tools sit inside the delegation that caused them.
          // It cannot hand its tracer back — records are immutable — so it
          // hands back what it recorded and this run folds it in.
          // A child starts fresh: a thread belongs to the agent whose conversation
          // it is, and replaying a parent's transcript into a specialist would ask
          // it to answer questions it was never part of.
          let childPrior: Turn[] = [];
          // The workspace is the thread's, and the thread is the parent's
          // conversation — so the child gets the files too: it is doing the
          // parent's work on the parent's material.
          let noChildChunks: string[] = [];
          let below2: RunContext = {
            depth: deeper, path: below, tracer: tracerForCallee(trace),
            parentSpan: callSpan.id, prior: childPrior, threadId: threadId,
            excludeChunks: noChildChunks,
            // The child runs its own model, never the one chosen for this
            // conversation — see `modelConfigId` on RunContext.
            modelConfigId: "",
            // The parent's round, not a fresh one: the child's writes belong
            // to the round that delegated, which is what lets the round join
            // see them.
            baseSeq: where.baseSeq,
            owner: where.owner,
            // Inherited: a person who asked for care wants it from the agents
            // the answer passes through, not only the one they addressed.
            think: where.think,
          };
          let asked = runAgentAt(db, child.id, question, master, below2);
          if (on) { trace = tracerWithMoreSpans(trace, asked.spans); }
          // What the child reached counts as reached: an evaluation asking
          // whether the stock tool was called does not care which agent
          // called it.
          inputTokens = inputTokens + asked.inputTokens;
          outputTokens = outputTokens + asked.outputTokens;
          calledAgents.push(child.agentName);
          calledAgents = withAll(calledAgents, asked.calledAgents);
          calledTools = withAll(calledTools, asked.calledTools);
          resultOk = asked.ok;
          resultText = asked.text;
          if (!asked.ok) {
            // What the child could not do, in words the parent can act on —
            // it may know another way to get the answer.
            resultText = child.agentName + " could not answer: " + asked.error;
          }
          // A child whose own tool calls failed can still answer confidently,
          // and the parent has no way to see that: it gets text, not a trace.
          // Observed doing exactly that — a lookup failed and the child
          // reported "no stock" — so the failure is recorded where an operator
          // reading the run will find it. In the notes rather than in the
          // result, because the result goes to the model and a warning it can
          // quote is a warning that reaches the user as an answer.
          let broke = failedSteps(asked.steps);
          if (broke > 0) {
            notes.push(child.agentName + " answered after " + `${broke}` + " of its own tool calls failed; its answer may not be grounded");
          }
          // The child's notes are the parent's business too: an operator
          // reading one run should not have to fetch three to find out a
          // server was down.
          let cn: int = 0;
          while (cn < asked.notes.length) {
            notes.push(child.agentName + ": " + asked.notes[cn]);
            cn = cn + 1;
          }
          // The child's own steps are its run's business, but the parent's
          // trace should say a delegation happened and to whom.
          from = child.agentName;
        }
      } else {
        let answered = callMounted(mounted, calls[i].name, calls[i].args);
        resultOk = answered.ok;
        resultText = answered.text;
        calledTools.push(calls[i].name);
      }
      if (on) { trace = endTool(trace, callSpan, { input: calls[i].args, output: resultText }, resultOk); }
      // Closed with what only the dispatch knows: which server answered, or
      // which child. Rewritten whole rather than patched, because `persist` is
      // an upsert over every column.
      if (threadId != "") {
        let done: StepStart = {
          threadId: live.threadId, seq: live.seq, depth: live.depth,
          rotation: live.rotation, idx: live.idx, kind: live.kind,
          name: live.name, target: from, args: live.args, now: live.now,
        };
        // `Date.now()` is i64 and a step's duration is an int, which is i32.
        // A call lasting more than 24 days would not fit — and a call lasting
        // 24 days has a different problem — so the narrowing is safe, but it
        // has to be written down rather than assumed by the compiler.
        let took = parseInt(`${Date.now() - startedMs}`, 10) ?? -1;
        // Where an edit landed, when this call was one — the card numbers its
        // snippets from it. A result, so it can only be said at the close.
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
      // A failed call goes back as the result, not as a dead run: the model
      // asked for something and is owed an answer it can act on.
      context.push(toolTurn(calls[i].id, calls[i].name, resultText));
      i = i + 1;
    }
  }

  if (answer == "") { answer = closingWord(model, configRow, system, context, key); }
  if (on) { trace = endSpan(trace, agentSpan, { input: userText, output: answer }); }
  return report(agent, prompt, model, notes, context, steps, last, answer, "max_steps", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
}

// A run's spans, or nothing when tracing is off. Reading them from a tracer
// that recorded none is harmless; the guard is here so the intent is legible
// at the call sites rather than implied.
function spansOf(on: bool, t: Tracer): RecordedSpan[] {
  if (!on) {
    let none: RecordedSpan[] = [];
    return none;
  }
  return tracerSpans(t);
}

// One list with another's entries added, each name once. Order is first-seen,
// because a reader comparing an expected list against this one is helped by
// the order things happened in.
function withAll(into: string[], more: string[]): string[] {
  let out = into;
  let i: int = 0;
  while (i < more.length) {
    if (!hasName(out, more[i])) { out.push(more[i]); }
    i = i + 1;
  }
  return out;
}

export function hasName(names: string[], name: string): bool {
  let i: int = 0;
  while (i < names.length) {
    if (names[i] == name) { return true; }
    i = i + 1;
  }
  return false;
}

// What a retrieval found, for the span's output: which folder each passage
// came off and how far away it was. The bodies are in the context already, and
// repeating them here would put the corpus in the trace twice.
function passageSummary(found: Retrieved[]): string {
  if (found.length == 0) { return "nothing retrieved"; }
  let out = "";
  let i: int = 0;
  while (i < found.length) {
    if (i > 0) { out = out + "\n"; }
    out = out + found[i].scope + "/" + found[i].source + "  distance " + `${found[i].distance}`;
    i = i + 1;
  }
  return out;
}

// The passages close enough to be worth showing. `distance` is cosine, so 0 is
// identical and 2 is opposite; a caller that wants everything sets the maximum
// high rather than this returning everything by default.
function withinDistance(found: Retrieved[], maxDistance: number): Retrieved[] {
  let out: Retrieved[] = [];
  let i: int = 0;
  while (i < found.length) {
    if (found[i].distance <= maxDistance) { out.push(found[i]); }
    i = i + 1;
  }
  return out;
}

// How many of a run's tool calls failed.
function failedSteps(steps: AgentStep[]): int {
  let n: int = 0;
  let i: int = 0;
  while (i < steps.length) {
    if (!steps[i].ok) { n = n + 1; }
    i = i + 1;
  }
  return n;
}

// Whether an agent is already somewhere above this run.
function onPath(path: string[], agentId: string): bool {
  let i: int = 0;
  while (i < path.length) {
    if (path[i] == agentId) { return true; }
    i = i + 1;
  }
  return false;
}

// Whether a tool of this name is already offered. A server's tool wins: it was
// mounted first, and renaming a child out from under the person who named it
// would be worse than not offering it.
function nameTaken(specs: ToolSpec[], name: string): bool {
  let i: int = 0;
  while (i < specs.length) {
    if (specs[i].name == name) { return true; }
    i = i + 1;
  }
  return false;
}

// The child a tool name stands for, or a row with an empty id when the name is
// a server's tool rather than an agent.
function childFor(children: AgentRow[], name: string): AgentRow {
  let i: int = 0;
  while (i < children.length) {
    if (delegateToolName(children[i].agentName) == name) { return children[i]; }
    i = i + 1;
  }
  let none: AgentRow = { id: "", agentName: "", description: "", modelConfigId: "", promptId: "", scriptImageId: "", isDefault: false, enabled: false, updatedAt: "" };
  return none;
}

// Out of steps must not mean out of words. A run that spends its whole tool
// budget mid-work used to return an empty answer; the thread then stored no
// round at all — while the artifact edits the run DID make sat there,
// versioned, unexplained. One more model call with no tools on offer turns
// the cut into a status report: what was done, what still fails, what comes
// next. The budget bounds side effects, and a closing sentence has none.
function closingWord(model: ModelRow, configRow: ModelConfigRow, system: string, context: Turn[], key: string): string {
  let asked: Turn[] = [...context, userTurn(
    "You have used every available tool step for this round. Do not call any tool. "
    + "Tell the user plainly what you changed, what the validator still refuses if anything, "
    + "and what you would do next.")];
  let noTools: ToolSpec[] = [];
  let said = completeTurns(model, configRow, system, asked, noTools, key);
  if (!said.ok) { return ""; }
  return assistantText(model.provider, said.text).text;
}

// One place builds the result, so a run that ended four different ways still
// reports which agent, prompt and model served it.
function report(agent: AgentRow, prompt: PromptRow, model: ModelRow, notes: string[], context: Turn[], steps: AgentStep[], last: Completion, answer: string, stopReason: string, rounds: int, spans: RecordedSpan[], calledTools: string[], calledAgents: string[], retrieved: Retrieved[], inputTokens: int, outputTokens: int): AgentRun {
  let why = last.error;
  if (stopReason == "max_steps" && why == "") {
    why = "stopped after " + `${MAX_TOOL_STEPS}` + " tool steps without a final answer";
  }
  // A cut round that still said something IS a round: the closing word (or
  // the model's own last text) is a real answer about real side effects, and
  // a transcript that hides it while the artifact versions it produced stand
  // is the worse lie. Only a silent cut stays not-ok.
  let out: AgentRun = {
    // Cancelled is ok=true whatever the last completion said: nothing
    // failed — the person stopped it, and an error card over their own
    // choice would read as the engine objecting.
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
