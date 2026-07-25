// Many-to-many through a link table, including the self-referential case: an
// agent's sub-agents are agents.
//
//   cd packages/plume && lumen test linkrelations_pg.test.ts

import { Db, DbConfig } from "./driver.ts";
import { postgres } from "./postgres.ts";
import { DbField, DbRelation, DbRepository, field, repository, repositoryWith, hasManyThrough, relationValid, connectDatabase, createTable, dropTable, persist, findById, listWhere, countWhere, execute } from "./plume.ts";

let database: Db = postgres();

type AgentRow = { id: string, agentName: string };
type ServerRow = { id: string, serverName: string, url: string };

function agentsFlat(): DbRepository {
  let fs: DbField[] = [ field("id", "id", "text"), field("agentName", "agent_name", "text") ];
  return repository("lk_agents", "id", "id", fs);
}

function serversRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("serverName", "server_name", "text"),
    field("url", "url", "text"),
  ];
  return repository("lk_servers", "id", "id", fs);
}

// An agent, its MCP servers, and its sub-agents — both through link tables,
// and the second pointing back at the same table it lives in.
function agentsRepo(): DbRepository {
  let rs: DbRelation[] = [
    hasManyThrough("servers", "lk_servers", "id",
                   "lk_agent_servers", "agent_id", "server_id",
                   "id", "id, server_name AS \"serverName\", url"),
    hasManyThrough("subAgents", "lk_agents", "id",
                   "lk_agent_children", "parent_id", "child_id",
                   "id", "id, agent_name AS \"agentName\""),
  ];
  return repositoryWith("lk_agents", "id", "id", agentsFlat().fields, rs);
}

function seeded(): DbRepository {
  let fromEnv = process.env("PLUME_TEST_CONNINFO") ?? "";
  let cfg: DbConfig = { host: "127.0.0.1", user: "lumen", password: "lumen", database: "lumenvec" };
  if (fromEnv != "") { cfg = { options: fromEnv }; }
  connectDatabase(database, cfg);
  execute(database, "DROP TABLE IF EXISTS lk_agent_children");
  execute(database, "DROP TABLE IF EXISTS lk_agent_servers");
  dropTable(database, agentsFlat());
  dropTable(database, serversRepo());
  createTable(database, agentsFlat());
  createTable(database, serversRepo());
  execute(database, "CREATE TABLE lk_agent_servers (agent_id varchar(64) NOT NULL, server_id varchar(64) NOT NULL)");
  execute(database, "CREATE TABLE lk_agent_children (parent_id varchar(64) NOT NULL, child_id varchar(64) NOT NULL)");

  let lead: AgentRow = { id: "a1", agentName: "lead" };
  let scout: AgentRow = { id: "a2", agentName: "scout" };
  let writer: AgentRow = { id: "a3", agentName: "writer" };
  persist(database, agentsFlat(), JSON.stringify(lead));
  persist(database, agentsFlat(), JSON.stringify(scout));
  persist(database, agentsFlat(), JSON.stringify(writer));

  let fs: ServerRow = { id: "s1", serverName: "filesystem", url: "stdio://fs" };
  let gh: ServerRow = { id: "s2", serverName: "github", url: "https://mcp.gh" };
  persist(database, serversRepo(), JSON.stringify(fs));
  persist(database, serversRepo(), JSON.stringify(gh));

  execute(database, "INSERT INTO lk_agent_servers VALUES ('a1','s1'),('a1','s2'),('a2','s1')");
  execute(database, "INSERT INTO lk_agent_children VALUES ('a1','a2'),('a1','a3')");
  return agentsRepo();
}

// --- offline ----------------------------------------------------------------

test("a link relation states both halves of the join", () => {
  let r = hasManyThrough("servers", "lk_servers", "id", "lk_agent_servers", "agent_id", "server_id", "id", "id");
  expect(r.kind == "many");
  expect(r.linkTable == "lk_agent_servers");
  expect(r.linkLocalColumn == "agent_id");
  expect(r.linkForeignColumn == "server_id");
  expect(relationValid(r));
});

