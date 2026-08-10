import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable } from "../plume/plume.ts";
import { storeCredential } from "./credentials.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, ScriptImageRow, McpServerRow, SkillRow, SkillFileRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, skillsMapping, skillFilesMapping, credentialsMapping, schemaPlan } from "./schema.ts";
import { Mounted, mountTools, toolSpecs, callMounted, serverOf, mountedIndex, agentServers, artifactTools, callArtifactTool, scriptTool, scriptTools, scriptEnvNames, jsonSafe, callScriptTool, SKILL_BRIEFING_LINES, agentSkills, skillTools, callSkillTool, skillBriefing, MountedTool, findTools, findToolsSpec, stillWaiting } from "./tools.ts";
import { userTokenKey } from "./connect.ts";
import { BRIEFING_LINES, artifactBriefing, artifactPlan, getArtifact, getVersion, putArtifact } from "./artifacts.ts";
import { envPlan, envDockerOverride } from "./environments.ts";
import { scriptProbeReset } from "./run-script.ts";
import { ToolSpec } from "./provider.ts";

let database: Db = sqlite();

function seeded(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_tools_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP TABLE IF EXISTS script_images");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  migrate(database, schemaPlan(database));

  let a: AgentRow = { id: "a1", agentName: "researcher", description: "d", modelConfigId: "c1", promptId: "p1", scriptImageId: "", isDefault: false, enabled: true, updatedAt: "t" };
  persist(database, agentsMapping(), JSON.stringify(a));
}

function server(id: string, name: string, transport: string, endpoint: string, enabled: bool): void {
  let s: McpServerRow = { id: id, serverName: name, transport: transport, endpoint: endpoint, authKind: "none", authHeader: "", enabled: enabled };
  persist(database, mcpServersMapping(), JSON.stringify(s));
}

function link(agentId: string, serverId: string): void {
  execute(database, "INSERT INTO agent_mcp_servers VALUES ('" + agentId + "','" + serverId + "')");
}

function skill(id: string, name: string, description: string, body: string): void {
  let k: SkillRow = { id: id, skillName: name, description: description, body: body, updatedAt: "t", visibility: "private", featuredRank: 0 , source: "local", sourceUrl: "" };
  persist(database, skillsMapping(), JSON.stringify(k));
}

function linkSkill(agentId: string, skillId: string): void {
  execute(database, "INSERT INTO agent_skills VALUES ('" + agentId + "','" + skillId + "')");
}

test("an agent with no servers has no tools and nothing to report", () => {
  seeded();
  let mounted = mountTools(database, "a1", "0123456789abcdef0123456789abcdef", "");
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
  let mounted = mountTools(database, "a1", "0123456789abcdef0123456789abcdef", "");
  expect(mounted.tools.length == 0);
  expect(mounted.problems.length == 1);
  expect(mounted.problems[0].indexOf("filesystem") >= 0);
  expect(mounted.problems[0].indexOf("disabled") >= 0);
});

test("a stdio server says what is missing, rather than failing to connect", () => {
  seeded();
  server("s1", "local-fs", "stdio", "mcp-fs", true);
  link("a1", "s1");
  let mounted = mountTools(database, "a1", "0123456789abcdef0123456789abcdef", "");
  expect(mounted.tools.length == 0);
  expect(mounted.problems[0].indexOf("subprocess") >= 0);
});

test("an unreachable server leaves the agent short a tool, and says so", () => {
  seeded();
  server("s1", "github", "http", "http://127.0.0.1:1", true);
  link("a1", "s1");
  let mounted = mountTools(database, "a1", "0123456789abcdef0123456789abcdef", "");
  expect(mounted.tools.length == 0);
  expect(mounted.problems.length == 1);
  expect(mounted.problems[0].indexOf("github") >= 0);
});

test("a tool the model invented is refused in words it can act on", () => {
  seeded();
  let mounted = mountTools(database, "a1", "0123456789abcdef0123456789abcdef", "");
  let answered = callMounted(mounted, "delete_everything", "{}");
  expect(!answered.ok);
  expect(answered.text.indexOf("delete_everything") >= 0);
  expect(answered.text.indexOf("no tool named") >= 0);
  expect(answered.error.indexOf("delete_everything") >= 0);
});

