// Agents, made and changed by a sentence.
//
// "Make an agent that answers in French from my docs" is the multiplier: an
// agent is this product's atom — the bot answers through one, every workflow
// AGENT step runs as one — and until now the only door was the Settings
// form. These verbs follow the task-tools shape: fixed names, one sentence
// back, and SHOW BEFORE CHANGE for the one field where a careless write
// destroys work — the prompt. A prompt row is never edited (api.ts's own
// rule): changing one writes a NEW VERSION and repoints the agent, so a bad
// instruction is a roll-back, not a loss.
//
// Agents are deployment rows, not owner rows — the same truth the Settings
// page lives by. The gate here is the same as workflows': signed-in, not a
// guest. What a signed-in person may see in Settings they may say here.
//
// Written as tomorrow's MCP surface, deliberately: every schema is complete,
// every refusal is a sentence a stranger's agent can act on.
//
//   cd packages/agents && lumen test agent-tools.test.ts

import { Db } from "../plume/driver.ts";
import { DbOrder, asc, desc, existsById, findById, listOrdered, pageOrdered, persist } from "../plume/plume.ts";
import { ToolSpec, toolSpec } from "./provider.ts";
import { FileToolResult } from "./workspace.ts";
import { jsonRaw, jsonText } from "./scan.ts";
import { AgentRow, ModelConfigRow, PromptRow, agentsMapping, modelConfigRows, promptsMapping } from "./schema.ts";
import { maySchedule } from "./task-tools.ts";

function not(): FileToolResult {
  let none: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  return none;
}

function no(why: string): FileToolResult {
  let bad: FileToolResult = { handled: true, ok: false, text: why, line: 0, changed: "" };
  return bad;
}

function yes(text: string): FileToolResult {
  let good: FileToolResult = { handled: true, ok: true, text: text, line: 0, changed: "" };
  return good;
}

export function agentTools(): ToolSpec[] {
  let which = "From list_agents. Its name works too.";
  let out: ToolSpec[] = [];

  out.push(toolSpec("list_agents",
    "The agents on this deployment: name, what each is for, whether it is on, and which model "
    + "config it runs. Call it before creating one that may already exist, and before changing "
    + "anything.",
    "{\"type\":\"object\",\"properties\":{}}"));

  out.push(toolSpec("show_agent",
    "One agent in full, INCLUDING ITS CURRENT PROMPT TEXT and prompt version. Always call this "
    + "before change_agent touches the prompt — the person should hear what stands before it is "
    + "replaced.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"agent\":{\"type\":\"string\",\"description\":\"" + which + "\"}},"
    + "\"required\":[\"agent\"]}"));

  out.push(toolSpec("create_agent",
    "A new agent from a description: a name, what it is for, and its system prompt. It runs on "
    + "a model config from list_agents' vocabulary (or the deployment default when unsaid) and "
    + "is on immediately — a workflow step or a bot can name it.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"name\":{\"type\":\"string\",\"description\":\"A short name, letters and dashes, at most 48 characters — it doubles as a tool name when other agents delegate to it.\"},"
    + "\"description\":{\"type\":\"string\",\"description\":\"One line on what it is for, shown in every picker.\"},"
    + "\"prompt\":{\"type\":\"string\",\"description\":\"The system prompt: who it is, how it answers, what it must not do.\"},"
    + "\"model_config\":{\"type\":\"string\",\"description\":\"A model config id or label from list_agents. Leave out for the deployment's default.\"}},"
    + "\"required\":[\"name\",\"prompt\"]}"));

  out.push(toolSpec("change_agent",
    "Change an agent: its description, its model config, on/off, or its PROMPT. Only what is "
    + "sent changes. A new prompt becomes a NEW VERSION — the old one stays and can be rolled "
    + "back to — but still: show_agent first, and say what is being replaced.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"agent\":{\"type\":\"string\",\"description\":\"" + which + "\"},"
    + "\"description\":{\"type\":\"string\",\"description\":\"A new one-liner.\"},"
    + "\"prompt\":{\"type\":\"string\",\"description\":\"The WHOLE new system prompt, not a diff. Saved as a new version.\"},"
    + "\"model_config\":{\"type\":\"string\",\"description\":\"A model config id or label to run on.\"},"
    + "\"enabled\":{\"type\":\"boolean\",\"description\":\"false switches it off everywhere it is named.\"}},"
    + "\"required\":[\"agent\"]}"));

  return out;
}

export type AgentToolCall = {
  owner: string,
  name: string,
  args: string,
  nowMs: number,
};

