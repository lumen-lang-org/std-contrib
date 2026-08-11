import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, executeWith, findById, deleteById, countWhere, dropTable } from "../plume/plume.ts";
import { migrate, migration, forgetMigrations } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, ModelChoiceRow, ModelRouterRow, McpServerRow, AgentRow, SkillRow, SkillFileRow, modelsMapping, modelConfigsMapping, modelConfigRows, modelChoicesMapping, modelRoutersMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, enabledChoices, configForChoice } from "./schema.ts";
import { TraceConfigRow, traceConfigMapping } from "./trace.ts";
import { DiscoverFeed, allFeeds, ensureGeoFeed, geoCode, discoverFeedsMapping } from "./discover.ts";
import { AgentRetrievalRow, Retrieved, agentRetrievalMapping, grantScope, agentScopes } from "./knowledge.ts";
import { storeCredential, credentialFor } from "./credentials.ts";
import { UNKNOWN_TAG, tagsFromHeader, identityUnreadable, owningTag } from "./owner.ts";
import { openThread, ownedThread, threadOwner, threadChoice, rememberChoice, listThreads } from "./threads.ts";
import { recordRun, runsOf } from "./runlog.ts";
import { AgentRun, AgentStep } from "./run.ts";
import { Turn } from "./provider.ts";
import { jsonText } from "./scan.ts";
import { RecordedSpan } from "../tracing/tracing.ts";
import { putFile, getFile, listFiles } from "./workspace.ts";
import { TURN_SEQ_NONE, putArtifact, listArtifacts } from "./artifacts.ts";
import { beginStep, stepsOfThread } from "./steps.ts";
import { DocumentFileRow, documentFileId, documentFilesMapping, findDocumentFile, forgetDocumentFiles, holdsSource, sourcesWithFiles } from "./document-files.ts";
import { migrationFault, bearerRefused, askedPick, configInUse, mergedConfig, configFault, chatConfigFault, blankChoice, mergedChoice, choiceRowFault, choiceInUse, blankRouter, mergedRouter, preEncodedCandidates, candidatesFault, routerRowFault, withCanonicalCandidates, routerJson, allRouters, routerInUse, publishMenu } from "./api.ts";
import { forgetAgent } from "./routes/agents/agent.service.ts";
import { decodedSize } from "./routes/documents/document.utils.ts";
import { healthJson } from "./routes/healthz/controller.ts";
import { StoredModel } from "./routes/models/dtos/stored-model.dto.ts";
import { ModelService, modelDestinationFault } from "./routes/models/model.service.ts";
import { modelFault } from "./routes/models/model.utils.ts";
import { forgetServer, serverDestinationFault } from "./routes/servers/server.service.ts";
import { ServerBody } from "./routes/servers/dtos/server-body.dto.ts";
import { skillFileFault, skillFault } from "./routes/skills/skill.utils.ts";
import { traceDestinationFault } from "./routes/tracing/controller.ts";
import { bodyText, bodyJson, bodyBool, bodyInt, bodyNumber, bodyRank, guestTag, guestQuotaJson, askedChoice, choiceFault } from "./api-core.ts";

let database: Db = sqlite();

function testKey(): string {
  return "0123456789abcdef0123456789abcdef";
}

function fresh(): string {
  let cfg: DbConfig = { filename: "/tmp/agents_api_track_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP TABLE IF EXISTS agent_scopes");
  execute(database, "DROP TABLE IF EXISTS agent_retrieval");
  execute(database, "DROP TABLE IF EXISTS documents");
  execute(database, "DROP TABLE IF EXISTS document_files");
  execute(database, "DROP TABLE IF EXISTS trace_config");
  execute(database, "DROP TABLE IF EXISTS thread_thoughts");
  execute(database, "DROP TABLE IF EXISTS thread_steps");
  execute(database, "DROP TABLE IF EXISTS thread_chunks");
  execute(database, "DROP TABLE IF EXISTS thread_turns");
  execute(database, "DROP TABLE IF EXISTS threads");
  execute(database, "DROP TABLE IF EXISTS artifact_versions");
  execute(database, "DROP TABLE IF EXISTS artifacts");
  execute(database, "DROP TABLE IF EXISTS workspace_files");
  execute(database, "DROP TABLE IF EXISTS run_steps");
  execute(database, "DROP TABLE IF EXISTS runs");
  execute(database, "DROP TABLE IF EXISTS models");
  execute(database, "DROP TABLE IF EXISTS script_images");
  execute(database, "DROP TABLE IF EXISTS thread_summaries");
  execute(database, "DROP TABLE IF EXISTS plugins");
  execute(database, "DROP TABLE IF EXISTS plugin_items");
  execute(database, "DROP TABLE IF EXISTS auth_providers");
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP TABLE IF EXISTS discover_stories");
  execute(database, "DROP TABLE IF EXISTS discover_feeds");
  execute(database, "DROP TABLE IF EXISTS card_plugins");
  execute(database, "DROP TABLE IF EXISTS card_cases");
  execute(database, "DROP TABLE IF EXISTS tool_cards");
  execute(database, "DROP TABLE IF EXISTS agent_web_rag");
  execute(database, "DROP TABLE IF EXISTS scheduled_tasks");
  execute(database, "DROP TABLE IF EXISTS workflows");
  execute(database, "DROP TABLE IF EXISTS workflow_runs");
  execute(database, "DROP TABLE IF EXISTS secrets");
  execute(database, "DROP TABLE IF EXISTS projects");
  execute(database, "DROP TABLE IF EXISTS model_choices");
  execute(database, "DROP TABLE IF EXISTS model_routers");
  execute(database, "DROP TABLE IF EXISTS trigger_inbox");
  execute(database, "DROP TABLE IF EXISTS trigger_outbox");
  execute(database, "DROP TABLE IF EXISTS trigger_bots");
  execute(database, "DROP TABLE IF EXISTS env_keys");
  execute(database, "DROP TABLE IF EXISTS user_environments");
  execute(database, "DROP TABLE IF EXISTS env_templates");
  execute(database, "DROP TABLE IF EXISTS mcp_tool_roster");
  execute(database, "DROP TABLE IF EXISTS api_keys");
  execute(database, "DROP TABLE IF EXISTS sandbox_limits");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  execute(database, "DROP INDEX IF EXISTS scopes_by_agent");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  let fault = migrationFault(database);
  if (fault != "") {
    console.error("[fixture] the plan did not run: " + fault);
  }
  return fault;
}

function modelRow(id: string, provider: string, kind: string, baseUrl: string): StoredModel {
  let m: StoredModel = {
    id: id, label: "L " + id, apiName: "some-model", provider: provider,
    kind: kind, dimensions: kind == "embedding" ? 1024 : 0,
    baseUrl: baseUrl, enabled: true, contextTokens: 0 };
  return m;
}

function mcpRow(id: string, endpoint: string): ServerBody {
  let s: ServerBody = {
    id: id, serverName: "demo " + id, transport: "http", endpoint: endpoint,
    authKind: "bearer", authHeader: "", enabled: true,
  };
  return s;
}