test("nothing is mounted, so nothing is described", () => {
  seeded();
  expect(toolSpecs(mountTools(database, "a1", "0123456789abcdef0123456789abcdef", "")).length == 0);
  expect(mountedIndex(mountTools(database, "a1", "0123456789abcdef0123456789abcdef", "").tools, "anything") < 0);
  expect(serverOf(mountTools(database, "a1", "0123456789abcdef0123456789abcdef", ""), "anything") == "");
});

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
    if (specs[i].name == name) {
      return i;
    }
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
    threadId: "t1", agentId: "", name: "edit_artifact",
    args: "{\"path\":\"/report.md\",\"old\":\"total: 40\",\"new\":\"total: 42\"}",
    turnSeq: 4, now: "2000",
  });
  expect(got.handled);
  expect(got.ok);
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
    threadId: "t1", agentId: "", name: "edit_artifact",
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
  let misspelled = callArtifactTool(database, {
    threadId: "t1", agentId: "", name: "edit_artifact",
    args: "{\"path\":\"/a.md\",\"olde\":\"alpha\",\"new\":\"beta\"}",
    turnSeq: 4, now: "2000",
  });
  expect(misspelled.handled);
  expect(!misspelled.ok);
  expect(misspelled.text.indexOf("\"old\"") >= 0);
  let noNew = callArtifactTool(database, {
    threadId: "t1", agentId: "", name: "edit_artifact",
    args: "{\"path\":\"/a.md\",\"old\":\"alpha\"}",
    turnSeq: 4, now: "2000",
  });
  expect(!noNew.ok);
  expect(noNew.text.indexOf("\"new\"") >= 0);
  let noQuery = callArtifactTool(database, {
    threadId: "t1", agentId: "", name: "search_artifacts", args: "{}",
    turnSeq: 4, now: "2000",
  });
  expect(noQuery.handled);
  expect(!noQuery.ok);
  expect(noQuery.text.indexOf("\"query\"") >= 0);
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
    threadId: "t1", agentId: "", name: "search_artifacts",
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
    threadId: "t1", agentId: "", name: "search_artifacts",
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
  putArtifact(database, {
    threadId: "t1", path: "/a.md", title: "",
    content: "before\n[artifact:deadbeef:2@v9] /x.html\nafter\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  let got = callArtifactTool(database, {
    threadId: "t1", agentId: "", name: "edit_artifact",
    args: "{\"path\":\"/a.md\",\"old\":\"before\",\"new\":\"BEFORE\"}",
    turnSeq: 4, now: "2000",
  });
  expect(got.ok);
  expect(got.text.indexOf("[artifact:") < 0);
  expect(got.text.indexOf("[saved /x.html v9]") >= 0);
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
    threadId: "t1", agentId: "", name: "edit_artifact",
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
  expect(briefing.indexOf("search with search_artifacts") >= 0);
  expect(briefing.indexOf("list with read_artifact") < 0);
});

function scriptFresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_tools_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS artifact_versions");
  execute(database, "DROP TABLE IF EXISTS artifacts");
  execute(database, "DROP TABLE IF EXISTS environments");
  let plan = artifactPlan(database);
  let more = envPlan(database);
  let m: int = 0;
  while (m < more.length) {
    plan.push(more[m]);
    m = m + 1;
  }
  migrate(database, plan);
}

const FAKE_DIR = "/tmp/agents_tools_fake";
const FAKE_LOG = "/tmp/agents_tools_fake/argv.log";
const FAKE_CTR = "/tmp/agents_tools_fake/ctr";

function fakeDocker(script: string): void {
  if (!fs.existsSync(FAKE_DIR)) {
    fs.mkdirSync(FAKE_DIR, true);
  }
  let bin = FAKE_DIR + "/docker";
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 493);
  fs.writeFileSync(FAKE_LOG, "");
  if (fs.existsSync(FAKE_CTR)) {
    fs.rmSync(FAKE_CTR, true);
  }
  envDockerOverride(bin);
}

