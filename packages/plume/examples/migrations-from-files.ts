// Migrations read from a directory of .sql files, compiled into the binary.
//
// Needs `embedDir` (Lumen spec 458), so this sits under examples/ where no
// test suite picks it up.
//
//   cd packages/plume && lumen run examples/migrations-from-files.ts
//
// The two good properties stop being alternatives. Each statement is a .sql
// file — reviewable, lintable and diffable by someone who reads SQL and not
// Lumen — and `embed` reads it while compiling, so the program is still one
// binary with nothing beside it. Delete the sql/ directory after building and
// the program still runs.
//
// The version and the description come from the file name, as Flyway's do:
// V1__create_teams.sql is version 1, "create teams", and V1_1__x.sql is 1.1.
// Adding a migration is adding a file. What stays checked is everything after
// that — ordering by version, the checksum over the contents, and the refusal
// to run a plan that has drifted from what the database recorded.

import { Db, DbConfig } from "../driver.ts";
import { sqlite } from "../sqlite.ts";
import { DbField, DbRepository, field, repository, connectDatabase, closeDatabase, persist, findById, countWhere } from "../plume.ts";
import { Migration, SqlFile, migrationsFrom, migrationNameProblem, migrate, migrationInfo, forgetMigrations } from "../migrate.ts";

let database: Db = sqlite();

type Team = { id: string, teamName: string };
type AgentRow = { id: string, agentName: string, maxSteps: int, teamId: string };

function teamsRepo(): DbRepository {
  let fs: DbField[] = [ field("id", "id", "text"), field("teamName", "team_name", "text") ];
  return repository({ table: "mf_teams", idField: "id", idColumn: "id", fields: fs });
}

function agentsRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
    field("teamId", "team_id", "text"),
  ];
  return repository({ table: "mf_agents", idField: "id", idColumn: "id", fields: fs });
}

// The plan is the directory. `embedDir` reads it while compiling, and the
// version and description come from each file name the way Flyway's do — so
// adding a migration is adding a file, and nothing has to be edited here.
function sqlDirectory(): SqlFile[] {
  return embedDir("./sql");
}

function migrationPlan(): Migration[] {
  return migrationsFrom(sqlDirectory());
}

function main(): void {
  let local: DbConfig = { filename: "/tmp/plume_migrations_from_files.db" };
  connectDatabase(database, local);

  // Start over, so the example is the same every run.
  forgetMigrations(database);
  database.exec("DROP TABLE IF EXISTS mf_agents");
  database.exec("DROP TABLE IF EXISTS mf_teams");

  // A file that is not a migration is an error, not something to skip
  // quietly: one named wrongly would otherwise never run and never be missed.
  let problem = migrationNameProblem(sqlDirectory());
  if (problem != "") {
    console.error("the migration directory is not a plan: " + problem);
    return;
  }

  // What would happen, before anything does.
  let before = migrationInfo(database, migrationPlan());
  let i: int = 0;
  while (i < before.length) {
    console.log("pending  " + before[i].version + "  " + before[i].description);
    i = i + 1;
  }

  let r = migrate(database, migrationPlan());
  console.log("");
  console.log("applied  " + `${r.applied}` + "  ok=" + `${r.ok}` + " " + r.error);

  let t: Team = { id: "t1", teamName: "research" };
  persist(database, teamsRepo(), JSON.stringify(t));
  let a: AgentRow = { id: "a1", agentName: "researcher", maxSteps: 5, teamId: "t1" };
  persist(database, agentsRepo(), JSON.stringify(a));

  console.log("");
  console.log("agents   " + `${countWhere(database, agentsRepo(), "", [])}`);
  console.log("read     " + findById(database, agentsRepo(), "a1"));

  // Running again applies nothing: the history already holds all three.
  let again = migrate(database, migrationPlan());
  console.log("re-run   applied=" + `${again.applied}`);

  closeDatabase(database);
}

main();
