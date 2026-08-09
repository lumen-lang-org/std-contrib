// Secrets a workflow step may send but never hold, against a live database.
//
//   cd packages/agents && lumen test secrets.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute, dropTable, findById } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { agentsMapping, credentialsMapping, mcpServersMapping, modelConfigsMapping, modelsMapping, promptsMapping, schemaPlan } from "./schema.ts";
import { hasCredential } from "./credentials.ts";
import { SecretRow, createSecret, forgetSecret, graphSecretProblem, secretById, secretByName, secretValue, secretsMapping, secretsOf, secretsPlan, touchSecret, MAX_SECRETS_PER_OWNER } from "./secrets.ts";
import { WfEdge, WfGraph, WfNode, emptyGraph, emptyNode, secretIds } from "../workflow/workflow.ts";

let database: Db = sqlite();

function testKey(): string {
  return "0123456789abcdef0123456789abcdef";
}

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_secrets_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  // Everything the plan creates or ALTERs — credentials.test.ts's list: a
  // table left standing stops the plan at its CREATE, and a stopped plan
  // takes 109 (the one this suite is about) with it.
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  // The rest of what schemaPlan ALTERs — a column added to a standing table
  // is a duplicate on the second fresh(), and the stopped plan takes 109
  // (the one this suite is about) with it.
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP TABLE IF EXISTS auth_providers");
  execute(database, "DROP TABLE IF EXISTS script_images");
  dropTable(database, secretsMapping());
  // One plan, extended — api.ts's rule: a second migrate() call is handed a
  // plan that lacks the versions already recorded, and refuses everything.
  let plan = schemaPlan(database);
  let extra = secretsPlan(database);
  let i: int = 0;
  while (i < extra.length) { plan.push(extra[i]); i = i + 1; }
  migrate(database, plan);
}

function stored(name: string, owner: string): string {
  let made = createSecret(database, {
    owner: owner, name: name, value: "Bearer sk-test-0001",
    destination: "https://api.example.com/v1/anything?x=1", header: "", category: "",
    master: testKey(), now: "t1",
  });
  // A failure here surfaces as the caller's own expects failing on "".
  return made.id;
}

// An HTTP node aimed somewhere, carrying a secret — built whole, records
// are immutable.
function httpNode(url: string, secretId: string): WfNode {
  let base = emptyNode();
  let n: WfNode = {
    id: "h1", type: "HTTP", name: "Call the API", x: 0.0, y: 0.0,
    instruction: "", agentId: "", serverId: "", tool: "", args: "",
    url: url, method: "GET", body: "", query: "",
    test: "", needle: "", subject: base.subject, schedule: "", source: "",
    // The list field, which is what a step carries now; the single-secret
    // spelling below it is covered by its own test.
    secrets: secretId,
  };
  return n;
}

function graphWith(node: WfNode): WfGraph {
  let g = emptyGraph();
  let nodes: WfNode[] = [];
  nodes.push(node);
  let built: WfGraph = { nodes: nodes, edges: g.edges, view: g.view };
  return built;
}

// --- the row and the value ---------------------------------------------------

test("a stored secret lists by name and opens only through the runner's door", () => {
  fresh();
  let id = stored("stripe key", "o1");
  let listed = secretsOf(database, "o1");
  expect(listed.indexOf("stripe key") >= 0);
  // The destination was reduced to its origin; the path did not survive.
  expect(listed.indexOf("https://api.example.com") >= 0);
  expect(listed.indexOf("/v1/anything") < 0);
  // The value is nowhere in either table's rows as stored.
  expect(listed.indexOf("sk-test") < 0);
  expect(findById(database, secretsMapping(), id).indexOf("sk-test") < 0);
  // The runner opens it; the header defaulted.
  let row = secretById(database, id, "o1");
  expect(row.header == "Authorization");
  expect(secretValue(database, row, testKey()) == "Bearer sk-test-0001");
});

test("somebody else's secret is absent, not forbidden", () => {
  fresh();
  let id = stored("stripe key", "o1");
  expect(secretById(database, id, "o2").id == "");
  expect(secretByName(database, "stripe key", "o2").id == "");
  expect(secretsOf(database, "o2") == "[]");
  // And absent means undeletable too.
  expect(!forgetSecret(database, id, "o2"));
  expect(secretById(database, id, "o1").id == id);
});

test("deleting a secret takes its envelope with it", () => {
  fresh();
  let id = stored("stripe key", "o1");
  expect(hasCredential(database, "secret:" + id));
  expect(forgetSecret(database, id, "o1"));
  expect(!hasCredential(database, "secret:" + id));
  expect(secretById(database, id, "o1").id == "");
});