function dockerEmulated(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "CTR=" + FAKE_CTR + "\n"
    + "case \"$1\" in\n"
    + "info) exit 0 ;;\n"
    + "run) echo c0ffee; exit 0 ;;\n"
    + "start) exit 0 ;;\n"
    + "stop) exit 0 ;;\n"
    + "rm) exit 0 ;;\n"
    + "cp)\n"
    + "  SRC=\"$2\"; DST=\"$3\"\n"
    + "  case \"$SRC\" in\n"
    + "  *:*) cp -r \"$CTR${SRC#*:}\" \"$DST\" || exit 1 ;;\n"
    + "  *) P=\"$CTR${DST#*:}\"; mkdir -p \"$(dirname \"$P\")\" && cp -r \"$SRC\" \"$P\" || exit 1 ;;\n"
    + "  esac\n"
    + "  exit 0 ;;\n"
    + "exec)\n"
    + "  shift\n"
    + "  WD=/\n"
    + "  while true; do\n"
    + "    case \"$1\" in\n"
    + "    --user) shift 2 ;;\n"
    + "    --workdir) WD=\"$2\"; shift 2 ;;\n"
    + "    -e) shift 2 ;;\n"
    + "    *) break ;;\n"
    + "    esac\n"
    + "  done\n"
    + "  shift\n"
    + "  case \"$1\" in\n"
    + "  chown) exit 0 ;;\n"
    + "  rm) exit 0 ;;\n"
    + "  timeout)\n"
    + "    cd \"$CTR$WD\" || exit 1\n"
    + "    timeout -k \"$3\" \"$4\" \"$5\" \"$CTR$6\"\n"
    + "    exit $? ;;\n"
    + "  esac\n"
    + "  exit 0 ;;\n"
    + "esac\n"
    + "exit 0\n");
}

test("run_script is offered only where docker answers, and not offered at all otherwise", () => {
  dockerEmulated();
  scriptProbeReset();
  let offered = scriptTools(database);
  expect(offered.length == 1);
  expect(offered[0].name == "run_script");
  fakeDocker("#!/bin/sh\nexit 1\n");
  scriptProbeReset();
  expect(scriptTools(database).length == 0);
  scriptProbeReset();
});

test("the tool names the environments an operator enabled", () => {
  seeded();
  let img: ScriptImageRow = { id: "img-search", label: "Search", image: "agents-search:1", enabled: true, summary: "python, playwright, ddg and bing fallbacks" };
  persist(database, scriptImagesMapping(), JSON.stringify(img));
  let off: ScriptImageRow = { id: "img-old", label: "Retired", image: "old:1", enabled: false, summary: "" };
  persist(database, scriptImagesMapping(), JSON.stringify(off));

  let names = scriptEnvNames(database);
  expect(names.length == 1);
  expect(names[0] == "search (python, playwright, ddg and bing fallbacks)");

  let spec = scriptTool(names);
  expect(spec.schema.indexOf("search") >= 0);
  expect(spec.schema.indexOf("playwright") >= 0);
});

test("a quote in an operator's summary cannot break the request body", () => {
  seeded();
  let img: ScriptImageRow = { id: "img-q", label: "office", image: "x:1", enabled: true,
    summary: "run fill-docx in.docx out.docx '{\"<KEY>\":\"value\"}' first" };
  persist(database, scriptImagesMapping(), JSON.stringify(img));
  let spec = scriptTool(scriptEnvNames(database));
  let back: ToolSpec = JSON.parse<ToolSpec>("{\"name\":\"x\",\"description\":\"y\",\"schema\":"
    + JSON.stringify(spec.schema) + "}");
  expect(back.schema.length > 0);
  expect(jsonSafe("a \" b").indexOf("\\") >= 0);
});

test("the tool tells the model what only telling can teach", () => {
  let none: string[] = [];
  let spec = scriptTool(none);
  expect(spec.name == "run_script");
  expect(spec.description.indexOf("persists between runs") >= 0);
  expect(spec.description.indexOf("pip install and npm install work") >= 0);
  expect(spec.description.indexOf("bytes of UTF-8") >= 0);
  expect(spec.description.indexOf("nothing is ever deleted") >= 0);
  expect(spec.schema.indexOf("mayCreate") >= 0);
  expect(spec.schema.indexOf("environment") >= 0);
});

