// Versioned migrations, in the shape Flyway made standard: an ordered plan of
// versioned steps, a history table recording what ran, and a checksum over
// each step so an already-applied migration that someone has since edited is
// refused rather than silently ignored.
//
// What is deliberately not here is Flyway's filename convention. A plan is
// written out, in order, in the program:
//
//   let plan: Migration[] = [
//     migration("1", "create agents", "CREATE TABLE agents (id text PRIMARY KEY)"),
//     migration("1.1", "add name", "ALTER TABLE agents ADD COLUMN name text"),
//     repeatable("agent view", "CREATE VIEW ..."),
//   ];
//   let r = migrate(db, plan);
//
// so nothing depends on how a file happens to be named, and a plan can be
// assembled from anywhere — a directory read, a constant, a generated list.

import { Db } from "./driver.ts";
import { execute, safeIdentifier, placeholderAt, beginTransaction, commitTransaction, rollbackTransaction, DbResult } from "./plume.ts";

// One step. `version` orders it and identifies it; an empty version marks a
// repeatable step, which re-runs whenever its SQL changes and always sorts
// after every versioned one.
export type Migration = {
  version: string,
  description: string,
  sql: string,
};

// What the history table says about one step.
export type MigrationState = {
  version: string,
  description: string,
  // "pending" | "applied" | "changed" | "missing" | "out-of-order"
  status: string,
  checksum: int,
  // Whether the history holds this step at all, and what checksum it holds.
  recorded: bool,
  appliedChecksum: int,
  rank: int,
};

export type MigrateResult = {
  ok: bool,
  applied: int,
  error: string,
  // The version that failed, so a diagnostic can name it.
  failedVersion: string,
};

export function migration(version: string, description: string, sql: string): Migration {
  let m: Migration = { version: version, description: description, sql: sql };
  return m;
}

// A step with no version, re-applied whenever its SQL changes. Views, stored
// procedures and grants are the usual reason: they are easier to redefine than
// to alter.
export function repeatable(description: string, sql: string): Migration {
  let m: Migration = { version: "", description: description, sql: sql };
  return m;
}

function migrateOk(applied: int): MigrateResult {
  let r: MigrateResult = { ok: true, applied: applied, error: "", failedVersion: "" };
  return r;
}

function migrateErr(version: string, message: string): MigrateResult {
  let r: MigrateResult = { ok: false, applied: 0, error: message, failedVersion: version };
  return r;
}

// --- checksums ------------------------------------------------------------

// CRC-32, the same function Flyway uses, so a checksum here means what a
// checksum there means. Bitwise, over bytes, with the reversed polynomial.
export function checksum(text: string): int {
  let crc: int = -1;
  let i: int = 0;
  while (i < text.length) {
    crc = crc ^ (text.charCodeAt(i) & 255);
    let bit: int = 0;
    while (bit < 8) {
      let lsb = crc & 1;
      crc = (crc >> 1) & 2147483647;
      if (lsb == 1) {
        crc = crc ^ -306674912;
      }
      bit = bit + 1;
    }
    i = i + 1;
  }
  return crc ^ -1;
}

// --- versions -------------------------------------------------------------

// Compare two dotted versions numerically, so 1.10 is after 1.9 rather than
// before it, and a shorter prefix is earlier: 1 before 1.0.1.
export function compareVersions(a: string, b: string): int {
  let pa = a.split(".");
  let pb = b.split(".");
  let n = pa.length;
  if (pb.length > n) {
    n = pb.length;
  }
  let i: int = 0;
  while (i < n) {
    let x: int = 0;
    let y: int = 0;
    if (i < pa.length) {
      x = versionPart(pa[i]);
    }
    if (i < pb.length) {
      y = versionPart(pb[i]);
    }
    if (x < y) {
      return -1;
    }
    if (x > y) {
      return 1;
    }
    i = i + 1;
  }
  return 0;
}

function versionPart(s: string): int {
  let n: int = 0;
  let i: int = 0;
  while (i < s.length) {
    let c = s.charCodeAt(i);
    if (c < 48 || c > 57) {
      return n;
    }
    n = n * 10 + (c - 48);
    i = i + 1;
  }
  return n;
}

