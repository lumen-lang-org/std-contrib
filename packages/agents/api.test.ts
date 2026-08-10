// What the API refuses, and what it takes with it when it deletes something.
//
// The routes themselves are methods on `@controller` classes, and a class is
// not something a Lumen module can export — so what a route decides lives in a
// free function beside it and is asked here directly, against a real database.
// Every case below is one an operator can reach with one curl.
//
//   cd packages/agents && lumen test api.test.ts

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
import { migrationProblem, bearerRefused, askedPick, configInUse, mergedConfig, configProblem, chatConfigProblem, blankChoice, mergedChoice, choiceRowProblem, choiceInUse, blankRouter, mergedRouter, preEncodedCandidates, candidatesProblem, routerRowProblem, withCanonicalCandidates, routerJson, allRouters, routerInUse, publishMenu } from "./api.ts";
import { forgetAgent } from "./routes/agents/controller.ts";
import { decodedSize } from "./routes/documents/controller.ts";
import { healthJson } from "./routes/healthz/controller.ts";
import { choicesJson, modelDestinationProblem, modelProblem } from "./routes/models/controller.ts";
import { forgetServer, serverDestinationProblem } from "./routes/servers/controller.ts";
import { skillFileProblem, skillProblem } from "./routes/skills/controller.ts";
import { traceDestinationProblem } from "./routes/tracing/controller.ts";
import { bodyText, bodyJson, bodyBool, bodyInt, bodyNumber, bodyRank, guestTag, guestQuotaJson, askedChoice, choiceProblem } from "./api-core.ts";

let database: Db = sqlite();

// A fixed master key, so the suite is repeatable. A real one comes from the
// environment.
function testKey(): string {
  return "0123456789abcdef0123456789abcdef";
}

// Returns what the plan could not do, so a test can insist on "" — the owner
// suite below writes to tables whose new columns are the thing under test, and
// half a plan would read as a scoping bug rather than a fixture one.
function fresh(): string {
  let cfg: DbConfig = { filename: "/tmp/agents_api_track_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP TABLE IF EXISTS agent_scopes");
  execute(database, "DROP TABLE IF EXISTS agent_retrieval");
  execute(database, "DROP TABLE IF EXISTS documents");
  // The originals kept beside that text (104). Not ALTERed, so the plan would
  // survive a leftover table — but the rows would survive with it, and a
  // listing's `hasFile` would then be a fact about how often this suite has
  // been run rather than about what the test just stored.
  execute(database, "DROP TABLE IF EXISTS document_files");
  execute(database, "DROP TABLE IF EXISTS trace_config");
  // Every table the plan ALTERs, or the second run of this suite fails on the
  // first `ADD COLUMN` that finds its column already there — and a plan that
  // stops takes every migration numbered above it with it, which surfaces
  // later as a table missing a column nobody edited.
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
  // Same rule, the newest arrivals: models gained context_tokens (90.6),
  // script_images gained summary (90.5), and thread_summaries is new (90.7).
  // A table left standing here fails the ALTER that adds its column, and a
  // stopped plan takes every migration above it with it.
  execute(database, "DROP TABLE IF EXISTS models");
  execute(database, "DROP TABLE IF EXISTS script_images");
  execute(database, "DROP TABLE IF EXISTS thread_summaries");
  execute(database, "DROP TABLE IF EXISTS plugins");
  execute(database, "DROP TABLE IF EXISTS plugin_items");
  // Same rule again: auth_providers gained `kind` at 90.9, and a table left
  // standing fails that ALTER as a duplicate column on the second fresh() —
  // which stops the plan and reads, tests later, as a scoping bug.
  execute(database, "DROP TABLE IF EXISTS auth_providers");
  // Skills, for the same reason as the rest of this list and with a worse
  // symptom: nothing here dropped them, so a second run of this suite met
  // migration 77 adding `visibility` to a table that already had it, the plan
  // stopped there, and EVERY migration numbered above it silently never ran —
  // which by now includes the model menu at 83 and the thread's choice at 85.
  // The visible failure was a table that does not exist, three tests away from
  // the line that did not run.
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  // The same rule again, and the same symptom, for everything that arrived
  // after the list above was last extended: Discover's stories gained four
  // columns at 98.3-98.5 and 100, a card plugin gained two at 97.3-97.4. The
  // FIRST fresh() in a run creates those tables; every one after it re-ran the
  // plan against them and failed on a duplicate column, which stopped the plan
  // and left eighteen tests reporting a scoping bug that was really a fixture
  // that had not kept up.
  execute(database, "DROP TABLE IF EXISTS discover_stories");
  execute(database, "DROP TABLE IF EXISTS discover_feeds");
  execute(database, "DROP TABLE IF EXISTS card_plugins");
  execute(database, "DROP TABLE IF EXISTS card_cases");
  execute(database, "DROP TABLE IF EXISTS tool_cards");
  execute(database, "DROP TABLE IF EXISTS agent_web_rag");
  execute(database, "DROP TABLE IF EXISTS scheduled_tasks");
  execute(database, "DROP TABLE IF EXISTS workflows");
  execute(database, "DROP TABLE IF EXISTS workflow_runs");
  // Secrets (109): created fresh each run so a test's rows cannot outlive it.
  execute(database, "DROP TABLE IF EXISTS secrets");
  // ALTERed at 103 (files_thread_id), so it joins the list above for the
  // reason auth_providers did: left standing, the second run of this fixture
  // meets a duplicate column and the plan stops there.
  execute(database, "DROP TABLE IF EXISTS projects");
  // Not ALTERed, but seeded below: rows surviving a wipe would make the menu's
  // order a fact about how often this suite has been run.
  execute(database, "DROP TABLE IF EXISTS model_choices");
  execute(database, "DROP TABLE IF EXISTS model_routers");
  // Everything migrated above secrets' 109. Each is its own plan appended to
  // migrationProblem's, and none was in this list, so the first fresh() of a
  // run created them and every fresh() after it met a table its migration was
  // about to create. That stops the plan, and a stopped plan takes every step
  // numbered above it, which is why the failures read as scoping and document
  // bugs rather than as a fixture that had not kept up.
  // The triggers tables, and trigger_inbox is the one that was actually
  // failing: 106.1 creates it from a mapping frozen without thread_id and
  // 106.2 adds that column. Left standing, 106.1's CREATE finds the table
  // already there and does nothing, then 106.2 adds a column that is already
  // there and the plan stops at 106.2 — taking every step above it with it.
  execute(database, "DROP TABLE IF EXISTS trigger_inbox");
  execute(database, "DROP TABLE IF EXISTS trigger_outbox");
  execute(database, "DROP TABLE IF EXISTS trigger_bots");
  execute(database, "DROP TABLE IF EXISTS env_keys");            // 110
  execute(database, "DROP TABLE IF EXISTS user_environments");   // 111
  execute(database, "DROP TABLE IF EXISTS env_templates");       // 112
  execute(database, "DROP TABLE IF EXISTS mcp_tool_roster");     // 113
  execute(database, "DROP TABLE IF EXISTS api_keys");            // 115
  execute(database, "DROP TABLE IF EXISTS sandbox_limits");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  execute(database, "DROP INDEX IF EXISTS scopes_by_agent");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  // Said out loud. Twenty-two tests across owners, documents, the model menu
  // and healthz failed on this one line returning a sentence nobody printed,
  // and each of them read as a bug in the thing it was testing.
  let problem = migrationProblem(database);
  if (problem != "") { console.error("[fixture] the plan did not run: " + problem); }
  return problem;
}

function modelRow(id: string, provider: string, kind: string, baseUrl: string): ModelRow {
  let m: ModelRow = {
    id: id, label: "L " + id, apiName: "some-model", provider: provider,
    kind: kind, dimensions: kind == "embedding" ? 1024 : 0,
    baseUrl: baseUrl, enabled: true, contextTokens: 0 };
  return m;
}

function mcpRow(id: string, endpoint: string): McpServerRow {
  let s: McpServerRow = {
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

// --- a write-only secret stays write-only ------------------------------------

test("a model's base URL cannot be moved while its provider's key is stored", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });

  // The attack: repoint the row, then press "test". The key travels.
  let moved = modelDestinationProblem(database, modelRow("m1", "mistral", "chat", "http://attacker.example/v1"));
  expect(moved != "");
  // A refusal has to say what to do next, or it is just a locked door.
  expect(moved.indexOf("attacker.example") >= 0);
  expect(moved.indexOf("DELETE /providers/mistral/key") >= 0);
});

