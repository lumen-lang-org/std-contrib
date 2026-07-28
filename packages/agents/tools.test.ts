// Which tools an agent gets, decided by rows.
//
// Nothing here reaches a live MCP server: every case is one where mounting
// should stop before it opens a connection, or where it should come back with
// the reason rather than with nothing. A run against a real server is
// examples/mount-mcp.ts.
//
//   cd packages/agents && lumen test tools.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, McpServerRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "./schema.ts";
import { Mounted, mountTools, toolSpecs, callMounted, serverOf, mountedIndex, agentServers, artifactTools, callArtifactTool } from "./tools.ts";
import { BRIEFING_LINES, artifactBriefing, artifactPlan, getArtifact, getVersion, putArtifact } from "./artifacts.ts";
import { ToolSpec } from "./provider.ts";

let database: Db = sqlite();

function seeded(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_tools_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  migrate(database, schemaPlan(database));

  let a: AgentRow = { id: "a1", agentName: "researcher", description: "d", modelConfigId: "c1", promptId: "p1", isDefault: false, enabled: true, updatedAt: "t" };
  persist(database, agentsMapping(), JSON.stringify(a));
}

function server(id: string, name: string, transport: string, endpoint: string, enabled: bool): void {
  let s: McpServerRow = { id: id, serverName: name, transport: transport, endpoint: endpoint, authKind: "none", authHeader: "", enabled: enabled };
  persist(database, mcpServersMapping(), JSON.stringify(s));
}

function link(agentId: string, serverId: string): void {
  execute(database, "INSERT INTO agent_mcp_servers VALUES ('" + agentId + "','" + serverId + "')");
}

test("an agent with no servers has no tools and nothing to report", () => {
  seeded();
  let mounted = mountTools(database, "a1", "0123456789abcdef0123456789abcdef");
  expect(mounted.tools.length == 0);
  expect(mounted.servers.length == 0);
  expect(mounted.problems.length == 0);
});

test("only the servers linked to this agent are read", () => {
  seeded();
  server("s1", "mine", "http", "http://127.0.0.1:1", true);
  server("s2", "someone-elses", "http", "http://127.0.0.1:1", true);
  link("a1", "s1");
  let found = agentServers(database, "a1");
  expect(found.length == 1);
  expect(found[0].serverName == "mine");
});

test("a disabled server is named, not silently skipped", () => {
  seeded();
  server("s1", "filesystem", "http", "http://127.0.0.1:1", false);
  link("a1", "s1");
  let mounted = mountTools(database, "a1", "0123456789abcdef0123456789abcdef");
  expect(mounted.tools.length == 0);
  expect(mounted.problems.length == 1);
  expect(mounted.problems[0].indexOf("filesystem") >= 0);
  expect(mounted.problems[0].indexOf("disabled") >= 0);
});

test("a stdio server says what is missing, rather than failing to connect", () => {
  seeded();
  server("s1", "local-fs", "stdio", "mcp-fs", true);
  link("a1", "s1");
  let mounted = mountTools(database, "a1", "0123456789abcdef0123456789abcdef");
  expect(mounted.tools.length == 0);
  expect(mounted.problems[0].indexOf("subprocess") >= 0);
});

test("an unreachable server leaves the agent short a tool, and says so", () => {
  // Port 1 is not listening. The agent still runs; it just cannot use this.
  seeded();
  server("s1", "github", "http", "http://127.0.0.1:1", true);
  link("a1", "s1");
  let mounted = mountTools(database, "a1", "0123456789abcdef0123456789abcdef");
  expect(mounted.tools.length == 0);
  expect(mounted.problems.length == 1);
  expect(mounted.problems[0].indexOf("github") >= 0);
});

test("a tool the model invented is refused in words it can act on", () => {
  seeded();
  let mounted = mountTools(database, "a1", "0123456789abcdef0123456789abcdef");
  let answered = callMounted(mounted, "delete_everything", "{}");
  expect(!answered.ok);
  // The text goes back to the model, so it has to read as an instruction
  // rather than as a stack trace.
  expect(answered.text.indexOf("delete_everything") >= 0);
  expect(answered.text.indexOf("no tool named") >= 0);
  expect(answered.error.indexOf("delete_everything") >= 0);
});