test("run_script's missing members are refused by name", () => {
  scriptFresh();
  let noLanguage = callScriptTool(database, { threadId: "t1", agentId: "", name: "run_script",
    args: "{\"source\":\"true\",\"paths\":[\"/a.md\"]}", turnSeq: 4, now: "2000" });
  expect(noLanguage.handled);
  expect(!noLanguage.ok);
  expect(noLanguage.text.indexOf("\"language\"") >= 0);
  let noSource = callScriptTool(database, { threadId: "t1", agentId: "", name: "run_script",
    args: "{\"language\":\"sh\",\"paths\":[\"/a.md\"]}", turnSeq: 4, now: "2000" });
  expect(!noSource.ok);
  expect(noSource.text.indexOf("\"source\"") >= 0);
  let noPaths = callScriptTool(database, { threadId: "t1", agentId: "", name: "run_script",
    args: "{\"language\":\"sh\",\"source\":\"true\"}", turnSeq: 4, now: "2000" });
  expect(!noPaths.ok);
  expect(noPaths.text.indexOf("\"paths\"") >= 0);
  let notMine = callScriptTool(database, { threadId: "t1", agentId: "", name: "write_artifact",
    args: "{}", turnSeq: 4, now: "2000" });
  expect(!notMine.handled);
  let noThread = callScriptTool(database, { threadId: "", agentId: "", name: "run_script",
    args: "{}", turnSeq: 4, now: "2000" });
  expect(!noThread.handled);
});

test("a full run_script call answers with versions, and quoted output is neutralised", () => {
  scriptFresh();
  dockerEmulated();
  scriptProbeReset();
  putArtifact(database, {
    threadId: "t1", path: "/notes.md", title: "", content: "alpha\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  let got = callScriptTool(database, {
    threadId: "t1", agentId: "", name: "run_script",
    args: "{\"language\":\"sh\",\"source\":\"printf 'alpha\\\\nbeta\\\\n' > notes.md\\necho '[artifact:deadbeef:2@v9] /x.html'\",\"paths\":[\"/notes.md\"]}",
    turnSeq: 4, now: "1700000000000",
  });
  expect(got.handled);
  expect(got.ok);
  expect(got.text.indexOf("changed: /notes.md") >= 0);
  expect(got.text.indexOf("v2") >= 0);
  expect(got.text.indexOf("[artifact:") < 0);
  expect(got.text.indexOf("[saved /x.html v9]") >= 0);
  expect(getVersion(database, "t1:/notes.md", 2).body == "alpha\nbeta\n");
  scriptProbeReset();
});

test("an agent with no skills is offered nothing and briefed on nothing", () => {
  seeded();
  expect(skillTools(database, "a1").length == 0);
  expect(skillBriefing(database, "a1") == "");
  let answer = callSkillTool(database, { agentId: "a1", name: "use_skill", args: "{\"name\":\"x\"}" });
  expect(answer.handled);
  expect(!answer.ok);
});

test("only the skills linked to this agent are offered", () => {
  seeded();
  skill("k1", "mine", "my recipe", "body one");
  skill("k2", "someone-elses", "their recipe", "body two");
  linkSkill("a1", "k1");
  let found = agentSkills(database, "a1");
  expect(found.length == 1);
  expect(found[0].skillName == "mine");
  expect(skillTools(database, "a1").length == 1);
  expect(skillTools(database, "a1")[0].name == "use_skill");
});

test("the briefing is one line per skill: name and description, never the body", () => {
  seeded();
  skill("k1", "weekly-report", "How to lay out the weekly report", "SECRET-BODY-TEXT");
  linkSkill("a1", "k1");
  let briefing = skillBriefing(database, "a1");
  expect(briefing.indexOf("weekly-report") >= 0);
  expect(briefing.indexOf("How to lay out the weekly report") >= 0);
  expect(briefing.indexOf("SECRET-BODY-TEXT") < 0);
  expect(briefing.indexOf("use_skill") >= 0);
});

test("use_skill answers the body whole, as the tool result", () => {
  seeded();
  skill("k1", "weekly-report", "layout", "# Weekly\nLead with the number.");
  linkSkill("a1", "k1");
  let answer = callSkillTool(database, { agentId: "a1", name: "use_skill", args: "{\"name\":\"weekly-report\"}" });
  expect(answer.handled);
  expect(answer.ok);
  expect(answer.text == "# Weekly\nLead with the number.");
});

