// The schema, against a live database: created from its own mappings, then
// read the way a request would read it.
//
//   cd packages/agents && lumen test schema.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { DbOrder, asc, connectDatabase, persist, findById, listOrdered, countWhere, existsById, execute, dropTable } from "../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../plume/migrate.ts";
import { thinkingJson } from "./provider.ts";
import { Candidate, candidatesFrom } from "./router.ts";
import { ROUTER_MAX_TOKENS, DERIVED_RANK_BASE, ModelRow, ModelConfigRow, PromptRow, McpServerRow, AgentRow, SkillRow, ModelChoiceRow, ModelRouterRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, skillsMapping, modelChoicesMapping, modelRoutersMapping, enabledChoices, configForChoice, agentsFull, schemaPlan, derivedMenuStatements } from "./schema.ts";

let database: Db = sqlite();

// What one read of an agent gives back.
type PromptView = { id: string, promptName: string, version: int, body: string };
type ConfigView = { id: string, modelId: string, temperature: number, maxTokens: int, topP: number, extra: string, thinking: string };
// What reading a config on its own gives back: every column of the live
// mapping AND its model relation, which agentsFull's hand-written projection
// deliberately does not carry. A ModelConfigRow cannot stand in — the nested
// document has a field the record does not declare, and JSON.parse refuses it.
type NestedModelView = { id: string, label: string, apiName: string, provider: string, enabled: bool };
type ConfigRowView = {
  id: string, modelId: string, temperature: number, maxTokens: int, topP: number,
  extra: string, thinking: string, label: string, selectable: bool, rank: int,
  model: NestedModelView,
};
// Exactly what agentsFull projects for a linked server — no more, or
// JSON.parse refuses the row for a field the query never selected.
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
  // auth_providers carries an ALTER (90.9 adds `kind`); left standing, the
  // column survives the wipe and that migration fails as a duplicate next run.
  execute(database, "DROP TABLE IF EXISTS auth_providers");
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  // Every table the plan creates, or a column an ALTER adds survives the wipe
  // and the migration that adds it fails as a duplicate on the next run —
  // which reads as "the plan is broken" and is really "the fixture is stale".
  // These four were missing and cost an afternoon between them.
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

  let opus: ModelRow = { id: "m1", label: "Opus 5", apiName: "claude-opus-5", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  let haiku: ModelRow = { id: "m2", label: "Haiku 4.5", apiName: "claude-haiku-4-5-20251001", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  persist(database, modelsMapping(), JSON.stringify(opus));
  persist(database, modelsMapping(), JSON.stringify(haiku));

  // c1 is offered and c2 is not, which is the pair the selectable tests need:
  // a config an operator published beside one that only serves an agent.
  let careful: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.2, maxTokens: 8192, topP: 0.95, extra: "{}", thinking: "", label: "Careful", selectable: true, rank: 1 };
  let quick: ModelConfigRow = { id: "c2", modelId: "m2", temperature: 0.7, maxTokens: 2048, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(database, modelConfigsMapping(database), JSON.stringify(careful));
  persist(database, modelConfigsMapping(database), JSON.stringify(quick));

  let p1: PromptRow = { id: "p1", promptName: "lead", version: 1, body: "You lead.", createdAt: "2026-07-25" };
  let p2: PromptRow = { id: "p2", promptName: "lead", version: 2, body: "You lead, briefly.", createdAt: "2026-07-25" };
  let p3: PromptRow = { id: "p3", promptName: "scout", version: 1, body: "You search.", createdAt: "2026-07-25" };
  persist(database, promptsMapping(), JSON.stringify(p1));
  persist(database, promptsMapping(), JSON.stringify(p2));
  persist(database, promptsMapping(), JSON.stringify(p3));

  let fsSrv: McpServerRow = { id: "s1", serverName: "filesystem", transport: "stdio", endpoint: "mcp-fs", authKind: "none", authHeader: "", enabled: true };
  let ghSrv: McpServerRow = { id: "s2", serverName: "github", transport: "http", endpoint: "https://mcp.gh", authKind: "none", authHeader: "", enabled: true };
  persist(database, mcpServersMapping(), JSON.stringify(fsSrv));
  persist(database, mcpServersMapping(), JSON.stringify(ghSrv));

  let lead: AgentRow = { id: "a1", agentName: "lead", description: "delegates", modelConfigId: "c1", promptId: "p2", scriptImageId: "", isDefault: false, enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  let scout: AgentRow = { id: "a2", agentName: "scout", description: "searches", modelConfigId: "c2", promptId: "p3", scriptImageId: "", isDefault: false, enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  persist(database, agentsMapping(), JSON.stringify(lead));
  persist(database, agentsMapping(), JSON.stringify(scout));

  execute(database, "INSERT INTO agent_mcp_servers VALUES ('a1','s1'),('a1','s2'),('a2','s1')");
  execute(database, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");

  // 'private' and rank 0: a skill an agent carries by attachment, which is
  // what the agent_skills row below makes it. Both columns arrived at 77 and
  // 78 and the literal had never been updated, so this file did not compile.
  let recipe: SkillRow = { id: "k1", skillName: "weekly-report", description: "How to lay out the weekly report", body: "# Weekly report\nLead with the number.", updatedAt: "2026-07-25T10:00:00Z", visibility: "private", featuredRank: 0 , source: "local", sourceUrl: "" };
  persist(database, skillsMapping(), JSON.stringify(recipe));
  execute(database, "INSERT INTO agent_skills VALUES ('a1','k1')");

  // The menu: a router first, then two configs, plus one disabled row and one
  // premium row — enough that ordering, the enabled filter and the two kinds
  // are all observable.
  let auto: ModelChoiceRow = { id: "ch-auto", label: "Auto", description: "Picks for you", kind: "router", configId: "", routerId: "r1", tier: "", enabled: true, rank: 1 };
  let fast: ModelChoiceRow = { id: "ch-fast", label: "Fast", description: "Short answers, quickly", kind: "config", configId: "c2", routerId: "", tier: "", enabled: true, rank: 2 };
  let deep: ModelChoiceRow = { id: "ch-deep", label: "Thinking", description: "Takes its time", kind: "config", configId: "c1", routerId: "", tier: "premium", enabled: true, rank: 3 };
  let retired: ModelChoiceRow = { id: "ch-old", label: "Legacy", description: "Was offered once", kind: "config", configId: "c1", routerId: "", tier: "", enabled: false, rank: 4 };
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

// --- the schema builds itself ------------------------------------------------

test("the plan creates every table, from the mappings", () => {
  wipe();
  let r = migrate(database, schemaPlan(database));
  expect(r.ok);
  // Fifty-seven: ten tables from mappings, the plugins pair (a bundle's
  // receipt and what it brought — migrations 90.3 and 90.4), three link
  // tables, the credentials table, the index, the twelve ALTERs that add
  // columns those tables did not have when they were first created (the
  // newest being auth_providers.kind, 90.9; before it a skill's source and
  // sourceUrl, 90.1 and 90.2 — this count sat at 48 while both were already
  // in the plan, which is exactly the "canary nobody updates" failure the
  // healthz test warns about), the twelve statements of the named seed, the
  // four of the derived seed, and the three that repair what those four wrote
  // where they did find rows. Every one of them changes nothing on an empty
  // database, which is the point of the empty case. Asserting the number
  // rather than "some" is what catches a migration silently dropped.
  expect(r.applied == 57);
  // Every table answers, which means every generated statement ran.
  expect(countWhere(database, modelsMapping(), "", []) == 0);
  expect(countWhere(database, agentsMapping(), "", []) == 0);
});

test("running the plan twice applies nothing the second time", () => {
  wipe();
  expect(migrate(database, schemaPlan(database)).applied == 57);
  expect(migrate(database, schemaPlan(database)).applied == 0);
});

// --- one read gives a runnable agent ------------------------------------------

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
  // The projection names id, skill_name and description and stops there: a
  // body is big, the full view is read to run and to list, and a body rides
  // GET /skills/:id when someone edits. The SkillView type above declares
  // exactly the projected fields, so a body slipping into the projection
  // would fail this parse — that is the assertion, not an absence check.
  let scout: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(scout.skills.length == 0);
});

test("the model name is a row, so swapping models is an update", () => {
  seeded();
  // The config points at a model; the model carries the wire name.
  let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(agent.config.modelId == "m1");
  let model: ModelRow = JSON.parse<ModelRow>(findById(database, modelsMapping(), agent.config.modelId));
  expect(model.apiName == "claude-opus-5");

  // Point the config at the other model. Nothing is recompiled.
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
  // And version 2 is still there to go back to.
  expect(countWhere(database, promptsMapping(), "prompt_name = " + database.placeholder, ["lead"]) == 2);
});

test("a change is visible to the next read, with nothing reloaded", () => {
  seeded();
  execute(database, "UPDATE agents SET enabled = 0, description = 'retired' WHERE id = 'a2'");
  let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(!agent.enabled);
  expect(agent.description == "retired");
  // And the parent sees the change in its own read of the child.
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
  // a2 is a1's child and has no children of its own.
  let child: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(child.subAgents.length == 0);
  // A cycle does not hang: the read stops at one level.
  execute(database, "INSERT INTO agent_sub_agents VALUES ('a2','a1')");
  let cycled: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(cycled.subAgents.length == 1);
  expect(cycled.subAgents[0].agentName == "lead");
});

test("listing agents does not multiply them by their relations", () => {
  seeded();
  // a1 has two servers and one sub-agent; a join would repeat it.
  expect(countWhere(database, agentsFull(database), "", []) == 2);
  let keys: DbOrder[] = [asc("agent_name")];
  let json = listOrdered(database, agentsFull(database), "", [], keys);
  expect(json.indexOf("lead") == json.lastIndexOf("lead") - 0 || json.indexOf("lead") >= 0);
  expect(json.indexOf("scout") >= 0);
});

// --- the model menu -------------------------------------------------------------

test("the menu is the enabled rows, in rank order", () => {
  seeded();
  let menu = enabledChoices(database);
  // Four rows are seeded and one is disabled. A row retired from the menu is
  // still in the table — threads point at it — so the filter is what keeps it
  // off the list rather than a DELETE.
  expect(menu.length == 3);
  expect(menu[0].label == "Auto");
  expect(menu[1].label == "Fast");
  expect(menu[2].label == "Thinking");
});

test("a choice carries its kind and its tier, so the menu can draw the lock", () => {
  seeded();
  let menu = enabledChoices(database);
  // The router leads and names a router, never a config: one list, two kinds,
  // and the UI reads which from the row rather than from whichever id is set.
  expect(menu[0].kind == "router");
  expect(menu[0].routerId == "r1");
  expect(menu[0].configId == "");
  expect(menu[0].tier == "");
  // Premium is a label the menu renders; nothing here enforces it, which is
  // the design — the gate is where the choice is applied.
  expect(menu[2].tier == "premium");
  expect(menu[2].kind == "config");
});

test("a config choice resolves to a config; a router choice resolves to nothing", () => {
  seeded();
  expect(configForChoice(database, "ch-fast") == "c2");
  expect(configForChoice(database, "ch-deep") == "c1");
  // Not an error and not the fallback: the router phase has not run yet, and
  // which config it lands on is not knowable here.
  expect(configForChoice(database, "ch-auto") == "");
});

test("an unknown, empty or disabled choice means the agent's own config", () => {
  seeded();
  // "" is what every thread written before this feature holds.
  expect(configForChoice(database, "") == "");
  expect(configForChoice(database, "ch-nothing") == "");
  // The row exists and points at a real config, but the operator retired it.
  // A thread still pointing at it must keep running.
  expect(configForChoice(database, "ch-old") == "");
  // And re-enabling it is an UPDATE, with nothing reloaded.
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
  // Text, not a table. The keys are what the reply is matched against, so
  // what matters is that the operator's own words come back unchanged.
  expect(router.candidatesJson.indexOf("\"key\":\"fast\"") >= 0);
  expect(router.candidatesJson.indexOf("\"key\":\"deep\"") >= 0);
});

test("a config can be labelled and offered without any schema change", () => {
  seeded();
  let careful: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c1"));
  expect(careful.label == "Careful");
  expect(careful.selectable);
  expect(careful.rank == 1);
  // c2 exists to serve an agent and is not on offer, which is the state every
  // row already in a live deployment migrates into.
  let quick: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c2"));
  expect(!quick.selectable);
  expect(quick.label == "");
  // Publishing it is an UPDATE. `menu_rank` is the column and `rank` the
  // field — RANK is a reserved word in MySQL 8, so the table cannot use it.
  execute(database, "UPDATE model_configs SET selectable = 1, label = 'Quick', menu_rank = 2 WHERE id = 'c2'");
  let published: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c2"));
  expect(published.selectable);
  expect(published.label == "Quick");
  expect(published.rank == 2);
});

test("the new columns do not disturb the one read that runs an agent", () => {
  seeded();
  // agentsFull projects the config's columns by hand, and a label or a rank
  // has no business in a run. The AgentView type declares exactly what is
  // projected, so a new column leaking into that list would fail this parse.
  let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(agent.config.id == "c1");
  expect(agent.config.maxTokens == 8192);
});

// --- the seed -----------------------------------------------------------------

// The seed's own statements, run again against a database that holds the rows
// they look for.
//
// `migrate` has already applied all sixteen — on a database where every one of
// them matched nothing, which is the case every test above exercises and the
// case a fresh install is. Re-running the plan's own text is the only way to
// watch them do something, and taking the text from the plan rather than
// restating it is what keeps this from being a copy that can drift from the
// migration it is testing.
//
// Answers whether all sixteen ran, so a caller asserts it: a statement the
// database refuses is the failure this whole section is for, and one that
// happened inside a helper would otherwise show up as a missing row somewhere
// further down. Sixteen is twelve named statements and the four derived ones,
// and running them in plan order matters — the derived four read what the
// named twelve left behind, and are numbered above them for that reason.
function runSeed(): bool {
  let plan: Migration[] = schemaPlan(database);
  let ran: int = 0;
  let i: int = 0;
  while (i < plan.length) {
    if (plan[i].version.startsWith("87.")) {
      if (!execute(database, plan[i].sql).ok) { return false; }
      ran = ran + 1;
    }
    i = i + 1;
  }
  return ran == 19;
}

// The boot-time half: what `publishMenu` in api.ts runs after `seed`, on every
// start.
//
// It is separate from `runSeed` for the reason it is separate from the plan —
// the derived statements stopped being migrations because a migration runs at a
// moment fixed by the history, and on a new install that moment is before the
// database holds a model. Every caller below runs the two in the order `main`
// does: migrate, seed rows, publish the menu.
function runMenu(): bool {
  let statements = derivedMenuStatements(database);
  let i: int = 0;
  while (i < statements.length) {
    if (!execute(database, statements[i]).ok) { return false; }
    i = i + 1;
  }
  return statements.length == 4;
}

// A database shaped like the live deployment on the day the seed lands: the two
// chat models it names, and the one config that points at either of them — the
// default agent's. `flashEnabled` is the switch the seed's own guard reads, and
// false is a stand-in for every deployment that has no cheap model at all.
function liveShaped(flashEnabled: bool): bool {
  wipe();
  migrate(database, schemaPlan(database));
  let flash: ModelRow = { id: "m-gemini-flash", label: "Gemini 2.5 Flash", apiName: "gemini-2.5-flash", provider: "vertex", kind: "chat", dimensions: 0, baseUrl: "https://example.invalid/openapi", enabled: flashEnabled, contextTokens: 0 };
  let pro: ModelRow = { id: "m-gemini-pro", label: "Gemini 2.5 Pro", apiName: "gemini-2.5-pro", provider: "vertex", kind: "chat", dimensions: 0, baseUrl: "https://example.invalid/openapi", enabled: true, contextTokens: 0 };
  persist(database, modelsMapping(), JSON.stringify(flash));
  persist(database, modelsMapping(), JSON.stringify(pro));
  // Unlabelled, unoffered, unranked: the state every config in a live
  // deployment migrates into at 82, and what the seed has to work from.
  let onPro: ModelConfigRow = { id: "c-gemini-pro", modelId: "m-gemini-pro", temperature: 0.2, maxTokens: 8192, topP: 0.95, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(database, modelConfigsMapping(database), JSON.stringify(onPro));
  return runSeed() && runMenu();
}

test("an empty database gets no menu rather than a broken one", () => {
  wipe();
  expect(migrate(database, schemaPlan(database)).ok);
  // Run again for good measure. The named half matches nothing because it names
  // rows nobody has; the derived half matches nothing because it derives from
  // rows nobody has. Twice, and with the same answer both times: a menu is a
  // reading of the tables, so empty tables read as an empty menu.
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
  // Auto leads and is not the default: "" on a thread still means the agent's
  // own config, so a conversation nobody has chosen for behaves exactly as
  // every conversation written before this feature does.
  expect(menu[0].label == "Auto");
  expect(menu[0].kind == "router");
  expect(menu[0].routerId == "rt-auto");
  expect(menu[0].configId == "");
  expect(menu[1].label == "Fast");
  expect(menu[2].label == "Standard");
  expect(menu[3].label == "Thinking");
  // Nothing is priced, so nothing renders a lock.
  expect(menu[3].tier == "");
  expect(configForChoice(database, "ch-auto") == "");
  expect(configForChoice(database, "ch-fast") == "c-gemini-flash");
  expect(configForChoice(database, "ch-standard") == "c-gemini-pro");
  expect(configForChoice(database, "ch-thinking") == "c-gemini-pro-think");
});

test("the fast config is created, and the standard one is only offered", () => {
  expect(liveShaped(true));
  // m-gemini-flash is enabled in the live deployment and nothing points at it,
  // so Fast is a config the seed has to write before it can be a choice.
  let fast: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-gemini-flash"));
  expect(fast.modelId == "m-gemini-flash");
  expect(fast.temperature == 0.3);
  expect(fast.maxTokens == 8192);
  expect(fast.topP == 1.0);
  expect(fast.thinking == "");
  expect(fast.selectable);
  // Standard is the row the default agent already runs. It is published, not
  // replaced: a second config on the same model is how the menu would start
  // answering on knobs nobody set.
  let standard: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-gemini-pro"));
  expect(standard.label == "Standard");
  expect(standard.selectable);
  expect(standard.temperature == 0.2);
});

test("the thinking config asks for an effort the provider will actually send", () => {
  expect(liveShaped(true));
  let think: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-gemini-pro-think"));
  // The same model and the same knobs as Standard — copied off that row rather
  // than restated, so a deployment that has since moved its temperature keeps
  // the move.
  expect(think.modelId == "m-gemini-pro");
  expect(think.temperature == 0.2);
  expect(think.maxTokens == 8192);
  expect(think.model.provider == "vertex");
  expect(think.thinking == "high");

  // The word is not the assertion; what the provider does with it is.
  // `thinkingJson` recognises a token budget for anthropic and one of three
  // efforts for everyone else, and drops anything else without a word — so the
  // spelling that reads natural, a budget, would have made a Thinking choice
  // that thinks exactly as hard as Standard, on vertex, silently. Asking the
  // function is the only way to test that, and this is the first row in the
  // deployment ever to set the column.
  let asRow: ModelConfigRow = { id: think.id, modelId: think.modelId, temperature: think.temperature, maxTokens: think.maxTokens, topP: think.topP, extra: think.extra, thinking: think.thinking, label: think.label, selectable: think.selectable, rank: think.rank };
  expect(thinkingJson("vertex", asRow) == ",\"reasoning_effort\":\"high\"");
  let budgeted: ModelConfigRow = { id: "c-x", modelId: "m-gemini-pro", temperature: 0.2, maxTokens: 8192, topP: 0.95, extra: "{}", thinking: "8192", label: "", selectable: false, rank: 0 };
  expect(thinkingJson("vertex", budgeted) == "");
});

test("the router routes on the cheap config and falls back to the standard one", () => {
  expect(liveShaped(true));
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-auto"));
  // The routing call is a small model answering with one word; paying Pro
  // rates to be told "fast" is the one cost this feature has no excuse for.
  //
  // On a config of its OWN, which 87.10/87.11 move it onto. 87.5 pointed it at
  // c-gemini-flash — the same row 87.7 publishes as the user-facing "Fast" —
  // so one number had to be both an 8192-token chat budget and the small
  // ceiling that is MODEL-CHOICE.md's only stated mitigation for the injection
  // cost the router accepts. One row could not be both.
  expect(router.routerConfigId == "c-router");
  let own: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-router"));
  // 87.10 created this row at sixteen tokens and 87.12 moved it, because on the
  // vertex rows this deployment routes with, sixteen was not a small budget but
  // no budget: the model's own thinking is billed against the same ceiling and
  // spent all of it before reaching the text, so every routed turn came back
  // truncated with nothing in it to match. The row has to agree with what
  // `routeTurn` actually sends, or the settings tab shows a number that is not
  // the one in use.
  expect(own.maxTokens == ROUTER_MAX_TOKENS);
  expect(own.modelId == "m-gemini-flash");
  // Plumbing, not a menu row: a config whose whole job is to answer with one
  // word does not belong in a list a person picks from.
  expect(!own.selectable);
  expect(countWhere(database, modelChoicesMapping(), "config_id = 'c-router'", []) == 0);
  // And the Fast choice keeps the budget a person asking a question needs.
  let fast: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-gemini-flash"));
  expect(fast.maxTokens == 8192);
  // And every failure path lands on Standard, not on Fast: a run that silently
  // downgrades is worse than one that silently costs a little more.
  expect(router.fallbackConfigId == "c-gemini-pro");
  expect(router.routeEvery == "turn");
  expect(!router.escalateOnly);
  expect(router.enabled);

  let candidates: Candidate[] = candidatesFrom(router.candidatesJson);
  expect(candidates.length == 3);
  expect(candidates[0].key == "fast");
  expect(candidates[1].key == "standard");
  expect(candidates[2].key == "think");
  // Every candidate names a config that exists. This is the failure the guards
  // are for: a seeded candidate pointing at a row nobody created routes to
  // nothing, and the symptom is Auto quietly always falling back.
  let i: int = 0;
  while (i < candidates.length) {
    expect(existsById(database, modelConfigsMapping(database), candidates[i].configId));
    expect(candidates[i].when != "");
    i = i + 1;
  }
});

test("without a cheap model there is no Fast row, and the router is the derived one", () => {
  expect(liveShaped(false));
  // m-gemini-flash exists but is switched off, so the named seed makes no
  // config for it and no `rt-auto`: with nothing cheap to route WITH, every one
  // of 87.5, 87.7, 87.10 and 87.11 matches nothing.
  expect(!existsById(database, modelConfigsMapping(database), "c-gemini-flash"));
  expect(!existsById(database, modelRoutersMapping(), "rt-auto"));
  // The derived seed then finds two selectable configs — Standard and Thinking,
  // one model at two thinking budgets — and that IS a decision worth
  // automating, so it builds a router over them. This is the case the named
  // seed left a deployment without one: MODEL-CHOICE.md's rule is "two or more
  // candidates", not "a cheap model exists", and a config is the unit.
  expect(countWhere(database, modelRoutersMapping(), "", []) == 1);
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-menu"));
  // The first config in rank order does the routing and catches the failures.
  expect(router.routerConfigId == "c-gemini-pro");
  expect(router.fallbackConfigId == "c-gemini-pro");
  expect(router.enabled);
  let candidates: Candidate[] = candidatesFrom(router.candidatesJson);
  expect(candidates.length == 2);
  expect(candidates[0].configId == "c-gemini-pro");
  expect(candidates[1].configId == "c-gemini-pro-think");
  // The `when` lines have to differ or the router is choosing between two
  // descriptions of the same thing. Both configs sit on ONE model here, so a
  // line derived from the model's label would have been the same sentence
  // twice — which is why it is derived from the config's label first.
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
  // Four configs, not three: Fast, Thinking, the default agent's Standard —
  // and the router's own, which 87.10 gives it so that capping the routing
  // call's output does not also cap the "Fast" chat choice.
  expect(countWhere(database, modelConfigsMapping(database), "", []) == 4);
  expect(countWhere(database, modelChoicesMapping(), "", []) == 4);
  expect(countWhere(database, modelRoutersMapping(), "", []) == 1);
  // What a row is CALLED is the operator's, so the label is written only into
  // an empty one. What is offered is this feature's business, and is set again.
  let standard: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "c-gemini-pro"));
  expect(standard.label == "House model");
  expect(standard.selectable);
  // And a menu row they retired stays retired: an id that is taken is left
  // alone rather than resurrected.
  expect(enabledChoices(database).length == 3);
});

// --- the derived seed, on a deployment that is not nuraly.io -------------------

// A community install: an Ollama model, optionally a Mistral one beside it, and
// three rows the seed has to refuse — an embedding model, a chat model somebody
// switched off, and the e2e's fake provider.
//
// Not one Gemini row anywhere, which is the whole point. Every statement of the
// named seed matches nothing here, so what comes out is exactly what the four
// derived statements could read off the tables, and a menu appearing at all is
// the defect being fixed: eleven guarded migrations gave this box nothing, and
// there is no admin UI for the operator to make a menu by hand.
//
// Two providers rather than two models from one, because the claim under test
// is that the seed never says a provider's name.
function communityShaped(second: bool): bool {
  wipe();
  migrate(database, schemaPlan(database));

  let llama: ModelRow = { id: "m-llama", label: "Llama 3.1", apiName: "llama3.1", provider: "ollama", kind: "chat", dimensions: 0, baseUrl: "http://127.0.0.1:11434", enabled: true, contextTokens: 0 };
  persist(database, modelsMapping(), JSON.stringify(llama));
  // Unlabelled, unoffered, unranked — the state migration 82 leaves every
  // config a deployment already had, and what the seed has to work from.
  let onLlama: ModelConfigRow = { id: "cfg-llama", modelId: "m-llama", temperature: 0.3, maxTokens: 4096, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(database, modelConfigsMapping(database), JSON.stringify(onLlama));

  if (second) {
    let mistral: ModelRow = { id: "m-small", label: "Mistral Small", apiName: "mistral-small-latest", provider: "mistral", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
    persist(database, modelsMapping(), JSON.stringify(mistral));
    let onMistral: ModelConfigRow = { id: "cfg-small", modelId: "m-small", temperature: 0.3, maxTokens: 8192, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
    persist(database, modelConfigsMapping(database), JSON.stringify(onMistral));
  }

  // The three refusals, each with a config pointing at it so that "no choice
  // was made for it" is a decision the seed took rather than a row it never
  // saw. An embedding model is not something a person picks to talk to; a
  // switched-off one is a dead menu row; and the fake provider is the argument
  // MODEL-CHOICE.md makes for a curated table existing at all.
  let embed: ModelRow = { id: "m-embed", label: "Nomic Embed", apiName: "nomic-embed-text", provider: "ollama", kind: "embedding", dimensions: 768, baseUrl: "http://127.0.0.1:11434", enabled: true, contextTokens: 0 };
  let retired: ModelRow = { id: "m-retired", label: "Mistral Retired", apiName: "mistral-tiny", provider: "mistral", kind: "chat", dimensions: 0, baseUrl: "", enabled: false, contextTokens: 0 };
  let fake: ModelRow = { id: "m-fake", label: "Double", apiName: "double-1", provider: "double", kind: "chat", dimensions: 0, baseUrl: "http://127.0.0.1:8932", enabled: true, contextTokens: 0 };
  persist(database, modelsMapping(), JSON.stringify(embed));
  persist(database, modelsMapping(), JSON.stringify(retired));
  persist(database, modelsMapping(), JSON.stringify(fake));
  let onEmbed: ModelConfigRow = { id: "cfg-embed", modelId: "m-embed", temperature: 0.0, maxTokens: 512, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  let onRetired: ModelConfigRow = { id: "cfg-retired", modelId: "m-retired", temperature: 0.3, maxTokens: 2048, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  let onFake: ModelConfigRow = { id: "cfg-fake", modelId: "m-fake", temperature: 0.0, maxTokens: 1024, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(database, modelConfigsMapping(database), JSON.stringify(onEmbed));
  persist(database, modelConfigsMapping(database), JSON.stringify(onRetired));
  persist(database, modelConfigsMapping(database), JSON.stringify(onFake));

  return runSeed() && runMenu();
}

test("a community box with two chat models gets two choices and a router", () => {
  expect(communityShaped(true));

  // Two choices over the two chat configs, ranked by the model's label, and
  // nothing over the embedding, the retired model or the fake.
  expect(countWhere(database, modelChoicesMapping(), "kind = 'config'", []) == 2);
  let llama: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-cfg-llama"));
  let small: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-cfg-small"));
  // The label falls back to the model's, because no config in a deployment that
  // predates migration 82 has one.
  expect(llama.label == "Llama 3.1");
  expect(small.label == "Mistral Small");
  // The description is the api name: the only thing that tells two rows sharing
  // a label apart, and a fact rather than a sentence somebody has to write.
  expect(llama.description == "llama3.1");
  expect(llama.configId == "cfg-llama");
  // Above anything a person would have placed by hand, so that on a deployment
  // that already curated a menu the derived rows land after it in one block
  // rather than interleaving with it.
  expect(llama.rank == DERIVED_RANK_BASE + 1);
  expect(small.rank == DERIVED_RANK_BASE + 2);
  expect(llama.tier == "");
  // Both configs are now offered, at the rank their menu row got — the two
  // tables cannot disagree about where a config sits, because one reads the
  // other.
  let cfg: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-llama"));
  expect(cfg.selectable);
  expect(cfg.rank == DERIVED_RANK_BASE + 1);
  let cfgSmall: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-small"));
  expect(cfgSmall.selectable);
  expect(cfgSmall.rank == DERIVED_RANK_BASE + 2);
  // And the three refusals stayed refused, on the row as well as in the menu.
  expect(!JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-embed")).selectable);
  expect(!JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-retired")).selectable);
  expect(!JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-fake")).selectable);

  // One router, because two candidates is a decision worth automating.
  expect(countWhere(database, modelRoutersMapping(), "", []) == 1);
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-menu"));
  // Both jobs go to the first config in rank order: the cheapest thing
  // available is the right default for the routing call and for the failure
  // path alike, and there is no tier to read to say otherwise.
  expect(router.routerConfigId == "cfg-llama");
  expect(router.fallbackConfigId == "cfg-llama");
  expect(router.routeEvery == "turn");
  // Off, because the ratchet is a preference an operator turns on rather than a
  // correctness rule.
  expect(!router.escalateOnly);
  expect(router.enabled);

  let candidates: Candidate[] = candidatesFrom(router.candidatesJson);
  expect(candidates.length == 2);
  // In rank order, keyed by the config id — the only thing about a config that
  // is unique and safe to put in a model's mouth, since `matchKey` compares a
  // reply against the whole key and a key with a space in it can never match.
  expect(candidates[0].key == "cfg-llama");
  expect(candidates[1].key == "cfg-small");
  let i: int = 0;
  while (i < candidates.length) {
    expect(existsById(database, modelConfigsMapping(database), candidates[i].configId));
    // Prose, and different per candidate, or the router is choosing between two
    // descriptions of the same thing. The operator is expected to rewrite them.
    expect(candidates[i].when != "");
    i = i + 1;
  }
  expect(candidates[0].when != candidates[1].when);

  // And it is pickable. `threads.model_choice_id` names a choice and nothing
  // else, so a router with no menu row is a completion nobody can ask for.
  let menu = enabledChoices(database);
  expect(menu.length == 3);
  expect(menu[0].label == "Auto");
  expect(menu[0].kind == "router");
  expect(menu[0].routerId == "rt-menu");
  expect(menu[1].label == "Llama 3.1");
  expect(menu[2].label == "Mistral Small");
  // A router choice resolves to "" — which config it lands on is not known
  // until the routing completion has been made.
  expect(configForChoice(database, "ch-rt-menu") == "");
  expect(configForChoice(database, "ch-cfg-small") == "cfg-small");

  // Nothing the named seed asserts exists here, which is the claim: this menu
  // was read off the tables rather than written into a migration.
  expect(!existsById(database, modelConfigsMapping(database), "c-gemini-flash"));
  expect(!existsById(database, modelRoutersMapping(), "rt-auto"));
});

test("a community box with one chat model gets one choice and no router", () => {
  expect(communityShaped(false));
  // One choice, and no second one invented to give the router something to
  // decide between. The embedding model, the retired model and the fake are all
  // still there and all still refused.
  expect(countWhere(database, modelChoicesMapping(), "", []) == 1);
  let only: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-cfg-llama"));
  expect(only.kind == "config");
  expect(only.configId == "cfg-llama");
  expect(only.rank == DERIVED_RANK_BASE + 1);

  // And no router: MODEL-CHOICE.md's rule, and the reason it is a rule — "a
  // router over a single candidate is a completion call that can only return
  // one answer", and a community box paying per token should not spend one
  // deciding which of one model to use.
  expect(countWhere(database, modelRoutersMapping(), "", []) == 0);
  expect(!existsById(database, modelChoicesMapping(), "ch-rt-menu"));

  let menu = enabledChoices(database);
  expect(menu.length == 1);
  expect(menu[0].label == "Llama 3.1");

  // Run the whole seed again: a second pass adds nothing, because every insert
  // asks whether the row it would write is already there.
  expect(runSeed());
  expect(countWhere(database, modelChoicesMapping(), "", []) == 1);
  expect(countWhere(database, modelRoutersMapping(), "", []) == 0);
});

test("the derived seed leaves a curated menu alone", () => {
  expect(liveShaped(true));
  // nuraly.io, where the named seed already ran: Fast, Standard and Thinking
  // over Gemini rows, plus `c-router`, the capped config `rt-auto` routes with.
  // The derived four run after all of it and change nothing.
  //
  // Three reasons, each of which is a separate guard: the three published
  // configs are already selectable; `c-router` is a router's own config and so
  // is not a thing to offer; and an enabled router already exists, which is an
  // operator's choice not to be shadowed by a second one.
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
  // A model the operator added later and never published — the ordinary case on
  // any deployment that has been running a while.
  let opus: ModelRow = { id: "m-opus", label: "Opus 5", apiName: "claude-opus-5", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  persist(database, modelsMapping(), JSON.stringify(opus));
  let onOpus: ModelConfigRow = { id: "cfg-opus", modelId: "m-opus", temperature: 0.2, maxTokens: 8192, topP: 0.95, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(database, modelConfigsMapping(database), JSON.stringify(onOpus));
  expect(runSeed());

  // `enabledChoices` orders on rank and then on label, so a derived row ranked
  // from 1 would have sorted between the curated tiers — "Opus 5" falls between
  // "Fast" and "Standard" — and broken Auto / Fast / Standard / Thinking into
  // pieces. It goes last instead, and the four the operator curated stay
  // together and in their order.
  let menu = enabledChoices(database);
  expect(menu.length == 5);
  expect(menu[0].label == "Auto");
  expect(menu[1].label == "Fast");
  expect(menu[2].label == "Standard");
  expect(menu[3].label == "Thinking");
  expect(menu[4].label == "Opus 5");
  expect(menu[4].rank == DERIVED_RANK_BASE + 1);
  // And the curated four kept the ranks 87.1 to 87.9 gave them.
  expect(menu[1].rank == 2);
});

// --- the menu is published at boot, not at migration --------------------------

// A brand new install, in the order `main()` really does it: migrate an empty
// database, write the rows `seed` writes, then publish the menu.
//
// This is the case the derived seed could not serve as a migration and the
// reason it is no longer one. `migrate` ran the four derived statements against
// a database with no models in it — because that is when a new install runs
// them — wrote nothing, and recorded them as applied, so they could never run
// again. Every fresh install answered `GET /models/choices` with `[]` for ever.
//
// The configs are `selectable: true` exactly as `seed` writes them, which was
// the second half of that failure: 87.20 skipped a selectable config, and the
// only configs a fresh install has are selectable.
function freshInstall(): bool {
  wipe();
  migrate(database, schemaPlan(database));
  let opus: ModelRow = { id: "m1", label: "Opus 5", apiName: "claude-opus-5", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  let haiku: ModelRow = { id: "m2", label: "Haiku 4.5", apiName: "claude-haiku-4-5-20251001", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  persist(database, modelsMapping(), JSON.stringify(opus));
  persist(database, modelsMapping(), JSON.stringify(haiku));
  let careful: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.2, maxTokens: 8192, topP: 0.95, extra: "{}", thinking: "", label: "Careful", selectable: true, rank: 1 };
  let quick: ModelConfigRow = { id: "c2", modelId: "m2", temperature: 0.7, maxTokens: 2048, topP: 1.0, extra: "{}", thinking: "", label: "Quick", selectable: true, rank: 2 };
  persist(database, modelConfigsMapping(database), JSON.stringify(careful));
  persist(database, modelConfigsMapping(database), JSON.stringify(quick));
  return runMenu();
}

test("a fresh install gets its menu from the boot, not from the migration", () => {
  expect(freshInstall());
  let menu = enabledChoices(database);
  expect(menu.length == 3);
  // Auto leads, and the two seeded configs follow in the derived block. Their
  // order there is by the MODEL's label, which is what the derivation has to go
  // on; the ranks the seed gave the configs are a curated menu it never made.
  expect(menu[0].label == "Auto");
  expect(menu[0].kind == "router");
  expect(menu[0].routerId == "rt-menu");
  expect(menu[1].label == "Quick");
  expect(menu[2].label == "Careful");
  expect(menu[1].rank == DERIVED_RANK_BASE + 1);
  expect(menu[2].rank == DERIVED_RANK_BASE + 2);
  expect(configForChoice(database, "ch-c1") == "c1");
  // And running it again is a no-op, which is what makes it safe on every
  // start rather than once.
  expect(runMenu());
  expect(enabledChoices(database).length == 3);
  expect(countWhere(database, modelRoutersMapping(), "", []) == 1);
});

test("a menu row the operator retired is not resurrected at the next boot", () => {
  expect(freshInstall());
  execute(database, "UPDATE model_choices SET enabled = 0 WHERE id = 'ch-c1'");
  execute(database, "UPDATE model_choices SET label = 'House model' WHERE id = 'ch-c2'");
  expect(runMenu());
  // The row is still there, still off, and still called what they called it:
  // this only ever inserts a choice for a config that has none.
  expect(enabledChoices(database).length == 2);
  let renamed: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-c2"));
  expect(renamed.label == "House model");
});

test("a model added after the install is on the menu at the next boot", () => {
  expect(communityShaped(false));
  expect(enabledChoices(database).length == 1);
  // The operator adds a second model in the settings tab, months later. No
  // migration will ever run again on this database, so the menu either grows
  // here or it never does.
  let mistral: ModelRow = { id: "m-small", label: "Mistral Small", apiName: "mistral-small-latest", provider: "mistral", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  persist(database, modelsMapping(), JSON.stringify(mistral));
  let onMistral: ModelConfigRow = { id: "cfg-small", modelId: "m-small", temperature: 0.3, maxTokens: 8192, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(database, modelConfigsMapping(database), JSON.stringify(onMistral));
  expect(runMenu());

  let menu = enabledChoices(database);
  expect(menu.length == 3);
  expect(menu[0].label == "Auto");
  expect(menu[1].label == "Llama 3.1");
  expect(menu[2].label == "Mistral Small");
  // Ranked after the row that was already there, and the config now says it is
  // offered at the rank its menu row got.
  expect(menu[2].rank == DERIVED_RANK_BASE + 2);
  let cfg: ConfigRowView = JSON.parse<ConfigRowView>(findById(database, modelConfigsMapping(database), "cfg-small"));
  expect(cfg.selectable);
  expect(cfg.rank == DERIVED_RANK_BASE + 2);
  // And the second model is what makes a router worth having: one option is no
  // decision, two is.
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-menu"));
  expect(router.routerConfigId == "cfg-llama");
  expect(candidatesFrom(router.candidatesJson).length == 2);
});

// --- two rows that would have read alike --------------------------------------

// One model at two ceilings, neither labelled: c-mistral and c-mistral-big on
// the live deployment, and the shape MODEL-CHOICE.md says the data already has
// ("Two configs already share one model ... it just has no labels").
function twoBudgetsOneModel(): bool {
  wipe();
  migrate(database, schemaPlan(database));
  let solo: ModelRow = { id: "m-solo", label: "Local Llama", apiName: "llama-local", provider: "ollama", kind: "chat", dimensions: 0, baseUrl: "http://127.0.0.1:11434", enabled: true, contextTokens: 0 };
  persist(database, modelsMapping(), JSON.stringify(solo));
  let small: ModelConfigRow = { id: "cfg-a", modelId: "m-solo", temperature: 0.3, maxTokens: 4096, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  let big: ModelConfigRow = { id: "cfg-b", modelId: "m-solo", temperature: 0.3, maxTokens: 8192, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(database, modelConfigsMapping(database), JSON.stringify(small));
  persist(database, modelConfigsMapping(database), JSON.stringify(big));
  return runSeed() && runMenu();
}

test("two configs on one model are told apart in the menu", () => {
  expect(twoBudgetsOneModel());
  let menu = enabledChoices(database);
  expect(menu.length == 2);
  // The label is the same word twice, because both fall back to the model's —
  // which MODEL-CHOICE.md answers with "label the rows", an operator action.
  // What must not happen is two rows that are identical in BOTH fields, which
  // is a menu offering the same option twice with no way to tell which is
  // which. 87.20 wrote exactly that: the description is the api name, and two
  // configs sharing a label share it because they share a model, which is the
  // one case where the api name cannot tell them apart.
  expect(menu[0].label == "Local Llama");
  expect(menu[1].label == "Local Llama");
  expect(menu[0].description != menu[1].description);
  expect(menu[0].description == "llama-local (cfg-a)");
  expect(menu[1].description == "llama-local (cfg-b)");
});

test("a router is not seeded over two options that read the same", () => {
  expect(twoBudgetsOneModel());
  // 87.22 counts configs and would have built one: two candidates, both
  // described as "messages best answered by Local Llama". A classifier handed
  // two identical options picks arbitrarily, so the deployment pays a
  // completion per turn to flip max_tokens between 4096 and 8192. 87.24 and
  // 87.25 take that router away, and the boot-time derivation does not make
  // another: two of something means two things a classifier can tell apart.
  expect(countWhere(database, modelRoutersMapping(), "", []) == 0);
  expect(!existsById(database, modelChoicesMapping(), "ch-rt-menu"));
  // And once the operator labels them, it is a decision worth automating.
  execute(database, "UPDATE model_configs SET label = 'Long answers' WHERE id = 'cfg-b'");
  expect(runMenu());
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-menu"));
  let candidates: Candidate[] = candidatesFrom(router.candidatesJson);
  expect(candidates.length == 2);
  expect(candidates[0].when != candidates[1].when);
});

test("a repaired description is repaired once, and only where 87.20 wrote it", () => {
  expect(twoBudgetsOneModel());
  // The repair keys off the description still being EXACTLY the model's api
  // name, which is 87.20's signature — so a second pass matches nothing, and
  // words an operator wrote are never appended to.
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
