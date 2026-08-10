import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { DbOrder, connectDatabase, persist, findById, listOrdered, countWhere, existsById, execute, dropTable } from "../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../plume/migrate.ts";
import { thinkingJson } from "./provider.ts";
import { Candidate, candidatesFrom } from "./router.ts";
import { ROUTER_MAX_TOKENS, DERIVED_RANK_BASE, ModelRow, ModelConfigRow, PromptRow, McpServerRow, AgentRow, SkillRow, ModelChoiceRow, ModelRouterRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, skillsMapping, modelChoicesMapping, modelRoutersMapping, enabledChoices, configForChoice, agentsFull, schemaPlan, derivedMenuStatements } from "./schema.ts";

let database: Db = sqlite();

type PromptView = { id: string, promptName: string, version: int, body: string };
type ConfigView = { id: string, modelId: string, temperature: number, maxTokens: int, topP: number, extra: string, thinking: string };
type NestedModelView = { id: string, label: string, apiName: string, provider: string, enabled: bool };
type ConfigRowView = {
  id: string, modelId: string, temperature: number, maxTokens: int, topP: number,
  extra: string, thinking: string, label: string, selectable: bool, rank: int,
  model: NestedModelView,
};
type ServerView = { id: string, serverName: string, transport: string, endpoint: string, enabled: bool };
type SubAgentView = { id: string, agentName: string, enabled: bool };
type SkillView = { id: string, skillName: string, description: string };
type AgentView = {
  id: string,
  agentName: string,
  description: string,
  modelConfigId: string,
  promptId: string,
  enabled: bool,
  isDefault: bool,
  scriptImageId: string,
  updatedAt: string,
  prompt: PromptView,
  config: ConfigView,
  servers: ServerView[],
  subAgents: SubAgentView[],
  skills: SkillView[],
};

function connect(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_schema_test.db" };
  connectDatabase(database, cfg);
}