function traceRow(endpoint: string): TraceConfigRow {
  let t: TraceConfigRow = {
    id: "default", backend: "langfuse", endpoint: endpoint, publicKey: "pk-lf-1",
    serviceName: "agents", environment: "test", enabled: true,
  };
  return t;
}

test("a model's base URL cannot be moved while its provider's key is stored", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  storeCredential(database, {
    provider: "mistral",
    apiKey: "sk-fake-mistral-0001",
    masterKey: testKey(),
    now: "t",
  });

  let moved = modelDestinationFault(database, modelRow("m1", "mistral", "chat", "http://attacker.example/v1"));
  expect(moved != "");
  expect(moved.indexOf("attacker.example") >= 0);
  expect(moved.indexOf("DELETE /providers/mistral/key") >= 0);
});

test("a model created against a foreign base URL is refused just as a moved one is", () => {
  fresh();
  storeCredential(database, {
    provider: "mistral",
    apiKey: "sk-fake-mistral-0001",
    masterKey: testKey(),
    now: "t",
  });
  let created = modelDestinationFault(database, modelRow("m9", "mistral", "chat", "http://attacker.example/v1"));
  expect(created != "");
  expect(created.indexOf("attacker.example") >= 0);
});

test("a model whose provider changes is refused, because that changes the key too", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  storeCredential(database, {
    provider: "openai",
    apiKey: "sk-fake-openai-0002",
    masterKey: testKey(),
    now: "t",
  });
  let switched = modelDestinationFault(database, modelRow("m1", "openai", "chat", ""));
  expect(switched != "");
});

test("an edit that leaves the address alone is allowed", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  storeCredential(database, {
    provider: "mistral",
    apiKey: "sk-fake-mistral-0001",
    masterKey: testKey(),
    now: "t",
  });
  let renamed: StoredModel = {
    id: "m1", label: "A better label", apiName: "mistral-small-latest", provider: "mistral",
    kind: "chat", dimensions: 0, baseUrl: "", enabled: false, contextTokens: 0 };
  expect(modelDestinationFault(database, renamed) == "");
});

test("a path change on the same host is not a move", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "https://gw.internal/v1")));
  storeCredential(database, {
    provider: "mistral",
    apiKey: "sk-fake-mistral-0001",
    masterKey: testKey(),
    now: "t",
  });
  expect(modelDestinationFault(database, modelRow("m1", "mistral", "chat", "https://gw.internal/v2")) == "");
  expect(modelDestinationFault(database, modelRow("m1", "mistral", "chat", "https://gw.attacker/v1")) != "");
});

test("with no key stored there is nothing to protect and nothing is refused", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  expect(modelDestinationFault(database, modelRow("m1", "mistral", "chat", "http://anywhere.example/v1")) == "");
});

test("a base URL that is not an address is refused where it is written", () => {
  expect(modelFault(modelRow("m1", "mistral", "chat", "notaurl")).indexOf("base URL") >= 0);
  expect(modelFault(modelRow("m1", "mistral", "chat", "file:///etc/passwd")).indexOf("base URL") >= 0);
  expect(modelFault(modelRow("m1", "mistral", "chat", "")) == "");
  expect(modelFault(modelRow("m1", "mistral", "chat", "https://gw.internal/v1")) == "");
});

test("an MCP server's endpoint cannot be moved while its token is stored", () => {
  fresh();
  persist(database, mcpServersMapping(), JSON.stringify(mcpRow("s1", "https://mcp.example/mcp")));
  storeCredential(database, {
    provider: "mcp:s1",
    apiKey: "mcp-fake-token",
    masterKey: testKey(),
    now: "t",
  });

  let moved = serverDestinationFault(database, mcpRow("s1", "http://attacker.example/mcp"));
  expect(moved != "");
  expect(moved.indexOf("attacker.example") >= 0);
  expect(moved.indexOf("/servers/s1/auth") >= 0);
});

test("an MCP server keeping its endpoint is written without complaint", () => {
  fresh();
  persist(database, mcpServersMapping(), JSON.stringify(mcpRow("s1", "https://mcp.example/mcp")));
  storeCredential(database, {
    provider: "mcp:s1",
    apiKey: "mcp-fake-token",
    masterKey: testKey(),
    now: "t",
  });
  expect(serverDestinationFault(database, mcpRow("s1", "https://mcp.example/mcp")) == "");
});

test("the trace collector cannot be moved while its secret is stored", () => {
  fresh();
  persist(database, traceConfigMapping(), JSON.stringify(traceRow("https://cloud.langfuse.com")));
  storeCredential(database, {
    provider: "tracing",
    apiKey: "sk-lf-fake",
    masterKey: testKey(),
    now: "t",
  });

  let moved = traceDestinationFault(database, traceRow("http://attacker.example"));
  expect(moved != "");
  expect(moved.indexOf("attacker.example") >= 0);
  expect(moved.indexOf("DELETE /tracing/key") >= 0);
});

test("an address that cannot be read is treated as somewhere else", () => {
  fresh();
  persist(database, traceConfigMapping(), JSON.stringify(traceRow("https://cloud.langfuse.com")));
  storeCredential(database, {
    provider: "tracing",
    apiKey: "sk-lf-fake",
    masterKey: testKey(),
    now: "t",
  });
  expect(traceDestinationFault(database, traceRow("cloud.langfuse.com")) != "");
});

test("deleting an MCP server deletes its stored token", () => {
  fresh();
  persist(database, mcpServersMapping(), JSON.stringify(mcpRow("s1", "https://mcp.example/mcp")));
  storeCredential(database, {
    provider: "mcp:s1",
    apiKey: "mcp-fake-token",
    masterKey: testKey(),
    now: "t",
  });
  expect(credentialFor(database, "mcp:s1", testKey()) == "mcp-fake-token");

  forgetServer(database, "s1");

  expect(credentialFor(database, "mcp:s1", testKey()) == "");
  expect(countWhere(database, credentialsMapping(), "", []) == 0);
});

