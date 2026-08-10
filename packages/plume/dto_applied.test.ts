// @dto as the compiler applies it, rather than as a function being called.
//
// dto.test.ts proves the decorator is a pure function by calling it with a
// description built by hand. That test would still pass if the compiler could
// not apply the decorator at all, so this one puts it on a class and uses the
// constant that comes back — and then writes through it, against a real
// database, because the narrowing and the write together are where the sharp
// edge is.
//
// # What this program may import, and why it is not "anything"
//
// Both decorator modules declare a `EntityDescription` type of their own, because the
// compiler parses a decorator's module alone and requires the name `EntityDescription`
// in it. That makes them coexist on one condition, which this file meets and
// which is easy to break: **at most one of entity.ts and dto.ts may be linked
// into the program**, and the other must be imported for its decorator alone.
//
//   import { entity } from "./entity.ts";                    // decorator only
//   import { dto, narrowTo, ... } from "./dto.ts";           // linked
//
// Adding a second name to the entity.ts line — `defaultSqlType`, `field`,
// `FieldDescription`, anything — links entity.ts too, and the compile stops
// with:
//
//   dto.ts:75:1: error: type 'EntityDescription' is declared by both entity.ts and
//   dto.ts [E_DUPLICATE_TYPE]
//
// dto.ts must be the linked one, because `@dto` cannot be used without
// `Projection` in scope. So the constraint is one-sided: entity.ts is the
// module that has to stay decorator-only.
//
// This is a compiler problem, not a naming problem — see the header of dto.ts.
// The claim tested below is therefore the narrow one: these two coexist *as
// imported here*. Nothing here shows, or could show, that they coexist for an
// arbitrary pair of imports, because a duplicate-binding error is a compile
// error and a test file that does not compile does not run.
//
//   sh packages/plume/build.sh
//   cd packages/plume && lumen test dto_applied.test.ts

import { entity } from "./entity.ts";
import { dto, narrowTo, columnViolation, coverageViolation, documentViolation, writeViolation } from "./dto.ts";
import { Db, DbConfig } from "./driver.ts";
import { sqlite } from "./sqlite.ts";
import { connectDatabase, createTable, dropTable, persist, findById, jsonMember, execute } from "./plume.ts";

@entity("dto_applied_test_agents")
class Agent {
  @id @column("id", "text") id: string;
  @column("agent_name", "text") agentName: string;
  @column("prompt_id", "text") promptId: string;
}

// The shape a write accepts: the row, without whatever a read nests around it.
@dto
class AgentEdit {
  id: string;
  agentName: string;
  promptId: string;
}

// A shape with a field that is the program's rather than the table's.
@dto
class AgentBrief {
  id: string;
  agentName: string;
  @extra turnsToday: int;
}

let database: Db = sqlite();

function dtoConfig(): DbConfig {
  let named: DbConfig = { filename: "/tmp/plume_dto_test.db" };
  return named;
}

// One agent, stored whole, on a table whose prompt_id is nullable.
//
// The DDL is written out rather than taken from `createTable`, which makes
// every non-key column NOT NULL. That difference is the whole subject of the
// two tests below: a NOT NULL column turns this mistake into a refused write,
// and a nullable one lets it through. The real agents table has a nullable
// prompt_id, because an agent need not have a prompt.
function fresh(): void {
  connectDatabase(database, dtoConfig());
  dropTable(database, entityAgent);
  execute(database, "CREATE TABLE dto_applied_test_agents ("
    + "id text PRIMARY KEY, agent_name text NOT NULL, prompt_id text)");
  persist(database, entityAgent, "{\"id\":\"a1\",\"agentName\":\"Support\",\"promptId\":\"p1\"}");
}

// The same row on the table `createTable` builds, where every column is NOT
// NULL.
function freshStrict(): void {
  connectDatabase(database, dtoConfig());
  dropTable(database, entityAgent);
  createTable(database, entityAgent);
  persist(database, entityAgent, "{\"id\":\"a1\",\"agentName\":\"Support\",\"promptId\":\"p1\"}");
}

test("the compiler applies @dto and names the constant after the class", () => {
  expect(dtoAgentEdit.name == "AgentEdit");
  expect(dtoAgentEdit.fields.length == 3);
  expect(dtoAgentEdit.fields[0] == "id");
});

test("a document from the read route narrows to the write shape", () => {
  // This is the case the whole thing exists for: GET answers the agent with
  // its prompt, its config and its sub-agents nested; PUT takes the row.
  let full = "{\"id\":\"a1\",\"agentName\":\"Support\",\"promptId\":\"p1\","
    + "\"prompt\":{\"id\":\"p1\",\"body\":\"You are…\"},"
    + "\"config\":{\"id\":\"c1\",\"maxTokens\":8192},"
    + "\"subAgents\":[{\"id\":\"a2\"}]}";
  expect(narrowTo(dtoAgentEdit, full)
    == "{\"id\":\"a1\",\"agentName\":\"Support\",\"promptId\":\"p1\"}");
});

