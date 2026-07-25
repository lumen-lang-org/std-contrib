import { Db } from "./driver.ts";
import { postgres } from "./postgres.ts";
import { sqlite } from "./sqlite.ts";
import { mysql } from "./mysql.ts";
import { DbField, DbRepository, field, repository, createTable, dropTable, persist, persistMany, findById, listWhere, countWhere, execute, repositoryValid } from "./plume.ts";

function wideRepo(n: int): DbRepository {
  let fs: DbField[] = [ field("id", "id", "text") ];
  let i: int = 0;
  while (i < n) {
    fs = fs.concat([field("f" + `${i}`, "f" + `${i}`, "int")]);
    i = i + 1;
  }
  return repository("zz_wide", "id", "id", fs);
}

function wideJson(n: int): string {
  let out = "{\"id\":\"w1\"";
  let i: int = 0;
  while (i < n) { out = out + ",\"f" + `${i}` + "\":" + `${i}`; i = i + 1; }
  return out + "}";
}

function bigRepo(t: string): DbRepository {
  let fs: DbField[] = [ field("id", "id", "text"), field("blob", "blob", t) ];
  return repository("zz_big", "id", "id", fs);
}

function rep(s: string, k: int): string {
  let out = "";
  let acc = s;
  let i: int = 0;
  while (i < k) { out = out + acc; i = i + 1; }
  return out;
}

function rowsRepo(): DbRepository {
  let fs: DbField[] = [ field("id", "id", "text"), field("n", "n", "int") ];
  return repository("zz_many", "id", "id", fs);
}

function probe(label: string, conn: Db, target: string, idType: string, bigType: string): void {
  console.log("");
  console.log("=== " + label + " ===");
  if (!conn.connect(target)) { console.log("  connect failed"); return; }

  // 100 fields
  let w = wideRepo(100);
  console.log("  repositoryValid(100 fields) = " + `${repositoryValid(w)}`);
  dropTable(conn, w);
  let cw = createTable(conn, w);
  console.log("  createTable ok=" + `${cw.ok}` + " err=" + cw.error.slice(0, 90));
  let pw = persist(conn, w, wideJson(100));
  console.log("  persist ok=" + `${pw.ok}` + " err=" + pw.error.slice(0, 90));
  let bw = findById(conn, w, "w1");
  console.log("  findById bytes=" + `${bw.length}` + " tail=" + bw.slice(bw.length - 20, bw.length));
  dropTable(conn, w);

  // one large document
  let b = bigRepo(bigType);
  dropTable(conn, b);
  execute(conn, "CREATE TABLE zz_big (id " + idType + " PRIMARY KEY, blob " + bigType + ")");
  let payload = rep(rep("0123456789", 1000), 100); // 1,000,000 bytes
  console.log("  payload bytes = " + `${payload.length}`);
  let pb = persist(conn, b, "{\"id\":\"b1\",\"blob\":\"" + payload + "\"}");
  console.log("  persist(1MB) ok=" + `${pb.ok}` + " err=" + pb.error.slice(0, 90));
  let rb = findById(conn, b, "b1");
  console.log("  findById(1MB) bytes=" + `${rb.length}`);
  dropTable(conn, b);

  // 10000 rows aggregated into one array
  let m = rowsRepo();
  dropTable(conn, m);
  createTable(conn, m);
  let batch: int = 0;
  while (batch < 20) {
    let arr = "[";
    let k: int = 0;
    while (k < 500) {
      let id = batch * 500 + k;
      if (k > 0) { arr = arr + ","; }
      arr = arr + "{\"id\":\"r" + `${id}` + "\",\"n\":" + `${id}` + "}";
      k = k + 1;
    }
    arr = arr + "]";
    let pm = persistMany(conn, m, arr);
    if (!pm.ok) { console.log("  persistMany batch " + `${batch}` + " failed: " + pm.error.slice(0, 90)); }
    batch = batch + 1;
  }
  console.log("  countWhere = " + `${countWhere(conn, m, "", "")}`);
  let all = listWhere(conn, m, "", "");
  console.log("  listWhere(no args) bytes=" + `${all.length}` + " tail=" + all.slice(all.length - 24, all.length));
  let some = listWhere(conn, m, "n >= " + conn.placeholder, "0");
  console.log("  listWhere(bound)   bytes=" + `${some.length}` + " tail=" + some.slice(some.length - 24, some.length));
  dropTable(conn, m);
  conn.close();
}

let pg: Db = postgres();
let sq: Db = sqlite();
let my: Db = mysql();

probe("postgres", pg, "host=127.0.0.1 user=lumen password=lumen dbname=lumenvec", "text", "text");
probe("sqlite", sq, "/tmp/claude-1000/-home-ubuntu-projects/d7a464b1-451d-46f9-a4ea-42eb8304004d/scratchpad/zz8.db", "text", "text");
probe("mysql", my, "host=127.0.0.1 port=13306 user=root password=lumen dbname=lumentest", "varchar(64)", "longtext");