test("deleting an agent takes its scopes, its retrieval row and its parents' links", () => {
  fresh();
  let a1: AgentRow = {
    id: "a1",
    agentName: "lead",
    description: "d",
    modelConfigId: "c1",
    promptId: "p1",
    scriptImageId: "",
    isDefault: true,
    enabled: true,
    updatedAt: "t",
  };
  let a2: AgentRow = {
    id: "a2",
    agentName: "scout",
    description: "d",
    modelConfigId: "c1",
    promptId: "p1",
    scriptImageId: "",
    isDefault: false,
    enabled: true,
    updatedAt: "t",
  };
  persist(database, agentsMapping(), JSON.stringify(a1));
  persist(database, agentsMapping(), JSON.stringify(a2));
  execute(database, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");
  grantScope(database, "a2", "/specs");
  let retrieval: AgentRetrievalRow = {
    agentId: "a2",
    embeddingModelId: "e1",
    topK: 5,
    maxDistance: 1.0,
    enabled: true,
  };
  persist(database, agentRetrievalMapping(), JSON.stringify(retrieval));

  forgetAgent(database, "a2");

  expect(agentScopes(database, "a2").length == 0);
  expect(findById(database, agentRetrievalMapping(), "a2") == "");
  execute(database, "SELECT parent_id FROM agent_sub_agents WHERE child_id = 'a2'");
  expect(database.rows() == 0);
});

test("a migration that fails stops the server rather than being logged", () => {
  fresh();
  forgetMigrations(database);
  migrate(database, [migration("9999", "from a future build", "SELECT 1")]);
  let fault = migrationFault(database);
  expect(fault != "");
  expect(fault.indexOf("schema") >= 0);
});

test("a skill is refused at the door for each way of being unusable, by name", () => {
  let good: SkillRow = {
    id: "k1",
    skillName: "read-proto-enums",
    description: "compute enum values",
    body: "run enums.py",
    updatedAt: "t",
    visibility: "private",
    featuredRank: 0,
    source: "local",
    sourceUrl: "",
  };
  expect(skillFault(good) == "");

  let unnamed: SkillRow = {
    id: "k1",
    skillName: " ",
    description: "d",
    body: "b",
    updatedAt: "t",
    visibility: "private",
    featuredRank: 0,
    source: "local",
    sourceUrl: "",
  };
  expect(skillFault(unnamed).indexOf("needs a name") >= 0);
  let pathy: SkillRow = {
    id: "k1",
    skillName: "a/b",
    description: "d",
    body: "b",
    updatedAt: "t",
    visibility: "private",
    featuredRank: 0,
    source: "local",
    sourceUrl: "",
  };
  expect(skillFault(pathy).indexOf("container path") >= 0);
  let mute: SkillRow = {
    id: "k1",
    skillName: "ok",
    description: " ",
    body: "b",
    updatedAt: "t",
    visibility: "private",
    featuredRank: 0,
    source: "local",
    sourceUrl: "",
  };
  expect(skillFault(mute).indexOf("cannot be chosen") >= 0);
  let tall: SkillRow = {
    id: "k1",
    skillName: "ok",
    description: "two\nlines",
    body: "b",
    updatedAt: "t",
    visibility: "private",
    featuredRank: 0,
    source: "local",
    sourceUrl: "",
  };
  expect(skillFault(tall).indexOf("one line") >= 0);
  let empty: SkillRow = {
    id: "k1",
    skillName: "ok",
    description: "d",
    body: "  ",
    updatedAt: "t",
    visibility: "private",
    featuredRank: 0,
    source: "local",
    sourceUrl: "",
  };
  expect(skillFault(empty).indexOf("not an instruction") >= 0);
});

test("a skill file is a plain name with a body, within the cap", () => {
  let good: SkillFileRow = { id: "f1", skillId: "k1", path: "enums.py", body: "print(1)" };
  expect(skillFileFault(good) == "");
  let nested: SkillFileRow = { id: "f1", skillId: "k1", path: "a/b.py", body: "x" };
  expect(skillFileFault(nested).indexOf("plain name") >= 0);
  let escaping: SkillFileRow = { id: "f1", skillId: "k1", path: "..py", body: "x" };
  expect(skillFileFault(escaping).indexOf("plain name") >= 0);
  let hollow: SkillFileRow = { id: "f1", skillId: "k1", path: "x.py", body: "" };
  expect(skillFileFault(hollow).indexOf("nothing worth staging") >= 0);
});

let unscoped: string[] = [];

function emptyRun(text: string): AgentRun {
  let steps: AgentStep[] = [];
  let context: Turn[] = [];
  let notes: string[] = [];
  let names: string[] = [];
  let passages: Retrieved[] = [];
  let spans: RecordedSpan[] = [];
  let r: AgentRun = {
    ok: true, text: text, body: "{}", status: 200,
    agentName: "lead", promptVersion: 1, modelApiName: "claude-opus-5",
    inputTokens: 10, outputTokens: 5,
    error: "", context: context, steps: steps, stopReason: "final", rounds: 1,
    notes: notes, calledTools: names, calledAgents: names, retrieved: passages,
    spans: spans,
  };
  return r;
}

function threadFor(owner: string, word: string): string {
  let id = openThread(database, { agentId: "a1", owner: owner, now: "1700000000000" });
  putFile(database, {
    threadId: id,
    fileName: word + ".md",
    mime: "text/markdown",
    origin: "uploaded",
    body: "the " + word + " notes",
    documentId: "",
    now: "1700000000000",
  });
  putArtifact(database, {
    threadId: id, path: "/" + word + ".html", title: word, content: "<p>" + word + "</p>",
    note: "", origin: "uploaded", mustCreate: true, turnSeq: TURN_SEQ_NONE, now: "1700000000000",
  });
  beginStep(database, {
    threadId: id, seq: 0, depth: 0, rotation: 0, idx: 0, kind: "tool",
    name: "read_file", target: "", args: "{}", now: "1700000000000",
  });
  recordRun(database, {
    agentId: "a1",
    threadId: id,
    owner: owner,
    question: "about " + word,
    run: emptyRun(word),
    modelChoiceId: "",
    routeNote: "",
  });
  return id;
}

test("with no trusted proxy the header is not read at all", () => {
  expect(tagsFromHeader(false, "{\"uuid\":\"u-alice\"}").length == 0);
  expect(tagsFromHeader(false, "u-alice").length == 0);
  expect(tagsFromHeader(false, "").length == 0);
  expect(owningTag(tagsFromHeader(false, "u-alice")) == "");
});

test("a trusted proxy names one tag, and it is the id rather than the name", () => {
  let nuraly = tagsFromHeader(true, "{\"uuid\":\"u-alice\",\"username\":\"alice@example.test\",\"email\":\"alice@example.test\",\"anonymous\":false,\"roles\":[\"user\"]}");
  expect(nuraly.length == 1);
  expect(nuraly[0] == "u-alice");

  let plain = tagsFromHeader(true, "  alice  ");
  expect(plain.length == 1);
  expect(plain[0] == "alice");

  let silent = tagsFromHeader(true, "");
  expect(silent.length == 1);
  expect(silent[0] == "");
});

test("a document with no readable uuid is refused, not read as the unowned tag", () => {
  let anonymous = "{\"uuid\":null,\"username\":\"\",\"anonymous\":true,\"roles\":[]}";
  let renamed = "{\"userId\":\"u-alice\",\"anonymous\":false}";
  let empty = "{\"uuid\":\"\",\"anonymous\":false}";
  expect(tagsFromHeader(true, anonymous)[0] == UNKNOWN_TAG);
  expect(tagsFromHeader(true, renamed)[0] == UNKNOWN_TAG);
  expect(tagsFromHeader(true, empty)[0] == UNKNOWN_TAG);
  expect(tagsFromHeader(true, anonymous)[0] != "");

  expect(identityUnreadable(true, anonymous));
  expect(identityUnreadable(true, renamed));
  expect(!identityUnreadable(false, anonymous));
  expect(!identityUnreadable(true, ""));
  expect(!identityUnreadable(true, "alice"));
});

test("no row can hold the unknown tag", () => {
  expect(fresh() == "");
  let hers = threadFor("u-alice", "lyon");
  expect(ownedThread(database, hers, [UNKNOWN_TAG]) == "");
  expect(threadFor("", "unowned") != "");
  expect(listThreads(database, {
    tags: [UNKNOWN_TAG],
    limit: 50,
    offset: 0,
    project: "",
  }).length == 0);
});

test("two tags cannot reach each other's threads, files, artifacts, steps or runs", () => {
  expect(fresh() == "");
  let hers = threadFor("u-alice", "lyon");
  let his = threadFor("u-bob", "rotterdam");

  expect(ownedThread(database, hers, ["u-alice"]) == "a1");
  expect(ownedThread(database, his, ["u-bob"]) == "a1");
  expect(ownedThread(database, hers, ["u-bob"]) == "");
  expect(ownedThread(database, his, ["u-alice"]) == "");

  expect(listFiles(database, hers).length == 1);
  expect(getFile(database, hers, "lyon.md").body.indexOf("lyon") >= 0);
  expect(listArtifacts(database, hers).length == 1);
  expect(stepsOfThread(database, hers).length == 1);

  let sidebar = listThreads(database, { tags: ["u-alice"], limit: 50, offset: 0, project: "" });
  expect(sidebar.length == 1);
  expect(sidebar[0].id == hers);
  expect(listThreads(database, { tags: ["u-bob"], limit: 50, offset: 0, project: "" }).length == 1);

  let herRuns = runsOf(database, "a1", ["u-alice"], 50);
  expect(herRuns.indexOf("about lyon") >= 0);
  expect(herRuns.indexOf("about rotterdam") < 0);

  expect(threadOwner(database, hers) == "u-alice");
});

test("the trust gate off means every tag sees everything, exactly as before", () => {
  fresh();
  let hers = threadFor("u-alice", "lyon");
  let his = threadFor("u-bob", "rotterdam");
  let nobodys = threadFor("", "unclaimed");

  expect(ownedThread(database, hers, unscoped) == "a1");
  expect(ownedThread(database, his, unscoped) == "a1");
  expect(ownedThread(database, nobodys, unscoped) == "a1");
  expect(listThreads(database, { tags: unscoped, limit: 50, offset: 0, project: "" }).length == 3);
  expect(runsOf(database, "a1", unscoped, 50).indexOf("about rotterdam") >= 0);
});

test("turning the gate on does not hand the pre-gateway history to whoever logs in first", () => {
  fresh();
  let nobodys = threadFor("", "unclaimed");
  let hers = threadFor("u-alice", "lyon");

  expect(ownedThread(database, nobodys, ["u-alice"]) == "");
  let sidebar = listThreads(database, { tags: ["u-alice"], limit: 50, offset: 0, project: "" });
  expect(sidebar.length == 1);
  expect(sidebar[0].id == hers);
  executeWith(database, "UPDATE threads SET owner = " + database.placeholder + " WHERE owner = ''", ["u-alice"]);
  expect(ownedThread(database, nobodys, ["u-alice"]) == "a1");
});

test("a guest is exactly one tag with the guest prefix, and nobody else is", () => {
  expect(guestTag(["guest:0123abcd"]) == "guest:0123abcd");
  expect(guestTag(["u-alice"]) == "");
  expect(guestTag([""]) == "");
  expect(guestTag(unscoped) == "");
  expect(guestTag(["guest:0123abcd", "u-alice"]) == "");
  let minted = "{\"uuid\":\"guest:0123abcd\",\"username\":\"guest\",\"email\":\"\",\"anonymous\":true,\"roles\":[]}";
  expect(guestTag(tagsFromHeader(true, minted)) == "guest:0123abcd");
  expect(guestTag(tagsFromHeader(false, minted)) == "");
});

test("the guest refusal names the limit, zero remaining, and when it resets", () => {
  let said = guestQuotaJson(10, "2026-08-02T00:00:00Z");
  expect(said.indexOf("\"error\":\"guest_quota\"") >= 0);
  expect(said.indexOf("\"limit\":10") >= 0);
  expect(said.indexOf("\"used\":10") >= 0);
  expect(said.indexOf("\"remaining\":0") >= 0);
  expect(said.indexOf("\"resetsAt\":\"2026-08-02T00:00:00Z\"") >= 0);
});

test("with no token configured nothing is refused, which is every deployment today", () => {
  expect(!bearerRefused("", "/threads", ""));
  expect(!bearerRefused("", "/threads", "Bearer whatever"));
});

test("configured, a route wants the token and says so for every way of missing it", () => {
  expect(bearerRefused("s3cret", "/threads", ""));
  expect(bearerRefused("s3cret", "/threads", "Bearer "));
  expect(bearerRefused("s3cret", "/threads", "Bearer wrong"));
  expect(bearerRefused("s3cret", "/threads", "Bearer s3cre"));
  expect(bearerRefused("s3cret", "/threads", "Bearer S3CRET"));
  expect(bearerRefused("s3cret", "/threads", "Basic s3cret"));
  expect(!bearerRefused("s3cret", "/threads", "Bearer s3cret"));
  expect(!bearerRefused("s3cret", "/threads", "bearer s3cret"));
  expect(!bearerRefused("s3cret", "/threads", "Bearer  s3cret "));
});

test("the probe answers without the token, and nothing else does", () => {
  expect(!bearerRefused("s3cret", "/healthz", ""));
  expect(!bearerRefused("s3cret", "/healthz/", ""));
  expect(!bearerRefused("s3cret", "/healthz?verbose=1", ""));
  expect(bearerRefused("s3cret", "/healthzz", ""));
  expect(bearerRefused("s3cret", "/healthz/../threads", ""));
  expect(bearerRefused("s3cret", "/preview/abc", ""));
});

test("healthz says which build, how far the schema got, and whether docker is there", () => {
  expect(fresh() == "");
  let said = healthJson(database, "1700000000000");
  expect(said.indexOf("\"version\":\"") >= 0);
  expect(said.indexOf("\"migration\":\"115\"") >= 0);
  expect(said.indexOf("\"docker\":true") >= 0 || said.indexOf("\"docker\":false") >= 0);
});

function keptFile(source: string, scope: string, bytes: string): DocumentFileRow {
  let row: DocumentFileRow = {
    id: documentFileId(scope, source),
    source: source, scope: scope,
    filename: source + ".pdf", mime: "application/pdf",
    bytes: bytes, size: decodedSize(bytes), createdAt: "1700000000000",
  };
  return row;
}

test("a kept original is found by the pair that names it, however the scope was spelled", () => {
  expect(fresh() == "");
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("notes", "/e2e", "aGVsbG8gcGRm")));
  expect(findDocumentFile(database, "/e2e", "notes").bytes == "aGVsbG8gcGRm");
  expect(findDocumentFile(database, "/e2e/", "notes").bytes == "aGVsbG8gcGRm");
  expect(findDocumentFile(database, "e2e", "notes").filename == "notes.pdf");
  expect(findDocumentFile(database, "/other", "notes").id == "");
  expect(findDocumentFile(database, "/e2e", "absent").id == "");
});