test("a skill that ships files says so, naming them and where they land", () => {
  seeded();
  skill("k1", "read-proto-enums", "compute enum values", "Run the script.");
  linkSkill("a1", "k1");
  let f: SkillFileRow = { id: "f1", skillId: "k1", path: "enums.py", body: "print('hi')" };
  persist(database, skillFilesMapping(), JSON.stringify(f));
  let answer = callSkillTool(database, { agentId: "a1", name: "use_skill", args: "{\"name\":\"read-proto-enums\"}" });
  expect(answer.ok);
  expect(answer.text.indexOf("Run the script.") == 0);
  expect(answer.text.indexOf("/skills/read-proto-enums/") > 0);
  expect(answer.text.indexOf("enums.py") > 0);
  expect(answer.text.indexOf("print('hi')") < 0);
});

test("a skill the model invented is refused in words it can act on", () => {
  seeded();
  skill("k1", "read-proto-enums", "compute enum values", "body");
  linkSkill("a1", "k1");
  let answer = callSkillTool(database, { agentId: "a1", name: "use_skill", args: "{\"name\":\"proto-enums\"}" });
  expect(answer.handled);
  expect(!answer.ok);
  expect(answer.text.indexOf("proto-enums") >= 0);
  expect(answer.text.indexOf("read-proto-enums") >= 0);
  expect(answer.text.indexOf("exactly") >= 0);
});

test("a missing \"name\" member is refused by name, not as an empty value", () => {
  seeded();
  skill("k1", "mine", "d", "b");
  linkSkill("a1", "k1");
  let empty = callSkillTool(database, { agentId: "a1", name: "use_skill", args: "{}" });
  expect(empty.handled);
  expect(!empty.ok);
  expect(empty.text.indexOf("member named \"name\"") >= 0);
  let misspelled = callSkillTool(database, { agentId: "a1", name: "use_skill", args: "{\"nam\":\"mine\"}" });
  expect(!misspelled.ok);
  expect(misspelled.text.indexOf("member named \"name\"") >= 0);
  expect(!callSkillTool(database, { agentId: "a1", name: "read_file", args: "{}" }).handled);
  expect(!callSkillTool(database, { agentId: "", name: "use_skill", args: "{}" }).handled);
});

test("past the cap, the overflow lists names only, and every skill still loads", () => {
  seeded();
  let i: int = 0;
  while (i < SKILL_BRIEFING_LINES + 2) {
    let pad = i < 10 ? "0" + `${i}` : `${i}`;
    skill("k" + pad, "skill-" + pad, "description " + pad, "body " + pad);
    linkSkill("a1", "k" + pad);
    i = i + 1;
  }
  let briefing = skillBriefing(database, "a1");
  expect(briefing.indexOf("skill-51") >= 0);
  expect(briefing.indexOf("description 51") < 0);
  expect(briefing.indexOf("description 49") >= 0);
  expect(briefing.indexOf("one line each was too many") >= 0);
  let answer = callSkillTool(database, { agentId: "a1", name: "use_skill", args: "{\"name\":\"skill-51\"}" });
  expect(answer.ok);
  expect(answer.text == "body 51");
});

test("editing a skill row is visible to the next use_skill, with nothing reloaded", () => {
  seeded();
  skill("k1", "mine", "d", "old body");
  linkSkill("a1", "k1");
  expect(callSkillTool(database, { agentId: "a1", name: "use_skill", args: "{\"name\":\"mine\"}" }).text == "old body");
  skill("k1", "mine", "d", "new body");
  expect(callSkillTool(database, { agentId: "a1", name: "use_skill", args: "{\"name\":\"mine\"}" }).text == "new body");
});

test("a person's own token outranks the deployment's, and absence falls back", () => {
  seeded();
  let s: McpServerRow = { id: "s9", serverName: "gh", transport: "http", endpoint: "https://mcp.example/mcp", authKind: "bearer", authHeader: "", enabled: true };
  persist(database, mcpServersMapping(), JSON.stringify(s));
  link("a1", "s9");
  let master = "0123456789abcdef0123456789abcdef";
  storeCredential(database, { provider: "mcp:s9", apiKey: "shared-pat", masterKey: master, now: "t" });
  storeCredential(database, { provider: userTokenKey("s9", "u-ana"), apiKey: "anas-pat", masterKey: master, now: "t" });

  expect(mountTools(database, "a1", master, "u-ana").tokens[0] == "anas-pat");
  expect(mountTools(database, "a1", master, "u-ben").tokens[0] == "shared-pat");
  expect(mountTools(database, "a1", master, "").tokens[0] == "shared-pat");
});