// A version must be digits and dots, since it goes into the history table and
// is compared numerically.
export function versionValid(v: string): bool {
  if (v.length == 0) {
    return false;
  }
  let i: int = 0;
  let lastWasDot = true;
  while (i < v.length) {
    let c = v.charCodeAt(i);
    if (c == 46) {
      if (lastWasDot) {
        return false;
      }
      lastWasDot = true;
    } else {
      if (c < 48 || c > 57) {
        return false;
      }
      lastWasDot = false;
    }
    i = i + 1;
  }
  return !lastWasDot;
}

// A plan must not repeat a version, and every versioned step must be ordered
// before every repeatable one is considered. Checked before anything runs, so
// a malformed plan never leaves the database half-migrated.
export function planValid(plan: Migration[]): string {
  let i: int = 0;
  while (i < plan.length) {
    let v = plan[i].version;
    if (v != "") {
      if (!versionValid(v)) {
        return "version \"" + v + "\" is not a dotted number";
      }
      let j: int = 0;
      while (j < i) {
        if (plan[j].version == v) {
          return "version \"" + v + "\" appears twice in the plan";
        }
        j = j + 1;
      }
    } else {
      if (plan[i].description == "") {
        return "a repeatable migration needs a description to identify it";
      }
      let k: int = 0;
      while (k < i) {
        if (plan[k].version == "" && plan[k].description == plan[i].description) {
          return "repeatable \"" + plan[i].description + "\" appears twice in the plan";
        }
        k = k + 1;
      }
    }
    i = i + 1;
  }
  return "";
}


// --- a plan from a directory ------------------------------------------------
//
// Flyway's naming, which is the part of Flyway worth taking: a file name
// carries the version and the description, so the plan is the directory
// listing and adding a migration is adding a file.
//
//   sql/1__create_teams.sql         version 1,   "create teams"
//   sql/1_1__add_agent_name.sql     version 1.1, "add agent name"
//   sql/V2__create_agents.sql       version 2,   "create agents"
//   sql/R__active_agents_view.sql   repeatable,  "active agents view"
//
// A name starts with its version. Flyway's `V` prefix is accepted because
// people have directories full of it, but nothing needs it: the version is
// what a migration is ordered by, so it is what the name leads with.
//
//   let plan = migrationsFrom(embedDir("./sql"));
//
// `embedDir` reads the directory while compiling, so the names are resolved at
// build time and the binary still ships alone. Nothing here requires that,
// though — any list of name-and-contents will do.

// One file, as `embedDir` hands it over.
export type SqlFile = {
  name: string,
  text: string,
};

export type ParsedName = {
  version: string,
  description: string,
  valid: bool,
  violation: string,
};

function parsedName(version: string, description: string): ParsedName {
  let p: ParsedName = { version: version, description: description, valid: true, violation: "" };
  return p;
}

function unparsedName(fileName: string, why: string): ParsedName {
  let p: ParsedName = {
    version: "",
    description: "",
    valid: false,
    violation: "\"" + fileName + "\" " + why,
  };
  return p;
}

// `V1_1__add_agent_name.sql` -> version 1.1, "add agent name".
//
// The separator is a double underscore, so a single one is free to mean a dot
// in the version and a space in the description — which is Flyway's rule, and
// the reason a description cannot contain a double underscore.
export function parseMigrationName(fileName: string): ParsedName {
  let stem = fileName;
  let dot = stem.lastIndexOf(".");
  if (dot > 0) {
    stem = stem.substring(0, dot);
  }

  let sep = stem.indexOf("__");
  if (sep < 0) {
    return unparsedName(fileName, "has no __ separating its version from its description");
  }
  let head = stem.substring(0, sep);
  let tail = stem.substring(sep + 2, stem.length);
  if (tail == "") {
    return unparsedName(fileName, "has nothing after its __ separator to describe it");
  }
  let description = tail.replaceAll("_", " ");

  if (head == "R") {
    return parsedName("", description);
  }
  // A leading V is Flyway's and is optional: a name starts with its version.
  let digits = head;
  if (head.startsWith("V")) {
    digits = head.substring(1, head.length);
  }
  if (digits == "") {
    return unparsedName(fileName, "has no version before its __ separator");
  }
  let first = digits.charCodeAt(0);
  if (first < 48 || first > 57) {
    return unparsedName(fileName, "starts with neither a version number nor R for a repeatable step");
  }
  let version = digits.replaceAll("_", ".");
  if (!versionValid(version)) {
    return unparsedName(fileName, "has \"" + version + "\" where a dotted number belongs");
  }
  return parsedName(version, description);
}