test("re-uploading a document replaces its kept copy rather than adding one", () => {
  expect(fresh() == "");
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("notes", "/e2e", "b25l")));
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("notes", "/e2e", "dHdv")));
  expect(countWhere(database, documentFilesMapping(), "source = ?", ["notes"]) == 1);
  expect(findDocumentFile(database, "/e2e", "notes").bytes == "dHdv");
});

test("deleting a document takes its original with it, in every folder", () => {
  expect(fresh() == "");
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("notes", "/e2e", "b25l")));
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("notes", "/spec", "dHdv")));
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("other", "/e2e", "dGhyZWU=")));
  forgetDocumentFiles(database, "notes");
  expect(findDocumentFile(database, "/e2e", "notes").id == "");
  expect(findDocumentFile(database, "/spec", "notes").id == "");
  expect(findDocumentFile(database, "/e2e", "other").bytes == "dGhyZWU=");
});

test("the folder listing learns which sources have an original in one query", () => {
  expect(fresh() == "");
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("notes", "/e2e", "b25l")));
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("elsewhere", "/spec", "dHdv")));
  let mine = sourcesWithFiles(database, "/e2e");
  expect(mine.length == 1);
  expect(holdsSource(mine, "notes"));
  expect(!holdsSource(mine, "unindexed"));
  expect(!holdsSource(mine, "elsewhere"));
});