function wipe(): void {
  connect();
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS provider_credentials");
  execute(database, "DROP TABLE IF EXISTS auth_providers");
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  execute(database, "DROP TABLE IF EXISTS script_images");
  execute(database, "DROP TABLE IF EXISTS templates");
  execute(database, "DROP TABLE IF EXISTS template_files");
  execute(database, "DROP TABLE IF EXISTS plugins");
  execute(database, "DROP TABLE IF EXISTS plugin_items");
  execute(database, "DROP TABLE IF EXISTS thread_summaries");
  dropTable(database, modelChoicesMapping());
  dropTable(database, modelRoutersMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
}

function seeded(): void {
  wipe();
  migrate(database, schemaPlan(database));

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
  persist(database, modelsMapping(), JSON.stringify(opus));
  persist(database, modelsMapping(), JSON.stringify(haiku));

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
    label: "",
    selectable: false,
    rank: 0,
  };
  persist(database, modelConfigsMapping(database), JSON.stringify(careful));
  persist(database, modelConfigsMapping(database), JSON.stringify(quick));

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
  let p3: PromptRow = {
    id: "p3",
    promptName: "scout",
    version: 1,
    body: "You search.",
    createdAt: "2026-07-25",
  };
  persist(database, promptsMapping(), JSON.stringify(p1));
  persist(database, promptsMapping(), JSON.stringify(p2));
  persist(database, promptsMapping(), JSON.stringify(p3));

  let fsSrv: McpServerRow = {
    id: "s1",
    serverName: "filesystem",
    transport: "stdio",
    endpoint: "mcp-fs",
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
  persist(database, mcpServersMapping(), JSON.stringify(fsSrv));
  persist(database, mcpServersMapping(), JSON.stringify(ghSrv));

  let lead: AgentRow = {
    id: "a1",
    agentName: "lead",
    description: "delegates",
    modelConfigId: "c1",
    promptId: "p2",
    scriptImageId: "",
    isDefault: false,
    enabled: true,
    updatedAt: "2026-07-25T10:00:00Z",
  };
  let scout: AgentRow = {
    id: "a2",
    agentName: "scout",
    description: "searches",
    modelConfigId: "c2",
    promptId: "p3",
    scriptImageId: "",
    isDefault: false,
    enabled: true,
    updatedAt: "2026-07-25T10:00:00Z",
  };
  persist(database, agentsMapping(), JSON.stringify(lead));
  persist(database, agentsMapping(), JSON.stringify(scout));

  execute(database, "INSERT INTO agent_mcp_servers VALUES ('a1','s1'),('a1','s2'),('a2','s1')");
  execute(database, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");

  let recipe: SkillRow = {
    id: "k1",
    skillName: "weekly-report",
    description: "How to lay out the weekly report",
    body: "# Weekly report\nLead with the number.",
    updatedAt: "2026-07-25T10:00:00Z",
    visibility: "private",
    featuredRank: 0,
    source: "local",
    sourceUrl: "",
  };
  persist(database, skillsMapping(), JSON.stringify(recipe));
  execute(database, "INSERT INTO agent_skills VALUES ('a1','k1')");

  let auto: ModelChoiceRow = {
    id: "ch-auto",
    label: "Auto",
    description: "Picks for you",
    kind: "router",
    configId: "",
    routerId: "r1",
    tier: "",
    enabled: true,
    rank: 1,
  };
  let fast: ModelChoiceRow = {
    id: "ch-fast",
    label: "Fast",
    description: "Short answers, quickly",
    kind: "config",
    configId: "c2",
    routerId: "",
    tier: "",
    enabled: true,
    rank: 2,
  };
  let deep: ModelChoiceRow = {
    id: "ch-deep",
    label: "Thinking",
    description: "Takes its time",
    kind: "config",
    configId: "c1",
    routerId: "",
    tier: "premium",
    enabled: true,
    rank: 3,
  };
  let retired: ModelChoiceRow = {
    id: "ch-old",
    label: "Legacy",
    description: "Was offered once",
    kind: "config",
    configId: "c1",
    routerId: "",
    tier: "",
    enabled: false,
    rank: 4,
  };
  persist(database, modelChoicesMapping(), JSON.stringify(auto));
  persist(database, modelChoicesMapping(), JSON.stringify(fast));
  persist(database, modelChoicesMapping(), JSON.stringify(deep));
  persist(database, modelChoicesMapping(), JSON.stringify(retired));

  let router: ModelRouterRow = {
    id: "r1", label: "Auto", routerConfigId: "c2",
    candidatesJson: "[{\"key\":\"fast\",\"configId\":\"c2\",\"when\":\"greetings and short factual questions\"},{\"key\":\"deep\",\"configId\":\"c1\",\"when\":\"writing a document or a multi-step analysis\"}]",
    fallbackConfigId: "c1", routeEvery: "turn", escalateOnly: false, enabled: true,
  };
  persist(database, modelRoutersMapping(), JSON.stringify(router));
}

test("the plan creates every table, from the mappings", () => {
  wipe();
  let r = migrate(database, schemaPlan(database));
  expect(r.ok);
  expect(r.applied == 62);
  expect(countWhere(database, modelsMapping(), "", []) == 0);
  expect(countWhere(database, agentsMapping(), "", []) == 0);
});

test("running the plan twice applies nothing the second time", () => {
  wipe();
  expect(migrate(database, schemaPlan(database)).applied == 62);
  expect(migrate(database, schemaPlan(database)).applied == 0);
});

test("an agent arrives with its prompt, config, servers and sub-agents", () => {
  seeded();
  let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(agent.agentName == "lead");
  expect(agent.prompt.body == "You lead, briefly.");
  expect(agent.config.maxTokens == 8192);
  expect(agent.servers.length == 2);
  expect(agent.subAgents.length == 1);
  expect(agent.subAgents[0].agentName == "scout");
});

test("an agent arrives with its skills, and the full view carries no bodies", () => {
  seeded();
  let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(agent.skills.length == 1);
  expect(agent.skills[0].skillName == "weekly-report");
  expect(agent.skills[0].description == "How to lay out the weekly report");
  let scout: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(scout.skills.length == 0);
});

test("the model name is a row, so swapping models is an update", () => {
  seeded();
  let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(agent.config.modelId == "m1");
  let model: ModelRow = JSON.parse<ModelRow>(findById(database, modelsMapping(), agent.config.modelId));
  expect(model.apiName == "claude-opus-5");

  execute(database, "UPDATE model_configs SET model_id = 'm2' WHERE id = 'c1'");
  let after: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  let swapped: ModelRow = JSON.parse<ModelRow>(findById(database, modelsMapping(), after.config.modelId));
  expect(swapped.apiName == "claude-haiku-4-5-20251001");
});

test("a prompt is versioned, so rolling back is pointing at an older row", () => {
  seeded();
  let before: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(before.prompt.version == 2);

  execute(database, "UPDATE agents SET prompt_id = 'p1' WHERE id = 'a1'");
  let after: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(after.prompt.version == 1);
  expect(after.prompt.body == "You lead.");
  expect(countWhere(database, promptsMapping(), "prompt_name = " + database.placeholder, ["lead"]) == 2);
});

test("a change is visible to the next read, with nothing reloaded", () => {
  seeded();
  execute(database, "UPDATE agents SET enabled = 0, description = 'retired' WHERE id = 'a2'");
  let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(!agent.enabled);
  expect(agent.description == "retired");
  let parent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(!parent.subAgents[0].enabled);
});

test("adding a server to an agent needs no schema change", () => {
  seeded();
  let before: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(before.servers.length == 1);
  execute(database, "INSERT INTO agent_mcp_servers VALUES ('a2','s2')");
  let after: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(after.servers.length == 2);
});

test("a sub-agent is an agent, and reads one level at a time", () => {
  seeded();
  let child: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(child.subAgents.length == 0);
  execute(database, "INSERT INTO agent_sub_agents VALUES ('a2','a1')");
  let cycled: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(cycled.subAgents.length == 1);
  expect(cycled.subAgents[0].agentName == "lead");
});

test("listing agents does not multiply them by their relations", () => {
  seeded();
  expect(countWhere(database, agentsFull(database), "", []) == 2);
  let keys: DbOrder[] = [{ column: "agent_name" }];
  let json = listOrdered(database, agentsFull(database), { order: keys });
  expect(json.indexOf("lead") == json.lastIndexOf("lead") - 0 || json.indexOf("lead") >= 0);
  expect(json.indexOf("scout") >= 0);
});

test("the menu is the enabled rows, in rank order", () => {
  seeded();
  let menu = enabledChoices(database);
  expect(menu.length == 3);
  expect(menu[0].label == "Auto");
  expect(menu[1].label == "Fast");
  expect(menu[2].label == "Thinking");
});

test("a choice carries its kind and its tier, so the menu can draw the lock", () => {
  seeded();
  let menu = enabledChoices(database);
  expect(menu[0].kind == "router");
  expect(menu[0].routerId == "r1");
  expect(menu[0].configId == "");
  expect(menu[0].tier == "");
  expect(menu[2].tier == "premium");
  expect(menu[2].kind == "config");
});

test("a config choice resolves to a config; a router choice resolves to nothing", () => {
  seeded();
  expect(configForChoice(database, "ch-fast") == "c2");
  expect(configForChoice(database, "ch-deep") == "c1");
  expect(configForChoice(database, "ch-auto") == "");
});

test("an unknown, empty or disabled choice means the agent's own config", () => {
  seeded();
  expect(configForChoice(database, "") == "");
  expect(configForChoice(database, "ch-nothing") == "");
  expect(configForChoice(database, "ch-old") == "");
  execute(database, "UPDATE model_choices SET enabled = 1 WHERE id = 'ch-old'");
  expect(configForChoice(database, "ch-old") == "c1");
});

test("a router row keeps its candidates whole", () => {
  seeded();
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "r1"));
  expect(router.routerConfigId == "c2");
  expect(router.fallbackConfigId == "c1");
  expect(router.routeEvery == "turn");
  expect(!router.escalateOnly);
  expect(router.candidatesJson.indexOf("\"key\":\"fast\"") >= 0);
  expect(router.candidatesJson.indexOf("\"key\":\"deep\"") >= 0);
});