test("a model created against a foreign base URL is refused just as a moved one is", () => {
  fresh();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  // No row exists yet, so there is nothing to "change" — and a fresh row
  // naming someone else's host leaks exactly as much as an edited one.
  let created = modelDestinationProblem(database, modelRow("m9", "mistral", "chat", "http://attacker.example/v1"));
  expect(created != "");
  expect(created.indexOf("attacker.example") >= 0);
});

test("a model whose provider changes is refused, because that changes the key too", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  storeCredential(database, { provider: "openai", apiKey: "sk-fake-openai-0002", masterKey: testKey(), now: "t" });
  let switched = modelDestinationProblem(database, modelRow("m1", "openai", "chat", ""));
  expect(switched != "");
});

test("an edit that leaves the address alone is allowed", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  let renamed: ModelRow = {
    id: "m1", label: "A better label", apiName: "mistral-small-latest", provider: "mistral",
    kind: "chat", dimensions: 0, baseUrl: "", enabled: false, contextTokens: 0 };
  expect(modelDestinationProblem(database, renamed) == "");
});

test("a path change on the same host is not a move", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "https://gw.internal/v1")));
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  expect(modelDestinationProblem(database, modelRow("m1", "mistral", "chat", "https://gw.internal/v2")) == "");
  // A different host on the same path is.
  expect(modelDestinationProblem(database, modelRow("m1", "mistral", "chat", "https://gw.attacker/v1")) != "");
});

test("with no key stored there is nothing to protect and nothing is refused", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  expect(modelDestinationProblem(database, modelRow("m1", "mistral", "chat", "http://anywhere.example/v1")) == "");
});

test("a base URL that is not an address is refused where it is written", () => {
  // Unreadable here means uncomparable later: nothing can decide whether it is
  // where the key was stored for.
  expect(modelProblem(modelRow("m1", "mistral", "chat", "notaurl")).indexOf("base URL") >= 0);
  expect(modelProblem(modelRow("m1", "mistral", "chat", "file:///etc/passwd")).indexOf("base URL") >= 0);
  // An empty one is how "use the provider's own endpoint" is spelled.
  expect(modelProblem(modelRow("m1", "mistral", "chat", "")) == "");
  expect(modelProblem(modelRow("m1", "mistral", "chat", "https://gw.internal/v1")) == "");
});

test("an MCP server's endpoint cannot be moved while its token is stored", () => {
  fresh();
  persist(database, mcpServersMapping(), JSON.stringify(mcpRow("s1", "https://mcp.example/mcp")));
  storeCredential(database, { provider: "mcp:s1", apiKey: "mcp-fake-token", masterKey: testKey(), now: "t" });

  let moved = serverDestinationProblem(database, mcpRow("s1", "http://attacker.example/mcp"));
  expect(moved != "");
  expect(moved.indexOf("attacker.example") >= 0);
  expect(moved.indexOf("/servers/s1/auth") >= 0);
});

test("an MCP server keeping its endpoint is written without complaint", () => {
  fresh();
  persist(database, mcpServersMapping(), JSON.stringify(mcpRow("s1", "https://mcp.example/mcp")));
  storeCredential(database, { provider: "mcp:s1", apiKey: "mcp-fake-token", masterKey: testKey(), now: "t" });
  expect(serverDestinationProblem(database, mcpRow("s1", "https://mcp.example/mcp")) == "");
});

test("the trace collector cannot be moved while its secret is stored", () => {
  fresh();
  persist(database, traceConfigMapping(), JSON.stringify(traceRow("https://cloud.langfuse.com")));
  storeCredential(database, { provider: "tracing", apiKey: "sk-lf-fake", masterKey: testKey(), now: "t" });

  let moved = traceDestinationProblem(database, traceRow("http://attacker.example"));
  expect(moved != "");
  expect(moved.indexOf("attacker.example") >= 0);
  expect(moved.indexOf("DELETE /tracing/key") >= 0);
});

test("an address that cannot be read is treated as somewhere else", () => {
  fresh();
  persist(database, traceConfigMapping(), JSON.stringify(traceRow("https://cloud.langfuse.com")));
  storeCredential(database, { provider: "tracing", apiKey: "sk-lf-fake", masterKey: testKey(), now: "t" });
  // Not a URL this can parse. Refusing beats guessing.
  expect(traceDestinationProblem(database, traceRow("cloud.langfuse.com")) != "");
});

// --- deleting a row takes its secrets and its links with it -------------------

test("deleting an MCP server deletes its stored token", () => {
  fresh();
  persist(database, mcpServersMapping(), JSON.stringify(mcpRow("s1", "https://mcp.example/mcp")));
  storeCredential(database, { provider: "mcp:s1", apiKey: "mcp-fake-token", masterKey: testKey(), now: "t" });
  expect(credentialFor(database, "mcp:s1", testKey()) == "mcp-fake-token");

  forgetServer(database, "s1");

  // Ids are short human strings chosen by the caller, so "s1" comes back. If
  // the token outlives the row, the next server called s1 is handed the old
  // one's secret and sends it wherever it points.
  expect(credentialFor(database, "mcp:s1", testKey()) == "");
  expect(countWhere(database, credentialsMapping(), "", []) == 0);
});

