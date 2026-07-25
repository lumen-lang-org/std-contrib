import { Db } from "./driver.ts";
import { postgres } from "./postgres.ts";
import { sqlite } from "./sqlite.ts";
import { mysql } from "./mysql.ts";
import { DbField, DbRepository, field, repository, createTable, dropTable, persist, findById, execute, safeSqlType, repositoryValid, listWhere } from "./plume.ts";

function injRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    // safeSqlType() lets letters, digits, underscore, space, ( ) and , through.
    field("n", "n", "int DEFAULT (0) , smuggled int"),
  ];
  return repository("zz_inj", "id", "id", fs);
}

function kwRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("order", "order", "text"),
  ];
  return repository("zz_kw", "id", "id", fs);
}

function nestRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("doc", "doc", "text"),
  ];
  return repository("zz_nest", "id", "id", fs);
}

function probe(label: string, conn: Db, target: string, listCols: string): void {
  console.log("");
  console.log("=== " + label + " ===");
  if (!conn.connect(target)) { console.log("  connect failed: " + conn.lastError()); return; }

  // 1. a SQL type that smuggles a second column definition
  let r1 = injRepo();
  console.log("  repositoryValid(smuggling type) = " + `${repositoryValid(r1)}`);
  dropTable(conn, r1);
  let c1 = createTable(conn, r1);
  console.log("  createTable ok=" + `${c1.ok}` + " err=" + c1.error.slice(0, 80));
  if (conn.queryNoArgs(listCols)) {
    let cols = "";
    let i: int = 0;
    while (i < conn.rows()) { cols = cols + conn.value(i, 0) + " "; i = i + 1; }
    console.log("  zz_inj columns = " + cols);
  }
  dropTable(conn, r1);

  // 2. a field/column that is a reserved word
  let r2 = kwRepo();
  dropTable(conn, r2);
  let c2 = createTable(conn, r2);
  console.log("  createTable(order) ok=" + `${c2.ok}` + " err=" + c2.error.slice(0, 90));
  if (c2.ok) {
    let p = persist(conn, r2, "{\"id\":\"k1\",\"order\":\"first\"}");
    console.log("  persist(order) ok=" + `${p.ok}` + " err=" + p.error.slice(0, 90));
    console.log("  findById       = " + findById(conn, r2, "k1"));
  }
  dropTable(conn, r2);

  // 3. a JSON document whose field is a nested object / array
  let r3 = nestRepo();
  dropTable(conn, r3);
  createTable(conn, r3);
  let p3 = persist(conn, r3, "{\"id\":\"n1\",\"doc\":{\"a\":1,\"b\":[2,3]}}");
  console.log("  persist(nested obj) ok=" + `${p3.ok}` + " err=" + p3.error.slice(0, 90));
  console.log("  findById(n1)   = " + findById(conn, r3, "n1"));
  let p4 = persist(conn, r3, "{\"id\":\"n2\",\"doc\":[1,2,3]}");
  console.log("  persist(nested arr) ok=" + `${p4.ok}` + " err=" + p4.error.slice(0, 90));
  console.log("  findById(n2)   = " + findById(conn, r3, "n2"));
  dropTable(conn, r3);
  conn.close();
}

let pg: Db = postgres();
let sq: Db = sqlite();
let my: Db = mysql();

probe("postgres", pg, "host=127.0.0.1 user=lumen password=lumen dbname=lumenvec",
  "SELECT column_name FROM information_schema.columns WHERE table_name = 'zz_inj' ORDER BY ordinal_position");
probe("sqlite", sq, "/tmp/claude-1000/-home-ubuntu-projects/d7a464b1-451d-46f9-a4ea-42eb8304004d/scratchpad/zz6.db",
  "SELECT name FROM pragma_table_info('zz_inj')");
probe("mysql", my, "host=127.0.0.1 port=13306 user=root password=lumen dbname=lumentest",
  "SELECT column_name FROM information_schema.columns WHERE table_schema = 'lumentest' AND table_name = 'zz_inj' ORDER BY ordinal_position");