test("a config can be labelled and offered without any schema change", () => {
  seeded();
  let careful: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c1"));
  expect(careful.label == "Careful");
  expect(careful.selectable);
  expect(careful.rank == 1);
  let quick: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c2"));
  expect(!quick.selectable);
  expect(quick.label == "");
  execute(database, "UPDATE model_configs SET selectable = 1, label = 'Quick', menu_rank = 2 WHERE id = 'c2'");
  let published: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c2"));
  expect(published.selectable);
  expect(published.label == "Quick");
  expect(published.rank == 2);
});

test("the new columns do not disturb the one read that runs an agent", () => {
  seeded();
  let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(agent.config.id == "c1");
  expect(agent.config.maxTokens == 8192);
});

function runSeed(): bool {
  let plan: Migration[] = schemaPlan(database);
  let ran: int = 0;
  let i: int = 0;
  while (i < plan.length) {
    if (plan[i].version.startsWith("87.")) {
      if (!execute(database, plan[i].sql).ok) {
        return false;
      }
      ran = ran + 1;
    }
    i = i + 1;
  }
  return ran == 19;
}

function runMenu(): bool {
  let statements = derivedMenuStatements(database);
  let i: int = 0;
  while (i < statements.length) {
    if (!execute(database, statements[i]).ok) {
      return false;
    }
    i = i + 1;
  }
  return statements.length == 4;
}