test("deleting an agent takes its scopes, its retrieval row and its parents' links", () => {
  fresh();
  let a1: AgentRow = { id: "a1", agentName: "lead", description: "d", modelConfigId: "c1", promptId: "p1", scriptImageId: "", isDefault: true, enabled: true, updatedAt: "t" };
  let a2: AgentRow = { id: "a2", agentName: "scout", description: "d", modelConfigId: "c1", promptId: "p1", scriptImageId: "", isDefault: false, enabled: true, updatedAt: "t" };
  persist(database, agentsMapping(), JSON.stringify(a1));
  persist(database, agentsMapping(), JSON.stringify(a2));
  execute(database, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");
  grantScope(database, "a2", "/specs");
  let retrieval: AgentRetrievalRow = { agentId: "a2", embeddingModelId: "e1", topK: 5, maxDistance: 1.0, enabled: true };
  persist(database, agentRetrievalMapping(), JSON.stringify(retrieval));

  forgetAgent(database, "a2");

  // Recreate the id and the new agent must start with nothing: no corpus it
  // was never granted, and no parent silently re-attached to it.
  expect(agentScopes(database, "a2").length == 0);
  expect(findById(database, agentRetrievalMapping(), "a2") == "");
  execute(database, "SELECT parent_id FROM agent_sub_agents WHERE child_id = 'a2'");
  expect(database.rows() == 0);
});

// --- a half-migrated schema is not something to serve on ----------------------

test("a migration that fails stops the server rather than being logged", () => {
  fresh();
  // A history holding a version this build's plan sits entirely below is what
  // a rolled-back deploy looks like from the database's side, and migrate
  // refuses to run beneath it rather than guessing.
  forgetMigrations(database);
  migrate(database, [migration("9999", "from a future build", "SELECT 1")]);
  let problem = migrationProblem(database);
  expect(problem != "");
  // Naming the schema is the point: "could not connect" and "your database is
  // one release ahead" are different mornings.
  expect(problem.indexOf("schema") >= 0);
});

// --- the skill door's guards ---------------------------------------------------

test("a skill is refused at the door for each way of being unusable, by name", () => {
  let good: SkillRow = { id: "k1", skillName: "read-proto-enums", description: "compute enum values", body: "run enums.py", updatedAt: "t", visibility: "private", featuredRank: 0 , source: "local", sourceUrl: "" };
  expect(skillProblem(good) == "");

  let unnamed: SkillRow = { id: "k1", skillName: " ", description: "d", body: "b", updatedAt: "t", visibility: "private", featuredRank: 0 , source: "local", sourceUrl: "" };
  expect(skillProblem(unnamed).indexOf("needs a name") >= 0);
  // The name becomes /skills/<name>/ in a container, so the environment-name
  // charset holds here too.
  let pathy: SkillRow = { id: "k1", skillName: "a/b", description: "d", body: "b", updatedAt: "t", visibility: "private", featuredRank: 0 , source: "local", sourceUrl: "" };
  expect(skillProblem(pathy).indexOf("container path") >= 0);
  let mute: SkillRow = { id: "k1", skillName: "ok", description: " ", body: "b", updatedAt: "t", visibility: "private", featuredRank: 0 , source: "local", sourceUrl: "" };
  expect(skillProblem(mute).indexOf("cannot be chosen") >= 0);
  let tall: SkillRow = { id: "k1", skillName: "ok", description: "two\nlines", body: "b", updatedAt: "t", visibility: "private", featuredRank: 0 , source: "local", sourceUrl: "" };
  expect(skillProblem(tall).indexOf("one line") >= 0);
  let empty: SkillRow = { id: "k1", skillName: "ok", description: "d", body: "  ", updatedAt: "t", visibility: "private", featuredRank: 0 , source: "local", sourceUrl: "" };
  expect(skillProblem(empty).indexOf("not an instruction") >= 0);
});

test("a skill file is a plain name with a body, within the cap", () => {
  let good: SkillFileRow = { id: "f1", skillId: "k1", path: "enums.py", body: "print(1)" };
  expect(skillFileProblem(good) == "");
  let nested: SkillFileRow = { id: "f1", skillId: "k1", path: "a/b.py", body: "x" };
  expect(skillFileProblem(nested).indexOf("plain name") >= 0);
  let escaping: SkillFileRow = { id: "f1", skillId: "k1", path: "..py", body: "x" };
  expect(skillFileProblem(escaping).indexOf("plain name") >= 0);
  let hollow: SkillFileRow = { id: "f1", skillId: "k1", path: "x.py", body: "" };
  expect(skillFileProblem(hollow).indexOf("nothing worth staging") >= 0);
});

// --- whose conversation it is --------------------------------------------------
//
// The gate is off in this process — no `AGENTS_TRUST_PROXY_AUTH`, so
// `callerTags` would answer an empty list for every request — which is exactly
// why the routes take the tag list as an argument. What a route DECIDES is
// `ownedThread(db, id, tags)`, and that is what is asked here.

// An unscoped caller: no proxy in front, so no owner is known and none is
// checked. Every deployment that has ever run this (owner.ts).
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

// One conversation with something of every kind hanging off it, so the
// refusals below are refusals of content that is really there.
function threadFor(owner: string, word: string): string {
  let id = openThread(database, { agentId: "a1", owner: owner, now: "1700000000000" });
  putFile(database, { threadId: id, fileName: word + ".md", mime: "text/markdown", origin: "uploaded", body: "the " + word + " notes", documentId: "", now: "1700000000000" });
  putArtifact(database, {
    threadId: id, path: "/" + word + ".html", title: word, content: "<p>" + word + "</p>",
    note: "", origin: "uploaded", mustCreate: true, turnSeq: TURN_SEQ_NONE, now: "1700000000000",
  });
  beginStep(database, {
    threadId: id, seq: 0, depth: 0, rotation: 0, idx: 0, kind: "tool",
    name: "read_file", target: "", args: "{}", now: "1700000000000",
  });
  recordRun(database, { agentId: "a1", threadId: id, owner: owner, question: "about " + word, run: emptyRun(word), modelChoiceId: "", routeNote: "" });
  return id;
}

test("with no trusted proxy the header is not read at all", () => {
  // The community-safety property, and the whole of it: untrusted, X-USER is
  // not parsed, not compared, not consulted. A box someone forgot to firewall
  // is then a box with no owners, not a box where the caller picks one.
  expect(tagsFromHeader(false, "{\"uuid\":\"u-alice\"}").length == 0);
  expect(tagsFromHeader(false, "u-alice").length == 0);
  expect(tagsFromHeader(false, "").length == 0);
  // And an empty list means unscoped everywhere downstream, which is what
  // "bit-for-bit what it does today" is made of.
  expect(owningTag(tagsFromHeader(false, "u-alice")) == "");
});

test("a trusted proxy names one tag, and it is the id rather than the name", () => {
  let nuraly = tagsFromHeader(true, "{\"uuid\":\"u-alice\",\"username\":\"alice@example.test\",\"email\":\"alice@example.test\",\"anonymous\":false,\"roles\":[\"user\"]}");
  expect(nuraly.length == 1);
  // Not the username and not the email: both are things a person changes, and
  // ownership that moves when someone edits their profile is not ownership.
  expect(nuraly[0] == "u-alice");

  // A self-hoster's own nginx setting a bare name is the documented community
  // contract, and it works without ceremony.
  let plain = tagsFromHeader(true, "  alice  ");
  expect(plain.length == 1);
  expect(plain[0] == "alice");

  // Trusted but unnamed is the unowned tag — one tag, "" — never "no scoping"
  // and never a set holding both "" and a real one.
  let silent = tagsFromHeader(true, "");
  expect(silent.length == 1);
  expect(silent[0] == "");
});

test("a document with no readable uuid is refused, not read as the unowned tag", () => {
  // The fail-open this replaces: `jsonText` answers "" for a member that is
  // absent, null or not a string, so each of these used to become the "" tag —
  // read and write over every row written before the gateway existed, and
  // nothing in the logs to tell it from a headerless request.
  let anonymous = "{\"uuid\":null,\"username\":\"\",\"anonymous\":true,\"roles\":[]}";
  let renamed = "{\"userId\":\"u-alice\",\"anonymous\":false}";
  let empty = "{\"uuid\":\"\",\"anonymous\":false}";
  expect(tagsFromHeader(true, anonymous)[0] == UNKNOWN_TAG);
  expect(tagsFromHeader(true, renamed)[0] == UNKNOWN_TAG);
  expect(tagsFromHeader(true, empty)[0] == UNKNOWN_TAG);
  expect(tagsFromHeader(true, anonymous)[0] != "");

  // A tenant of nothing, and no route needs to know about it: the door turns
  // these away before one is matched.
  expect(identityUnreadable(true, anonymous));
  expect(identityUnreadable(true, renamed));
  // Untrusted, the header is still not read — the gate comes first, always.
  expect(!identityUnreadable(false, anonymous));
  // And the cases that are not documents are untouched: a headerless trusted
  // request is the unowned tag, a self-hoster's bare name is that name.
  expect(!identityUnreadable(true, ""));
  expect(!identityUnreadable(true, "alice"));
});

test("no row can hold the unknown tag", () => {
  expect(fresh() == "");
  // Belt and braces on the door: even reached with it, the tag matches
  // nothing. Owners are "" or a trimmed header, so the leading space is the
  // guarantee rather than the decoration.
  let hers = threadFor("u-alice", "lyon");
  expect(ownedThread(database, hers, [UNKNOWN_TAG]) == "");
  expect(threadFor("", "unowned") != "");
  expect(listThreads(database, { tags: [UNKNOWN_TAG], limit: 50, offset: 0, project: "" }).length == 0);
});

test("two tags cannot reach each other's threads, files, artifacts, steps or runs", () => {
  // Insisted on, not assumed: half a plan leaves these tables without the
  // columns under test, and that reads as a scoping bug rather than a fixture
  // one.
  expect(fresh() == "");
  let hers = threadFor("u-alice", "lyon");
  let his = threadFor("u-bob", "rotterdam");

  // Every /threads/:id/... route opens with this one call, so this is the
  // whole of the refusal for sixteen of them.
  expect(ownedThread(database, hers, ["u-alice"]) == "a1");
  expect(ownedThread(database, his, ["u-bob"]) == "a1");
  expect(ownedThread(database, hers, ["u-bob"]) == "");
  expect(ownedThread(database, his, ["u-alice"]) == "");

  // The content really is there — the refusal above is a refusal of
  // something, not of an empty thread.
  expect(listFiles(database, hers).length == 1);
  expect(getFile(database, hers, "lyon.md").body.indexOf("lyon") >= 0);
  expect(listArtifacts(database, hers).length == 1);
  expect(stepsOfThread(database, hers).length == 1);

  // The list is filtered in SQL, so a page is a page of one tag's threads and
  // not a page of everyone's with the others removed afterwards.
  let sidebar = listThreads(database, { tags: ["u-alice"], limit: 50, offset: 0, project: "" });
  expect(sidebar.length == 1);
  expect(sidebar[0].id == hers);
  expect(listThreads(database, { tags: ["u-bob"], limit: 50, offset: 0, project: "" }).length == 1);

  // Runs hang off the agent, and the agent is shared, so the tag is the only
  // thing between one tenant's transcripts and another's.
  let herRuns = runsOf(database, "a1", ["u-alice"], 50);
  expect(herRuns.indexOf("about lyon") >= 0);
  expect(herRuns.indexOf("about rotterdam") < 0);

  // A run is filed under the THREAD's owner, so a guest asking in a shared
  // conversation would not quietly take the log line with them.
  expect(threadOwner(database, hers) == "u-alice");
});

test("the trust gate off means every tag sees everything, exactly as before", () => {
  fresh();
  let hers = threadFor("u-alice", "lyon");
  let his = threadFor("u-bob", "rotterdam");
  // Legacy: opened before there were owners, and by a community deployment
  // that will never have one.
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

  // The cutover rule: `owner = tag`, never `owner = '' OR owner = tag`. The
  // second reading is one character of SQL away and would give every
  // authenticated user the whole of what the box held before it had users.
  expect(ownedThread(database, nobodys, ["u-alice"]) == "");
  let sidebar = listThreads(database, { tags: ["u-alice"], limit: 50, offset: 0, project: "" });
  expect(sidebar.length == 1);
  expect(sidebar[0].id == hers);
  // Claiming them is a deliberate backfill (scenarios/backfill_owner.py), not
  // something a first login does by accident.
  executeWith(database, "UPDATE threads SET owner = " + database.placeholder + " WHERE owner = ''", ["u-alice"]);
  expect(ownedThread(database, nobodys, ["u-alice"]) == "a1");
});

// --- the guest gate ------------------------------------------------------------
//
// Who counts as a guest is a decision about the tag list `callerTags` built,
// and the refusal body is a free function — both asked here directly; the
// windowed count itself is usage.test.ts's subject.

test("a guest is exactly one tag with the guest prefix, and nobody else is", () => {
  expect(guestTag(["guest:0123abcd"]) == "guest:0123abcd");
  // A real user, the unowned tag, no tags, and a set that merely contains a
  // guest: none of these get the ceiling.
  expect(guestTag(["u-alice"]) == "");
  expect(guestTag([""]) == "");
  expect(guestTag(unscoped) == "");
  expect(guestTag(["guest:0123abcd", "u-alice"]) == "");
  // End to end through the door: the gateway's minted document reads as a
  // guest; untrusted, the same header is never read at all, so the community
  // deployment has no guests and no gate.
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

// --- the bearer lock -------------------------------------------------------------
//
// Off unless an operator sets AGENTS_API_TOKEN, and this process has not — so
// what is asked here is the decision, with the configured token passed in.
// The firewall is what isolates :8100; this is what a missed rule runs into
// next, and the reason it exists is that with the trust gate on, reaching the
// port at all means choosing an identity (GATEWAY.md).

test("with no token configured nothing is refused, which is every deployment today", () => {
  expect(!bearerRefused("", "/threads", ""));
  expect(!bearerRefused("", "/threads", "Bearer whatever"));
});

test("configured, a route wants the token and says so for every way of missing it", () => {
  expect(bearerRefused("s3cret", "/threads", ""));
  expect(bearerRefused("s3cret", "/threads", "Bearer "));
  expect(bearerRefused("s3cret", "/threads", "Bearer wrong"));
  // A near miss is a miss: no prefix match, no case folding of the secret.
  expect(bearerRefused("s3cret", "/threads", "Bearer s3cre"));
  expect(bearerRefused("s3cret", "/threads", "Bearer S3CRET"));
  // Another scheme carrying the right string is not a bearer token.
  expect(bearerRefused("s3cret", "/threads", "Basic s3cret"));
  expect(!bearerRefused("s3cret", "/threads", "Bearer s3cret"));
  // The scheme itself is case-insensitive per RFC 7235, and curl users write
  // it both ways.
  expect(!bearerRefused("s3cret", "/threads", "bearer s3cret"));
  // Whitespace around the value is the shell's, not the caller's.
  expect(!bearerRefused("s3cret", "/threads", "Bearer  s3cret "));
});

test("the probe answers without the token, and nothing else does", () => {
  // A probe that needs the secret cannot tell "the engine is down" from "the
  // secret is wrong", and those are different pages of the runbook.
  expect(!bearerRefused("s3cret", "/healthz", ""));
  expect(!bearerRefused("s3cret", "/healthz/", ""));
  expect(!bearerRefused("s3cret", "/healthz?verbose=1", ""));
  // Exact, so a path that merely starts with it is still locked.
  expect(bearerRefused("s3cret", "/healthzz", ""));
  expect(bearerRefused("s3cret", "/healthz/../threads", ""));
  // Including the preview door: the token is between the gateway and this
  // process, and the gateway sends it on everything it proxies.
  expect(bearerRefused("s3cret", "/preview/abc", ""));
});

// --- the probe --------------------------------------------------------------------

test("healthz says which build, how far the schema got, and whether docker is there", () => {
  expect(fresh() == "");
  let said = healthJson(database, "1700000000000");
  expect(said.indexOf("\"version\":\"") >= 0);
  // The high-water mark, and it is the plan's own top version — a build served
  // against a database that stopped at 60 is a different incident from one
  // that never started.
  //
  // Bumped by hand with the top of the plan, and worth the chore: this read
  // "76" while the top was 86.2, because `fresh()` did not drop `skills` and
  // the plan had been stopping at migration 77 for real. A canary that is
  // never updated is a canary that has already died.
  expect(said.indexOf("\"migration\":\"115\"") >= 0);
  // A fact, whichever way it falls: this suite runs on hosts with docker and
  // hosts without.
  expect(said.indexOf("\"docker\":true") >= 0 || said.indexOf("\"docker\":false") >= 0);
});

// --- the original file, kept beside its text ---------------------------------
//
// The routes themselves are PostgreSQL-only (retrieval is), so what is asked
// here is what the store DECIDES: that the id is a function of the pair, which
// is the whole of the idempotency claim, and that a deleted document does not
// leave its bytes behind.

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
  // A trailing slash is the same folder, so it must be the same row — the id
  // normalises, and a caller that spells it either way gets the file back.
  expect(findDocumentFile(database, "/e2e", "notes").bytes == "aGVsbG8gcGRm");
  expect(findDocumentFile(database, "/e2e/", "notes").bytes == "aGVsbG8gcGRm");
  expect(findDocumentFile(database, "e2e", "notes").filename == "notes.pdf");
  // A different folder is a different document, not the same one seen twice.
  expect(findDocumentFile(database, "/other", "notes").id == "");
  expect(findDocumentFile(database, "/e2e", "absent").id == "");
});

test("re-uploading a document replaces its kept copy rather than adding one", () => {
  expect(fresh() == "");
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("notes", "/e2e", "b25l")));
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("notes", "/e2e", "dHdv")));
  // One row, holding the second upload. Two rows would mean the first file's
  // bytes were kept forever with nothing able to name them — a leak that grows
  // by a file every time somebody's browser retries.
  expect(countWhere(database, documentFilesMapping(), "source = ?", ["notes"]) == 1);
  expect(findDocumentFile(database, "/e2e", "notes").bytes == "dHdv");
});