// The plan a directory describes. Files that do not follow the naming are
// skipped here and reported by `migrationNameViolation`, so a stray README beside
// the SQL is not silently treated as a migration.
export function migrationsFrom(files: SqlFile[]): Migration[] {
  let out: Migration[] = [];
  let i: int = 0;
  while (i < files.length) {
    let parsed = parseMigrationName(files[i].name);
    if (parsed.valid) {
      out.push(migration(parsed.version, parsed.description, files[i].text));
    }
    i = i + 1;
  }
  return out;
}

// Why a directory does not describe a plan. A file that is not a migration is
// an error rather than something to ignore: a migration that was meant to run
// and was named wrongly would otherwise disappear without a word.
export function migrationNameViolation(files: SqlFile[]): string {
  if (files.length == 0) {
    return "no files to read migrations from";
  }
  let i: int = 0;
  while (i < files.length) {
    let parsed = parseMigrationName(files[i].name);
    if (!parsed.valid) {
      return parsed.violation;
    }
    i = i + 1;
  }
  return planValid(migrationsFrom(files));
}

// --- the history table ----------------------------------------------------

// The table name is fixed rather than configurable, because two names in one
// database is a way to apply everything twice.
export function historyTable(): string {
  return "plume_schema_history";
}

export function createHistory(db: Db): DbResult {
  return execute(db, "CREATE TABLE IF NOT EXISTS " + historyTable() + " ("
    + "installed_rank " + db.intType + " NOT NULL, "
    + "version " + db.textType + " NOT NULL, "
    + "description " + db.textType + " NOT NULL, "
    + "checksum " + db.intType + " NOT NULL, "
    + "installed_on " + db.timestampType + " NOT NULL DEFAULT " + db.nowExpr + ", "
    + "execution_ms " + db.intType + " NOT NULL DEFAULT 0, "
    + "success " + db.intType + " NOT NULL DEFAULT 1, "
    + "PRIMARY KEY (version, description))");
}

// A step's identity in the history table. A versioned step is its version; a
// repeatable one has no version, so its description identifies it, and the
// empty version keeps the two kinds from colliding.
function historyKey(m: Migration): string {
  if (m.version == "") {
    return "";
  }
  return m.version;
}

// The two-column key of the history table, both values bound. A description is
// free text a person writes, and until the driver could bind more than one
// value it had to be escaped into the statement instead.
function historyKeyWhere(db: Db): string {
  return " WHERE version = " + placeholderAt(db, 1)
    + " AND description = " + placeholderAt(db, 2);
}

// Whether the history already holds this step. Separate from its checksum
// because a checksum of any value is a legitimate one, so no sentinel can
// stand in for "not recorded".
function historyHas(db: Db, version: string, description: string): bool {
  if (!db.query("SELECT 1 FROM " + historyTable() + historyKeyWhere(db), [version, description])) {
    return false;
  }
  return db.rows() > 0;
}

function recordedChecksum(db: Db, version: string, description: string): int {
  if (!db.query("SELECT checksum FROM " + historyTable() + historyKeyWhere(db), [version, description])) {
    return 0;
  }
  if (db.rows() == 0) {
    return 0;
  }
  return parseIntOr(db.value(0, 0), 0);
}

function rankOf(db: Db, version: string, description: string): int {
  if (!db.query("SELECT installed_rank FROM " + historyTable() + historyKeyWhere(db), [version, description])) {
    return 0;
  }
  if (db.rows() == 0) {
    return 0;
  }
  return parseIntOr(db.value(0, 0), 0);
}

// The highest version the database has already seen, so a plan that inserts a
// step below it can be reported as out of order.
export function appliedHighWater(db: Db): string {
  if (!db.query("SELECT version FROM " + historyTable() + " WHERE version <> ''", [])) {
    return "";
  }
  let best = "";
  let i: int = 0;
  while (i < db.rows()) {
    let v = db.value(i, 0);
    if (best == "" || compareVersions(v, best) > 0) {
      best = v;
    }
    i = i + 1;
  }
  return best;
}

function nextRank(db: Db): int {
  if (!db.query("SELECT coalesce(max(installed_rank), 0) FROM " + historyTable(), [])) {
    return 1;
  }
  if (db.rows() == 0) {
    return 1;
  }
  return parseIntOr(db.value(0, 0), 0) + 1;
}

