// Relations: a related row, or rows, fetched with the record that points at
// them. Not a join — each relation is a correlated subquery producing its own
// JSON, nested inside the parent document by the database.
//
// The same suite as relations.test.ts, against MySQL and MariaDB.
//
//   cd packages/plume && lumen test relations_mysql.test.ts

import { Db, DbConfig } from "./driver.ts";
import { mysql } from "./mysql.ts";
import { DbField, DbRelation, DbRepository, field, repository, repositoryWith, hasOne, hasMany, relationValid, connectDatabase, createTable, dropTable, persist, findById, listWhere, countWhere } from "./plume.ts";

let database: Db = mysql();

type Team = { id: string, teamName: string };
type Task = { id: string, agentId: string, title: string };
type AgentRow = { id: string, agentName: string, teamId: string };

// What comes back once the relations are attached.
type AgentDeep = {
  id: string,
  agentName: string,
  teamId: string,
  team: Team,
  tasks: Task[],
};

function connectionConfig(): DbConfig {
  // An env override arrives as a key=value target; `options` takes it whole,
  // which is the escape hatch a config keeps for a target the fields cannot
  // describe.
  let fromEnv = process.env("PLUME_MYSQL_CONNINFO") ?? "";
  if (fromEnv != "") { let raw: DbConfig = { options: fromEnv }; return raw; }
  let named: DbConfig = { host: "127.0.0.1", port: 13306, database: "lumentest", user: "root", password: "lumen" };
  return named;
}

function teamsRepo(): DbRepository {
  let fs: DbField[] = [ field("id", "id", "text"), field("teamName", "team_name", "text") ];
  return repository("rel_teams", "id", "id", fs);
}

function tasksRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentId", "agent_id", "text"),
    field("title", "title", "text"),
  ];
  return repository("rel_tasks", "id", "id", fs);
}

function agentsRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("teamId", "team_id", "text"),
  ];
  let rs: DbRelation[] = [
    hasOne("team", "rel_teams", "team_id", "id", "id, team_name AS \"teamName\""),
    hasMany("tasks", "rel_tasks", "id", "agent_id", "id, agent_id AS \"agentId\", title"),
  ];
  return repositoryWith("rel_agents", "id", "id", fs, rs);
}

// The same mapping without relations, to show they are what changed.
function agentsFlat(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("teamId", "team_id", "text"),
  ];
  return repository("rel_agents", "id", "id", fs);
}

function seeded(): DbRepository {
  connectDatabase(database, connectionConfig());
  dropTable(database, agentsRepo());
  dropTable(database, teamsRepo());
  dropTable(database, tasksRepo());
  createTable(database, teamsRepo());
  createTable(database, tasksRepo());
  createTable(database, agentsFlat());

  let t: Team = { id: "t1", teamName: "research" };
  persist(database, teamsRepo(), JSON.stringify(t));
  let a: AgentRow = { id: "a1", agentName: "researcher", teamId: "t1" };
  let b: AgentRow = { id: "a2", agentName: "loner", teamId: "t9" };
  persist(database, agentsFlat(), JSON.stringify(a));
  persist(database, agentsFlat(), JSON.stringify(b));
  let k1: Task = { id: "k1", agentId: "a1", title: "read" };
  let k2: Task = { id: "k2", agentId: "a1", title: "write" };
  persist(database, tasksRepo(), JSON.stringify(k1));
  persist(database, tasksRepo(), JSON.stringify(k2));
  return agentsRepo();
}

// --- offline ---------------------------------------------------------------

test("a relation states both sides and how to shape what comes back", () => {
  let r = hasOne("team", "rel_teams", "team_id", "id", "id, team_name AS \"teamName\"");
  expect(r.field == "team");
  expect(r.kind == "one");
  expect(r.table == "rel_teams");
  expect(r.localColumn == "team_id");
  expect(r.foreignColumn == "id");
  expect(relationValid(r));
});

test("a many relation differs only in kind", () => {
  expect(hasMany("tasks", "rel_tasks", "id", "agent_id", "id, title").kind == "many");
});

