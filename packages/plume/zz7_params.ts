import { Db } from "./driver.ts";
import { postgres } from "./postgres.ts";
import { sqlite } from "./sqlite.ts";
import { mysql } from "./mysql.ts";
import { DbField, DbRepository, field, repository, createTable, dropTable, persist, listWhere, countWhere, deleteWhere, execute } from "./plume.ts";

function pRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("name", "name", "text"),
  ];
  return repository("zz_par", "id", "id", fs);
}

function probe(label: string, conn: Db, target: string, twice: string): void {
  console.log("");
  console.log("=== " + label + " ===");
  if (!conn.connect(target)) { console.log("  connect failed"); return; }
  let repo = pRepo();
  dropTable(conn, repo);
  createTable(conn, repo);
  persist(conn, repo, "{\"id\":\"p1\",\"name\":\"p1\"}");
  persist(conn, repo, "{\"id\":\"p2\",\"name\":\"other\"}");

  // A where clause that names the bound value twice. On every driver this
  // should match exactly p1.
  let w = "id = " + twice + " AND name = " + twice;
  console.log("  where: " + w);
  console.log("  listWhere  = " + listWhere(conn, repo, w, "p1"));
  console.log("  countWhere = " + `${countWhere(conn, repo, w, "p1")}`);
  console.log("  lastError  = " + conn.lastError().slice(0, 100));
  dropTable(conn, repo);
  conn.close();
}

let pg: Db = postgres();
let sq: Db = sqlite();
let my: Db = mysql();

let PGT = "host=127.0.0.1 user=lumen password=lumen dbname=lumenvec";
let SQT = "/tmp/claude-1000/-home-ubuntu-projects/d7a464b1-451d-46f9-a4ea-42eb8304004d/scratchpad/zz7.db";
let MYT = "host=127.0.0.1 port=13306 user=root password=lumen dbname=lumentest";

// Each driver's own documented placeholder, used twice.
probe("postgres $1 twice", pg, PGT, "$1");
probe("sqlite ?1 twice", sq, SQT, "?1");
probe("mysql ? twice", my, MYT, "?");
// And the portable-looking bare `?` on sqlite, which is what a MySQL-shaped
// fragment looks like.
probe("sqlite bare ? twice", sq, SQT, "?");