test("the size of a kept file is arithmetic over its base64, never a decode", () => {
  expect(decodedSize("") == 0);
  expect(decodedSize("aGVsbG8gcGRm") == 9);
  expect(decodedSize("aGVsbG8=") == 5);
  expect(decodedSize("aGVsbG8hIQ==") == 7);
});

function seedMenu(): void {
  let think: ModelChoiceRow = { id: "mc-think", label: "Thinking", description: "slower, for hard questions",
    kind: "config", configId: "c2", routerId: "", tier: "premium", enabled: true, rank: 2 };
  let gone: ModelChoiceRow = { id: "mc-gone", label: "Retired", description: "the operator turned this off",
    kind: "config", configId: "c2", routerId: "", tier: "", enabled: false, rank: 4 };
  let auto: ModelChoiceRow = { id: "mc-auto", label: "Auto", description: "decides for each message",
    kind: "router", configId: "", routerId: "rt-1", tier: "", enabled: true, rank: 1 };
  let fast: ModelChoiceRow = { id: "mc-fast", label: "Fast", description: "short answers, quickly",
    kind: "config", configId: "cfg-quick", routerId: "", tier: "", enabled: true, rank: 3 };
  persist(database, modelChoicesMapping(), JSON.stringify(think));
  persist(database, modelChoicesMapping(), JSON.stringify(gone));
  persist(database, modelChoicesMapping(), JSON.stringify(auto));
  persist(database, modelChoicesMapping(), JSON.stringify(fast));
}

test("the menu is the enabled rows in rank order, and never names the config behind one", () => {
  expect(fresh() == "");
  seedMenu();
  let menu = new ModelService(database, "");
  let wire = menu.choices();

  expect(wire.indexOf("\"Auto\"") < wire.indexOf("\"Thinking\""));
  expect(wire.indexOf("\"Thinking\"") < wire.indexOf("\"Fast\""));
  expect(wire.indexOf("Retired") < 0);
  expect(enabledChoices(database).length == 3);

  expect(wire.indexOf("\"id\":\"mc-auto\"") >= 0);
  expect(wire.indexOf("\"description\":\"decides for each message\"") >= 0);
  expect(wire.indexOf("\"kind\":\"router\"") >= 0);
  expect(wire.indexOf("\"kind\":\"config\"") >= 0);
  expect(wire.indexOf("configId") < 0);
  expect(wire.indexOf("cfg-quick") < 0);
  expect(wire.indexOf("routerId") < 0);
  expect(wire.indexOf("rt-1") < 0);
  expect(wire.indexOf("\"enabled\"") < 0);
  expect(wire.indexOf("\"rank\"") < 0);

  expect(wire.indexOf("\"tier\":\"premium\"") >= 0);
});

test("a body that says nothing about a model is a body that changes nothing", () => {
  expect(askedChoice("{\"text\":\"hello\"}") == "");
  expect(askedChoice("{\"text\":\"hello\",\"modelChoiceId\":\"mc-fast\"}") == "mc-fast");
  expect(askedChoice("{\"text\":\"hello\",\"modelChoiceId\":\"\"}") == "");
  expect(askedChoice("") == "");
  expect(askedChoice("{\"agentId\":\"a1\",\"modelChoiceId\":\"mc-think\"}") == "mc-think");
});

test("the door reads its members and never parses the body into a narrow record", () => {
  let sent = "{\"text\":\"hello\",\"modelChoiceId\":\"\"}";
  expect(jsonText(sent, "text") == "hello");
  expect(askedChoice(sent) == "");
  expect(jsonText("{\"text\":\"hello\"}", "text") == "hello");
  expect(jsonText("{\"agentId\":\"a1\",\"modelChoiceId\":\"mc-think\"}", "agentId") == "a1");
  expect(jsonText("{\"agentId\":\"a1\"}", "agentId") == "a1");
});

test("\"Agent default\" is a choice a person makes, not the absence of one", () => {
  let cleared = askedPick("{\"text\":\"hello\",\"modelChoiceId\":\"\"}");
  expect(cleared.choiceId == "" && cleared.sent);
  let picked = askedPick("{\"text\":\"hello\",\"modelChoiceId\":\"mc-fast\"}");
  expect(picked.choiceId == "mc-fast" && picked.sent);
  let silent = askedPick("{\"text\":\"hello\"}");
  expect(silent.choiceId == "" && !silent.sent);
  expect(!askedPick("").sent);
  expect(!askedPick("{\"text\":\"{\\\"modelChoiceId\\\":\\\"mc-fast\\\"}\"}").sent);
});

test("a choice that names nothing is refused at the door, by name", () => {
  expect(fresh() == "");
  seedMenu();
  expect(choiceFault(database, "") == "");
  expect(choiceFault(database, "mc-fast") == "");
  expect(choiceFault(database, "mc-auto") == "");
  expect(choiceFault(database, "mc-think") == "");

  expect(choiceFault(database, "mc-nope").indexOf("mc-nope") >= 0);
  expect(choiceFault(database, "mc-gone").indexOf("not offered") >= 0);
  expect(choiceFault(database, "mc-gone").indexOf("no model choice") < 0);
  expect(choiceFault(database, "cfg-quick") != "");
});

test("retiring a row stops new picks without stopping the conversations holding it", () => {
  expect(fresh() == "");
  seedMenu();
  expect(choiceFault(database, "mc-gone") != "");
  expect(configForChoice(database, "mc-gone") == "");
  expect(configForChoice(database, "mc-fast") == "cfg-quick");
  expect(configForChoice(database, "mc-auto") == "");
});