// A string literal for SQL.
//
// Doubling the quote is the standard escape and all three accept it, but MySQL
// also treats a backslash inside a literal as an escape character, so a
// description ending in a backslash swallows the closing quote and everything
// after it becomes SQL. That is not hypothetical: `note C:\path\` made the
// history INSERT a syntax error, which left a migration that had RUN with no
// record of it and no way to record it — and a description crafted around the
// same hole appended a row of its own to the history.
//
// A description is free text a person writes, so it is escaped rather than
// restricted.
export function quoted(db: Db, text: string): string {
  let body = text;
  if (db.backslashEscapes) {
    body = body.replaceAll("\\", "\\\\");
  }
  return "'" + body.replaceAll("'", "''") + "'";
}

function parseIntOr(text: string, fallback: int): int {
  if (text.length == 0) {
    return fallback;
  }
  let neg = false;
  let i: int = 0;
  if (text.charCodeAt(0) == 45) {
    neg = true;
    i = 1;
  }
  let n: int = 0;
  let any = false;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c < 48 || c > 57) {
      break;
    }
    n = n * 10 + (c - 48);
    any = true;
    i = i + 1;
  }
  if (!any) {
    return fallback;
  }
  if (neg) {
    return 0 - n;
  }
  return n;
}

// --- what would happen ----------------------------------------------------

// The plan against the history, without changing anything. This is `flyway
// info`, and it is the thing to call before `migrate` in a deployment that
// wants to know rather than to do.
export function migrationInfo(db: Db, plan: Migration[]): MigrationState[] {
  let out: MigrationState[] = [];
  if (!createHistory(db).ok) {
    return out;
  }
  let water = appliedHighWater(db);
  let i: int = 0;
  while (i < plan.length) {
    let m = plan[i];
    let sum = checksum(m.sql);
    let known = historyHas(db, historyKey(m), m.description);
    let status = "pending";
    let appliedSum: int = 0;
    let rank: int = 0;
    if (known) {
      appliedSum = recordedChecksum(db, historyKey(m), m.description);
      rank = rankOf(db, historyKey(m), m.description);
      if (appliedSum == sum) {
        status = "applied";
      } else {
        // A repeatable step is meant to change; a versioned one is not.
        if (m.version == "") {
          status = "pending";
        } else {
          status = "changed";
        }
      }
    } else {
      if (m.version != "" && water != "" && compareVersions(m.version, water) < 0) {
        status = "out-of-order";
      }
    }
    let st: MigrationState = {
      version: m.version,
      description: m.description,
      status: status,
      checksum: sum,
      recorded: known,
      appliedChecksum: appliedSum,
      rank: rank,
    };
    out.push(st);
    i = i + 1;
  }
  return out;
}

// Every step the history knows about that the plan no longer contains. A
// migration deleted from the plan after it ran is a real fault — the next
// database built from that plan will differ from this one.
export function missingMigrations(db: Db, plan: Migration[]): string[] {
  let out: string[] = [];
  if (!createHistory(db).ok) {
    return out;
  }
  if (!db.query("SELECT version, description FROM " + historyTable() + " ORDER BY installed_rank", [])) {
    return out;
  }
  let rows = db.rows();
  let i: int = 0;
  while (i < rows) {
    let v = db.value(i, 0);
    let d = db.value(i, 1);
    let found = false;
    let j: int = 0;
    while (j < plan.length) {
      if (historyKey(plan[j]) == v && plan[j].description == d) {
        found = true;
      }
      j = j + 1;
    }
    if (!found) {
      if (v == "") {
        out.push("repeatable \"" + d + "\"");
      } else {
        out.push(v + " \"" + d + "\"");
      }
    }
    i = i + 1;
  }
  return out;
}

// The checks `migrate` makes before it runs anything, on their own. Returns
// the first fault, or an empty string.
export function validateMigrations(db: Db, plan: Migration[]): string {
  let planned = planValid(plan);
  if (planned != "") {
    return planned;
  }
  let states = migrationInfo(db, plan);
  let i: int = 0;
  while (i < states.length) {
    if (states[i].status == "changed") {
      return "migration " + states[i].version + " \"" + states[i].description
        + "\" has been edited since it was applied: recorded checksum "
        + `${states[i].appliedChecksum}` + ", plan checksum " + `${states[i].checksum}`;
    }
    i = i + 1;
  }
  let missing = missingMigrations(db, plan);
  if (missing.length > 0) {
    return "the database has migrations the plan does not: " + missing.join(", ");
  }
  return "";
}