test("deleting a document takes its original with it, in every folder", () => {
  expect(fresh() == "");
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("notes", "/e2e", "b25l")));
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("notes", "/spec", "dHdv")));
  persist(database, documentFilesMapping(), JSON.stringify(keptFile("other", "/e2e", "dGhyZWU=")));
  // Scope-blind, because the corpus's own DELETE is: it takes every chunk of
  // the source in every folder, and a file whose text is gone can never be
  // asked for again.
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
  // A document indexed before this table existed, or uploaded by anything that
  // does not keep bytes, is a `hasFile:false` row and not a missing one.
  expect(!holdsSource(mine, "unindexed"));
  // Scoped: another folder's originals are not this folder's.
  expect(!holdsSource(mine, "elsewhere"));
});

test("the size of a kept file is arithmetic over its base64, never a decode", () => {
  // Four characters carry three bytes, and each "=" stands for a byte that is
  // not there. Computed rather than measured so an eighteen-megabyte upload is
  // never held twice — once encoded, once decoded to be counted.
  expect(decodedSize("") == 0);
  expect(decodedSize("aGVsbG8gcGRm") == 9);      // "hello pdf"
  expect(decodedSize("aGVsbG8=") == 5);          // "hello", one pad
  expect(decodedSize("aGVsbG8hIQ==") == 7);      // "hello!!", two pads
});

// --- which model a conversation runs on ---------------------------------------
//
// The menu, the field that overrides it, and where that field is kept. The
// routes are methods on a class, so what each one DECIDES is asked here: the
// serialisation the menu answers with, the refusal the two write doors share,
// and the one column that remembers a pick.

