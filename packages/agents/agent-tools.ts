import { Db } from "../plume/driver.ts";
import { DbOrder, executeWith, existsById, findById, listOrdered, pageOrdered, persist, placeholderAt } from "../plume/plume.ts";
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
    + "\"enabled\":{\"type\":\"boolean\",\"description\":\"false switches it off everywhere it is named.\"},"
    + "\"default\":{\"type\":\"boolean\",\"description\":\"true makes it the agent new conversations open against — the old default steps down.\"},"
    + "\"add_skill\":{\"type\":\"string\",\"description\":\"A skill name from list_skills to attach, so this agent can use_skill it.\"},"
    + "\"prompt_version\":{\"type\":\"number\",\"description\":\"Roll the prompt back (or forward) to this version of its history. show_agent names the current one.\"}},"
    + "\"required\":[\"agent\"]}"));

  out.push(toolSpec("delete_agent",
    "Remove an agent. Refused for the default agent; workflow steps that name a deleted agent "
    + "fail with its name when they next run — say so if any might.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"agent\":{\"type\":\"string\",\"description\":\"" + which + "\"}},"
    + "\"required\":[\"agent\"]}"));

  return out;
}

export type AgentToolCall = {
  owner: string,
  name: string,
  args: string,
  nowMs: number,
};

function agentSaid(db: Db, said: string): AgentRow {
  let doc = findById(db, agentsMapping(), said);
  if (doc != "") {
    return JSON.parse<AgentRow>(doc);
  }
  let rows = JSON.parse<AgentRow[]>(listOrdered(db, agentsMapping(), { order: noOrder() }));
  let found: int = -1;
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].agentName.toLowerCase() == said.toLowerCase()) {
      if (found >= 0) {
        return emptyAgent();
      }
      found = i;
    }
    i = i + 1;
  }
  if (found >= 0) {
    return rows[found];
  }
  return emptyAgent();
}

function noOrder(): DbOrder[] {
  let keys: DbOrder[] = [{ column: "agent_name" }];
  return keys;
}

function emptyAgent(): AgentRow {
  let none: AgentRow = {
    id: "", agentName: "", description: "", modelConfigId: "", promptId: "",
    enabled: false, isDefault: false, scriptImageId: "", updatedAt: "",
  };
  return none;
}

function configSaid(db: Db, said: string): ModelConfigRow {
  let doc = findById(db, modelConfigRows(db), said);
  if (doc != "") {
    return JSON.parse<ModelConfigRow>(doc);
  }
  let rows = JSON.parse<ModelConfigRow[]>(listOrdered(db, modelConfigRows(db), { order: labelOrder() }));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].label.toLowerCase() == said.toLowerCase()) {
      return rows[i];
    }
    i = i + 1;
  }
  let none: ModelConfigRow = {
    id: "", modelId: "", temperature: 0.0, maxTokens: 0, topP: 0.0,
    extra: "", thinking: "", label: "", selectable: false, rank: 0,
  };
  return none;
}

function labelOrder(): DbOrder[] {
  let keys: DbOrder[] = [{ column: "label" }];
  return keys;
}

function defaultConfig(db: Db): string {
  let rows = JSON.parse<AgentRow[]>(listOrdered(db, agentsMapping(), { order: noOrder() }));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].isDefault) {
      return rows[i].modelConfigId;
    }
    i = i + 1;
  }
  let configs = JSON.parse<ModelConfigRow[]>(listOrdered(db, modelConfigRows(db), { order: labelOrder() }));
  i = 0;
  while (i < configs.length) {
    if (configs[i].selectable) {
      return configs[i].id;
    }
    i = i + 1;
  }
  return "";
}

function promptOf(db: Db, promptId: string): PromptRow {
  let doc = findById(db, promptsMapping(), promptId);
  if (doc != "") {
    return JSON.parse<PromptRow>(doc);
  }
  let none: PromptRow = { id: "", promptName: "", version: 0, body: "", createdAt: "" };
  return none;
}

function writePromptVersion(db: Db, promptName: string, body: string, nowMs: number): string {
  let newest: DbOrder[] = [{ column: "version", direction: "desc" }];
  let page = pageOrdered(db, promptsMapping(), { where: "prompt_name = " + db.placeholder, args: [promptName], order: newest, limit: 1, offset: 0 });
  let at = 0;
  if (page != "" && page != "[]") {
    let rows: PromptRow[] = JSON.parse<PromptRow[]>(page);
    if (rows.length > 0) {
      at = rows[0].version;
    }
  }
  let row: PromptRow = {
    id: crypto.randomUUID(), promptName: promptName, version: at + 1,
    body: body, createdAt: `${nowMs}`,
  };
  persist(db, promptsMapping(), JSON.stringify(row));
  return row.id;
}

function findSkill(db: Db, said: string): string {
  let sql = "SELECT id FROM skills WHERE LOWER(skill_name) = " + db.placeholder;
  if (!db.query(sql, [said.toLowerCase()])) {
    return "";
  }
  if (db.rows() != 1) {
    return "";
  }
  return db.value(0, 0);
}

function promptAtVersion(db: Db, promptName: string, version: int): string {
  let sql = "SELECT id FROM prompts WHERE prompt_name = " + db.placeholder
    + " AND version = " + placeholderAt(db, 2);
  if (!db.query(sql, [promptName, `${version}`])) {
    return "";
  }
  if (db.rows() != 1) {
    return "";
  }
  return db.value(0, 0);
}