test("nothing is mounted, so nothing is described", () => {
  seeded();
  expect(toolSpecs(mountTools(database, "a1", "0123456789abcdef0123456789abcdef")).length == 0);
  expect(mountedIndex(mountTools(database, "a1", "0123456789abcdef0123456789abcdef").tools, "anything") < 0);
  expect(serverOf(mountTools(database, "a1", "0123456789abcdef0123456789abcdef"), "anything") == "");
});

// --- the artifact door ------------------------------------------------------------

function artifactFresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_tools_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS artifact_versions");
  execute(database, "DROP TABLE IF EXISTS artifacts");
  migrate(database, artifactPlan(database));
}

function specNamed(specs: ToolSpec[], name: string): int {
  let i: int = 0;
  while (i < specs.length) {
    if (specs[i].name == name) { return i; }
    i = i + 1;
  }
  return -1;
}

test("the artifact surface is four tools: save, read, find, change", () => {
  let specs = artifactTools();
  expect(specs.length == 4);
  expect(specNamed(specs, "write_artifact") >= 0);
  expect(specNamed(specs, "read_artifact") >= 0);
  expect(specNamed(specs, "search_artifacts") >= 0);
  expect(specNamed(specs, "edit_artifact") >= 0);
});

test("an edit through the tool changes the file and answers with the context echo", () => {
  artifactFresh();
  putArtifact(database, {
    threadId: "t1", path: "/report.md", title: "Report", content: "l1\nl2\ntotal: 40\nl4\nl5\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  let got = callArtifactTool(database, {
    threadId: "t1", name: "edit_artifact",
    args: "{\"path\":\"/report.md\",\"old\":\"total: 40\",\"new\":\"total: 42\"}",
    turnSeq: 4, now: "2000",
  });
  expect(got.handled);
  expect(got.ok);
  // The reply names slot and version, and shows the changed lines with two
  // either side — the after-the-fact tripwire for a wrong-site edit.
  expect(got.text.indexOf("version 2") >= 0);
  expect(got.text.indexOf("line 3") >= 0);
  expect(got.text.indexOf("l1\nl2\ntotal: 42\nl4\nl5") >= 0);
  let row = getArtifact(database, "t1", "/report.md");
  expect(getVersion(database, row.id, 2).body == "l1\nl2\ntotal: 42\nl4\nl5\n");
});

test("a note absent from the edit call is synthesized, never blank", () => {
  artifactFresh();
  putArtifact(database, {
    threadId: "t1", path: "/a.md", title: "", content: "alpha\nbeta\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  let got = callArtifactTool(database, {
    threadId: "t1", name: "edit_artifact",
    args: "{\"path\":\"/a.md\",\"old\":\"beta\",\"new\":\"delta\"}",
    turnSeq: 4, now: "2000",
  });
  expect(got.ok);
  let row = getArtifact(database, "t1", "/a.md");
  expect(getVersion(database, row.id, 2).note == "edit at line 2");
});