// A menu the operator curated: a router, two configs, and a row they have
// since retired. Written in an order that is neither rank nor alphabetical, so
// the order it comes back in is the table's doing and not the insert's.
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
  let wire = choicesJson(enabledChoices(database));

  // Rank, not the alphabet: these three sort Auto, Fast, Thinking by label and
  // Auto, Thinking, Fast by rank, so only one of the two can produce this.
  expect(wire.indexOf("\"Auto\"") < wire.indexOf("\"Thinking\""));
  expect(wire.indexOf("\"Thinking\"") < wire.indexOf("\"Fast\""));
  // The retired row is not on offer, and the enabled ones are all of it.
  expect(wire.indexOf("Retired") < 0);
  expect(enabledChoices(database).length == 3);

  // What a row carries: enough to draw it, and nothing a client could send
  // back. A `configId` on the wire is a `modelChoiceId` somebody eventually
  // posts — which names no choice row and reads as the menu being broken.
  expect(wire.indexOf("\"id\":\"mc-auto\"") >= 0);
  expect(wire.indexOf("\"description\":\"decides for each message\"") >= 0);
  expect(wire.indexOf("\"kind\":\"router\"") >= 0);
  expect(wire.indexOf("\"kind\":\"config\"") >= 0);
  expect(wire.indexOf("configId") < 0);
  expect(wire.indexOf("cfg-quick") < 0);
  expect(wire.indexOf("routerId") < 0);
  expect(wire.indexOf("rt-1") < 0);
  // Nor the two fields that would hold one value forever: every row here is
  // enabled, and the array is already in rank order.
  expect(wire.indexOf("\"enabled\"") < 0);
  expect(wire.indexOf("\"rank\"") < 0);

  // Premium is on the menu rather than hidden from it: a lock that cannot be
  // seen sells nothing, and enforcement is at the messages POST.
  expect(wire.indexOf("\"tier\":\"premium\"") >= 0);
});

test("a body that says nothing about a model is a body that changes nothing", () => {
  // Read off the raw body, and this is why: `modelChoiceId` declared on a body
  // record would make JSON.parse refuse every body that omits it — which is
  // every curl in this package's own header.
  expect(askedChoice("{\"text\":\"hello\"}") == "");
  expect(askedChoice("{\"text\":\"hello\",\"modelChoiceId\":\"mc-fast\"}") == "mc-fast");
  expect(askedChoice("{\"text\":\"hello\",\"modelChoiceId\":\"\"}") == "");
  expect(askedChoice("") == "");
  // The open door reads the same field off its own body.
  expect(askedChoice("{\"agentId\":\"a1\",\"modelChoiceId\":\"mc-think\"}") == "mc-think");
});

test("the door reads its members and never parses the body into a narrow record", () => {
  // The other half of the rule above, and the expensive one. `JSON.parse<T>`
  // refuses a document carrying a key the record does NOT declare, so
  // `{ text: string }` against the console's own send — which always carries
  // `modelChoiceId` — throws UnknownField, the server answers 400, and the
  // validation below it is unreachable. Declaring the field breaks the old
  // callers; not declaring it breaks the new ones. Neither door parses.
  //
  // This is the shape `say` in app/src/api.ts actually posts.
  let sent = "{\"text\":\"hello\",\"modelChoiceId\":\"\"}";
  expect(jsonText(sent, "text") == "hello");
  expect(askedChoice(sent) == "");
  // And the shape everything written before the picker posts.
  expect(jsonText("{\"text\":\"hello\"}", "text") == "hello");
  // The open door, same two shapes.
  expect(jsonText("{\"agentId\":\"a1\",\"modelChoiceId\":\"mc-think\"}", "agentId") == "a1");
  expect(jsonText("{\"agentId\":\"a1\"}", "agentId") == "a1");
});

test("\"Agent default\" is a choice a person makes, not the absence of one", () => {
  // The menu's last row sends "". Read as "the caller said nothing", picking it
  // inherits the thread's memory — so a conversation moved onto Thinking could
  // never be moved back, and reopening it snapped the picker to Thinking again.
  // There was no value the wire could carry meaning "clear".
  //
  // One field still, read twice: what was said, and whether anything was.
  let cleared = askedPick("{\"text\":\"hello\",\"modelChoiceId\":\"\"}");
  expect(cleared.choiceId == "" && cleared.sent);
  let picked = askedPick("{\"text\":\"hello\",\"modelChoiceId\":\"mc-fast\"}");
  expect(picked.choiceId == "mc-fast" && picked.sent);
  // Absent is the inheriting case, which is every request written before the
  // picker existed.
  let silent = askedPick("{\"text\":\"hello\"}");
  expect(silent.choiceId == "" && !silent.sent);
  expect(!askedPick("").sent);
  // A key that only LOOKS like the field, inside a string, is not the field —
  // `jsonFind` reads strings whole rather than searching their text.
  expect(!askedPick("{\"text\":\"{\\\"modelChoiceId\\\":\\\"mc-fast\\\"}\"}").sent);
});

test("a choice that names nothing is refused at the door, by name", () => {
  expect(fresh() == "");
  seedMenu();
  // Nothing chosen is not a mistake — it is what every conversation written
  // before there was a menu means.
  expect(choiceProblem(database, "") == "");
  expect(choiceProblem(database, "mc-fast") == "");
  expect(choiceProblem(database, "mc-auto") == "");
  // Premium passes here today, deliberately. When editions price a row this
  // is the line that has to change, and it is a test somebody must read
  // before they can change it.
  expect(choiceProblem(database, "mc-think") == "");

  expect(choiceProblem(database, "mc-nope").indexOf("mc-nope") >= 0);
  // Absent and retired are separate sentences because they are separate
  // mistakes: an id a client invented, against a menu the operator changed
  // under a console that has not reloaded.
  expect(choiceProblem(database, "mc-gone").indexOf("not offered") >= 0);
  expect(choiceProblem(database, "mc-gone").indexOf("no model choice") < 0);
  // The id of the config behind a choice is not a choice. It never reaches a
  // client (the menu above), so a caller that has one has guessed.
  expect(choiceProblem(database, "cfg-quick") != "");
});

test("retiring a row stops new picks without stopping the conversations holding it", () => {
  expect(fresh() == "");
  seedMenu();
  // The asymmetry, in one test so it cannot be tidied away as an
  // inconsistency: the door refuses what the read tolerates.
  expect(choiceProblem(database, "mc-gone") != "");
  expect(configForChoice(database, "mc-gone") == "");
  // A live config choice resolves to the row that will answer.
  expect(configForChoice(database, "mc-fast") == "cfg-quick");
  // A router choice resolves to "" as well: which config it lands on is not
  // known until the routing completion has been made, so this is not the
  // question being asked.
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

  // The guard used to ask about agents alone, and this is what that missed: a
  // menu row is a live option. Delete the config under it and "Fast" stays on
  // the menu, passes `choiceProblem` because the CHOICE is still enabled, and
  // then hard-fails every turn with "no model config cfg-quick" — because
  // run.ts refuses a dangling config by name rather than answering on
  // something else. Every message sent on Fast dies until somebody edits the
  // table by hand.
  expect(configInUse(database, "cfg-quick").indexOf("model menu") >= 0);
  // A router is the same failure on the two columns it resolves by id: with no
  // config it cannot make its call, and with no fallback it has nowhere to land.
  expect(configInUse(database, "c-router").indexOf("router") >= 0);
  expect(configInUse(database, "c-standard").indexOf("router") >= 0);
  // Every refusal says what to do next, or it is just a locked door.
  expect(configInUse(database, "cfg-quick").indexOf("take the choice off the menu") >= 0);
  expect(configInUse(database, "c-router").indexOf("repoint the router") >= 0);

  // The agent guard that was already there still answers first.
  let a9: AgentRow = { id: "a9", agentName: "lead", description: "d", modelConfigId: "c-agents", promptId: "p1", scriptImageId: "", isDefault: false, enabled: true, updatedAt: "t" };
  persist(database, agentsMapping(), JSON.stringify(a9));
  expect(configInUse(database, "c-agents").indexOf("used by an agent") >= 0);

  // And a config nothing points at is free to go. `candidatesJson` is
  // deliberately not searched — that is JSON in a text column across three
  // databases, for a case run.ts already refuses by name — so a candidate-only
  // reference does not hold a row.
  expect(configInUse(database, "c-nobody") == "");
});

