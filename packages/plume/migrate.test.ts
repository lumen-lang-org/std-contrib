// Migrations against a live database. Ordering, checksums, out-of-order
// detection and repeatable steps are all claims about what the database ends
// up holding, so none of them are tested against a mock.
//
//   sh packages/plume/build.sh
//   cd packages/plume && lumen test migrate.test.ts
//
// Runs against SQLite by default because it needs no server. Set
// PLUME_TEST_CONNINFO to run the same suite against PostgreSQL — see
// migrate_pg.test.ts, which is this file with one line changed.

import { Db, DbConfig } from "./driver.ts";
import { sqlite } from "./sqlite.ts";
import { execute } from "./plume.ts";
import { Migration, MigrationState, migration, repeatable, migrate, migrateAllowingOutOfOrder, migrationInfo, validateMigrations, missingMigrations, planValid, planOrder, checksum, compareVersions, versionValid, historyTable, createHistory, repairChecksums, baseline, migrationApplied, forgetMigrations, appliedHighWater, quoted } from "./migrate.ts";

let database: Db = sqlite();

function dbConfig(): DbConfig {
  let named: DbConfig = { filename: "/tmp/plume_migrate_test.db" };
  return named;
}

function clean(): void {
  database.connect(dbConfig());
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS mig_a");
  execute(database, "DROP TABLE IF EXISTS mig_b");
}

function basePlan(): Migration[] {
  let plan: Migration[] = [
    migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY)"),
    migration("2", "create b", "CREATE TABLE mig_b (id text PRIMARY KEY)"),
  ];
  return plan;
}

// --- offline: versions, ordering, checksums --------------------------------

test("a version is digits and dots, and nothing else", () => {
  expect(versionValid("1"));
  expect(versionValid("1.2.3"));
  expect(!versionValid(""));
  expect(!versionValid("1."));
  expect(!versionValid(".1"));
  expect(!versionValid("1..2"));
  expect(!versionValid("1.2a"));
  expect(!versionValid("v1"));
});

test("versions compare as numbers, so 1.10 is after 1.9", () => {
  expect(compareVersions("1.10", "1.9") > 0);
  expect(compareVersions("1.9", "1.10") < 0);
  expect(compareVersions("2", "10") < 0);
  expect(compareVersions("1", "1.0") == 0);
  expect(compareVersions("1", "1.0.1") < 0);
  expect(compareVersions("3.4", "3.4") == 0);
});

test("a checksum changes with the statement and not with anything else", () => {
  let a = checksum("CREATE TABLE t (id text)");
  let b = checksum("CREATE TABLE t (id text)");
  let c = checksum("CREATE TABLE t (id TEXT)");
  expect(a == b);
  expect(a != c);
  // A known CRC-32, so this is a checksum rather than merely a hash: the
  // value must be reproducible outside this program.
  expect(checksum("123456789") == 3421780262 - 4294967296);
});

test("the plan runs in version order regardless of how it was written", () => {
  let plan: Migration[] = [
    migration("2", "second", "SELECT 1"),
    repeatable("a view", "SELECT 1"),
    migration("1.10", "tenth", "SELECT 1"),
    migration("1.9", "ninth", "SELECT 1"),
  ];
  let order = planOrder(plan);
  expect(order.length == 4);
  expect(plan[order[0]].version == "1.9");
  expect(plan[order[1]].version == "1.10");
  expect(plan[order[2]].version == "2");
  // Repeatable steps run after every versioned one.
  expect(plan[order[3]].version == "");
});

test("a plan may not repeat a version or an unnamed repeatable", () => {
  let dup: Migration[] = [
    migration("1", "a", "SELECT 1"),
    migration("1", "b", "SELECT 1"),
  ];
  expect(planValid(dup).indexOf("appears twice") >= 0);

  let bad: Migration[] = [migration("v1", "a", "SELECT 1")];
  expect(planValid(bad).indexOf("dotted number") >= 0);

  let unnamed: Migration[] = [repeatable("", "SELECT 1")];
  expect(planValid(unnamed).indexOf("needs a description") >= 0);

  expect(planValid(basePlan()) == "");
});

test("a quoted literal doubles its quotes, and its backslashes where they escape", () => {
  expect(quoted(database, "plain") == "'plain'");
  expect(quoted(database, "it's") == "'it''s'");
  // MySQL treats a backslash inside a literal as an escape character and the
  // others do not, so the same text is not the same literal on all three.
  if (database.backslashEscapes) {
    expect(quoted(database, "C:\\path") == "'C:\\\\path'");
  } else {
    expect(quoted(database, "C:\\path") == "'C:\\path'");
  }
});