/** One agent said by name or id. */
function agentSaid(db: Db, said: string): AgentRow {
  let doc = findById(db, agentsMapping(), said);
  if (doc != "") { return JSON.parse<AgentRow>(doc); }
  let rows = JSON.parse<AgentRow[]>(listOrdered(db, agentsMapping(), "", [], noOrder()));
  let found: int = -1;
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].agentName.toLowerCase() == said.toLowerCase()) {
      if (found >= 0) { return emptyAgent(); }
      found = i;
    }
    i = i + 1;
  }
  if (found >= 0) { return rows[found]; }
  return emptyAgent();
}

function noOrder(): DbOrder[] {
  let keys: DbOrder[] = [asc("agent_name")];
  return keys;
}

function emptyAgent(): AgentRow {
  let none: AgentRow = {
    id: "", agentName: "", description: "", modelConfigId: "", promptId: "",
    enabled: false, isDefault: false, scriptImageId: "", updatedAt: "",
  };
  return none;
}

/** A model config said by id or label, or empty. */
function configSaid(db: Db, said: string): ModelConfigRow {
  let doc = findById(db, modelConfigRows(db), said);
  if (doc != "") { return JSON.parse<ModelConfigRow>(doc); }
  let rows = JSON.parse<ModelConfigRow[]>(listOrdered(db, modelConfigRows(db), "", [], labelOrder()));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].label.toLowerCase() == said.toLowerCase()) { return rows[i]; }
    i = i + 1;
  }
  let none: ModelConfigRow = {
    id: "", modelId: "", temperature: 0.0, maxTokens: 0, topP: 0.0,
    extra: "", thinking: "", label: "", selectable: false, rank: 0,
  };
  return none;
}

function labelOrder(): DbOrder[] {
  let keys: DbOrder[] = [asc("label")];
  return keys;
}

/** The deployment default config: the default agent's, or the first
 *  selectable one — the same "what would Settings offer first" answer. */
function defaultConfig(db: Db): string {
  let rows = JSON.parse<AgentRow[]>(listOrdered(db, agentsMapping(), "", [], noOrder()));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].isDefault) { return rows[i].modelConfigId; }
    i = i + 1;
  }
  let configs = JSON.parse<ModelConfigRow[]>(listOrdered(db, modelConfigRows(db), "", [], labelOrder()));
  i = 0;
  while (i < configs.length) {
    if (configs[i].selectable) { return configs[i].id; }
    i = i + 1;
  }
  return "";
}

/** The prompt an agent points at, or an empty row. */
function promptOf(db: Db, promptId: string): PromptRow {
  let doc = findById(db, promptsMapping(), promptId);
  if (doc != "") { return JSON.parse<PromptRow>(doc); }
  let none: PromptRow = { id: "", promptName: "", version: 0, body: "", createdAt: "" };
  return none;
}

/** A new prompt VERSION under a name — never an edit, api.ts's own rule. */
function writePromptVersion(db: Db, promptName: string, body: string, nowMs: number): string {
  let newest: DbOrder[] = [desc("version")];
  let page = pageOrdered(db, promptsMapping(), "prompt_name = " + db.placeholder, [promptName], newest, 1, 0);
  let at = 0;
  if (page != "" && page != "[]") {
    let rows: PromptRow[] = JSON.parse<PromptRow[]>(page);
    if (rows.length > 0) { at = rows[0].version; }
  }
  let row: PromptRow = {
    id: crypto.randomUUID(), promptName: promptName, version: at + 1,
    body: body, createdAt: `${nowMs}`,
  };
  persist(db, promptsMapping(), JSON.stringify(row));
  return row.id;
}

function describeAgent(db: Db, agent: AgentRow, withPrompt: bool): string {
  let config = configSaid(db, agent.modelConfigId);
  let line = agent.agentName + " [" + agent.id + "]"
    + (agent.isDefault ? " (default)" : "")
    + (agent.enabled ? "" : " — OFF") + "\n"
    + "  " + (agent.description == "" ? "(no description)" : agent.description) + "\n"
    + "  runs on " + (config.label == "" ? agent.modelConfigId : config.label);
  if (withPrompt) {
    let prompt = promptOf(db, agent.promptId);
    line = line + "\n  prompt \"" + prompt.promptName + "\" v" + `${prompt.version}` + ":\n"
      + "  ---\n" + prompt.body + "\n  ---";
  }
  return line;
}