test("a config the menu or a router points at cannot be deleted out from under it", () => {
  expect(fresh() == "");
  seedMenu();
  let auto: ModelRouterRow = {
    id: "rt-1", label: "Auto", routerConfigId: "c-router",
    candidatesJson: "[{\"key\":\"fast\",\"configId\":\"cfg-quick\",\"when\":\"greetings\"}]",
    fallbackConfigId: "c-standard", routeEvery: "turn", escalateOnly: false, enabled: true,
  };
  persist(database, modelRoutersMapping(), JSON.stringify(auto));

  expect(configInUse(database, "cfg-quick").indexOf("model menu") >= 0);
  expect(configInUse(database, "c-router").indexOf("router") >= 0);
  expect(configInUse(database, "c-standard").indexOf("router") >= 0);
  expect(configInUse(database, "cfg-quick").indexOf("take the choice off the menu") >= 0);
  expect(configInUse(database, "c-router").indexOf("repoint the router") >= 0);

  let a9: AgentRow = {
    id: "a9",
    agentName: "lead",
    description: "d",
    modelConfigId: "c-agents",
    promptId: "p1",
    scriptImageId: "",
    isDefault: false,
    enabled: true,
    updatedAt: "t",
  };
  persist(database, agentsMapping(), JSON.stringify(a9));
  expect(configInUse(database, "c-agents").indexOf("used by an agent") >= 0);

  expect(configInUse(database, "c-nobody") == "");
});

test("a conversation can be opened already pointing at a choice", () => {
  expect(fresh() == "");
  seedMenu();
  let asked = askedChoice("{\"agentId\":\"a1\",\"modelChoiceId\":\"mc-think\"}");
  expect(choiceFault(database, asked) == "");
  let hers = openThread(database, { agentId: "a1", owner: "u-alice", now: "1700000000000" });
  let his = openThread(database, { agentId: "a1", owner: "u-bob", now: "1700000000000" });

  expect(threadChoice(database, hers) == "");
  expect(rememberChoice(database, hers, asked) == "");
  expect(threadChoice(database, hers) == "mc-think");

  expect(threadOwner(database, hers) == "u-alice");
  expect(ownedThread(database, hers, ["u-alice"]) == "a1");
  expect(ownedThread(database, hers, ["u-bob"]) == "");

  expect(threadChoice(database, his) == "");
});

function configRow(id: string, modelId: string, label: string): ModelConfigRow {
  let c: ModelConfigRow = {
    id: id, modelId: modelId, temperature: 0.2, maxTokens: 8192, topP: 1.0,
    extra: "", thinking: "", label: label, selectable: true, rank: 1,
  };
  return c;
}

function seedConfigs(): void {
  persist(database, modelsMapping(), JSON.stringify(modelRow("m-chat", "mistral", "chat", "")));
  persist(database, modelsMapping(), JSON.stringify(modelRow("m-embed", "mistral", "embedding", "")));
  persist(database, modelConfigsMapping(database), JSON.stringify(configRow("c-fast", "m-chat", "Fast")));
  persist(database, modelConfigsMapping(database), JSON.stringify(configRow("c-deep", "m-chat", "Deep")));
  persist(database, modelConfigsMapping(database), JSON.stringify(configRow("c-vec", "m-embed", "Vectors")));
}

test("an operator's body is read a member at a time, and an unexpected field is not a 400", () => {
  let sent = "{\"label\":\"Fast\",\"selectable\":true,\"menuRank\":3,"
    + "\"model\":{\"id\":\"m-chat\",\"label\":\"Mistral\"},\"somethingNew\":\"ignored\"}";
  expect(bodyText(sent, "label", "kept") == "Fast");
  expect(bodyBool(sent, "selectable", false));
  expect(bodyRank(sent, 0) == 3);

  expect(bodyText(sent, "thinking", "kept") == "kept");
  expect(bodyInt(sent, "maxTokens", 4096) == 4096);
  expect(bodyBool(sent, "enabled", true));

  expect(bodyText(sent, "id", "none") == "none");
  let nested = "{\"candidates\":[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"x\"}],\"label\":\"Auto\"}";
  expect(bodyText(nested, "configId", "") == "");
  expect(bodyText(nested, "label", "") == "Auto");
});

test("menuRank and rank are one column under its two names", () => {
  expect(bodyRank("{\"rank\":2}", 9) == 2);
  expect(bodyRank("{\"menuRank\":5}", 9) == 5);
  expect(bodyRank("{\"rank\":2,\"menuRank\":5}", 9) == 2);
  expect(bodyRank("{\"label\":\"x\"}", 9) == 9);

  expect(bodyRank("{\"rank\":\"tuesday\"}", 9) == 9);
  expect(bodyInt("{\"maxTokens\":\"4096\"}", "maxTokens", 0) == 4096);
  expect(bodyNumber("{\"temperature\":0.7}", "temperature", 0.0) == 0.7);
  expect(!bodyBool("{\"enabled\":\"false\"}", "enabled", true));
});

test("a config PUT writes what the body names and leaves the rest of the row alone", () => {
  expect(fresh() == "");
  seedConfigs();

  let stored: ModelConfigRow = JSON.parse<ModelConfigRow>(findById(database, modelConfigRows(database), "c-fast"));
  expect(stored.maxTokens == 8192);

  let merged = mergedConfig(stored, "{\"label\":\"Quick\",\"selectable\":false,\"menuRank\":7,\"whatIsThis\":true}");
  expect(merged.label == "Quick");
  expect(!merged.selectable);
  expect(merged.rank == 7);
  expect(configFault(database, merged) == "");
  expect(merged.id == "c-fast");
  expect(merged.modelId == "m-chat");
  expect(merged.maxTokens == 8192);
  expect(merged.temperature == 0.2);

  let tuned = mergedConfig(stored, "{\"maxTokens\":512,\"thinking\":\"high\",\"temperature\":1.0,\"extra\":{\"top_k\":40}}");
  expect(tuned.maxTokens == 512);
  expect(tuned.thinking == "high");
  expect(tuned.temperature == 1.0);
  expect(tuned.extra == "{\"top_k\":40}");
  expect(mergedConfig(stored, "{\"extra\":\"{\\\"top_k\\\":40}\"}").extra == "{\"top_k\":40}");
  expect(bodyJson("{\"extra\":\"plain\"}", "extra", "kept") == "plain");
});

test("a config is refused for each way of being unwritable, by name", () => {
  expect(fresh() == "");
  seedConfigs();
  let stored = configRow("c-fast", "m-chat", "Fast");
  expect(configFault(database, mergedConfig(stored, "{\"modelId\":\"m-nope\"}")).indexOf("m-nope") >= 0);
  expect(configFault(database, mergedConfig(stored, "{\"modelId\":\"\"}")).indexOf("modelId") >= 0);
  expect(configFault(database, mergedConfig(stored, "{\"maxTokens\":0}")).indexOf("maxTokens") >= 0);
  expect(configFault(database, mergedConfig(stored, "{\"menuRank\":-1}")).indexOf("menuRank") >= 0);

  expect(configFault(database, mergedConfig(stored, "{\"label\":\"\",\"selectable\":true}")) == "");
});