// --- applying --------------------------------------------------------------

test("migrations apply once and are recorded", () => {
  clean();
  let plan = basePlan();
  let first = migrate(database, plan);
  expect(first.ok);
  expect(first.applied == 2);
  expect(migrationApplied(database, "1"));
  expect(migrationApplied(database, "2"));
  expect(!migrationApplied(database, "3"));

  // A second run applies nothing.
  let second = migrate(database, plan);
  expect(second.ok);
  expect(second.applied == 0);
});

test("what info reports matches what migrate did", () => {
  clean();
  let plan = basePlan();
  let before = migrationInfo(database, plan);
  expect(before.length == 2);
  expect(before[0].status == "pending");
  expect(before[1].status == "pending");

  migrate(database, plan);
  let after = migrationInfo(database, plan);
  expect(after[0].status == "applied");
  expect(after[1].status == "applied");
  expect(after[0].appliedChecksum == after[0].checksum);
  expect(after[0].rank > 0);
  expect(after[1].rank > after[0].rank);
});

test("a failing migration names itself and stops the rest", () => {
  clean();
  let plan: Migration[] = [
    migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY)"),
    migration("2", "nonsense", "THIS IS NOT SQL"),
    migration("3", "create b", "CREATE TABLE mig_b (id text PRIMARY KEY)"),
  ];
  let r = migrate(database, plan);
  expect(!r.ok);
  expect(r.failedVersion == "2");
  expect(r.error.indexOf("nonsense") >= 0);
  // The first ran, the third did not.
  expect(migrationApplied(database, "1"));
  expect(!migrationApplied(database, "3"));
  // Nothing was recorded for the failure, so fixing it re-runs it rather than
  // needing a repair.
  expect(!migrationApplied(database, "2"));
});

test("a fixed migration runs on the next attempt", () => {
  clean();
  let broken: Migration[] = [
    migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY)"),
    migration("2", "create b", "THIS IS NOT SQL"),
  ];
  expect(!migrate(database, broken).ok);
  let fixed: Migration[] = [
    migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY)"),
    migration("2", "create b", "CREATE TABLE mig_b (id text PRIMARY KEY)"),
  ];
  let r = migrate(database, fixed);
  expect(r.ok);
  expect(r.applied == 1);
  expect(migrationApplied(database, "2"));
});

test("a description containing a backslash is recorded, not lost", () => {
  // MySQL treats a backslash inside a string literal as an escape, so a
  // description ending in one swallowed the closing quote: the migration RAN
  // and could never be recorded, and every later run failed on "already
  // exists". Doubling the quote is not enough there.
  clean();
  let plan: Migration[] = [
    migration("1", "note C:\\path\\", "CREATE TABLE mig_a (id text PRIMARY KEY)"),
  ];
  let first = migrate(database, plan);
  expect(first.ok);
  expect(first.applied == 1);
  expect(migrationApplied(database, "1"));
  // And running again is the no-op it should be.
  let second = migrate(database, plan);
  expect(second.ok);
  expect(second.applied == 0);
});

test("a description cannot append a row of its own to the history", () => {
  clean();
  let hostile = "\\',0),(999,0x39,0x494e4a,0)#";
  let plan: Migration[] = [
    migration("5", hostile, "CREATE TABLE mig_a (id text PRIMARY KEY)"),
  ];
  expect(migrate(database, plan).ok);
  database.query("SELECT count(*) FROM " + historyTable(), []);
  expect(database.value(0, 0) == "1");
  // Stored as the text it is.
  expect(migrationApplied(database, "5"));
});

// --- checksums in anger ----------------------------------------------------

test("editing an applied migration is refused, not ignored", () => {
  clean();
  expect(migrate(database, basePlan()).ok);

  let edited: Migration[] = [
    migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY, extra text)"),
    migration("2", "create b", "CREATE TABLE mig_b (id text PRIMARY KEY)"),
  ];
  let states = migrationInfo(database, edited);
  expect(states[0].status == "changed");

  let r = migrate(database, edited);
  expect(!r.ok);
  expect(r.error.indexOf("edited since it was applied") >= 0);

  // And it says which checksums disagree, so the report is actionable.
  expect(r.error.indexOf("recorded checksum") >= 0);
});

