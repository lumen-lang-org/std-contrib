import { Db } from "./driver.ts";
import { sqlite } from "./sqlite.ts";
import { mysql } from "./mysql.ts";
import { DbField, DbRepository, field, repository, createTable, dropTable, persist, findById, listWhere, countWhere, execute, pageWhere } from "./plume.ts";

function wideRepo(n: int): DbRepository {
  let fs: DbField[] = [ field("id", "id", "text") ];
  let i: int = 0;
  while (i < n) { fs = fs.concat([field("f" + `${i}`, "f" + `${i}`, "int")]); i = i + 1; }
  return repository("zz_wide", "id", "id", fs);
}

function wideJson(n: int): string {
  let out = "{\"id\":\"w1\"";
  let i: int = 0;
  while (i < n) { out = out + ",\"f" + `${i}` + "\":" + `${i}`; i = i + 1; }
  return out + "}";
}

let sq: Db = sqlite();
sq.connect("/tmp/claude-1000/-home-ubuntu-projects/d7a464b1-451d-46f9-a4ea-42eb8304004d/scratchpad/zz9.db");

let widths: int[] = [40, 60, 62, 63, 64, 70, 100];
let k: int = 0;
while (k < widths.length) {
  let n = widths[k];
  let w = wideRepo(n);
  dropTable(sq, w);
  let c = createTable(sq, w);
  let p = persist(sq, w, wideJson(n));
  let got = findById(sq, w, "w1");
  let lst = listWhere(sq, w, "", "");
  let cnt = countWhere(sq, w, "", "");
  console.log("sqlite fields=" + `${n + 1}`
    + " create=" + `${c.ok}` + " persist=" + `${p.ok}`
    + " findById.len=" + `${got.length}`
    + " listWhere.len=" + `${lst.length}`
    + " count=" + `${cnt}`
    + " lastError=" + sq.lastError().slice(0, 70));
  dropTable(sq, w);
  k = k + 1;
}
sq.close();

// The 1MB document again, with a column name that is not a MySQL keyword.
let my: Db = mysql();
my.connect("host=127.0.0.1 port=13306 user=root password=lumen dbname=lumentest");
let bf: DbField[] = [ field("id", "id", "text"), field("payload", "payload", "longtext") ];
let big = repository("zz_big2", "id", "id", bf);
dropTable(my, big);
execute(my, "CREATE TABLE zz_big2 (id varchar(64) PRIMARY KEY, payload longtext)");
let sizes: int[] = [1000, 100000, 1000000, 8000000];
let j: int = 0;
while (j < sizes.length) {
  let unit = "0123456789";
  let s = "";
  while (s.length < sizes[j]) { s = s + unit; }
  let r = persist(my, big, "{\"id\":\"b" + `${j}` + "\",\"payload\":\"" + s + "\"}");
  let back = findById(my, big, "b" + `${j}`);
  console.log("mysql payload=" + `${s.length}` + " persist=" + `${r.ok}`
    + " err=" + r.error.slice(0, 70) + " readback.len=" + `${back.length}`);
  j = j + 1;
}
dropTable(my, big);
my.close();