test("a menu row is created and edited over the API, unexpected fields and all", () => {
  expect(fresh() == "");
  seedConfigs();
  let created = mergedChoice(blankChoice("ch-fast"),
    "{\"id\":\"ch-fast\",\"label\":\"Fast\",\"description\":\"short answers, quickly\","
    + "\"kind\":\"config\",\"configId\":\"c-fast\",\"clientVersion\":\"3\"}");
  expect(choiceRowFault(database, created) == "");
  expect(created.enabled);
  expect(created.tier == "");
  persist(database, modelChoicesMapping(), JSON.stringify(created));

  let stored: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-fast"));
  let edited = mergedChoice(stored, "{\"label\":\"Instant\",\"enabled\":false,\"menuRank\":4,\"tier\":\"premium\"}");
  expect(choiceRowFault(database, edited) == "");
  expect(edited.label == "Instant");
  expect(!edited.enabled);
  expect(edited.rank == 4);
  expect(edited.tier == "premium");
  expect(edited.kind == "config" && edited.configId == "c-fast");
  expect(edited.description == "short answers, quickly");
});

test("a menu row is refused for each way of being a broken option, by name", () => {
  expect(fresh() == "");
  seedConfigs();
  expect(choiceRowFault(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"Fast\",\"kind\":\"config\",\"configId\":\"c-fast\"}")) == "");

  expect(choiceRowFault(database, mergedChoice(blankChoice("ch-1"),
    "{\"kind\":\"config\",\"configId\":\"c-fast\"}")).indexOf("label") >= 0);
  expect(choiceRowFault(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"F\",\"kind\":\"config\",\"configId\":\"c-fast\",\"routerId\":\"rt-1\"}")).indexOf("routerId") >= 0);
  expect(choiceRowFault(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"F\",\"kind\":\"auto\",\"configId\":\"c-fast\"}")).indexOf("kind") >= 0);
  expect(choiceRowFault(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"F\",\"kind\":\"config\",\"configId\":\"c-gone\"}")).indexOf("c-gone") >= 0);
  expect(choiceRowFault(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"F\",\"kind\":\"config\",\"configId\":\"c-vec\"}")).indexOf("chat") >= 0);
  expect(choiceRowFault(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"F\",\"kind\":\"config\",\"configId\":\"c-fast\",\"tier\":\"gold\"}")).indexOf("premium") >= 0);
  expect(choiceRowFault(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"Auto\",\"kind\":\"router\",\"routerId\":\"rt-nope\"}")).indexOf("rt-nope") >= 0);
});

test("a router's candidates are a list of pairs, and every way of breaking one is refused", () => {
  expect(fresh() == "");
  seedConfigs();
  expect(candidatesFault(database,
    "[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"greetings and short questions\"},"
    + "{\"key\":\"deep\",\"configId\":\"c-deep\",\"when\":\"writing a document, multi-step analysis\"}]") == "");

  expect(candidatesFault(database, "{\"key\":\"fast\"}").indexOf("array") >= 0);
  expect(candidatesFault(database, "").indexOf("array") >= 0);
  expect(candidatesFault(database, "[]").indexOf("at least one") >= 0);
  expect(candidatesFault(database, "[{\"configId\":\"c-fast\",\"when\":\"x\"}]").indexOf("key") >= 0);
  expect(candidatesFault(database,
    "[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"x\"},"
    + "{\"key\":\"Fast\",\"configId\":\"c-deep\",\"when\":\"y\"}]").indexOf("repeats") >= 0);
  let blank = candidatesFault(database, "[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"  \"}]");
  expect(blank.indexOf("when") >= 0);
  expect(blank.indexOf("cannot choose on purpose") >= 0);
  expect(candidatesFault(database, "[{\"key\":\"fast\",\"configId\":\"c-gone\",\"when\":\"x\"}]").indexOf("c-gone") >= 0);
  expect(candidatesFault(database, "[{\"key\":\"fast\",\"configId\":\"c-vec\",\"when\":\"x\"}]").indexOf("chat") >= 0);
  let second = candidatesFault(database,
    "[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"x\"},"
    + "{\"key\":\"deep\",\"configId\":\"c-gone\",\"when\":\"y\"}]");
  expect(second.indexOf("candidate 2") >= 0);
  expect(second.indexOf("deep") >= 0);
});

test("a router is written as a real array and comes back as one", () => {
  expect(fresh() == "");
  seedConfigs();
  let body = "{\"id\":\"rt-1\",\"label\":\"Auto\",\"routerConfigId\":\"c-fast\","
    + "\"fallbackConfigId\":\"c-fast\",\"routeEvery\":\"turn\","
    + "\"candidates\":[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"greetings\",\"note\":\"mine\"},"
    + "{\"key\":\"deep\",\"configId\":\"c-deep\",\"when\":\"plans\"}],\"aFieldFromNextMonth\":1}";

  expect(preEncodedCandidates(body) == "");
  expect(preEncodedCandidates("{\"candidatesJson\":\"[]\"}").indexOf("candidates") >= 0);

  let row = mergedRouter(blankRouter("rt-1"), body);
  expect(routerRowFault(database, row) == "");
  let settled = withCanonicalCandidates(row);
  expect(settled.candidatesJson.indexOf("note") < 0);
  expect(settled.candidatesJson.indexOf("\"key\":\"fast\"") >= 0);
  expect(settled.candidatesJson.indexOf("\"when\":\"plans\"") >= 0);
  persist(database, modelRoutersMapping(), JSON.stringify(settled));

  let wire = routerJson(allRouters(database)[0]);
  expect(wire.indexOf("\"candidates\":[{") >= 0);
  expect(wire.indexOf("candidatesJson") < 0);
  expect(wire.indexOf("\"escalateOnly\":false") >= 0);
  expect(wire.indexOf("\"enabled\":true") >= 0);
  expect(wire.indexOf("\"routeEvery\":\"turn\"") >= 0);

  let stored: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-1"));
  let edited = mergedRouter(stored,
    "{\"candidates\":[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"greetings and edits\"}]}");
  expect(routerRowFault(database, edited) == "");
  expect(edited.label == "Auto" && edited.routerConfigId == "c-fast");
  expect(edited.candidatesJson.indexOf("greetings and edits") >= 0);
  expect(mergedRouter(stored, "{\"enabled\":false}").candidatesJson == stored.candidatesJson);
  expect(!mergedRouter(stored, "{\"enabled\":false}").enabled);
});