test("what a secret refuses at the door", () => {
  fresh();
  // No name, no destination, a header with a colon, an empty value.
  expect(createSecret(database, { owner: "o1", name: "", value: "v",
    destination: "https://a.example", header: "", category: "", master: testKey(), now: "t" }).problem != "");
  expect(createSecret(database, { owner: "o1", name: "k", value: "v",
    destination: "not a url", header: "", category: "", master: testKey(), now: "t" }).problem != "");
  expect(createSecret(database, { owner: "o1", name: "k", value: "v",
    destination: "https://a.example", header: "X: y", category: "", master: testKey(), now: "t" }).problem != "");
  expect(createSecret(database, { owner: "o1", name: "k", value: "",
    destination: "https://a.example", header: "", category: "", master: testKey(), now: "t" }).problem != "");
  // A name is one per owner.
  stored("stripe key", "o1");
  expect(createSecret(database, { owner: "o1", name: "Stripe Key", value: "v",
    destination: "https://a.example", header: "", category: "", master: testKey(), now: "t" }).problem.indexOf("already") >= 0);
});

test("the per-owner bound refuses the twenty-first", () => {
  fresh();
  let i: int = 0;
  while (i < MAX_SECRETS_PER_OWNER) {
    stored("key " + `${i}`, "o1");
    i = i + 1;
  }
  let over = createSecret(database, { owner: "o1", name: "one more", value: "v",
    destination: "https://a.example", header: "", category: "", master: testKey(), now: "t" });
  expect(over.problem.indexOf(`${MAX_SECRETS_PER_OWNER}`) >= 0);
});

// --- where a secret may go ---------------------------------------------------

test("a graph may only aim a secret at the address it was stored for", () => {
  fresh();
  let id = stored("stripe key", "o1");
  // The right origin, any path: fine.
  expect(graphSecretProblem(database, graphWith(httpNode("https://api.example.com/v2/charges", id)), "o1") == "");
  // A different host: refused, naming both addresses and the way out.
  let moved = graphSecretProblem(database, graphWith(httpNode("https://evil.example/steal", id)), "o1");
  expect(moved.indexOf("https://evil.example") >= 0);
  expect(moved.indexOf("https://api.example.com") >= 0);
  expect(moved.indexOf("Delete the secret") >= 0);
  // A templated origin never equals a stored one — the host is not ours to
  // let a previous step choose.
  expect(graphSecretProblem(database, graphWith(httpNode("https://{{prev}}/x", id)), "o1") != "");
  // Somebody else's graph cannot see the secret at all.
  expect(graphSecretProblem(database, graphWith(httpNode("https://api.example.com/v2", id)), "o2") != "");
  // No secret named, no rule engaged.
  expect(graphSecretProblem(database, graphWith(httpNode("https://anywhere.example/x", "")), "o1") == "");
});

test("a use is stamped, so the list can say what is alive", () => {
  fresh();
  let id = stored("stripe key", "o1");
  expect(secretById(database, id, "o1").lastUsedAt == "");
  touchSecret(database, id, "t9");
  expect(secretById(database, id, "o1").lastUsedAt == "t9");
});

test("a step may carry several secrets, and the spelling it used to carry still works", () => {
  fresh();
  let one = stored("stripe key", "o1");
  let made = createSecret(database, { owner: "o1", name: "trace key", value: "Bearer t-2",
    destination: "https://api.example.com", header: "X-Trace", category: "Tracing", master: testKey(), now: "t" });
  let two = made.id;

  // Two at once, on the address they were both stored for.
  let both = httpNode("https://api.example.com/v2", one + "," + two);
  expect(graphSecretProblem(database, graphWith(both), "o1") == "");
  expect(secretIds(both).length == 2);

  // One of them pointed elsewhere refuses the whole graph, naming it.
  let away = httpNode("https://elsewhere.example/v2", one + "," + two);
  expect(graphSecretProblem(database, graphWith(away), "o1") != "");

  // A graph saved before the list existed carries `secretId`, and it is still
  // read — an attachment must not quietly stop happening on an upgrade.
  let base = emptyNode();
  let old: WfNode = {
    id: "h1", type: "HTTP", name: "Old", x: 0.0, y: 0.0,
    instruction: "", agentId: "", serverId: "", tool: "", args: "",
    url: "https://api.example.com/v1", method: "GET", body: "", query: "",
    test: "", needle: "", subject: base.subject, schedule: "", source: "",
    secretId: one,
  };
  expect(secretIds(old).length == 1);
  expect(secretIds(old)[0] == one);
  expect(graphSecretProblem(database, graphWith(old), "o1") == "");

  // And a step of any other kind may carry one: the field is on every node,
  // and a step with no address of its own has no address to disagree with.
  let elsewhere: WfNode = {
    id: "a1", type: "AGENT", name: "Ask", x: 0.0, y: 0.0,
    instruction: "do the thing", agentId: "", serverId: "", tool: "", args: "",
    url: "", method: "", body: "", query: "",
    test: "", needle: "", subject: base.subject, schedule: "", source: "",
    secrets: one,
  };
  expect(graphSecretProblem(database, graphWith(elsewhere), "o1") == "");
});