test("a relation with an unsafe name or select list is refused", () => {
  expect(!relationValid(hasOne("team", "x; DROP TABLE y", "team_id", "id", "id")));
  expect(!relationValid(hasOne("team", "rel_teams", "team_id; --", "id", "id")));
  expect(!relationValid(hasOne("t", "rel_teams", "team_id", "id", "id AS \"a'b\"")));
  // A kind that is neither is not a relation.
  let odd: DbRelation = { field: "t", kind: "some", table: "rel_teams", localColumn: "team_id", foreignColumn: "id", columns: "id" };
  expect(!relationValid(odd));
});

test("a mapping without relations carries an empty list, not a missing one", () => {
  expect(agentsFlat().relations.length == 0);
  expect(agentsRepo().relations.length == 2);
});

// --- against the database --------------------------------------------------

test("a to-one relation arrives as a nested object", () => {
  let repo = seeded();
  let json = findById(database, repo, "a1");
  expect(json.indexOf("\"team\"") >= 0);
  let deep: AgentDeep = JSON.parse<AgentDeep>(json);
  expect(deep.team.id == "t1");
  expect(deep.team.teamName == "research");
});

test("a to-many relation arrives as an array", () => {
  let repo = seeded();
  let deep: AgentDeep = JSON.parse<AgentDeep>(findById(database, repo, "a1"));
  expect(deep.tasks.length == 2);
  expect(deep.tasks[0].title == "read");
  expect(deep.tasks[1].title == "write");
  expect(deep.tasks[0].agentId == "a1");
});

test("the parent's own fields are still there, and still mapped", () => {
  let repo = seeded();
  let deep: AgentDeep = JSON.parse<AgentDeep>(findById(database, repo, "a1"));
  expect(deep.id == "a1");
  expect(deep.agentName == "researcher");
  expect(deep.teamId == "t1");
});

test("a to-one that matches nothing is null, and a to-many is empty", () => {
  let repo = seeded();
  // a2 points at a team that does not exist and has no tasks.
  let json = findById(database, repo, "a2");
  expect(json.indexOf("\"team\": null") >= 0 || json.indexOf("\"team\":null") >= 0);
  expect(json.indexOf("[]") >= 0);
});

test("a list carries every row's relations", () => {
  let repo = seeded();
  let json = listWhere(database, repo, "", []);
  expect(json.indexOf("research") >= 0);
  expect(json.indexOf("read") >= 0);
  expect(json.indexOf("write") >= 0);
  // Two agents, and the one with no team still appears.
  expect(json.indexOf("loner") >= 0);
});

test("relations do not multiply the parent rows, which is why this is not a join", () => {
  let repo = seeded();
  // a1 has two tasks. A join would return a1 twice.
  expect(countWhere(database, repo, "", []) == 2);
  let json = listWhere(database, repo, "id = " + database.placeholder, ["a1"]);
  expect(json.indexOf("researcher") >= 0);
  // One occurrence of the parent's name, two of its tasks.
  expect(json.indexOf("researcher") == json.lastIndexOf("researcher"));
});

test("a filter still applies to the parent, not to the relation", () => {
  let repo = seeded();
  let json = listWhere(database, repo, "agent_name = " + database.placeholder, ["loner"]);
  expect(json.indexOf("loner") >= 0);
  expect(json.indexOf("researcher") < 0);
});

test("a malformed relation refuses the read rather than sending it", () => {
  let repo = seeded();
  let bad: DbRelation[] = [ hasOne("team", "rel_teams", "team_id", "id", "id AS \"a'b\"") ];
  let broken = repositoryWith("rel_agents", "id", "id", agentsFlat().fields, bad);
  expect(findById(database, broken, "a1") == "");
  expect(listWhere(database, broken, "", []) == "[]");
  // And the table is untouched.
  expect(countWhere(database, agentsFlat(), "", []) == 2);
});

test("the suite leaves nothing behind", () => {
  connectDatabase(database, connectionConfig());
  expect(dropTable(database, agentsFlat()).ok);
  expect(dropTable(database, teamsRepo()).ok);
  expect(dropTable(database, tasksRepo()).ok);
  database.close();
});