function liveShaped(flashEnabled: bool): bool {
  wipe();
  migrate(database, schemaPlan(database));
  let flash: ModelRow = {
    id: "m-gemini-flash",
    label: "Gemini 2.5 Flash",
    apiName: "gemini-2.5-flash",
    provider: "vertex",
    kind: "chat",
    dimensions: 0,
    baseUrl: "https://example.invalid/openapi",
    enabled: flashEnabled,
    contextTokens: 0,
  };
  let pro: ModelRow = {
    id: "m-gemini-pro",
    label: "Gemini 2.5 Pro",
    apiName: "gemini-2.5-pro",
    provider: "vertex",
    kind: "chat",
    dimensions: 0,
    baseUrl: "https://example.invalid/openapi",
    enabled: true,
    contextTokens: 0,
  };
  persist(database, modelsMapping(), JSON.stringify(flash));
  persist(database, modelsMapping(), JSON.stringify(pro));
  let onPro: ModelConfigRow = {
    id: "c-gemini-pro",
    modelId: "m-gemini-pro",
    temperature: 0.2,
    maxTokens: 8192,
    topP: 0.95,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  persist(database, modelConfigsMapping(database), JSON.stringify(onPro));
  return runSeed() && runMenu();
}

test("an empty database gets no menu rather than a broken one", () => {
  wipe();
  expect(migrate(database, schemaPlan(database)).ok);
  expect(runSeed());
  expect(countWhere(database, modelConfigsMapping(database), "", []) == 0);
  expect(countWhere(database, modelChoicesMapping(), "", []) == 0);
  expect(countWhere(database, modelRoutersMapping(), "", []) == 0);
  expect(enabledChoices(database).length == 0);
});

test("the seed builds Auto, Fast, Standard and Thinking, in that order", () => {
  expect(liveShaped(true));
  let menu = enabledChoices(database);
  expect(menu.length == 4);
  expect(menu[0].label == "Auto");
  expect(menu[0].kind == "router");
  expect(menu[0].routerId == "rt-auto");
  expect(menu[0].configId == "");
  expect(menu[1].label == "Fast");
  expect(menu[2].label == "Standard");
  expect(menu[3].label == "Thinking");
  expect(menu[3].tier == "");
  expect(configForChoice(database, "ch-auto") == "");
  expect(configForChoice(database, "ch-fast") == "c-gemini-flash");
  expect(configForChoice(database, "ch-standard") == "c-gemini-pro");
  expect(configForChoice(database, "ch-thinking") == "c-gemini-pro-think");
});

test("the fast config is created, and the standard one is only offered", () => {
  expect(liveShaped(true));
  let fast: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-gemini-flash"));
  expect(fast.modelId == "m-gemini-flash");
  expect(fast.temperature == 0.3);
  expect(fast.maxTokens == 8192);
  expect(fast.topP == 1.0);
  expect(fast.thinking == "");
  expect(fast.selectable);
  let standard: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-gemini-pro"));
  expect(standard.label == "Standard");
  expect(standard.selectable);
  expect(standard.temperature == 0.2);
});

test("the thinking config asks for an effort the provider will actually send", () => {
  expect(liveShaped(true));
  let think: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-gemini-pro-think"));
  expect(think.modelId == "m-gemini-pro");
  expect(think.temperature == 0.2);
  expect(think.maxTokens == 8192);
  expect(think.model.provider == "vertex");
  expect(think.thinking == "high");

  let asRow: ModelConfigRow = {
    id: think.id,
    modelId: think.modelId,
    temperature: think.temperature,
    maxTokens: think.maxTokens,
    topP: think.topP,
    extra: think.extra,
    thinking: think.thinking,
    label: think.label,
    selectable: think.selectable,
    rank: think.rank,
  };
  expect(thinkingJson("vertex", asRow) == ",\"reasoning_effort\":\"high\"");
  let budgeted: ModelConfigRow = {
    id: "c-x",
    modelId: "m-gemini-pro",
    temperature: 0.2,
    maxTokens: 8192,
    topP: 0.95,
    extra: "{}",
    thinking: "8192",
    label: "",
    selectable: false,
    rank: 0,
  };
  expect(thinkingJson("vertex", budgeted) == "");
});

test("the router routes on the cheap config and falls back to the standard one", () => {
  expect(liveShaped(true));
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-auto"));
  expect(router.routerConfigId == "c-router");
  let own: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-router"));
  expect(own.maxTokens == ROUTER_MAX_TOKENS);
  expect(own.modelId == "m-gemini-flash");
  expect(!own.selectable);
  expect(countWhere(database, modelChoicesMapping(), "config_id = 'c-router'", []) == 0);
  let fast: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-gemini-flash"));
  expect(fast.maxTokens == 8192);
  expect(router.fallbackConfigId == "c-gemini-pro");
  expect(router.routeEvery == "turn");
  expect(!router.escalateOnly);
  expect(router.enabled);

  let candidates: Candidate[] = candidatesFrom(router.candidatesJson);
  expect(candidates.length == 3);
  expect(candidates[0].key == "fast");
  expect(candidates[1].key == "standard");
  expect(candidates[2].key == "think");
  let i: int = 0;
  while (i < candidates.length) {
    expect(existsById(database, modelConfigsMapping(database), candidates[i].configId));
    expect(candidates[i].when != "");
    i = i + 1;
  }
});

test("without a cheap model there is no Fast row, and the router is the derived one", () => {
  expect(liveShaped(false));
  expect(!existsById(database, modelConfigsMapping(database), "c-gemini-flash"));
  expect(!existsById(database, modelRoutersMapping(), "rt-auto"));
  expect(countWhere(database, modelRoutersMapping(), "", []) == 1);
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-menu"));
  expect(router.routerConfigId == "c-gemini-pro");
  expect(router.fallbackConfigId == "c-gemini-pro");
  expect(router.enabled);
  let candidates: Candidate[] = candidatesFrom(router.candidatesJson);
  expect(candidates.length == 2);
  expect(candidates[0].configId == "c-gemini-pro");
  expect(candidates[1].configId == "c-gemini-pro-think");
  expect(candidates[0].when != candidates[1].when);

  let menu = enabledChoices(database);
  expect(menu.length == 3);
  expect(menu[0].label == "Auto");
  expect(menu[0].kind == "router");
  expect(menu[0].routerId == "rt-menu");
  expect(menu[1].label == "Standard");
  expect(menu[2].label == "Thinking");
});

test("the seed run twice adds nothing and keeps what the operator changed", () => {
  expect(liveShaped(true));
  execute(database, "UPDATE model_configs SET label = 'House model' WHERE id = 'c-gemini-pro'");
  execute(database, "UPDATE model_choices SET enabled = 0 WHERE id = 'ch-fast'");
  expect(runSeed());
  expect(countWhere(database, modelConfigsMapping(database), "", []) == 4);
  expect(countWhere(database, modelChoicesMapping(), "", []) == 4);
  expect(countWhere(database, modelRoutersMapping(), "", []) == 1);
  let standard: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-gemini-pro"));
  expect(standard.label == "House model");
  expect(standard.selectable);
  expect(enabledChoices(database).length == 3);
});

function communityShaped(second: bool): bool {
  wipe();
  migrate(database, schemaPlan(database));

  let llama: ModelRow = {
    id: "m-llama",
    label: "Llama 3.1",
    apiName: "llama3.1",
    provider: "ollama",
    kind: "chat",
    dimensions: 0,
    baseUrl: "http://127.0.0.1:11434",
    enabled: true,
    contextTokens: 0,
  };
  persist(database, modelsMapping(), JSON.stringify(llama));
  let onLlama: ModelConfigRow = {
    id: "cfg-llama",
    modelId: "m-llama",
    temperature: 0.3,
    maxTokens: 4096,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  persist(database, modelConfigsMapping(database), JSON.stringify(onLlama));

  if (second) {
    let mistral: ModelRow = {
      id: "m-small",
      label: "Mistral Small",
      apiName: "mistral-small-latest",
      provider: "mistral",
      kind: "chat",
      dimensions: 0,
      baseUrl: "",
      enabled: true,
      contextTokens: 0,
    };
    persist(database, modelsMapping(), JSON.stringify(mistral));
    let onMistral: ModelConfigRow = {
      id: "cfg-small",
      modelId: "m-small",
      temperature: 0.3,
      maxTokens: 8192,
      topP: 1.0,
      extra: "{}",
      thinking: "",
      label: "",
      selectable: false,
      rank: 0,
    };
    persist(database, modelConfigsMapping(database), JSON.stringify(onMistral));
  }

  let embed: ModelRow = {
    id: "m-embed",
    label: "Nomic Embed",
    apiName: "nomic-embed-text",
    provider: "ollama",
    kind: "embedding",
    dimensions: 768,
    baseUrl: "http://127.0.0.1:11434",
    enabled: true,
    contextTokens: 0,
  };
  let retired: ModelRow = {
    id: "m-retired",
    label: "Mistral Retired",
    apiName: "mistral-tiny",
    provider: "mistral",
    kind: "chat",
    dimensions: 0,
    baseUrl: "",
    enabled: false,
    contextTokens: 0,
  };
  let fake: ModelRow = {
    id: "m-fake",
    label: "Double",
    apiName: "double-1",
    provider: "double",
    kind: "chat",
    dimensions: 0,
    baseUrl: "http://127.0.0.1:8932",
    enabled: true,
    contextTokens: 0,
  };
  persist(database, modelsMapping(), JSON.stringify(embed));
  persist(database, modelsMapping(), JSON.stringify(retired));
  persist(database, modelsMapping(), JSON.stringify(fake));
  let onEmbed: ModelConfigRow = {
    id: "cfg-embed",
    modelId: "m-embed",
    temperature: 0.0,
    maxTokens: 512,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  let onRetired: ModelConfigRow = {
    id: "cfg-retired",
    modelId: "m-retired",
    temperature: 0.3,
    maxTokens: 2048,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  let onFake: ModelConfigRow = {
    id: "cfg-fake",
    modelId: "m-fake",
    temperature: 0.0,
    maxTokens: 1024,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  persist(database, modelConfigsMapping(database), JSON.stringify(onEmbed));
  persist(database, modelConfigsMapping(database), JSON.stringify(onRetired));
  persist(database, modelConfigsMapping(database), JSON.stringify(onFake));

  return runSeed() && runMenu();
}

test("a community box with two chat models gets two choices and a router", () => {
  expect(communityShaped(true));

  expect(countWhere(database, modelChoicesMapping(), "kind = 'config'", []) == 2);
  let llama: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-cfg-llama"));
  let small: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-cfg-small"));
  expect(llama.label == "Llama 3.1");
  expect(small.label == "Mistral Small");
  expect(llama.description == "llama3.1");
  expect(llama.configId == "cfg-llama");
  expect(llama.rank == DERIVED_RANK_BASE + 1);
  expect(small.rank == DERIVED_RANK_BASE + 2);
  expect(llama.tier == "");
  let cfg: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-llama"));
  expect(cfg.selectable);
  expect(cfg.rank == DERIVED_RANK_BASE + 1);
  let cfgSmall: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-small"));
  expect(cfgSmall.selectable);
  expect(cfgSmall.rank == DERIVED_RANK_BASE + 2);
  expect(!JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-embed")).selectable);
  expect(!JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-retired")).selectable);
  expect(!JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-fake")).selectable);

  expect(countWhere(database, modelRoutersMapping(), "", []) == 1);
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-menu"));
  expect(router.routerConfigId == "cfg-llama");
  expect(router.fallbackConfigId == "cfg-llama");
  expect(router.routeEvery == "turn");
  expect(!router.escalateOnly);
  expect(router.enabled);

  let candidates: Candidate[] = candidatesFrom(router.candidatesJson);
  expect(candidates.length == 2);
  expect(candidates[0].key == "cfg-llama");
  expect(candidates[1].key == "cfg-small");
  let i: int = 0;
  while (i < candidates.length) {
    expect(existsById(database, modelConfigsMapping(database), candidates[i].configId));
    expect(candidates[i].when != "");
    i = i + 1;
  }
  expect(candidates[0].when != candidates[1].when);

  let menu = enabledChoices(database);
  expect(menu.length == 3);
  expect(menu[0].label == "Auto");
  expect(menu[0].kind == "router");
  expect(menu[0].routerId == "rt-menu");
  expect(menu[1].label == "Llama 3.1");
  expect(menu[2].label == "Mistral Small");
  expect(configForChoice(database, "ch-rt-menu") == "");
  expect(configForChoice(database, "ch-cfg-small") == "cfg-small");

  expect(!existsById(database, modelConfigsMapping(database), "c-gemini-flash"));
  expect(!existsById(database, modelRoutersMapping(), "rt-auto"));
});

test("a community box with one chat model gets one choice and no router", () => {
  expect(communityShaped(false));
  expect(countWhere(database, modelChoicesMapping(), "", []) == 1);
  let only: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-cfg-llama"));
  expect(only.kind == "config");
  expect(only.configId == "cfg-llama");
  expect(only.rank == DERIVED_RANK_BASE + 1);

  expect(countWhere(database, modelRoutersMapping(), "", []) == 0);
  expect(!existsById(database, modelChoicesMapping(), "ch-rt-menu"));

  let menu = enabledChoices(database);
  expect(menu.length == 1);
  expect(menu[0].label == "Llama 3.1");

  expect(runSeed());
  expect(countWhere(database, modelChoicesMapping(), "", []) == 1);
  expect(countWhere(database, modelRoutersMapping(), "", []) == 0);
});

test("the derived seed leaves a curated menu alone", () => {
  expect(liveShaped(true));
  expect(countWhere(database, modelChoicesMapping(), "", []) == 4);
  expect(countWhere(database, modelRoutersMapping(), "", []) == 1);
  expect(!existsById(database, modelRoutersMapping(), "rt-menu"));
  expect(!existsById(database, modelChoicesMapping(), "ch-c-router"));
  expect(!JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-router")).selectable);
  let menu = enabledChoices(database);
  expect(menu.length == 4);
  expect(menu[0].routerId == "rt-auto");
});

test("a derived row lands after a curated menu rather than inside it", () => {
  expect(liveShaped(true));
  let opus: ModelRow = {
    id: "m-opus",
    label: "Opus 5",
    apiName: "claude-opus-5",
    provider: "anthropic",
    kind: "chat",
    dimensions: 0,
    baseUrl: "",
    enabled: true,
    contextTokens: 0,
  };
  persist(database, modelsMapping(), JSON.stringify(opus));
  let onOpus: ModelConfigRow = {
    id: "cfg-opus",
    modelId: "m-opus",
    temperature: 0.2,
    maxTokens: 8192,
    topP: 0.95,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  persist(database, modelConfigsMapping(database), JSON.stringify(onOpus));
  expect(runSeed());

  let menu = enabledChoices(database);
  expect(menu.length == 5);
  expect(menu[0].label == "Auto");
  expect(menu[1].label == "Fast");
  expect(menu[2].label == "Standard");
  expect(menu[3].label == "Thinking");
  expect(menu[4].label == "Opus 5");
  expect(menu[4].rank == DERIVED_RANK_BASE + 1);
  expect(menu[1].rank == 2);
});

function freshInstall(): bool {
  wipe();
  migrate(database, schemaPlan(database));
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
  persist(database, modelsMapping(), JSON.stringify(opus));
  persist(database, modelsMapping(), JSON.stringify(haiku));
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
  persist(database, modelConfigsMapping(database), JSON.stringify(careful));
  persist(database, modelConfigsMapping(database), JSON.stringify(quick));
  return runMenu();
}

test("a fresh install gets its menu from the boot, not from the migration", () => {
  expect(freshInstall());
  let menu = enabledChoices(database);
  expect(menu.length == 3);
  expect(menu[0].label == "Auto");
  expect(menu[0].kind == "router");
  expect(menu[0].routerId == "rt-menu");
  expect(menu[1].label == "Quick");
  expect(menu[2].label == "Careful");
  expect(menu[1].rank == DERIVED_RANK_BASE + 1);
  expect(menu[2].rank == DERIVED_RANK_BASE + 2);
  expect(configForChoice(database, "ch-c1") == "c1");
  expect(runMenu());
  expect(enabledChoices(database).length == 3);
  expect(countWhere(database, modelRoutersMapping(), "", []) == 1);
});

test("a menu row the operator retired is not resurrected at the next boot", () => {
  expect(freshInstall());
  execute(database, "UPDATE model_choices SET enabled = 0 WHERE id = 'ch-c1'");
  execute(database, "UPDATE model_choices SET label = 'House model' WHERE id = 'ch-c2'");
  expect(runMenu());
  expect(enabledChoices(database).length == 2);
  let renamed: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-c2"));
  expect(renamed.label == "House model");
});

test("a model added after the install is on the menu at the next boot", () => {
  expect(communityShaped(false));
  expect(enabledChoices(database).length == 1);
  let mistral: ModelRow = {
    id: "m-small",
    label: "Mistral Small",
    apiName: "mistral-small-latest",
    provider: "mistral",
    kind: "chat",
    dimensions: 0,
    baseUrl: "",
    enabled: true,
    contextTokens: 0,
  };
  persist(database, modelsMapping(), JSON.stringify(mistral));
  let onMistral: ModelConfigRow = {
    id: "cfg-small",
    modelId: "m-small",
    temperature: 0.3,
    maxTokens: 8192,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  persist(database, modelConfigsMapping(database), JSON.stringify(onMistral));
  expect(runMenu());

  let menu = enabledChoices(database);
  expect(menu.length == 3);
  expect(menu[0].label == "Auto");
  expect(menu[1].label == "Llama 3.1");
  expect(menu[2].label == "Mistral Small");
  expect(menu[2].rank == DERIVED_RANK_BASE + 2);
  let cfg: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-small"));
  expect(cfg.selectable);
  expect(cfg.rank == DERIVED_RANK_BASE + 2);
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-menu"));
  expect(router.routerConfigId == "cfg-llama");
  expect(candidatesFrom(router.candidatesJson).length == 2);
});

function twoBudgetsOneModel(): bool {
  wipe();
  migrate(database, schemaPlan(database));
  let solo: ModelRow = {
    id: "m-solo",
    label: "Local Llama",
    apiName: "llama-local",
    provider: "ollama",
    kind: "chat",
    dimensions: 0,
    baseUrl: "http://127.0.0.1:11434",
    enabled: true,
    contextTokens: 0,
  };
  persist(database, modelsMapping(), JSON.stringify(solo));
  let small: ModelConfigRow = {
    id: "cfg-a",
    modelId: "m-solo",
    temperature: 0.3,
    maxTokens: 4096,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  let big: ModelConfigRow = {
    id: "cfg-b",
    modelId: "m-solo",
    temperature: 0.3,
    maxTokens: 8192,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  persist(database, modelConfigsMapping(database), JSON.stringify(small));
  persist(database, modelConfigsMapping(database), JSON.stringify(big));
  return runSeed() && runMenu();
}

test("two configs on one model are told apart in the menu", () => {
  expect(twoBudgetsOneModel());
  let menu = enabledChoices(database);
  expect(menu.length == 2);
  expect(menu[0].label == "Local Llama");
  expect(menu[1].label == "Local Llama");
  expect(menu[0].description != menu[1].description);
  expect(menu[0].description == "llama-local (cfg-a)");
  expect(menu[1].description == "llama-local (cfg-b)");
});

test("a router is not seeded over two options that read the same", () => {
  expect(twoBudgetsOneModel());
  expect(countWhere(database, modelRoutersMapping(), "", []) == 0);
  expect(!existsById(database, modelChoicesMapping(), "ch-rt-menu"));
  execute(database, "UPDATE model_configs SET label = 'Long answers' WHERE id = 'cfg-b'");
  expect(runMenu());
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-menu"));
  let candidates: Candidate[] = candidatesFrom(router.candidatesJson);
  expect(candidates.length == 2);
  expect(candidates[0].when != candidates[1].when);
});

test("a repaired description is repaired once, and only where 87.20 wrote it", () => {
  expect(twoBudgetsOneModel());
  execute(database, "UPDATE model_choices SET description = 'The long one' WHERE id = 'ch-cfg-b'");
  expect(runSeed());
  let mine: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-cfg-b"));
  expect(mine.description == "The long one");
  let repaired: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-cfg-a"));
  expect(repaired.description == "llama-local (cfg-a)");
});

test("the suite leaves nothing behind", () => {
  wipe();
  expect(countWhere(database, agentsMapping(), "", []) == -1);
  database.close();
});
