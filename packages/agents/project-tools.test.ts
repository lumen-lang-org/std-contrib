import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, createTableSql, execute } from "../plume/plume.ts";
import { ProjectToolCall, callProjectTool, projectTools } from "./project-tools.ts";
import { assignProject, projectsMapping } from "./projects.ts";

// A real sqlite file, the same way workflow-cap.test.ts opens one: threads and
// projects, without the rest of the production schema neither tool touches.
let database: Db = sqlite();
let opened = false;

function fresh(): Db {
  if (!opened) {
    let file = "/tmp/agents_project_tools_test.db";
    let cfg: DbConfig = { filename: file };
    connectDatabase(database, cfg);
    opened = true;
  }
  execute(database, "DROP TABLE IF EXISTS projects");
  execute(database, "DROP TABLE IF EXISTS threads");
  execute(database, createTableSql(database, projectsMapping()));
  execute(database, "CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '')");
  return database;
}

function call(name: string, threadId: string, args: string): ProjectToolCall {
  let ask: ProjectToolCall = {
    owner: "u-ann", threadId: threadId, name: name, args: args, nowMs: 1787000000000.0,
  };
  return ask;
}

test("the family names the four verbs it answers to", () => {
  let names = projectTools().map<string>((t) => t.name);
  expect(names.join(",") == "list_projects,create_project,move_to_project,leave_project");
});

test("leaving a conversation that was never in a project says so, and changes nothing", () => {
  let db = fresh();
  execute(db, "INSERT INTO threads (id, project_id) VALUES ('t1', '')");
  let said = callProjectTool(db, call("leave_project", "t1", "{}"));
  expect(said.ok);
  expect(said.text.indexOf("not in a project") >= 0);
});

test("a conversation moved into a project can be taken back out of it", () => {
  let db = fresh();
  execute(db, "INSERT INTO threads (id, project_id) VALUES ('t1', '')");
  let made = callProjectTool(db, call("create_project", "t1",
    "{\"name\":\"Ledger\",\"instructions\":\"Answer in one paragraph.\"}"));
  expect(made.ok);

  let moved = callProjectTool(db, call("move_to_project", "t1", "{\"project\":\"Ledger\"}"));
  expect(moved.ok);
  db.query("SELECT project_id FROM threads WHERE id = 't1'", []);
  let holding = db.value(0, 0);
  expect(holding != "");

  let left = callProjectTool(db, call("leave_project", "t1", "{}"));
  expect(left.ok);
  expect(left.text.indexOf("Ledger") >= 0);
  db.query("SELECT project_id FROM threads WHERE id = 't1'", []);
  expect(db.value(0, 0) == "");

  // The project itself, and its instructions, are untouched — only the
  // conversation's own link to it is gone.
  let listed = callProjectTool(db, call("list_projects", "t1", "{}"));
  expect(listed.text.indexOf("Ledger") >= 0);
});

test("leaving needs a conversation to leave", () => {
  let db = fresh();
  let said = callProjectTool(db, call("leave_project", "", "{}"));
  expect(!said.ok);
  expect(said.text.indexOf("no conversation to move") >= 0);
});

test("leaving somebody else's conversation is not this tool's to decide", () => {
  let db = fresh();
  execute(db, "INSERT INTO threads (id, project_id) VALUES ('t1', 'p-other')");
  // assignProject itself does not check ownership — the guard is the caller
  // always being told which thread THEY are in, never somebody else's id.
  let fault = assignProject(db, "t1", "");
  expect(fault == "");
});
