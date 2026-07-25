// Foreign keys derived from relations, applied through a migration.
//
// A relation already says which column points at which column of which table.
// plume does not add the constraint itself — a schema change belongs in a
// migration, where it is recorded and checksummed like every other one.
//
//   cd packages/plume && lumen test foreignkeys.test.ts

import { Db } from "./driver.ts";
import { sqlite } from "./sqlite.ts";
import { DbField, DbRelation, DbRepository, field, repository, repositoryWith, hasOne, hasMany, connectDatabase, createTable, createTableSql, createTableSqlWithKeys, foreignKeys, foreignKeyName, dropTable, execute, persist, countWhere } from "./plume.ts";
import { Migration, migration, migrate, forgetMigrations } from "./migrate.ts";

let database: Db = sqlite();

type Team = { id: string, teamName: string };
type AgentRow = { id: string, agentName: string, teamId: string };

function connectionTarget(): string {
  return "/tmp/plume_fk_test.db";
}

function teamsRepo(): DbRepository {
  let fs: DbField[] = [ field("id", "id", "text"), field("teamName", "team_name", "text") ];
  return repository("fk_teams", "id", "id", fs);
}

function agentsRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("teamId", "team_id", "text"),
  ];
  let rs: DbRelation[] = [
    hasOne("team", "fk_teams", "team_id", "id", "id, team_name AS \"teamName\""),
    hasMany("tasks", "fk_tasks", "id", "agent_id", "id, title"),
  ];
  return repositoryWith("fk_agents", "id", "id", fs, rs);
}

function clean(): void {
  connectDatabase(database, connectionTarget());
  forgetMigrations(database);
  dropTable(database, agentsRepo());
  dropTable(database, teamsRepo());
}

// --- what is generated -----------------------------------------------------

test("createTable is unchanged: a relation adds nothing to it", () => {
  let sql = createTableSql(database, agentsRepo());
  expect(sql.indexOf("CREATE TABLE IF NOT EXISTS fk_agents") >= 0);
  expect(sql.indexOf("team_id") >= 0);
  // No constraint, exactly as before relations existed.
  expect(sql.indexOf("REFERENCES") < 0);
  expect(sql.indexOf("FOREIGN KEY") < 0);
});

test("a to-one relation becomes a REFERENCES clause when asked", () => {
  let sql = createTableSqlWithKeys(database, agentsRepo());
  expect(sql.indexOf("FOREIGN KEY (team_id) REFERENCES fk_teams (id)") >= 0);
});

test("a to-many adds nothing here, because its column is on the other table", () => {
  let sql = createTableSqlWithKeys(database, agentsRepo());
  expect(sql.indexOf("fk_tasks") < 0);
  // And exactly one constraint, not two.
  expect(sql.indexOf("FOREIGN KEY") == sql.lastIndexOf("FOREIGN KEY"));
});

test("a mapping with no relations generates the same statement either way", () => {
  expect(createTableSqlWithKeys(database, teamsRepo()) == createTableSql(database, teamsRepo()));
});

test("the constraint is named for the table and column it constrains", () => {
  let rel = agentsRepo().relations[0];
  expect(foreignKeyName(agentsRepo(), rel) == "fk_fk_agents_team_id");
});

test("an invalid relation produces no statement rather than a broken one", () => {
  let bad: DbRelation[] = [ hasOne("team", "x; DROP TABLE y", "team_id", "id", "id") ];
  let broken = repositoryWith("fk_agents", "id", "id", teamsRepo().fields, bad);
  expect(createTableSqlWithKeys(database, broken) == "");
  expect(foreignKeys(database, broken).length == 0);
});

// --- through a migration ---------------------------------------------------

test("the schema a migration builds comes from the same declaration", () => {
  clean();
  // The mapping is the single statement of the shape: the migration holds the
  // statement it generates, so the two cannot drift.
  let plan: Migration[] = [
    migration("1", "teams", createTableSql(database, teamsRepo())),
    migration("2", "agents", createTableSqlWithKeys(database, agentsRepo())),
  ];
  let r = migrate(database, plan);
  expect(r.ok);
  expect(r.applied == 2);

  // And the tables work.
  let t: Team = { id: "t1", teamName: "research" };
  expect(persist(database, teamsRepo(), JSON.stringify(t)).ok);
  let a: AgentRow = { id: "a1", agentName: "researcher", teamId: "t1" };
  expect(persist(database, agentsRepo(), JSON.stringify(a)).ok);
  expect(countWhere(database, agentsRepo(), "", "") == 1);
});

test("the constraint is really in the schema, not just in the string", () => {
  clean();
  let plan: Migration[] = [
    migration("1", "teams", createTableSql(database, teamsRepo())),
    migration("2", "agents", createTableSqlWithKeys(database, agentsRepo())),
  ];
  expect(migrate(database, plan).ok);
  // Ask the database what it built.
  expect(database.queryNoArgs("SELECT sql FROM sqlite_master WHERE name = 'fk_agents'"));
  expect(database.value(0, 0).indexOf("REFERENCES fk_teams") >= 0);
});

test("SQLite offers no ALTER route, and says so by generating nothing", () => {
  clean();
  // SQLite cannot add a constraint to a table that exists, so foreignKeys is
  // empty there and createTableSqlWithKeys is the way. A caller that used the
  // ALTER route regardless would get an empty plan, not a broken statement.
  expect(!database.canAddForeignKey);
  expect(foreignKeys(database, agentsRepo()).length == 0);
});

test("a declared foreign key is enforced once the database is asked to", () => {
  clean();
  let plan: Migration[] = [
    migration("1", "teams", createTableSql(database, teamsRepo())),
    migration("2", "agents", createTableSqlWithKeys(database, agentsRepo())),
  ];
  expect(migrate(database, plan).ok);
  // SQLite ignores foreign keys unless told not to, which is its own choice
  // and worth stating in a test rather than discovering in production.
  execute(database, "PRAGMA foreign_keys = ON");
  let orphan: AgentRow = { id: "a9", agentName: "nobody", teamId: "t-missing" };
  let w = persist(database, agentsRepo(), JSON.stringify(orphan));
  expect(!w.ok);
  expect(w.error.length > 0);
  execute(database, "PRAGMA foreign_keys = OFF");
});

test("the suite leaves nothing behind", () => {
  clean();
  // -1, not 0: a count against a table that is not there is a failed query,
  // and plume distinguishes that from a table holding no rows.
  expect(countWhere(database, agentsRepo(), "", "") == -1);
  expect(countWhere(database, teamsRepo(), "", "") == -1);
  database.close();
});
