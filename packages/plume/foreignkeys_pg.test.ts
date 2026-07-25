// Foreign keys derived from relations, applied through a migration.
//
// A relation already says which column points at which column of which table.
// plume does not add the constraint itself — a schema change belongs in a
// migration, where it is recorded and checksummed like every other one.
//
//   cd packages/plume && lumen test foreignkeys_pg.test.ts

import { Db } from "./driver.ts";
import { postgres } from "./postgres.ts";
import { DbField, DbRelation, DbRepository, field, repository, repositoryWith, hasOne, hasMany, connectDatabase, createTable, createTableSql, createTableSqlWithKeys, foreignKeys, foreignKeyName, dropTable, execute, persist, countWhere } from "./plume.ts";
import { Migration, migration, migrate, forgetMigrations } from "./migrate.ts";

let database: Db = postgres();

type Team = { id: string, teamName: string };
type AgentRow = { id: string, agentName: string, teamId: string };

function connectionTarget(): string {
  let fromEnv = process.env("PLUME_TEST_CONNINFO") ?? "";
  if (fromEnv != "") { return fromEnv; }
  return "host=127.0.0.1 user=lumen password=lumen dbname=lumenvec";
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

test("the ALTER route adds the constraint after the fact", () => {
  clean();
  // Here creation order does not matter, because the constraint arrives in a
  // later migration than either table.
  expect(database.canAddForeignKey);
  let keys = foreignKeys(database, agentsRepo());
  expect(keys.length == 1);
  expect(keys[0].indexOf("ADD CONSTRAINT fk_fk_agents_team_id") >= 0);
  expect(keys[0].indexOf("FOREIGN KEY (team_id) REFERENCES fk_teams (id)") >= 0);

  let plan: Migration[] = [
    migration("1", "agents", createTableSql(database, agentsRepo())),
    migration("2", "teams", createTableSql(database, teamsRepo())),
    migration("3", "agent keys", keys[0]),
  ];
  expect(migrate(database, plan).ok);
});

test("a declared foreign key is enforced", () => {
  clean();
  let plan: Migration[] = [
    migration("1", "agents", createTableSql(database, agentsRepo())),
    migration("2", "teams", createTableSql(database, teamsRepo())),
    migration("3", "agent keys", foreignKeys(database, agentsRepo())[0]),
  ];
  expect(migrate(database, plan).ok);
  let orphan: AgentRow = { id: "a9", agentName: "nobody", teamId: "t-missing" };
  let w = persist(database, agentsRepo(), JSON.stringify(orphan));
  expect(!w.ok);
  expect(w.error.length > 0);
});

test("the suite leaves nothing behind", () => {
  clean();
  // -1, not 0: a count against a table that is not there is a failed query,
  // and plume distinguishes that from a table holding no rows.
  expect(countWhere(database, agentsRepo(), "", "") == -1);
  expect(countWhere(database, teamsRepo(), "", "") == -1);
  database.close();
});