export function callAgentTool(db: Db, call: AgentToolCall): FileToolResult {
  if (call.name != "list_agents" && call.name != "show_agent"
    && call.name != "create_agent" && call.name != "change_agent") {
    return not();
  }
  // The workflows gate: what a signed-in person may do in Settings they may
  // say here; a guest may do neither.
  if (!maySchedule(call.owner)) {
    return no("signing in is what makes the deployment theirs to configure — say so.");
  }

  if (call.name == "list_agents") {
    let rows = JSON.parse<AgentRow[]>(listOrdered(db, agentsMapping(), "", [], noOrder()));
    let out = `${rows.length}` + " agent(s):\n";
    let i: int = 0;
    while (i < rows.length) {
      out = out + "\n" + describeAgent(db, rows[i], false) + "\n";
      i = i + 1;
    }
    return yes(out);
  }

  if (call.name == "create_agent") {
    let name = jsonText(call.args, "name").trim();
    if (name == "") { return no("an agent needs a name: {\"name\":\"...\",\"prompt\":\"...\"}"); }
    if (name.length > 48) { return no("an agent name is at most 48 characters — it doubles as a tool name."); }
    let prompt = jsonText(call.args, "prompt").trim();
    if (prompt == "") { return no("an agent needs its system prompt — who it is and how it answers."); }
    let taken = agentSaid(db, name);
    if (taken.id != "") { return no("\"" + name + "\" exists already — show_agent shows it, change_agent changes it."); }
    let configId = defaultConfig(db);
    let configSaidText = jsonText(call.args, "model_config").trim();
    if (configSaidText != "") {
      let config = configSaid(db, configSaidText);
      if (config.id == "") { return no("no model config called \"" + configSaidText + "\" — list_agents shows the ones in use."); }
      configId = config.id;
    }
    if (configId == "") { return no("this deployment has no model config to run an agent on yet."); }
    let promptId = writePromptVersion(db, name, prompt, call.nowMs);
    let row: AgentRow = {
      id: "a-" + crypto.randomUUID().slice(0, 8), agentName: name,
      description: jsonText(call.args, "description").trim(),
      modelConfigId: configId, promptId: promptId,
      enabled: true, isDefault: false, scriptImageId: "",
      updatedAt: `${call.nowMs}`,
    };
    persist(db, agentsMapping(), JSON.stringify(row));
    return yes("Created.\n\n" + describeAgent(db, row, true)
      + "\n\nA workflow step or a bot can name it now.");
  }

  let said = jsonText(call.args, "agent").trim();
  if (said == "") { return no("say which agent: {\"agent\":\"...\"} — list_agents shows them."); }
  let agent = agentSaid(db, said);
  if (agent.id == "") { return no("no agent by that name or id — list_agents shows them."); }

  if (call.name == "show_agent") {
    return yes(describeAgent(db, agent, true));
  }

  // change_agent.
  let description = jsonText(call.args, "description").trim();
  let promptText = jsonText(call.args, "prompt");
  let configWord = jsonText(call.args, "model_config").trim();
  let enabledRaw = jsonRaw(call.args, "enabled").trim();
  if (description == "" && promptText.trim() == "" && configWord == "" && enabledRaw == "") {
    return no("say what changes: description, prompt, model_config or enabled.");
  }
  let configId = agent.modelConfigId;
  let note = "";
  if (configWord != "") {
    let config = configSaid(db, configWord);
    if (config.id == "") { return no("no model config called \"" + configWord + "\"."); }
    configId = config.id;
    note = " Now on " + config.label + ".";
  }
  let promptId = agent.promptId;
  if (promptText.trim() != "") {
    let old = promptOf(db, agent.promptId);
    promptId = writePromptVersion(db, old.promptName == "" ? agent.agentName : old.promptName,
      promptText.trim(), call.nowMs);
    note = note + " Prompt is now v" + `${promptOf(db, promptId).version}`
      + " — v" + `${old.version}` + " stays, for rolling back.";
  }
  let edited: AgentRow = {
    id: agent.id, agentName: agent.agentName,
    description: description == "" ? agent.description : description,
    modelConfigId: configId, promptId: promptId,
    enabled: enabledRaw == "" ? agent.enabled : enabledRaw == "true",
    isDefault: agent.isDefault, scriptImageId: agent.scriptImageId,
    updatedAt: `${call.nowMs}`,
  };
  persist(db, agentsMapping(), JSON.stringify(edited));
  return yes("Changed." + note + "\n\n" + describeAgent(db, edited, false));
}
