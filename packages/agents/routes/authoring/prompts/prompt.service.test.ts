import { Db, DbConfig } from "../../../../plume/driver.ts";
import { sqlite } from "../../../../plume/sqlite.ts";
import { connectDatabase, createTableSql, execute } from "../../../../plume/plume.ts";
import { PromptService } from "./prompt.service.ts";
import { PromptRecord } from "./dtos/prompt-body.dto.ts";
import { promptRepository } from "./entities/prompt.entity.ts";

// A real sqlite file, the same shape project-tools.test.ts opens: prompts and
// row_owners, without the rest of the production schema this service never
// touches.
let database: Db = sqlite();
let opened = false;

function fresh(): Db {
  if (!opened) {
    let file = "/tmp/agents_prompt_service_test.db";
    let cfg: DbConfig = { filename: file };
    connectDatabase(database, cfg);
    opened = true;
  }
  execute(database, "DROP TABLE IF EXISTS prompts");
  execute(database, "DROP TABLE IF EXISTS row_owners");
  execute(database, createTableSql(database, promptRepository()));
  execute(database, "CREATE TABLE row_owners (kind TEXT NOT NULL, row_id TEXT NOT NULL, owner TEXT NOT NULL)");
  return database;
}

function seed(db: Db): void {
  // The deployment's prompt: no row_owners row.
  execute(db, "INSERT INTO prompts (id, prompt_name, version, body, created_at)"
    + " VALUES ('p-deploy', 'assistant', 1, 'the system prompt, which is the operator''s', 'now')");
  // Ann's own prompt.
  execute(db, "INSERT INTO prompts (id, prompt_name, version, body, created_at)"
    + " VALUES ('p-ann', 'my-helper', 1, 'ann wrote this', 'now')");
  execute(db, "INSERT INTO row_owners (kind, row_id, owner) VALUES ('prompt', 'p-ann', 'u-ann')");
}

test("a signed-in caller is shown the deployment's prompt by name, but its body comes back empty", () => {
  let db = fresh();
  seed(db);
  let service = new PromptService(db);
  let rows: PromptRecord[] = JSON.parse<PromptRecord[]>(service.listing("u-ann", "", false));
  expect(rows.length == 2);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].id == "p-deploy") {
      expect(rows[i].promptName == "assistant");
      expect(rows[i].body == "");
    }
    if (rows[i].id == "p-ann") {
      expect(rows[i].body == "ann wrote this");
    }
    i = i + 1;
  }
});

test("filing as the deployment reads the deployment's bodies in full", () => {
  let db = fresh();
  seed(db);
  let service = new PromptService(db);
  let rows: PromptRecord[] = JSON.parse<PromptRecord[]>(service.listing("", "", false));
  expect(rows.length == 1);
  expect(rows[0].id == "p-deploy");
  expect(rows[0].body == "the system prompt, which is the operator's");
});

test("the by-name listing withholds the same way as the plain one", () => {
  let db = fresh();
  seed(db);
  let service = new PromptService(db);
  let rows: PromptRecord[] = JSON.parse<PromptRecord[]>(service.listing("u-ann", "assistant", false));
  expect(rows.length == 1);
  expect(rows[0].body == "");
});

test("another caller's own listing never carries somebody else's rows, blanked or not", () => {
  let db = fresh();
  seed(db);
  let service = new PromptService(db);
  let rows: PromptRecord[] = JSON.parse<PromptRecord[]>(service.listing("u-bob", "", true));
  expect(rows.length == 0);
});