test("a conversation can be opened already pointing at a choice", () => {
  // What `POST /threads` does with a body carrying one, in order. The picker
  // is used before the thread exists, so the first message must not have to
  // re-state what was already showing — and threads.test.ts covers the other
  // door, where the choice arrives with a message.
  expect(fresh() == "");
  seedMenu();
  let asked = askedChoice("{\"agentId\":\"a1\",\"modelChoiceId\":\"mc-think\"}");
  expect(choiceProblem(database, asked) == "");
  let hers = openThread(database, { agentId: "a1", owner: "u-alice", now: "1700000000000" });
  let his = openThread(database, { agentId: "a1", owner: "u-bob", now: "1700000000000" });

  // `openThread` takes no choice on purpose, so an opened thread starts on the
  // agent's own model and the door writes the pick as its own statement.
  expect(threadChoice(database, hers) == "");
  expect(rememberChoice(database, hers, asked) == "");
  expect(threadChoice(database, hers) == "mc-think");

  // The write is one column. `persist` would have put the whole row back from
  // a copy read a moment earlier, and this lands between the ownership check
  // that let the request in and the run that answers it — so the next request
  // must still find the same owner on the same agent.
  expect(threadOwner(database, hers) == "u-alice");
  expect(ownedThread(database, hers, ["u-alice"]) == "a1");
  expect(ownedThread(database, hers, ["u-bob"]) == "");

  // One conversation's pick is not everybody's.
  expect(threadChoice(database, his) == "");
});

// --- the admin write surface -------------------------------------------------
//
// Until these routes existed the menu had no editor: `GET /models/choices` was
// read-only, `/model-configs` had a POST and a DELETE and nothing between them,
// and `label`, `selectable` and `menu_rank` — the three columns that decide
// whether a config is offered and what it is called — were reachable only from
// a psql session. Routes are methods on a class, so what each one decides is a
// free function, and it is asked here.

function configRow(id: string, modelId: string, label: string): ModelConfigRow {
  let c: ModelConfigRow = {
    id: id, modelId: modelId, temperature: 0.2, maxTokens: 8192, topP: 1.0,
    extra: "", thinking: "", label: label, selectable: true, rank: 1,
  };
  return c;
}

// Two chat configs and one over an embedding model. The third is the case both
// a menu row and a router candidate have to refuse: an embedding config in the
// menu is a row somebody picks and then gets an embedding endpoint's refusal
// from, per turn, until an operator reads a log.
function seedConfigs(): void {
  persist(database, modelsMapping(), JSON.stringify(modelRow("m-chat", "mistral", "chat", "")));
  persist(database, modelsMapping(), JSON.stringify(modelRow("m-embed", "mistral", "embedding", "")));
  persist(database, modelConfigsMapping(database), JSON.stringify(configRow("c-fast", "m-chat", "Fast")));
  persist(database, modelConfigsMapping(database), JSON.stringify(configRow("c-deep", "m-chat", "Deep")));
  persist(database, modelConfigsMapping(database), JSON.stringify(configRow("c-vec", "m-embed", "Vectors")));
}

test("an operator's body is read a member at a time, and an unexpected field is not a 400", () => {
  // The trap this whole surface is written around, and it has cost this feature
  // a production break once already: `JSON.parse<T>` refuses a document
  // carrying a member the record does NOT declare as firmly as one missing a
  // member it does. An admin console PUTs back the row it just read — which for
  // a config arrives with the whole `model` object nested inside it, because
  // the mapping declares a hasOne relation — plus whatever field ships next
  // month. Every one of those bodies is a 400 against a record type.
  let sent = "{\"label\":\"Fast\",\"selectable\":true,\"menuRank\":3,"
    + "\"model\":{\"id\":\"m-chat\",\"label\":\"Mistral\"},\"somethingNew\":\"ignored\"}";
  expect(bodyText(sent, "label", "kept") == "Fast");
  expect(bodyBool(sent, "selectable", false));
  expect(bodyRank(sent, 0) == 3);

  // Absent means "leave it alone", which is what makes a one-field PUT safe:
  // nothing the body did not mention can be reset to a zero value by omission.
  expect(bodyText(sent, "thinking", "kept") == "kept");
  expect(bodyInt(sent, "maxTokens", 4096) == 4096);
  expect(bodyBool(sent, "enabled", true));

  // Top-level only, and that is not the same reader the thread doors use.
  // scan.ts's `jsonFind` searches at ANY depth, which is right for a provider's
  // reply and wrong here: a router body carries an array of candidates with
  // their own `configId` members, and reading one of those as the router's own
  // is a silent repoint. `id` below lives inside `model` and must not be found.
  expect(bodyText(sent, "id", "none") == "none");
  let nested = "{\"candidates\":[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"x\"}],\"label\":\"Auto\"}";
  expect(bodyText(nested, "configId", "") == "");
  expect(bodyText(nested, "label", "") == "Auto");
});

test("menuRank and rank are one column under its two names", () => {
  // The column is `menu_rank` because RANK is a window function in MySQL 8 and
  // `createTableSql` does not quote identifiers; the record's field is `rank`,
  // which is what every GET emits. Both spellings are therefore loose in the
  // world, and `rank` is taken first so a read-then-write round trip is
  // lossless.
  expect(bodyRank("{\"rank\":2}", 9) == 2);
  expect(bodyRank("{\"menuRank\":5}", 9) == 5);
  expect(bodyRank("{\"rank\":2,\"menuRank\":5}", 9) == 2);
  expect(bodyRank("{\"label\":\"x\"}", 9) == 9);

  // A member holding the wrong type reads as absent, so the stored value
  // survives rather than being overwritten with a zero. That is the one place
  // these readers are lenient and it is bounded: the merged row is validated
  // afterwards either way.
  expect(bodyRank("{\"rank\":\"tuesday\"}", 9) == 9);
  expect(bodyInt("{\"maxTokens\":\"4096\"}", "maxTokens", 0) == 4096);
  expect(bodyNumber("{\"temperature\":0.7}", "temperature", 0.0) == 0.7);
  expect(!bodyBool("{\"enabled\":\"false\"}", "enabled", true));
});

test("a config PUT writes what the body names and leaves the rest of the row alone", () => {
  expect(fresh() == "");
  seedConfigs();

  // The row the merge starts from is read through `modelConfigRows` and not the
  // mapping the GET uses, for the reason above: that one's document carries the
  // model nested inside it and no record type can parse it back.
  let stored: ModelConfigRow = JSON.parse<ModelConfigRow>(findById(database, modelConfigRows(database), "c-fast"));
  expect(stored.maxTokens == 8192);

  // The three columns that used to need psql, and an unexpected field beside
  // them: the request must still succeed.
  let merged = mergedConfig(stored, "{\"label\":\"Quick\",\"selectable\":false,\"menuRank\":7,\"whatIsThis\":true}");
  expect(merged.label == "Quick");
  expect(!merged.selectable);
  expect(merged.rank == 7);
  expect(configProblem(database, merged) == "");
  // Untouched by a body that did not mention them — including the id, which
  // comes from the path and never from the body.
  expect(merged.id == "c-fast");
  expect(merged.modelId == "m-chat");
  expect(merged.maxTokens == 8192);
  expect(merged.temperature == 0.2);

  // And the tuning fields the POST already accepted.
  let tuned = mergedConfig(stored, "{\"maxTokens\":512,\"thinking\":\"high\",\"temperature\":1.0,\"extra\":{\"top_k\":40}}");
  expect(tuned.maxTokens == 512);
  expect(tuned.thinking == "high");
  expect(tuned.temperature == 1.0);
  // `extra` is a text column holding whatever a provider takes that this schema
  // does not name, so an object body means the object and a string body means
  // the string; both land as the text the column holds.
  expect(tuned.extra == "{\"top_k\":40}");
  expect(mergedConfig(stored, "{\"extra\":\"{\\\"top_k\\\":40}\"}").extra == "{\"top_k\":40}");
  expect(bodyJson("{\"extra\":\"plain\"}", "extra", "kept") == "plain");
});

test("a config is refused for each way of being unwritable, by name", () => {
  expect(fresh() == "");
  seedConfigs();
  let stored = configRow("c-fast", "m-chat", "Fast");
  expect(configProblem(database, mergedConfig(stored, "{\"modelId\":\"m-nope\"}")).indexOf("m-nope") >= 0);
  expect(configProblem(database, mergedConfig(stored, "{\"modelId\":\"\"}")).indexOf("modelId") >= 0);
  expect(configProblem(database, mergedConfig(stored, "{\"maxTokens\":0}")).indexOf("maxTokens") >= 0);
  expect(configProblem(database, mergedConfig(stored, "{\"menuRank\":-1}")).indexOf("menuRank") >= 0);

  // Deliberately NOT refused: a selectable config with no label. Migration
  // 87.21 turns `selectable` on for every config the derived menu covers and
  // never writes `model_configs.label` — the menu row carries the words — so
  // that rule would refuse an edit to rows this package created itself.
  expect(configProblem(database, mergedConfig(stored, "{\"label\":\"\",\"selectable\":true}")) == "");
});