// --- applying -------------------------------------------------------------

// Apply everything pending, in order, stopping at the first failure. Ordering
// is by version, with repeatable steps after all versioned ones, so the plan's
// own order does not have to be sorted by hand.
//
// `allowOutOfOrder` decides what happens when the plan contains a version
// below one already applied — the case of two branches merging. Refusing is
// the default because the two databases would otherwise disagree about what
// ran in which order.
export function migrate(db: Db, plan: Migration[]): MigrateResult {
  return migrateWith(db, plan, false);
}

export function migrateAllowingOutOfOrder(db: Db, plan: Migration[]): MigrateResult {
  return migrateWith(db, plan, true);
}

function migrateWith(db: Db, plan: Migration[], allowOutOfOrder: bool): MigrateResult {
  let violation = validateMigrations(db, plan);
  if (violation != "") {
    return migrateErr("", violation);
  }

  let order = planOrder(plan);
  let states = migrationInfo(db, plan);
  let applied: int = 0;
  let rank = nextRank(db);

  let n: int = 0;
  while (n < order.length) {
    let idx = order[n];
    let m = plan[idx];
    let st = states[idx];
    if (st.status == "applied") {
      n = n + 1;
      continue;
    }
    if (st.status == "out-of-order" && !allowOutOfOrder) {
      return migrateErr(m.version, "migration " + m.version + " \"" + m.description
        + "\" is below one already applied; pass it through migrateAllowingOutOfOrder to accept that");
    }
    // The statement and the row recording it go in together.
    //
    // They used to be two autocommitted round trips, and anything that landed
    // between them — a crash, a lost connection, a kill — left the migration
    // applied and still pending. It then re-ran on every boot, failing on the
    // table it had already created, and neither repairChecksums nor
    // forgetMigrations could get out of it: there was no row to repair and
    // dropping the history did not undo the statement.
    //
    // PostgreSQL and SQLite both roll DDL back, so on those the pair is atomic
    // and the failure is gone. MySQL commits implicitly at each DDL statement
    // and cannot be made to do this by any means available here; the
    // transaction is still opened, because a data migration on MySQL is
    // covered by it and a schema one is no worse off than before.
    //
    // A step that cannot run inside a transaction at all — PostgreSQL's CREATE
    // INDEX CONCURRENTLY is the one people meet — now fails with the
    // database's own message instead of running unrecorded. Run it by hand and
    // baseline it.
    let opened = beginTransaction(db);
    let ran = execute(db, m.sql);
    if (!ran.ok) {
      // Nothing is recorded for a failed step, so a fixed migration re-runs
      // rather than needing a repair.
      if (opened.ok) {
        rollbackTransaction(db);
      }
      return migrateErr(m.version, "migration " + stepLabel(m) + " failed: " + ran.error);
    }
    // A repeatable step that has run before is updated in place rather than
    // inserted again; anything else is new.
    let logged = writeHistory(db, m, rank, st.recorded);
    if (!logged.ok) {
      if (opened.ok) {
        rollbackTransaction(db);
        return migrateErr(m.version, "migration " + stepLabel(m)
          + " could not be recorded and was rolled back: " + logged.error);
      }
      return migrateErr(m.version, "applied " + stepLabel(m) + " but could not record it: " + logged.error);
    }
    if (opened.ok) {
      let committed = commitTransaction(db);
      if (!committed.ok) {
        return migrateErr(m.version, "applied " + stepLabel(m)
          + " but could not commit it: " + committed.error);
      }
    }
    rank = rank + 1;
    applied = applied + 1;
    n = n + 1;
  }
  return migrateOk(applied);
}

function stepLabel(m: Migration): string {
  if (m.version == "") {
    return "repeatable \"" + m.description + "\"";
  }
  return m.version + " \"" + m.description + "\"";
}

function writeHistory(db: Db, m: Migration, rank: int, replacing: bool): DbResult {
  let sum = checksum(m.sql);
  if (replacing) {
    return execute(db, "UPDATE " + historyTable() + " SET checksum = " + `${sum}`
      + ", installed_rank = " + `${rank}`
      + " WHERE version = " + quoted(db, historyKey(m))
      + " AND description = " + quoted(db, m.description));
  }
  return execute(db, "INSERT INTO " + historyTable()
    + " (installed_rank, version, description, checksum) VALUES ("
    + `${rank}` + ", " + quoted(db, historyKey(m)) + ", " + quoted(db, m.description) + ", " + `${sum}` + ")");
}

