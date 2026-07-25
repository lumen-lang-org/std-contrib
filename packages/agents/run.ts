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
import { Mounted, mountTools, toolSpecs, callMounted, serverOf } from "./tools.ts";

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
  // Every tool call the run made.
  steps: AgentStep[],
  // "final", "max_steps" or "refused".
  stopReason: string,
  // How many times the model was asked.
  rounds: int,
  // What could not be mounted. An agent whose server is down still answers,
  // and whoever reads the run should know it answered with one hand tied.
  notes: string[],
};

function failed(agentName: string, why: string): AgentRun {
  let noContext: Turn[] = [];
  let noSteps: AgentStep[] = [];
  let noNotes: string[] = [];
  let r: AgentRun = {
    ok: false, text: "", body: "", status: 0,
    agentName: agentName, promptVersion: 0, modelApiName: "", error: why,
    context: noContext, steps: noSteps, stopReason: "refused", rounds: 0, notes: noNotes,
  };
  return r;
}

// Run a user's text through an agent. Every refusal names what was missing,
// because "it did not answer" is the least useful thing a caller can be told.
export function runAgent(db: Db, agentId: string, userText: string, master: string): AgentRun {
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

  let context: Turn[] = [userTurn(userText)];
  let steps: AgentStep[] = [];
  let answer = "";
  let last: Completion = { ok: false, text: "", status: 0, error: "" };
  let rounds: int = 0;

  while (rounds < MAX_TOOL_STEPS) {
    last = completeTurns(model, configRow, prompt.body, context, specs, key);
    rounds = rounds + 1;
    if (!last.ok) {
      let refused = report(agent, prompt, model, mounted, context, steps, last, "", "refused", rounds);
      return refused;
    }

    let calls = toolCallsFrom(model.provider, last.text);
    let said = assistantText(model.provider, last.text);

    if (calls.length == 0) {
      // No calls is how a model says it has finished. `replyText` rather than
      // `said.text` so a reply in an unrecognised shape is handed back whole
      // instead of as an empty answer.
      answer = replyText(model.provider, last.text);
      return report(agent, prompt, model, mounted, context, steps, last, answer, "final", rounds);
    }

    context.push(assistantTurn(said.text, calls));

    let i: int = 0;
    while (i < calls.length) {
      // The step budget bounds tool calls as well as rounds: one reply can ask
      // for an unbounded number of them, so without this a single round could
      // run arbitrarily many side effects.
      if (steps.length >= MAX_TOOL_STEPS) {
        return report(agent, prompt, model, mounted, context, steps, last, said.text, "max_steps", rounds);
      }
      let answered = callMounted(mounted, calls[i].name, calls[i].args);
      let step: AgentStep = {
        index: steps.length,
        tool: calls[i].name,
        server: serverOf(mounted, calls[i].name),
        args: calls[i].args,
        result: answered.text,
        ok: answered.ok,
      };
      steps.push(step);
      // A failed call goes back as the result, not as a dead run: the model
      // asked for something and is owed an answer it can act on.
      context.push(toolTurn(calls[i].id, calls[i].name, answered.text));
      i = i + 1;
    }
  }

  return report(agent, prompt, model, mounted, context, steps, last, answer, "max_steps", rounds);
}

// One place builds the result, so a run that ended four different ways still
// reports which agent, prompt and model served it.
function report(agent: AgentRow, prompt: PromptRow, model: ModelRow, mounted: Mounted, context: Turn[], steps: AgentStep[], last: Completion, answer: string, stopReason: string, rounds: int): AgentRun {
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
    notes: mounted.problems,
  };
  return out;
}