test("a menu row is created and edited over the API, unexpected fields and all", () => {
  expect(fresh() == "");
  seedConfigs();
  let created = mergedChoice(blankChoice("ch-fast"),
    "{\"id\":\"ch-fast\",\"label\":\"Fast\",\"description\":\"short answers, quickly\","
    + "\"kind\":\"config\",\"configId\":\"c-fast\",\"clientVersion\":\"3\"}");
  expect(choiceRowProblem(database, created) == "");
  // On the menu unless the body says otherwise, and unpriced unless it does.
  expect(created.enabled);
  expect(created.tier == "");
  persist(database, modelChoicesMapping(), JSON.stringify(created));

  // The edit that used to be a psql session: what it is called, whether it is
  // offered, where it sits, and what it costs.
  let stored: ModelChoiceRow = JSON.parse<ModelChoiceRow>(findById(database, modelChoicesMapping(), "ch-fast"));
  let edited = mergedChoice(stored, "{\"label\":\"Instant\",\"enabled\":false,\"menuRank\":4,\"tier\":\"premium\"}");
  expect(choiceRowProblem(database, edited) == "");
  expect(edited.label == "Instant");
  expect(!edited.enabled);
  expect(edited.rank == 4);
  expect(edited.tier == "premium");
  // Everything the body did not mention is still there.
  expect(edited.kind == "config" && edited.configId == "c-fast");
  expect(edited.description == "short answers, quickly");
});

test("a menu row is refused for each way of being a broken option, by name", () => {
  expect(fresh() == "");
  seedConfigs();
  expect(choiceRowProblem(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"Fast\",\"kind\":\"config\",\"configId\":\"c-fast\"}")) == "");

  // A blank line in everybody's menu.
  expect(choiceRowProblem(database, mergedChoice(blankChoice("ch-1"),
    "{\"kind\":\"config\",\"configId\":\"c-fast\"}")).indexOf("label") >= 0);
  // `kind` is stated rather than inferred from whichever of the two ids is
  // filled in, so a row with both set is a mistake somebody is shown rather
  // than a precedence rule.
  expect(choiceRowProblem(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"F\",\"kind\":\"config\",\"configId\":\"c-fast\",\"routerId\":\"rt-1\"}")).indexOf("routerId") >= 0);
  expect(choiceRowProblem(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"F\",\"kind\":\"auto\",\"configId\":\"c-fast\"}")).indexOf("kind") >= 0);
  // The config behind a menu row must exist and must be able to answer a turn.
  // A dangling one does not degrade: run.ts refuses it by name, so every
  // message sent on that row dies.
  expect(choiceRowProblem(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"F\",\"kind\":\"config\",\"configId\":\"c-gone\"}")).indexOf("c-gone") >= 0);
  expect(choiceRowProblem(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"F\",\"kind\":\"config\",\"configId\":\"c-vec\"}")).indexOf("chat") >= 0);
  // Tier is a label with two values, not free text: LICENSING.md reads it.
  expect(choiceRowProblem(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"F\",\"kind\":\"config\",\"configId\":\"c-fast\",\"tier\":\"gold\"}")).indexOf("premium") >= 0);
  // And a router choice names a router that exists.
  expect(choiceRowProblem(database, mergedChoice(blankChoice("ch-1"),
    "{\"label\":\"Auto\",\"kind\":\"router\",\"routerId\":\"rt-nope\"}")).indexOf("rt-nope") >= 0);
});

