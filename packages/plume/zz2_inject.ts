// Does quoted() hold on MySQL, where backslash escapes inside a string literal?
import { Db } from "./driver.ts";
import { mysql } from "./mysql.ts";
import { execute } from "./plume.ts";
import { Migration, migration, migrate, repairChecksums, forgetMigrations, historyTable, quoted } from "./migrate.ts";

let database: Db = mysql();

function show(label: string, sql: string): void {
  if (!database.queryNoArgs(sql)) {
    console.log(label + " -> ERROR: " + database.lastError());
    return;
  }
  let out = "";
  let i: int = 0;
  while (i < database.rows()) {
    out = out + "[" + database.value(i, 0) + "|" + database.value(i, 1) + "|" + database.value(i, 2) + "] ";
    i = i + 1;
  }
  console.log(label + " -> rows=" + `${database.rows()}` + " " + out);
}

database.connect("host=127.0.0.1 port=13306 user=root password=lumen dbname=lumentest");
forgetMigrations(database);
execute(database, "DROP TABLE IF EXISTS mig_z1");
execute(database, "DROP TABLE IF EXISTS mig_z2");

let honest: Migration[] = [
  migration("1", "create z1", "CREATE TABLE mig_z1 (id varchar(64) PRIMARY KEY)"),
  migration("2", "create z2", "CREATE TABLE mig_z2 (id varchar(64) PRIMARY KEY)"),
];
let r = migrate(database, honest);
console.log("honest migrate ok=" + `${r.ok}` + " applied=" + `${r.applied}` + " err=" + r.error);
show("history before", "SELECT version, description, checksum FROM " + historyTable() + " ORDER BY installed_rank");

// The payload. quoted() only doubles the quote; MySQL also honours backslash.
let payload = "zz\\' OR 1=1 -- ";
console.log("payload      = [" + payload + "]");
console.log("quoted()     = " + quoted(payload));

// What the database makes of the literal quoted() produced.
show("literal test", "SELECT " + quoted(payload) + " AS a, 'x' AS b, 'y' AS c");

// The same text reaching a WHERE, exactly as historyHas builds it.
show("injected WHERE", "SELECT version, description, checksum FROM " + historyTable()
  + " WHERE version = '9' AND description = " + quoted(payload));

// And through the public API: repairChecksums writes an UPDATE with quoted().
let evil: Migration[] = [
  migration("9", payload, "SELECT 1"),
];
let rr = repairChecksums(database, evil);
console.log("repairChecksums ok=" + `${rr.ok}` + " err=" + rr.error);
show("history after", "SELECT version, description, checksum FROM " + historyTable() + " ORDER BY installed_rank");
database.close();
