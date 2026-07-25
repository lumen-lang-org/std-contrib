// Running an agent: everything about it comes out of the database.
//
//   let answer = runAgent(db, "a1", "What is 2+40?", masterKey());
//
// The prompt, the model, the wire name, the temperature and the key are all
// rows. Nothing here names a model or holds a credential, so changing which
// model an agent runs on, or rolling its prompt back a version, is an UPDATE
// and takes effect on the next call.

import { Db } from "../plume/driver.ts";
import { findById } from "../plume/plume.ts";
import { AgentRow, PromptRow, ModelRow, ModelConfigRow, modelsMapping, modelConfigsMapping, promptsMapping, agentsMapping } from "./schema.ts";
import { credentialFor } from "./credentials.ts";
import { Completion, complete, replyText } from "./provider.ts";

// model_configs declares a hasOne("model") relation, so its document carries
// the model nested. Named here because a record type must declare every key
// the document has, even one this path reads separately.
type NestedModel = { id: string, label: string, apiName: string, provider: string, enabled: bool };
type ConfigWithModel = {
  id: string, modelId: string, temperature: number, maxTokens: int, topP: number, extra: string,
  model: NestedModel,
};

export type AgentRun = {
  ok: bool,
  // The assistant's text, and the provider's whole reply behind it. Both,
  // because a caller usually wants the answer and occasionally needs the
  // token counts or the finish reason.
  text: string,
  body: string,
  status: int,
  // Which agent, prompt version and model actually served the call, so a
  // caller can record what answered rather than what it assumed would.
  agentName: string,
  promptVersion: int,
  modelApiName: string,
  error: string,
};

function failed(agentName: string, why: string): AgentRun {
  let r: AgentRun = {
    ok: false, text: "", body: "", status: 0,
    agentName: agentName, promptVersion: 0, modelApiName: "", error: why,
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

  let answered = complete(model, configRow, prompt.body, userText, key);
  let out: AgentRun = {
    ok: answered.ok,
    text: replyText(model.provider, answered.text),
    body: answered.text,
    status: answered.status,
    agentName: agent.agentName,
    promptVersion: prompt.version,
    modelApiName: model.apiName,
    error: answered.error,
  };
  return out;
}