test("a router's candidates are a list of pairs, and every way of breaking one is refused", () => {
  // This is the part of the design that has no other way in: "a special type
  // where we select a list of models and add a route description for each".
  // Every rule below is a failure `routeTurn` cannot report, because every
  // failure path in that file leads to the fallback on purpose — so a router
  // with a dud candidate does not throw, it just never picks that one, and the
  // only symptom is that "Auto" answers a bit worse than it used to.
  expect(fresh() == "");
  seedConfigs();
  expect(candidatesProblem(database,
    "[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"greetings and short questions\"},"
    + "{\"key\":\"deep\",\"configId\":\"c-deep\",\"when\":\"writing a document, multi-step analysis\"}]") == "");

  // Not an array — which is also what a client that pre-encoded the column
  // sends.
  expect(candidatesProblem(database, "{\"key\":\"fast\"}").indexOf("array") >= 0);
  expect(candidatesProblem(database, "").indexOf("array") >= 0);
  // Nothing to choose between: a completion call that can only fall back.
  expect(candidatesProblem(database, "[]").indexOf("at least one") >= 0);
  // A key that can never be matched is prompt text the model is not allowed to
  // choose.
  expect(candidatesProblem(database, "[{\"configId\":\"c-fast\",\"when\":\"x\"}]").indexOf("key") >= 0);
  // Two keys the router cannot tell apart: `matchKey` and `indexOfKey` both
  // fold case, so "Fast" and "fast" are ONE key and which of the two a reply
  // selects is whichever was written first — not a decision anybody made.
  expect(candidatesProblem(database,
    "[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"x\"},"
    + "{\"key\":\"Fast\",\"configId\":\"c-deep\",\"when\":\"y\"}]").indexOf("repeats") >= 0);
  // The rule the human asked for by name, and the one that matters most:
  // `when` is the entire interface to the decision.
  let blank = candidatesProblem(database, "[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"  \"}]");
  expect(blank.indexOf("when") >= 0);
  expect(blank.indexOf("cannot choose on purpose") >= 0);
  // And the config each pair points at, on both counts.
  expect(candidatesProblem(database, "[{\"key\":\"fast\",\"configId\":\"c-gone\",\"when\":\"x\"}]").indexOf("c-gone") >= 0);
  expect(candidatesProblem(database, "[{\"key\":\"fast\",\"configId\":\"c-vec\",\"when\":\"x\"}]").indexOf("chat") >= 0);
  // Which candidate, by position and by key. A router with three of these and
  // an unnamed refusal is a hunt.
  let second = candidatesProblem(database,
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

  // A blob the client pre-encoded is refused by name rather than ignored: an
  // edit that silently vanishes is worse than one that is turned down, because
  // the router goes on routing the way it did yesterday and nobody knows.
  expect(preEncodedCandidates(body) == "");
  expect(preEncodedCandidates("{\"candidatesJson\":\"[]\"}").indexOf("candidates") >= 0);

  let row = mergedRouter(blankRouter("rt-1"), body);
  expect(routerRowProblem(database, row) == "");
  let settled = withCanonicalCandidates(row);
  // Normalised to the three fields the router reads. `note` was already
  // invisible to `candidatesFrom`, so nothing a routing prompt ever saw is
  // lost — and what a later GET shows is now what the router sees.
  expect(settled.candidatesJson.indexOf("note") < 0);
  expect(settled.candidatesJson.indexOf("\"key\":\"fast\"") >= 0);
  expect(settled.candidatesJson.indexOf("\"when\":\"plans\"") >= 0);
  persist(database, modelRoutersMapping(), JSON.stringify(settled));

  // What you PUT is what you GET, which is the property that lets a settings
  // form read a row, change one `when` line and send it back.
  let wire = routerJson(allRouters(database)[0]);
  expect(wire.indexOf("\"candidates\":[{") >= 0);
  expect(wire.indexOf("candidatesJson") < 0);
  expect(wire.indexOf("\"escalateOnly\":false") >= 0);
  expect(wire.indexOf("\"enabled\":true") >= 0);
  expect(wire.indexOf("\"routeEvery\":\"turn\"") >= 0);

  // And that edit, made: one `when` line, nothing else stated.
  let stored: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-1"));
  let edited = mergedRouter(stored,
    "{\"candidates\":[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"greetings and edits\"}]}");
  expect(routerRowProblem(database, edited) == "");
  expect(edited.label == "Auto" && edited.routerConfigId == "c-fast");
  expect(edited.candidatesJson.indexOf("greetings and edits") >= 0);
  // A body that says nothing about the list keeps the stored one.
  expect(mergedRouter(stored, "{\"enabled\":false}").candidatesJson == stored.candidatesJson);
  expect(!mergedRouter(stored, "{\"enabled\":false}").enabled);
});

test("a router is refused for each id it resolves and for how often it routes", () => {
  expect(fresh() == "");
  seedConfigs();
  let candidates = "\"candidates\":[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"greetings\"}]";
  expect(routerRowProblem(database, mergedRouter(blankRouter("rt-1"),
    "{\"label\":\"Auto\",\"routerConfigId\":\"c-fast\",\"fallbackConfigId\":\"c-deep\"," + candidates + "}")) == "");

  expect(routerRowProblem(database, mergedRouter(blankRouter("rt-1"),
    "{\"routerConfigId\":\"c-fast\",\"fallbackConfigId\":\"c-deep\"," + candidates + "}")).indexOf("label") >= 0);
  expect(routerRowProblem(database, mergedRouter(blankRouter("rt-1"),
    "{\"label\":\"Auto\",\"routeEvery\":\"sometimes\",\"routerConfigId\":\"c-fast\","
    + "\"fallbackConfigId\":\"c-deep\"," + candidates + "}")).indexOf("routeEvery") >= 0);
  // Without a config there is no routing call to make: `routeChoice` writes a
  // note and the menu's lead row never routes.
  expect(routerRowProblem(database, mergedRouter(blankRouter("rt-1"),
    "{\"label\":\"Auto\",\"fallbackConfigId\":\"c-deep\"," + candidates + "}")).indexOf("routerConfigId") >= 0);
  // And the fallback is where every failure path in router.ts lands, so a
  // router nobody gave a usable one is a router that should not be enabled.
  let landing = routerRowProblem(database, mergedRouter(blankRouter("rt-1"),
    "{\"label\":\"Auto\",\"routerConfigId\":\"c-fast\",\"fallbackConfigId\":\"c-vec\"," + candidates + "}"));
  expect(landing.indexOf("fallbackConfigId") >= 0);
  expect(landing.indexOf("chat") >= 0);
  // The role is named on every one of the three, because "no model config c-x"
  // three times over says nothing about which id is wrong.
  expect(chatConfigProblem(database, "c-fast", "routerConfigId") == "");
  expect(chatConfigProblem(database, "", "fallbackConfigId").indexOf("fallbackConfigId") >= 0);
});

test("the menu is published from what the database holds, at every start", () => {
  // `main()` migrates, seeds and then calls this, and the order is the whole
  // point: the derived statements used to be migrations, so on a fresh install
  // they ran BEFORE any of these rows existed, wrote nothing, and recorded
  // themselves as applied. `fresh()` is that install — the plan has run, and
  // the models arrive afterwards, as they do on any real deployment.
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
  // The embedding config is refused, here as in every other place a chat model
  // is what is wanted.
  expect(configForChoice(database, "ch-c-vec") == "");
  expect(configForChoice(database, "ch-c-fast") == "c-fast");
  // Twice is once. This runs on every start, so "safe to repeat" is not a nice
  // property of it, it is the reason it can live there at all.
  expect(publishMenu(database) == "");
  expect(enabledChoices(database).length == 3);
});

test("a router can always be switched off, whatever its candidates say", () => {
  expect(fresh() == "");
  seedConfigs();
  // The state an operator reaches by deleting a config a candidate names.
  // `configInUse` deliberately does not guard `candidatesJson` — three dialects
  // of JSON function for a case run.ts already refuses by name — so this is
  // reachable through the ordinary API, and the router goes on spending a
  // completion per turn until somebody stops it.
  let stale: ModelRouterRow = {
    id: "rt-1", label: "Auto", routerConfigId: "c-fast",
    candidatesJson: "[{\"key\":\"fast\",\"configId\":\"c-fast\",\"when\":\"greetings\"},"
      + "{\"key\":\"deep\",\"configId\":\"c-gone\",\"when\":\"plans\"}]",
    fallbackConfigId: "c-fast", routeEvery: "turn", escalateOnly: false, enabled: true,
  };
  persist(database, modelRoutersMapping(), JSON.stringify(stale));
  let stored: ModelRouterRow = JSON.parse<ModelRouterRow>(findById(database, modelRoutersMapping(), "rt-1"));

  // While it is on, the dead candidate is a real problem and is named.
  expect(routerRowProblem(database, stored).indexOf("c-gone") >= 0);
  // The kill switch is the one action that must not depend on the list being
  // right: a router that is off routes nothing, so its candidates cannot be
  // wrong about anything. This used to answer 400 and leave the operator
  // reconstructing the whole array by hand to turn the thing off.
  let off = mergedRouter(stored, "{\"id\":\"rt-1\",\"enabled\":false}");
  expect(routerRowProblem(database, off) == "");
  expect(off.candidatesJson == stored.candidatesJson);
  // And turning it back on asks the question again, so nothing is let through
  // by going round the houses.
  expect(routerRowProblem(database, mergedRouter(off, "{\"id\":\"rt-1\",\"enabled\":true}")).indexOf("c-gone") >= 0);
  // The two ids the router resolves on every turn are still checked while it is
  // off: `configInUse` guards them, so a dangling one means somebody edited the
  // row rather than deleted a config.
  expect(routerRowProblem(database, mergedRouter(off, "{\"id\":\"rt-1\",\"routerConfigId\":\"c-gone\"}")).indexOf("routerConfigId") >= 0);
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

  // `model_choices.router_id` is the only way anything names a router, so it is
  // the whole guard — and left unguarded it is the same break `configInUse`
  // catches one level up: the menu goes on offering "Auto", `chooseModel` goes
  // on accepting it, and `routeChoice` finds no row and answers on the agent's
  // own model for every user, for ever, behind a note nobody reads.
  expect(routerInUse(database, "rt-1").indexOf("menu choice") >= 0);
  expect(routerInUse(database, "rt-1").indexOf("repoint") >= 0);
  // The guard the other way round is unchanged and still answers.
  expect(configInUse(database, "c-fast").indexOf("router") >= 0);
  // Take the choice off the menu and the router is free to go.
  deleteById(database, modelChoicesMapping(), "ch-auto");
  expect(routerInUse(database, "rt-1") == "");
  expect(routerInUse(database, "rt-never-existed") == "");

  // A conversation still set to a menu row. This one does NOT hard-fail —
  // `chooseModel` answers "the agent's own" and writes a note for an id that
  // names nothing, deliberately, so a conversation never stops working because
  // a menu changed — and it is refused anyway, because the operator's actual
  // intent is "take this off the menu", `enabled` does exactly that without
  // stranding anything, and a DELETE is the only version of the intent that
  // silently changes what somebody else's next turn runs on.
  let fast: ModelChoiceRow = { id: "ch-fast", label: "Fast", description: "quickly",
    kind: "config", configId: "c-fast", routerId: "", tier: "", enabled: true, rank: 1 };
  persist(database, modelChoicesMapping(), JSON.stringify(fast));
  let hers = openThread(database, { agentId: "a1", owner: "u-alice", now: "1700000000000" });
  expect(rememberChoice(database, hers, "ch-fast") == "");
  let held = choiceInUse(database, "ch-fast");
  expect(held.indexOf("ch-fast") >= 0);
  // A refusal that does not say what to do next is a locked door.
  expect(held.indexOf("enabled") >= 0);
  // A row nobody is on deletes.
  expect(choiceInUse(database, "ch-auto") == "");

  // Runs are history and deliberately never block: a menu row that can never be
  // deleted once it has answered once is a table that only grows.
  recordRun(database, { agentId: "a1", threadId: "", owner: "", question: "hi",
    run: emptyRun("hi"), modelChoiceId: "ch-auto", routeNote: "" });
  expect(choiceInUse(database, "ch-auto") == "");
});

test("a country code is two ISO letters or nothing at all", () => {
  expect(geoCode("GB") == "GB");
  // The header arrives however the proxy cased it.
  expect(geoCode("tn") == "TN");
  expect(geoCode(" de ") == "DE");
  // Cloudflare's unknowns, a Tor exit, and free text are all "no place".
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
  // Not digested yet: the digest job fills it on its next pass.
  expect(feeds[0].digestedAt == "");
  // Junk never becomes a row, however it is spelled.
  ensureGeoFeed(database, "XX");
  ensureGeoFeed(database, "??");
  ensureGeoFeed(database, "England");
  expect(allFeeds(database).length == 1);
});

test("place feeds are capped, so a GET cannot mint rows forever", () => {
  fresh();
  // Fill to the cap with synthetic place feeds...
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
  // ...and the next reader's country is refused quietly.
  ensureGeoFeed(database, "QQ");
  expect(allFeeds(database).length == 40);
});

test("a thread id alone is not authorisation, and refusal is a 404", () => {
  fresh();
  let hers = threadFor("u-alice", "lyon");
  // Nine routes checked `threadAgent(...) == ""` and seven resolved the file
  // or the artifact straight out of its table, so a conversation id was the
  // whole of the authorisation to read, delete or publish somebody else's
  // upload. Both now answer the same "" — which every route reads as "thread
  // not found", never 403: a 403 confirms the id names something real.
  expect(ownedThread(database, hers, ["u-bob"]) == "");
  expect(ownedThread(database, "a-thread-that-never-existed", ["u-bob"]) == "");
  database.close();
});