test("an unsafe name anywhere in the join refuses the relation", () => {
  expect(!relationValid(hasManyThrough("s", "lk_servers", "id", "x; DROP TABLE y", "agent_id", "server_id", "id", "id")));
  expect(!relationValid(hasManyThrough("s", "lk_servers", "id", "lk_agent_servers", "agent_id; --", "server_id", "id", "id")));
  expect(!relationValid(hasManyThrough("s", "lk_servers", "id", "lk_agent_servers", "agent_id", "server_id) --", "id", "id")));
});

test("a to-one through a link table is refused, since a link yields many", () => {
  let odd: DbRelation = { field: "s", kind: "one", table: "lk_servers", localColumn: "id", foreignColumn: "id", columns: "id", linkTable: "lk_agent_servers", linkLocalColumn: "agent_id", linkForeignColumn: "server_id" };
  expect(!relationValid(odd));
});

// --- against the database ----------------------------------------------------

test("a many-to-many arrives as an array", () => {
  let repo = seeded();
  let json = findById(database, repo, "a1");
  expect(json.indexOf("filesystem") >= 0);
  expect(json.indexOf("github") >= 0);
});

test("only the rows the link table names come back", () => {
  let repo = seeded();
  // a2 is linked to s1 only.
  let json = findById(database, repo, "a2");
  expect(json.indexOf("filesystem") >= 0);
  expect(json.indexOf("github") < 0);
});

test("a row with no links gets an empty array, not a failure", () => {
  let repo = seeded();
  let json = findById(database, repo, "a3");
  expect(json.indexOf("[]") >= 0);
});

test("a self-referential link works: an agent's sub-agents are agents", () => {
  let repo = seeded();
  let json = findById(database, repo, "a1");
  // a1's children are a2 and a3, by name.
  expect(json.indexOf("scout") >= 0);
  expect(json.indexOf("writer") >= 0);
  // And a1 is not its own child.
  // Split across statements because nesting a substring inside another's
  // arguments hits spec 464 — the compiler emits one temporary name twice.
  let at = json.indexOf("\"subAgents\"");
  let subs = json.substring(at, json.length);
  expect(subs.indexOf("lead") < 0);
});

test("a child agent has no children of its own", () => {
  let repo = seeded();
  let json = findById(database, repo, "a2");
  let at = json.indexOf("\"subAgents\"");
  let subs = json.substring(at, json.length);
  expect(subs.indexOf("scout") < 0);
  expect(subs.indexOf("writer") < 0);
});

test("both relations arrive on the same record", () => {
  let repo = seeded();
  let json = findById(database, repo, "a1");
  expect(json.indexOf("\"servers\"") >= 0);
  expect(json.indexOf("\"subAgents\"") >= 0);
  expect(json.indexOf("\"agentName\":\"lead\"") >= 0 || json.indexOf("\"agentName\": \"lead\"") >= 0);
});

test("a list carries every row's links without multiplying the rows", () => {
  let repo = seeded();
  // a1 has two servers and two children; a join would return it four times.
  expect(countWhere(database, repo, "", []) == 3);
  let json = listWhere(database, repo, "", []);
  expect(json.indexOf("lead") == json.lastIndexOf("lead"));
});

test("the suite leaves nothing behind", () => {
  let fromEnv = process.env("PLUME_TEST_CONNINFO") ?? "";
  let cfg: DbConfig = { host: "127.0.0.1", user: "lumen", password: "lumen", database: "lumenvec" };
  if (fromEnv != "") { cfg = { options: fromEnv }; }
  connectDatabase(database, cfg);
  execute(database, "DROP TABLE IF EXISTS lk_agent_children");
  execute(database, "DROP TABLE IF EXISTS lk_agent_servers");
  expect(dropTable(database, agentsFlat()).ok);
  expect(dropTable(database, serversRepo()).ok);
  database.close();
});
