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
import { AgentRow, PromptRow, ModelRow, ModelConfigRow, modelsMapping, modelConfigsMapping, promptsMapping, agentsMapping } from "./schema.ts";
import { credentialFor } from "./credentials.ts";
import { Completion, ToolSpec, ToolCall, Turn, complete, completeTurns, replyText, assistantText, toolCallsFrom, userTurn, assistantTurn, toolTurn } from "./provider.ts";
import { Mounted, mountTools, toolSpecs, callMounted, serverOf, agentChildren, delegateToolName, delegateDescription, delegateSchema } from "./tools.ts";
import { jsonText } from "./scan.ts";
import { Retrieved, embeddingModel, agentScopes, retrievalFor, retrieve, retrieveExcluding, asContext } from "./knowledge.ts";
import { FileToolResult, workspaceTools, callWorkspaceTool } from "./workspace.ts";
import { Tracer, TraceSpan, RecordedSpan, startSpan, endSpan, endSpanFailed, endGeneration, endTool, tracerSpans, tracerWithMoreSpans, tracerForCallee, noTracer, tracing, TRACE_AGENT, TRACE_GENERATION, TRACE_TOOL, TRACE_RETRIEVER } from "../tracing/tracing.ts";

// How many times a run may go back to the model after calling tools.
//
// A constant, and it should be a column: it is exactly the kind of knob this
// package exists to keep in the database. It is not one yet because the agents
// table is created from its mapping, so adding a field rewrites an applied
// migration and the checksum refuses it — a real question about how the schema
// evolves, and not one to answer silently in passing.
//
// Eight is enough for a research loop and short enough that a model stuck in
// one costs seconds rather than an afternoon.
const MAX_TOOL_STEPS: int = 8;

// How deep delegation may go. A parent asking a specialist which asks another
// is reasonable; a chain longer than this is a graph the builder should look
// at rather than a plan.
//
// This is a bound, not the cycle check. `agent_sub_agents` accepts a cycle —
// the schema's own suite inserts one to prove it — so a run also refuses to
// enter an agent already on its path, which stops A→B→A immediately rather
// than three levels later.
const MAX_DEPTH: int = 3;