// Indices into the plan, ordered the way migrations must run: versioned steps
// by version, then repeatable steps in the plan's own order.
export function planOrder(plan: Migration[]): int[] {
  let out: int[] = [];
  // Selection sort over versions: repeatedly take the lowest version not yet
  // taken. A plan is tens of entries, so the shape matters more than the
  // complexity, and `out` doubles as the record of what has been placed.
  let placed: int = 0;
  while (placed < plan.length) {
    let best: int = -1;
    let j: int = 0;
    while (j < plan.length) {
      if (plan[j].version != "" && out.indexOf(j) < 0) {
        if (best < 0 || compareVersions(plan[j].version, plan[best].version) < 0) {
          best = j;
        }
      }
      j = j + 1;
    }
    if (best < 0) {
      break;
    }
    out.push(best);
    placed = placed + 1;
  }
  // Then the repeatable ones, in the plan's own order.
  let k: int = 0;
  while (k < plan.length) {
    if (out.indexOf(k) < 0) {
      out.push(k);
    }
    k = k + 1;
  }
  return out;
}

// --- repair and baseline --------------------------------------------------

// Accept the plan's checksums as correct, for the case where a migration was
// edited deliberately — a formatting change, a comment — and re-running it is
// not what is wanted. This is `flyway repair`, and like Flyway's it is a
// statement that you know what you are doing.
export function repairChecksums(db: Db, plan: Migration[]): DbResult {
  let created = createHistory(db);
  if (!created.ok) {
    return created;
  }
  let i: int = 0;
  while (i < plan.length) {
    let m = plan[i];
    let sum = checksum(m.sql);
    let r = execute(db, "UPDATE " + historyTable() + " SET checksum = " + `${sum}`
      + " WHERE version = " + quoted(db, historyKey(m))
      + " AND description = " + quoted(db, m.description));
    if (!r.ok) {
      return r;
    }
    i = i + 1;
  }
  return created;
}

// Mark everything up to and including `version` as already applied, without
// running it — for adopting plume on a database that already has a schema.
export function baseline(db: Db, plan: Migration[], version: string): MigrateResult {
  let violation = planValid(plan);
  if (violation != "") {
    return migrateErr("", violation);
  }
  if (!versionValid(version)) {
    return migrateErr(version, "baseline version \"" + version + "\" is not a dotted number");
  }
  let created = createHistory(db);
  if (!created.ok) {
    return migrateErr(version, created.error);
  }
  let rank = nextRank(db);
  let marked: int = 0;
  let order = planOrder(plan);
  let n: int = 0;
  while (n < order.length) {
    let m = plan[order[n]];
    if (m.version != "" && compareVersions(m.version, version) <= 0) {
      if (!historyHas(db, m.version, m.description)) {
        let r = writeHistory(db, m, rank, false);
        if (!r.ok) {
          return migrateErr(m.version, r.error);
        }
        rank = rank + 1;
        marked = marked + 1;
      }
    }
    n = n + 1;
  }
  return migrateOk(marked);
}

// Whether a step with this version has run. The name rather than the version
// identifies a repeatable one, so pass its description as the version.
//
// A repeatable step is stored with an empty version and its description, so
// matching on `version` alone answered false for every one of them, whatever
// was passed — and a guard written on it did its work again on every boot.
// Both columns are searched, and the empty version is what keeps a versioned
// step from answering for a repeatable one that shares its text.
export function migrationApplied(db: Db, version: string): bool {
  let sql = "SELECT 1 FROM " + historyTable()
    + " WHERE version = " + placeholderAt(db, 1)
    + " OR (version = '' AND description = " + placeholderAt(db, 2) + ")";
  if (!db.query(sql, [version, version])) {
    return false;
  }
  return db.rows() > 0;
}

// Drop the history, for a test that wants to start over. Named for what it
// does rather than for what it is for.
export function forgetMigrations(db: Db): DbResult {
  if (!safeIdentifier(historyTable())) {
    return execute(db, "SELECT 1");
  }
  return execute(db, "DROP TABLE IF EXISTS " + historyTable());
}
