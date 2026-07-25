// The same operations on all three drivers, compared value by value.
import { Db } from "./driver.ts";
import { postgres } from "./postgres.ts";
import { sqlite } from "./sqlite.ts";
import { mysql } from "./mysql.ts";
import { DbField, DbRepository, field, repository, createTable, dropTable, persist, persistMany, findById, listWhere, countWhere, execute, listProjected, findProjected, pageWhere, deleteWhere } from "./plume.ts";

type Row = {
  id: string,
  name: string,
  n: int,
  x: number,
};

function rowRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("name", "name", "text"),
    field("n", "n", "int"),
    field("x", "x", "float8"),
  ];
  return repository("zz_dialect", "id", "id", fs);
}

function repeatStr(s: string, k: int): string {
  let out = "";
  let i: int = 0;
  while (i < k) { out = out + s; i = i + 1; }
  return out;
}

function probe(label: string, conn: Db, target: string): void {
  console.log("");
  console.log("=== " + label + " ===");
  if (!conn.connect(target)) { console.log("  connect failed: " + conn.lastError()); return; }
  let repo = rowRepo();
  dropTable(conn, repo);
  let ct = createTable(conn, repo);
  console.log("  createTable ok=" + `${ct.ok}` + " " + ct.error);

  let cases: string[] = [
    "{\"id\":\"c1\",\"name\":\"\",\"n\":0,\"x\":0}",
    "{\"id\":\"c2\",\"name\":\"it's\",\"n\":-7,\"x\":-0.5}",
    "{\"id\":\"c3\",\"name\":\"a\\\\b\",\"n\":1,\"x\":0.1}",
    "{\"id\":\"c4\",\"name\":\"a\\nb\",\"n\":2,\"x\":0.3333333333333333}",
    "{\"id\":\"c5\",\"name\":\"héllo 🚀\",\"n\":3,\"x\":1e308}",
    "{\"id\":\"c6\",\"name\":\"" + repeatStr("z", 300) + "\",\"n\":4,\"x\":1}",
    "{\"id\":\"c7\",\"name\":\"nul\\u0000here\",\"n\":5,\"x\":1}",
    "{\"id\":\"c8\",\"name\":\"tab\\ttab\",\"n\":6,\"x\":123456789.123456789}",
  ];
  let i: int = 0;
  while (i < cases.length) {
    let r = persist(conn, repo, cases[i]);
    let back = findById(conn, repo, "c" + `${i + 1}`);
    let shown = back;
    if (shown.length > 90) { shown = shown.slice(0, 90) + "...(" + `${shown.length}` + " bytes)"; }
    console.log("  c" + `${i + 1}` + " persist=" + `${r.ok}` + " err=" + r.error.slice(0, 60) + " | read=" + shown);
    i = i + 1;
  }
  console.log("  count = " + `${countWhere(conn, repo, "", "")}`);
  console.log("  listProjected(coalesce) = " + listProjected(conn, repo, "coalesce(name, 'none') AS nm", "", "").slice(0, 120));
  console.log("  listProjected(plain)    = " + listProjected(conn, repo, "id AS \"id\"", "", "").slice(0, 120));
  // Two placeholders in a user where clause, one bound value.
  let two = listWhere(conn, repo, "n = " + conn.placeholder + " OR n = " + conn.placeholder, "0");
  console.log("  two placeholders        = " + two.slice(0, 160));
  dropTable(conn, repo);
  conn.close();
}

let pg: Db = postgres();
let sq: Db = sqlite();
let my: Db = mysql();

probe("postgres", pg, "host=127.0.0.1 user=lumen password=lumen dbname=lumenvec");
probe("sqlite", sq, "/tmp/claude-1000/-home-ubuntu-projects/d7a464b1-451d-46f9-a4ea-42eb8304004d/scratchpad/zz.db");
probe("mysql", my, "host=127.0.0.1 port=13306 user=root password=lumen dbname=lumentest");