// model_configs declares a hasOne("model") relation, so its document carries
// the model nested. Named here because a record type must declare every key
// the document has, even one this path reads separately.
type NestedModel = { id: string, label: string, apiName: string, provider: string, enabled: bool };
type ConfigWithModel = {
  id: string, modelId: string, temperature: number, maxTokens: int, topP: number, extra: string,
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
export function runAgent(db: Db, agentId: string, userText: string, master: string): AgentRun {
  let path: string[] = [];
  let fresh: Turn[] = [];
  let noChunks: string[] = [];
  return runAgentAt(db, agentId, userText, master, 0, path, noTracer(), "", fresh, "", noChunks);
}

// The same run, traced. The tracer carries the collector's address and the
// trace id; every span this run and its children open hangs under `parentSpan`,
// which is "" at the top. The caller flushes — a run does not decide when a
// trace is sent, and a child must not send half of one.
export function runAgentTraced(db: Db, agentId: string, userText: string, master: string, tracer: Tracer): AgentRun {
  let path: string[] = [];
  let fresh: Turn[] = [];
  let noChunks: string[] = [];
  return runAgentAt(db, agentId, userText, master, 0, path, tracer, "", fresh, "", noChunks);
}

// The same run, at a depth, knowing which agents are already above it.
//
// `path` is the chain of agent ids from the top down, so a child that would
// re-enter one is refused by name. Passed rather than tracked in a global: a
// server runs handlers on many threads, and one run's path is nothing to do
// with another's.
export function runAgentAt(db: Db, agentId: string, userText: string, master: string, depth: int, path: string[], tracer: Tracer, parentSpan: string, prior: Turn[], threadId: string, excludeChunks: string[]): AgentRun {
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

  let configDoc = findById(db, modelConfigsMapping(db), agent.modelConfigId);
  if (configDoc == "") { return failed(agent.agentName, "no model config " + agent.modelConfigId); }
  let config: ConfigWithModel = JSON.parse<ConfigWithModel>(configDoc);

  let modelDoc = findById(db, modelsMapping(), config.modelId);
  if (modelDoc == "") { return failed(agent.agentName, "no model " + config.modelId); }
  let model: ModelRow = JSON.parse<ModelRow>(modelDoc);

  let configRow: ModelConfigRow = {
    id: config.id, modelId: config.modelId, temperature: config.temperature,
    maxTokens: config.maxTokens, topP: config.topP, extra: config.extra,
  };

  let key = credentialFor(db, model.provider, master);
  if (key == "") {
    return failed(agent.agentName, "no usable credential for " + model.provider);
  }

  // Only now, once the run is going to happen: mounting asks every linked
  // server what it offers, and a refused run should not have made a network
  // call to work out what it was refusing.
  let mounted = mountTools(db, agent.id);
  let specs = toolSpecs(mounted);

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
    trace = endSpan(trace, retrieveSpan, userText, passageSummary(retrieved));
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
  let last: Completion = { ok: false, text: "", status: 0, error: "", inputTokens: 0, outputTokens: 0, counted: false };
  // Summed across rounds and across children: what the whole run cost, which
  // is the only figure a budget can act on.
  let inputTokens: int = 0;
  let outputTokens: int = 0;
  let rounds: int = 0;


  while (rounds < MAX_TOOL_STEPS) {
    let modelSpan = startSpan(model.apiName, TRACE_GENERATION, agentSpan.id);
    last = completeTurns(model, configRow, prompt.body, context, specs, key);
    rounds = rounds + 1;
    if (!last.ok) {
      // Token counts are not read back: a failed call has none, and inventing
      // zeroes would put a real-looking number on a request that never ran.
      if (on) {
        trace = endSpanFailed(trace, modelSpan, userText, last.error);
        trace = endSpanFailed(trace, agentSpan, userText, last.error);
      }
      let refused = report(agent, prompt, model, notes, context, steps, last, "", "refused", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
      return refused;
    }
    if (on) {
      trace = endGeneration(trace, modelSpan, model.apiName, configRow.temperature, configRow.maxTokens,
        userText, replyText(model.provider, last.text), last.inputTokens, last.outputTokens);
    }

    inputTokens = inputTokens + last.inputTokens;
    outputTokens = outputTokens + last.outputTokens;

    let calls = toolCallsFrom(model.provider, last.text);
    let said = assistantText(model.provider, last.text);

    if (calls.length == 0) {
      // No calls is how a model says it has finished. `replyText` rather than
      // `said.text` so a reply in an unrecognised shape is handed back whole
      // instead of as an empty answer.
      answer = replyText(model.provider, last.text);
      if (on) { trace = endSpan(trace, agentSpan, userText, answer); }
      return report(agent, prompt, model, notes, context, steps, last, answer, "final", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
    }

    context.push(assistantTurn(said.text, calls));

    let i: int = 0;
    while (i < calls.length) {
      // The step budget bounds tool calls as well as rounds: one reply can ask
      // for an unbounded number of them, so without this a single round could
      // run arbitrarily many side effects.
      if (steps.length >= MAX_TOOL_STEPS) {
        if (on) { trace = endSpan(trace, agentSpan, userText, said.text); }
        return report(agent, prompt, model, notes, context, steps, last, said.text, "max_steps", rounds, spansOf(on, trace), calledTools, calledAgents, retrieved, inputTokens, outputTokens);
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
      let fileAnswer = callWorkspaceTool(db, threadId, calls[i].name,
        jsonText(calls[i].args, "name"), jsonText(calls[i].args, "content"), "now");
      if (fileAnswer.handled) {
        resultOk = fileAnswer.ok;
        resultText = fileAnswer.text;
        from = "workspace";
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
          let asked = runAgentAt(db, child.id, question, master, deeper, below, tracerForCallee(trace), callSpan.id, childPrior, threadId, noChildChunks);
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
      if (on) { trace = endTool(trace, callSpan, calls[i].args, resultText, resultOk); }
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

  if (on) { trace = endSpan(trace, agentSpan, userText, answer); }
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
  let none: AgentRow = { id: "", agentName: "", description: "", modelConfigId: "", promptId: "", enabled: false, updatedAt: "" };
  return none;
}

// One place builds the result, so a run that ended four different ways still
// reports which agent, prompt and model served it.
function report(agent: AgentRow, prompt: PromptRow, model: ModelRow, notes: string[], context: Turn[], steps: AgentStep[], last: Completion, answer: string, stopReason: string, rounds: int, spans: RecordedSpan[], calledTools: string[], calledAgents: string[], retrieved: Retrieved[], inputTokens: int, outputTokens: int): AgentRun {
  let why = last.error;
  if (stopReason == "max_steps" && why == "") {
    why = "stopped after " + `${MAX_TOOL_STEPS}` + " tool steps without a final answer";
  }
  let out: AgentRun = {
    ok: last.ok && stopReason == "final",
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