function boolLit(db: Db, v: bool): string {
  if (db.name == "postgres") {
    return v ? "TRUE" : "FALSE";
  }
  return v ? "1" : "0";
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
    && call.name != "create_agent" && call.name != "change_agent"
    && call.name != "delete_agent") {
    return not();
  }
  if (!maySchedule(call.owner)) {
    return no("signing in is what makes the deployment theirs to configure — say so.");
  }

  if (call.name == "list_agents") {
    let rows = JSON.parse<AgentRow[]>(listOrdered(db, agentsMapping(), { order: noOrder() }));
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
    if (name == "") {
      return no("an agent needs a name: {\"name\":\"...\",\"prompt\":\"...\"}");
    }
    if (name.length > 48) {
      return no("an agent name is at most 48 characters — it doubles as a tool name.");
    }
    let prompt = jsonText(call.args, "prompt").trim();
    if (prompt == "") {
      return no("an agent needs its system prompt — who it is and how it answers.");
    }
    let taken = agentSaid(db, name);
    if (taken.id != "") {
      return no("\"" + name + "\" exists already — show_agent shows it, change_agent changes it.");
    }
    let configId = defaultConfig(db);
    let configSaidText = jsonText(call.args, "model_config").trim();
    if (configSaidText != "") {
      let config = configSaid(db, configSaidText);
      if (config.id == "") {
        return no("no model config called \"" + configSaidText + "\" — list_agents shows the ones in use.");
      }
      configId = config.id;
    }
    if (configId == "") {
      return no("this deployment has no model config to run an agent on yet.");
    }
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
  if (said == "") {
    return no("say which agent: {\"agent\":\"...\"} — list_agents shows them.");
  }
  let agent = agentSaid(db, said);
  if (agent.id == "") {
    return no("no agent by that name or id — list_agents shows them.");
  }

  if (call.name == "show_agent") {
    return yes(describeAgent(db, agent, true));
  }

  if (call.name == "delete_agent") {
    if (agent.isDefault) {
      return no("\"" + agent.agentName + "\" is the default agent — make another the default first (change_agent with default: true).");
    }
    executeWith(db, "DELETE FROM agent_skills WHERE agent_id = " + db.placeholder, [agent.id]);
    executeWith(db, "DELETE FROM agents WHERE id = " + db.placeholder, [agent.id]);
    return yes("Deleted \"" + agent.agentName + "\". Any workflow step or bot that still names it will fail with its name — worth checking if one might.");
  }

  let description = jsonText(call.args, "description").trim();
  let promptText = jsonText(call.args, "prompt");
  let configWord = jsonText(call.args, "model_config").trim();
  let enabledRaw = jsonRaw(call.args, "enabled").trim();
  let wantDefault = jsonRaw(call.args, "default").trim() == "true";
  let addSkill = jsonText(call.args, "add_skill").trim();
  let promptVersionRaw = jsonRaw(call.args, "prompt_version").trim();
  if (description == "" && promptText.trim() == "" && configWord == "" && enabledRaw == ""
    && !wantDefault && addSkill == "" && promptVersionRaw == "") {
    return no("say what changes: description, prompt, model_config, enabled, default, add_skill or prompt_version.");
  }
  let configId = agent.modelConfigId;
  let note = "";
  if (configWord != "") {
    let config = configSaid(db, configWord);
    if (config.id == "") {
      return no("no model config called \"" + configWord + "\".");
    }
    configId = config.id;
    note = " Now on " + config.label + ".";
  }
  if (addSkill != "") {
    let sk = findSkill(db, addSkill);
    if (sk == "") {
      return no("no skill called \"" + addSkill + "\" — list_skills shows them.");
    }
    executeWith(db, "DELETE FROM agent_skills WHERE agent_id = " + db.placeholder
      + " AND skill_id = " + placeholderAt(db, 2), [agent.id, sk]);
    executeWith(db, "INSERT INTO agent_skills (agent_id, skill_id) VALUES ("
      + db.placeholder + ", " + placeholderAt(db, 2) + ")", [agent.id, sk]);
    note = note + " Skill \"" + addSkill + "\" attached.";
  }
  if (wantDefault && !agent.isDefault) {
    executeWith(db, "UPDATE agents SET is_default = " + boolLit(db, false)
      + " WHERE is_default = " + boolLit(db, true), []);
    note = note + " It is the default now.";
  }
  let promptId = agent.promptId;
  if (promptVersionRaw != "") {
    let wantV = parseInt(promptVersionRaw, 10) ?? 0;
    let old = promptOf(db, agent.promptId);
    let found = promptAtVersion(db, old.promptName, wantV);
    if (found == "") {
      return no("\"" + old.promptName + "\" has no version " + `${wantV}` + " — show_agent names the current one.");
    }
    promptId = found;
    note = note + " Prompt rolled to v" + `${wantV}` + ".";
  }
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
    isDefault: wantDefault ? true : agent.isDefault, scriptImageId: agent.scriptImageId,
    updatedAt: `${call.nowMs}`,
  };
  persist(db, agentsMapping(), JSON.stringify(edited));
  return yes("Changed." + note + "\n\n" + describeAgent(db, edited, false));
}