test("the shape and the entity are checked against each other", () => {
  // The pairing a decorator cannot check: it sees only the class it is on.
  expect(columnViolation(dtoAgentEdit, entityAgent) == "");
  expect(coverageViolation(dtoAgentEdit, entityAgent) == "");
});

test("@extra excuses a field the table does not have", () => {
  expect(dtoAgentBrief.extras.length == 1);
  expect(columnViolation(dtoAgentBrief, entityAgent) == "");
  // And it is still a shape that does not cover the row, which is legitimate
  // for reading and fatal for writing — so it is asked about separately.
  expect(coverageViolation(dtoAgentBrief, entityAgent).includes("promptId"));
});

test("narrowing a partial document and persisting it writes null over the omitted column", () => {
  // The hazard, stated as an assertion so it cannot quietly stop being true.
  // `persist` is an upsert over every column of the mapping, so a column the
  // document did not carry is not left alone — EXCLUDED writes it as null.
  fresh();
  let sent = "{\"id\":\"a1\",\"agentName\":\"Renamed\"}";
  let body = narrowTo(dtoAgentEdit, sent);
  expect(body == "{\"id\":\"a1\",\"agentName\":\"Renamed\"}");

  let stored = persist(database, entityAgent, body);
  expect(stored.ok);
  expect(stored.error == "");
  let row = findById(database, entityAgent, "a1");
  expect(jsonMember(row, "agentName") == "\"Renamed\"");
  // p1 is gone, and nothing reported anything.
  expect(jsonMember(row, "promptId") == "null");
});

test("a NOT NULL column turns the same mistake into a refused write", () => {
  // Which is the only reason this is ever noticed, and the reason it is worth a
  // check of its own: the schema catching it is luck, not design. Every
  // nullable column — every optional foreign key — is silently overwritten by
  // the test above.
  freshStrict();
  let sent = "{\"id\":\"a1\",\"agentName\":\"Renamed\"}";
  let stored = persist(database, entityAgent, narrowTo(dtoAgentEdit, sent));
  expect(!stored.ok);
  expect(stored.error.includes("prompt_id"));
  // The rename is lost too: the write was one statement and all of it failed.
  let row = findById(database, entityAgent, "a1");
  expect(jsonMember(row, "agentName") == "\"Support\"");
});

test("the shape says the document did not cover it, before the write happens", () => {
  fresh();
  let sent = "{\"id\":\"a1\",\"agentName\":\"Renamed\"}";
  let violation = documentViolation(dtoAgentEdit, sent);
  expect(violation.includes("AgentEdit"));
  expect(violation.includes("promptId"));
  // Which is what a write route does with it: ask, then write, or answer the
  // sentence to the client that sent the short document.
  if (violation == "") {
    persist(database, entityAgent, narrowTo(dtoAgentEdit, sent));
  }
  let row = findById(database, entityAgent, "a1");
  expect(jsonMember(row, "promptId") == "\"p1\"");
  expect(jsonMember(row, "agentName") == "\"Support\"");
});

test("a document that covers the shape writes every column it names", () => {
  fresh();
  let sent = "{\"id\":\"a1\",\"agentName\":\"Renamed\",\"promptId\":\"p2\","
    + "\"prompt\":{\"id\":\"p2\",\"body\":\"You are…\"}}";
  expect(writeViolation(dtoAgentEdit, entityAgent, sent) == "");
  expect(persist(database, entityAgent, narrowTo(dtoAgentEdit, sent)).ok);
  let row = findById(database, entityAgent, "a1");
  expect(jsonMember(row, "agentName") == "\"Renamed\"");
  expect(jsonMember(row, "promptId") == "\"p2\"");
});

test("a shape that does not cover the table is refused for a write, whatever the document says", () => {
  // AgentBrief drops promptId, so no document can make it safe to persist.
  // `writeViolation` asks that question before it asks about the document.
  fresh();
  let sent = "{\"id\":\"a1\",\"agentName\":\"Renamed\",\"turnsToday\":4}";
  expect(documentViolation(dtoAgentBrief, sent) == "");
  expect(writeViolation(dtoAgentBrief, entityAgent, sent).includes("promptId"));
});

test("the suite leaves nothing behind", () => {
  connectDatabase(database, dtoConfig());
  expect(dropTable(database, entityAgent).ok);
  database.close();
});