test("repair accepts an edit that was deliberate", () => {
  clean();
  expect(migrate(database, basePlan()).ok);
  let edited: Migration[] = [
    migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY) -- a comment"),
    migration("2", "create b", "CREATE TABLE mig_b (id text PRIMARY KEY)"),
  ];
  expect(!migrate(database, edited).ok);
  expect(repairChecksums(database, edited).ok);
  let r = migrate(database, edited);
  expect(r.ok);
  expect(r.applied == 0);
  expect(migrationInfo(database, edited)[0].status == "applied");
});

test("a migration deleted from the plan is reported", () => {
  clean();
  expect(migrate(database, basePlan()).ok);
  let shortened: Migration[] = [
    migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY)"),
  ];
  let missing = missingMigrations(database, shortened);
  expect(missing.length == 1);
  expect(missing[0].indexOf("create b") >= 0);
  let r = migrate(database, shortened);
  expect(!r.ok);
  expect(r.error.indexOf("the plan does not") >= 0);
});

// --- out of order ----------------------------------------------------------

test("a migration inserted below one already applied is refused by default", () => {
  clean();
  expect(migrate(database, basePlan()).ok);
  expect(appliedHighWater(database) == "2");

  let merged: Migration[] = [
    migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY)"),
    migration("1.5", "from another branch", "CREATE TABLE mig_b_extra (id text)"),
    migration("2", "create b", "CREATE TABLE mig_b (id text PRIMARY KEY)"),
  ];
  expect(migrationInfo(database, merged)[1].status == "out-of-order");
  let r = migrate(database, merged);
  expect(!r.ok);
  expect(r.failedVersion == "1.5");
  expect(r.error.indexOf("below one already applied") >= 0);

  // Accepting it is explicit.
  let allowed = migrateAllowingOutOfOrder(database, merged);
  expect(allowed.ok);
  expect(allowed.applied == 1);
  expect(migrationApplied(database, "1.5"));
  execute(database, "DROP TABLE IF EXISTS mig_b_extra");
});

// --- repeatable ------------------------------------------------------------

test("a repeatable step re-runs when its statement changes and not otherwise", () => {
  clean();
  execute(database, "DROP VIEW IF EXISTS mig_view");
  let v1: Migration[] = [
    migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY, name text)"),
    repeatable("mig_view", "CREATE VIEW mig_view AS SELECT id FROM mig_a"),
  ];
  let first = migrate(database, v1);
  expect(first.ok);
  expect(first.applied == 2);

  // Unchanged: nothing happens.
  let again = migrate(database, v1);
  expect(again.ok);
  expect(again.applied == 0);

  // Changed: it runs again, replacing rather than duplicating its record.
  let v2: Migration[] = [
    migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY, name text)"),
    repeatable("mig_view", "DROP VIEW IF EXISTS mig_view; CREATE VIEW mig_view AS SELECT id, name FROM mig_a"),
  ];
  expect(migrationInfo(database, v2)[1].status == "pending");
  let third = migrate(database, v2);
  expect(third.ok);
  expect(third.applied == 1);

  // One row, not two.
  database.query("SELECT count(*) FROM " + historyTable() + " WHERE description = 'mig_view'", []);
  expect(database.value(0, 0) == "1");
  execute(database, "DROP VIEW IF EXISTS mig_view");
});

// --- baseline --------------------------------------------------------------

test("baseline marks history without running anything", () => {
  clean();
  let plan: Migration[] = [
    migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY)"),
    migration("2", "create b", "CREATE TABLE mig_b (id text PRIMARY KEY)"),
    migration("3", "create c", "CREATE TABLE mig_c (id text PRIMARY KEY)"),
  ];
  let r = baseline(database, plan, "2");
  expect(r.ok);
  expect(r.applied == 2);
  // Marked, not run: the tables do not exist.
  expect(!execute(database, "SELECT id FROM mig_a").ok);
  expect(migrationApplied(database, "1"));
  expect(migrationApplied(database, "2"));
  expect(!migrationApplied(database, "3"));

  // And migrate now runs only what the baseline did not cover.
  let m = migrate(database, plan);
  expect(m.ok);
  expect(m.applied == 1);
  execute(database, "DROP TABLE IF EXISTS mig_c");
});

test("validation reports the first problem and nothing else", () => {
  clean();
  expect(validateMigrations(database, basePlan()) == "");
  expect(migrate(database, basePlan()).ok);
  expect(validateMigrations(database, basePlan()) == "");
});

test("the history table survives being created twice", () => {
  clean();
  expect(createHistory(database).ok);
  expect(createHistory(database).ok);
});

test("the suite leaves nothing behind", () => {
  clean();
  expect(!migrationApplied(database, "1"));
  database.close();
});
