// Reading a migration's version and description out of its file name.
//
// Flyway's naming, which is the part of Flyway worth taking: adding a
// migration is adding a file. Everything here is a pure function over names,
// so it needs no database and no compiler support — `embedDir` supplies the
// list at build time, but any list will do.
//
//   cd packages/plume && lumen test migratenames.test.ts

import { SqlFile, ParsedName, Migration, parseMigrationName, migrationsFrom, migrationNameViolation, planOrder } from "./migrate.ts";

function sqlFile(fileName: string, body: string): SqlFile {
  let f: SqlFile = { name: fileName, text: body };
  return f;
}

function directory(): SqlFile[] {
  let files: SqlFile[] = [
    sqlFile("V1__create_teams.sql", "CREATE TABLE teams (id text PRIMARY KEY)"),
    sqlFile("V1_1__add_team_name.sql", "ALTER TABLE teams ADD COLUMN team_name text"),
    sqlFile("V2__create_agents.sql", "CREATE TABLE agents (id text PRIMARY KEY)"),
    sqlFile("R__active_agents_view.sql", "CREATE VIEW active AS SELECT * FROM agents"),
  ];
  return files;
}

test("a name starts with its version, with or without Flyway's V", () => {
  expect(parseMigrationName("1__create_teams.sql").version == "1");
  expect(parseMigrationName("1__create_teams.sql").description == "create teams");
  expect(parseMigrationName("001__create_teams.sql").version == "001");
  expect(parseMigrationName("2_3_4__deep.sql").version == "2.3.4");
  // The V is accepted, because directories full of it exist.
  expect(parseMigrationName("V1__create_teams.sql").version == "1");
});

test("a version comes from the name, and a single underscore is a dot", () => {
  expect(parseMigrationName("V1__create_teams.sql").version == "1");
  expect(parseMigrationName("V1_1__add_team_name.sql").version == "1.1");
  expect(parseMigrationName("V2_3_4__deep.sql").version == "2.3.4");
});

test("a description comes from the name, and a single underscore is a space", () => {
  expect(parseMigrationName("V1__create_teams.sql").description == "create teams");
  expect(parseMigrationName("V1_1__add_team_name.sql").description == "add team name");
});

test("R marks a repeatable step, which has no version", () => {
  let r = parseMigrationName("R__active_agents_view.sql");
  expect(r.valid);
  expect(r.version == "");
  expect(r.description == "active agents view");
});

test("the extension is dropped, whatever it is", () => {
  expect(parseMigrationName("V1__create_teams.sql").description == "create teams");
  expect(parseMigrationName("V1__create_teams.ddl").description == "create teams");
  expect(parseMigrationName("V1__create_teams").description == "create teams");
});

test("a name that is not a migration says why", () => {
  expect(!parseMigrationName("README.md").valid);
  expect(parseMigrationName("README.md").violation.indexOf("no __ separating") >= 0);

  expect(!parseMigrationName("V1__.sql").valid);
  expect(parseMigrationName("V1__.sql").violation.indexOf("nothing after") >= 0);

  expect(!parseMigrationName("X1__nope.sql").valid);
  expect(parseMigrationName("X1__nope.sql").violation.indexOf("neither a version number") >= 0);

  expect(!parseMigrationName("Vabc__nope.sql").valid);
  expect(parseMigrationName("Vabc__nope.sql").violation.indexOf("neither a version number") >= 0);

  // The problem names the file, so a directory listing points at the culprit.
  expect(parseMigrationName("README.md").violation.indexOf("README.md") >= 0);
});

test("a directory becomes a plan", () => {
  let plan = migrationsFrom(directory());
  expect(plan.length == 4);
  expect(plan[0].version == "1");
  expect(plan[0].sql.indexOf("CREATE TABLE teams") >= 0);
  expect(plan[1].version == "1.1");
  expect(plan[3].version == "");
  expect(plan[3].description == "active agents view");
});

test("the plan runs in version order, not directory order", () => {
  // Deliberately shuffled, as a directory listing may well be.
  let files: SqlFile[] = [
    sqlFile("V2__create_agents.sql", "SELECT 1"),
    sqlFile("R__active_agents_view.sql", "SELECT 1"),
    sqlFile("V1_1__add_team_name.sql", "SELECT 1"),
    sqlFile("V1__create_teams.sql", "SELECT 1"),
  ];
  let plan = migrationsFrom(files);
  let order = planOrder(plan);
  expect(plan[order[0]].version == "1");
  expect(plan[order[1]].version == "1.1");
  expect(plan[order[2]].version == "2");
  expect(plan[order[3]].version == "");
});

test("10 sorts after 9, which a name sort would get wrong", () => {
  let files: SqlFile[] = [
    sqlFile("10__tenth.sql", "SELECT 1"),
    sqlFile("9__ninth.sql", "SELECT 1"),
  ];
  let plan = migrationsFrom(files);
  let order = planOrder(plan);
  expect(plan[order[0]].version == "9");
  expect(plan[order[1]].version == "10");
});

test("a file that is not a migration is reported, not ignored", () => {
  let files: SqlFile[] = [
    sqlFile("V1__create_teams.sql", "SELECT 1"),
    sqlFile("notes.txt", "remember to run this"),
  ];
  // It is left out of the plan...
  expect(migrationsFrom(files).length == 1);
  // ...and saying so is the point: a migration named wrongly would otherwise
  // disappear without a word.
  expect(migrationNameViolation(files).indexOf("notes.txt") >= 0);
});

test("a directory that describes a good plan reports no problem", () => {
  expect(migrationNameViolation(directory()) == "");
});

test("an empty directory is a problem, since a plan was expected", () => {
  let none: SqlFile[] = [];
  expect(migrationNameViolation(none).indexOf("no files") >= 0);
});

test("two files claiming the same version are refused", () => {
  let files: SqlFile[] = [
    sqlFile("V1__create_teams.sql", "SELECT 1"),
    sqlFile("V1__create_agents.sql", "SELECT 1"),
  ];
  expect(migrationNameViolation(files).indexOf("appears twice") >= 0);
});
