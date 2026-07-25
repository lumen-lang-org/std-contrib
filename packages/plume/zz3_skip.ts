// A migration that never runs, is never recorded, and is reported as applied.
import { Db } from "./driver.ts";
import { mysql } from "./mysql.ts";
import { execute } from "./plume.ts";
import { Migration, migration, migrate, migrationInfo, checksum, forgetMigrations, historyTable } from "./migrate.ts";

let database: Db = mysql();

function tableExists(name: string): bool {
  database.queryNoArgs("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'lumentest' AND table_name = '" + name + "'");
  return database.value(0, 0) != "0";
}

database.connect("host=127.0.0.1 port=13306 user=root password=lumen dbname=lumentest");
forgetMigrations(database);
execute(database, "DROP TABLE IF EXISTS mig_z3");

let body = "CREATE TABLE mig_z3 (id varchar(64) PRIMARY KEY)";
let sum = checksum(body);
console.log("plan checksum = " + `${sum}`);

// A description crafted so historyHas and recordedChecksum both lie.
let desc = "step\\' UNION SELECT " + `${sum}` + " -- ";
let plan: Migration[] = [ migration("7", desc, body) ];

let info = migrationInfo(database, plan);
console.log("info[0].status  = " + info[0].status);
console.log("info[0].recorded= " + `${info[0].recorded}`);

let r = migrate(database, plan);
console.log("migrate ok=" + `${r.ok}` + " applied=" + `${r.applied}` + " err=" + r.error);
console.log("mig_z3 exists?  = " + `${tableExists("mig_z3")}`);
database.queryNoArgs("SELECT count(*) FROM " + historyTable());
console.log("history rows    = " + database.value(0, 0));
database.close();