test("a router is refused for each id it resolves and for how often it routes", () => {
  expect(fresh() == "");
  seedConfigs();
  let candidates = "\"candidates\":[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"greetings\"}]";
  expect(routerRowFault(database, mergedRouter(blankRouter("rt-1"),
    "{\"label\":\"Auto\",\"routerConfigId\":\"c-fast\",\"fallbackConfigId\":\"c-deep\"," + candidates + "}")) == "");

  expect(routerRowFault(database, mergedRouter(blankRouter("rt-1"),
    "{\"routerConfigId\":\"c-fast\",\"fallbackConfigId\":\"c-deep\"," + candidates + "}")).indexOf("label") >= 0);
  expect(routerRowFault(database, mergedRouter(blankRouter("rt-1"),
    "{\"label\":\"Auto\",\"routeEvery\":\"sometimes\",\"routerConfigId\":\"c-fast\","
    + "\"fallbackConfigId\":\"c-deep\"," + candidates + "}")).indexOf("routeEvery") >= 0);
  expect(routerRowFault(database, mergedRouter(blankRouter("rt-1"),
    "{\"label\":\"Auto\",\"fallbackConfigId\":\"c-deep\"," + candidates + "}")).indexOf("routerConfigId") >= 0);
  let landing = routerRowFault(database, mergedRouter(blankRouter("rt-1"),
    "{\"label\":\"Auto\",\"routerConfigId\":\"c-fast\",\"fallbackConfigId\":\"c-vec\"," + candidates + "}"));
  expect(landing.indexOf("fallbackConfigId") >= 0);
  expect(landing.indexOf("chat") >= 0);
  expect(chatConfigFault(database, "c-fast", "routerConfigId") == "");
  expect(chatConfigFault(database, "", "fallbackConfigId").indexOf("fallbackConfigId") >= 0);
});

test("the menu is published from what the database holds, at every start", () => {
  expect(fresh() == "");
  expect(enabledChoices(database).length == 0);
  seedConfigs();
  expect(publishMenu(database) == "");

  let menu = enabledChoices(database);
  expect(menu.length == 3);
  expect(menu[0].label == "Auto");
  expect(menu[0].kind == "router");
  expect(menu[1].label == "Deep");
  expect(menu[2].label == "Fast");
  expect(configForChoice(database, "ch-c-vec") == "");
  expect(configForChoice(database, "ch-c-fast") == "c-fast");
  expect(publishMenu(database) == "");
  expect(enabledChoices(database).length == 3);
});

test("a router can always be switched off, whatever its candidates say", () => {
  expect(fresh() == "");
  seedConfigs();
  let stale: ModelRouterRow = {
    id: "rt-1", label: "Auto", routerConfigId: "c-fast",
    candidatesJson: "[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"greetings\"},"
      + "{\"key\":\"deep\",\"configId\":\"c-gone\",\"when\":\"plans\"}]",
    fallbackConfigId: "c-fast", routeEvery: "turn", escalateOnly: false, enabled: true,
  };
  persist(database, modelRoutersMapping(), JSON.stringify(stale));
  let stored: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-1"));

  expect(routerRowFault(database, stored).indexOf("c-gone") >= 0);
  let off = mergedRouter(stored, "{\"id\":\"rt-1\",\"enabled\":false}");
  expect(routerRowFault(database, off) == "");
  expect(off.candidatesJson == stored.candidatesJson);
  expect(routerRowFault(database, mergedRouter(off, "{\"id\":\"rt-1\",\"enabled\":true}")).indexOf("c-gone") >= 0);
  expect(routerRowFault(database, mergedRouter(off, "{\"id\":\"rt-1\",\"routerConfigId\":\"c-gone\"}")).indexOf("routerConfigId") >= 0);
});

test("neither a choice nor a router can be deleted out from under what points at it", () => {
  expect(fresh() == "");
  seedConfigs();
  let auto: ModelRouterRow = {
    id: "rt-1", label: "Auto", routerConfigId: "c-fast",
    candidatesJson: "[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"greetings\"}]",
    fallbackConfigId: "c-fast", routeEvery: "turn", escalateOnly: false, enabled: true,
  };
  persist(database, modelRoutersMapping(), JSON.stringify(auto));
  let onMenu: ModelChoiceRow = { id: "ch-auto", label: "Auto", description: "decides per message",
    kind: "router", configId: "", routerId: "rt-1", tier: "", enabled: true, rank: 0 };
  persist(database, modelChoicesMapping(), JSON.stringify(onMenu));

  expect(routerInUse(database, "rt-1").indexOf("menu choice") >= 0);
  expect(routerInUse(database, "rt-1").indexOf("repoint") >= 0);
  expect(configInUse(database, "c-fast").indexOf("router") >= 0);
  deleteById(database, modelChoicesMapping(), "ch-auto");
  expect(routerInUse(database, "rt-1") == "");
  expect(routerInUse(database, "rt-never-existed") == "");

  let fast: ModelChoiceRow = { id: "ch-fast", label: "Fast", description: "quickly",
    kind: "config", configId: "c-fast", routerId: "", tier: "", enabled: true, rank: 1 };
  persist(database, modelChoicesMapping(), JSON.stringify(fast));
  let hers = openThread(database, { agentId: "a1", owner: "u-alice", now: "1700000000000" });
  expect(rememberChoice(database, hers, "ch-fast") == "");
  let held = choiceInUse(database, "ch-fast");
  expect(held.indexOf("ch-fast") >= 0);
  expect(held.indexOf("enabled") >= 0);
  expect(choiceInUse(database, "ch-auto") == "");

  recordRun(database, { agentId: "a1", threadId: "", owner: "", question: "hi",
    run: emptyRun("hi"), modelChoiceId: "ch-auto", routeNote: "" });
  expect(choiceInUse(database, "ch-auto") == "");
});

test("a country code is two ISO letters or nothing at all", () => {
  expect(geoCode("GB") == "GB");
  expect(geoCode("tn") == "TN");
  expect(geoCode(" de ") == "DE");
  expect(geoCode("XX") == "");
  expect(geoCode("T1") == "");
  expect(geoCode("") == "");
  expect(geoCode("GBR") == "");
  expect(geoCode("<script>") == "");
});

test("the first reader from a place creates its feed, once", () => {
  fresh();
  ensureGeoFeed(database, "gb");
  ensureGeoFeed(database, "GB");
  let feeds = allFeeds(database);
  expect(feeds.length == 1);
  expect(feeds[0].id == "geo:gb");
  expect(feeds[0].country == "GB");
  expect(feeds[0].lang == "");
  expect(feeds[0].enabled);
  expect(feeds[0].digestedAt == "");
  ensureGeoFeed(database, "XX");
  ensureGeoFeed(database, "??");
  ensureGeoFeed(database, "England");
  expect(allFeeds(database).length == 1);
});

test("place feeds are capped, so a GET cannot mint rows forever", () => {
  fresh();
  let i: int = 0;
  while (i < 40) {
    let a = i / 26;
    let b = i - a * 26;
    let cc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(a, a + 1)
      + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(b, b + 1);
    let row: DiscoverFeed = {
      id: "geo:" + cc.toLowerCase(), topic: "Local news", query: "news",
      lang: "", country: cc, enabled: true, digestedAt: "",
    };
    persist(database, discoverFeedsMapping(), JSON.stringify(row));
    i = i + 1;
  }
  ensureGeoFeed(database, "QQ");
  expect(allFeeds(database).length == 40);
});

test("a thread id alone is not authorisation, and refusal is a 404", () => {
  fresh();
  let hers = threadFor("u-alice", "lyon");
  expect(ownedThread(database, hers, ["u-bob"]) == "");
  expect(ownedThread(database, "a-thread-that-never-existed", ["u-bob"]) == "");
  database.close();
});
