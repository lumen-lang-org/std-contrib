import { Db, noDatabase } from "./driver.ts";
import { Migration, migration, migrate, validateMigrations, planOrder, migrationInfo } from "./migrate.ts";

let dead: Db = noDatabase();

let plan: Migration[] = [
  migration("1", "create a", "CREATE TABLE mig_a (id text PRIMARY KEY)"),
];

console.log("validateMigrations says: [" + validateMigrations(dead, plan) + "]");
console.log("migrationInfo length: " + `${migrationInfo(dead, plan).length}`);
console.log("planOrder length: " + `${planOrder(plan).length}`);
let r = migrate(dead, plan);
console.log("migrate ok=" + `${r.ok}` + " error=" + r.error);