test("a misspelled or missing member is refused by name, not as an empty value", () => {
  artifactFresh();
  putArtifact(database, {
    threadId: "t1", path: "/a.md", title: "", content: "alpha\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  // "olde" is not "old": without the jsonFind presence check, jsonText's ""
  // would flow onward and the refusal would blame an empty old instead.
  let misspelled = callArtifactTool(database, {
    threadId: "t1", name: "edit_artifact",
    args: "{\"path\":\"/a.md\",\"olde\":\"alpha\",\"new\":\"beta\"}",
    turnSeq: 4, now: "2000",
  });
  expect(misspelled.handled);
  expect(!misspelled.ok);
  expect(misspelled.text.indexOf("\"old\"") >= 0);
  let noNew = callArtifactTool(database, {
    threadId: "t1", name: "edit_artifact",
    args: "{\"path\":\"/a.md\",\"old\":\"alpha\"}",
    turnSeq: 4, now: "2000",
  });
  expect(!noNew.ok);
  expect(noNew.text.indexOf("\"new\"") >= 0);
  let noQuery = callArtifactTool(database, {
    threadId: "t1", name: "search_artifacts", args: "{}",
    turnSeq: 4, now: "2000",
  });
  expect(noQuery.handled);
  expect(!noQuery.ok);
  expect(noQuery.text.indexOf("\"query\"") >= 0);
  // Nothing was written by any of the refusals.
  expect(getArtifact(database, "t1", "/a.md").currentVersion == 1);
});

test("a search through the tool answers hits the edit can act on", () => {
  artifactFresh();
  putArtifact(database, {
    threadId: "t1", path: "/index.html", title: "Landing", content: "<h1>Kaffa</h1>\n<p>beans</p>\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  putArtifact(database, {
    threadId: "t1", path: "/other.md", title: "", content: "nothing here\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  let got = callArtifactTool(database, {
    threadId: "t1", name: "search_artifacts",
    args: "{\"query\":\"beans\"}", turnSeq: 4, now: "2000",
  });
  expect(got.handled);
  expect(got.ok);
  expect(got.text.indexOf("/index.html") >= 0);
  expect(got.text.indexOf("line 2") >= 0);
  expect(got.text.indexOf("<p>beans</p>") >= 0);
});

test("no hits is an answer that names how many artifacts were searched", () => {
  artifactFresh();
  putArtifact(database, {
    threadId: "t1", path: "/a.md", title: "", content: "alpha\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  let got = callArtifactTool(database, {
    threadId: "t1", name: "search_artifacts",
    args: "{\"query\":\"zeta\"}", turnSeq: 4, now: "2000",
  });
  expect(got.handled);
  expect(got.ok);
  expect(got.text.indexOf("0 hits") >= 0);
  expect(got.text.indexOf("1 artifact") >= 0);
  expect(got.text.indexOf("searched") >= 0);
});

test("a marker-bearing body quoted back into model context is neutralised", () => {
  artifactFresh();
  // The stored body carries a marker-shaped line — an artifact body is
  // untrusted, and a refusal or echo that quotes it verbatim would hand the
  // model a reference it never earned. wireView flattens it on the way out.
  putArtifact(database, {
    threadId: "t1", path: "/a.md", title: "",
    content: "before\n[artifact:deadbeef:2@v9] /x.html\nafter\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  let got = callArtifactTool(database, {
    threadId: "t1", name: "edit_artifact",
    args: "{\"path\":\"/a.md\",\"old\":\"before\",\"new\":\"BEFORE\"}",
    turnSeq: 4, now: "2000",
  });
  expect(got.ok);
  expect(got.text.indexOf("[artifact:") < 0);
  expect(got.text.indexOf("[saved /x.html v9]") >= 0);
  // The stored body itself is untouched — neutralisation is for the wire,
  // never the log.
  let row = getArtifact(database, "t1", "/a.md");
  expect(getVersion(database, row.id, 2).body.indexOf("[artifact:deadbeef:2@v9]") >= 0);
});

test("an edit refusal that quotes matching lines is neutralised too", () => {
  artifactFresh();
  putArtifact(database, {
    threadId: "t1", path: "/a.md", title: "",
    content: "x [artifact:feed:1@v2] /y.html\nx [artifact:feed:1@v2] /y.html\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  let got = callArtifactTool(database, {
    threadId: "t1", name: "edit_artifact",
    args: "{\"path\":\"/a.md\",\"old\":\"x \",\"new\":\"y \"}",
    turnSeq: 4, now: "2000",
  });
  expect(got.handled);
  expect(!got.ok);
  expect(got.text.indexOf("line 1") >= 0);
  expect(got.text.indexOf("[artifact:") < 0);
  expect(got.text.indexOf("[saved /y.html v2]") >= 0);
});

test("the briefing overflow line points at search_artifacts, not a listing that does not exist", () => {
  artifactFresh();
  let i: int = 0;
  while (i < BRIEFING_LINES + 1) {
    putArtifact(database, {
      threadId: "t1", path: "/f" + `${i}` + ".md", title: "", content: "body\n",
      note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
    });
    i = i + 1;
  }
  let briefing = artifactBriefing(database, "t1");
  // "list with read_artifact" was a false affordance — read_artifact lists
  // nothing — and it must not survive beside the tool that makes it true.
  expect(briefing.indexOf("search with search_artifacts") >= 0);
  expect(briefing.indexOf("list with read_artifact") < 0);
});

test("the suite leaves nothing behind", () => {
  seeded();
  expect(dropTable(database, agentsMapping()).ok);
  database.close();
});