test("a skill called by its own name is a use_skill call", () => {
  seeded();
  skill("k9", "search-web", "search the web", "Run websearch.py.");
  execute(database, "INSERT INTO agent_skills VALUES ('a1','k9')");

  let direct = callSkillTool(database, { agentId: "a1", name: "search_web", args: "{\"query\":\"x\"}" });
  expect(direct.handled);
  expect(direct.ok);
  expect(direct.text.indexOf("websearch.py") >= 0);

  let made_up = callSkillTool(database, { agentId: "a1", name: "browse_internet", args: "{}" });
  expect(!made_up.handled);
});

test("a text edit on a binary document is refused with the route to the right tool", () => {
  seeded();
  let call: ArtifactToolCall = { threadId: "t1", agentId: "a1", name: "edit_artifact",
    args: "{\"path\":\"/meeting-notes.docx\",\"old\":\"<DATE>\",\"new\":\"2 August\"}",
    turnSeq: 0, now: "t" };
  let out = callArtifactTool(database, call);
  expect(out.handled);
  expect(!out.ok);
  expect(out.text.indexOf("binary") >= 0);
  expect(out.text.indexOf("make-doc") >= 0);
});

test("the suite leaves nothing behind", () => {
  seeded();
  expect(dropTable(database, agentsMapping()).ok);
  database.close();
});

function waiting(names: string[]): Mounted {
  let deferred: MountedTool[] = [];
  let i: int = 0;
  while (i < names.length) {
    let t: MountedTool = { name: names[i], description: "Does " + names[i] + " things.", schema: "{}", server: 0 };
    deferred.push(t);
    i = i + 1;
  }
  let servers: McpServerRow[] = [{ id: "s1", serverName: "linear", transport: "http", endpoint: "https://mcp.linear.app/mcp", authKind: "oauth", authHeader: "", enabled: true }];
  let m: Mounted = { tools: [], servers: servers, tokens: [""], problems: [], deferred: deferred };
  return m;
}

test("a search by intent finds the tool, not only an exact name", () => {
  let got = findTools(waiting(["list_issues", "get_team", "save_document"]), "list the issues", 8);
  expect(got.found.length == 1);
  expect(got.found[0].name == "list_issues");
  expect(got.mounted.tools.length == 1);
});

test("a short word does not match everything", () => {
  let got = findTools(waiting(["list_issues", "get_team"]), "of", 8);
  expect(got.found.length == 0);
});

test("the cap holds, so one broad query cannot undo the deferring", () => {
  let many: string[] = [];
  let i: int = 0;
  while (i < 30) {
    many.push("issue_tool_" + `${i}`);
    i = i + 1;
  }
  let got = findTools(waiting(many), "issue", 8);
  expect(got.found.length == 8);
});

test("asking twice does not mount the same tool twice", () => {
  let once = findTools(waiting(["list_issues", "get_issue"]), "issues", 8);
  expect(once.found.length == 1);
  let twice = findTools(once.mounted, "issues", 8);
  expect(twice.found.length == 0);
  expect(twice.mounted.tools.length == 1);
});

test("what is still waiting is counted after what has been taken", () => {
  let m = waiting(["list_issues", "get_issue", "save_document"]);
  expect(stillWaiting(m) == 3);
  let got = findTools(m, "issues", 8);
  expect(stillWaiting(got.mounted) == 2);
  let more = findTools(got.mounted, "issue", 8);
  expect(more.found.length == 1);
  expect(stillWaiting(more.mounted) == 1);
});

test("find_tools names the connectors, not just a number", () => {
  let spec = findToolsSpec(waiting(["list_issues", "get_issue"]));
  expect(spec.description.indexOf("linear") > 0);
  expect(spec.name == "find_tools");
});

test("an exact name beats a passing mention", () => {
  let m = waiting(["list_agent_skills", "list_comments", "list_cycles", "list_teams"]);
  let got = findTools(m, "teams", 2);
  expect(got.found.length == 1);
  expect(got.found[0].name == "list_teams");

  let all = findTools(waiting(["list_comments", "list_teams"]), "list teams", 2);
  expect(all.found[0].name == "list_teams");
});
