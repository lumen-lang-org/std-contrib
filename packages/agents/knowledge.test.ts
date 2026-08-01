// What retrieval refuses before it embeds anything.
//
// The search itself needs PostgreSQL and a credential, so it lives in
// examples/rag.ts; everything that can be decided from rows is here.
//
//   cd packages/agents && lumen test knowledge.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { ModelRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "./schema.ts";
import { Retrieved, embeddingModel, createDocuments, indexDocument, retrieve, asContext, normalScope, scopeCovers, scopeClause, scopeArgs, splitIntoChunks } from "./knowledge.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_knowledge_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS documents");
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  migrate(database, schemaPlan(database));

  let chat: ModelRow = { id: "m1", label: "Mistral Small", apiName: "mistral-small-latest", provider: "mistral", kind: "chat", dimensions: 0, baseUrl: "", enabled: true };
  persist(database, modelsMapping(), JSON.stringify(chat));
  let embedder: ModelRow = { id: "e1", label: "Mistral Embed", apiName: "mistral-embed", provider: "mistral", kind: "embedding", dimensions: 1024, baseUrl: "", enabled: true };
  persist(database, modelsMapping(), JSON.stringify(embedder));
  let unsized: ModelRow = { id: "e2", label: "Nameless Embed", apiName: "x", provider: "mistral", kind: "embedding", dimensions: 0, baseUrl: "", enabled: true };
  persist(database, modelsMapping(), JSON.stringify(unsized));
}

test("an embedding model is read from its row, with its own width", () => {
  fresh();
  let m = embeddingModel(database, "e1");
  expect(m.id == "e1");
  expect(m.dimensions == 1024);
  expect(m.kind == "embedding");
});

test("a chat model is not an embedding model, however it is asked for", () => {
  fresh();
  // Same provider, same credential, different endpoint — worth refusing here
  // rather than at the provider.
  expect(embeddingModel(database, "m1").id == "");
});

test("a model that is not there reads as absent, not as an error", () => {
  fresh();
  expect(embeddingModel(database, "nope").id == "");
});

test("a corpus cannot be created without a width", () => {
  fresh();
  expect(createDocuments(database, embeddingModel(database, "e2")).indexOf("how wide") >= 0);
  // And not at all without a model.
  expect(createDocuments(database, embeddingModel(database, "nope")).indexOf("no embedding model") >= 0);
});

test("indexing with a chat model is refused before a request is made", () => {
  fresh();
  let chat: ModelRow = JSON.parse<ModelRow>("{\"id\":\"m1\",\"label\":\"Mistral Small\",\"apiName\":\"mistral-small-latest\",\"provider\":\"mistral\",\"kind\":\"chat\",\"dimensions\":0,\"baseUrl\":\"\",\"enabled\":true}");
  expect(indexDocument(database, chat, { id: "d1", source: "s", scope: "/x", body: "body" }, "sk-fake").indexOf("not an embedding model") >= 0);
});

test("searching with a chat model is refused too", () => {
  fresh();
  let chat: ModelRow = JSON.parse<ModelRow>("{\"id\":\"m1\",\"label\":\"Mistral Small\",\"apiName\":\"mistral-small-latest\",\"provider\":\"mistral\",\"kind\":\"chat\",\"dimensions\":0,\"baseUrl\":\"\",\"enabled\":true}");
  let anywhere: string[] = ["/"];
  let r = retrieve(database, chat, anywhere, "question", 3, "sk-fake");
  expect(!r.ok);
  expect(r.error.indexOf("not an embedding model") >= 0);
});

test("k is bounded, so a search cannot ask for everything", () => {
  fresh();
  let m = embeddingModel(database, "e1");
  let all: string[] = ["/"];
  expect(!retrieve(database, m, all, "q", 0, "sk-fake").ok);
  expect(!retrieve(database, m, all, "q", 1000, "sk-fake").ok);
  expect(retrieve(database, m, all, "q", 0, "sk-fake").error.indexOf("between 1 and 100") >= 0);
});

test("a document id must be a plain name", () => {
  fresh();
  let m = embeddingModel(database, "e1");
  expect(indexDocument(database, m, { id: "a b; DROP TABLE documents", source: "s", scope: "/x", body: "body" }, "sk-fake").indexOf("plain name") >= 0);
});

test("context is labelled with where each chunk came from", () => {
  let found: Retrieved[] = [
    { id: "d1", source: "plume", scope: "/specs", body: "First chunk.", distance: 0.1 },
    { id: "d2", source: "rest", scope: "/specs", body: "Second chunk.", distance: 0.2 },
  ];
  let text = asContext(found);
  expect(text.indexOf("[plume/d1]") >= 0);
  expect(text.indexOf("[rest/d2]") >= 0);
  expect(text.indexOf("First chunk.") >= 0);
  // It still guards the corpus's voice — nothing may be attributed to it
  // that these passages do not say —
  expect(text.indexOf("never attribute to the corpus") >= 0);
  // — but it must not forbid the rest of the agent: "Use only the following
  // context" once made a tool-carrying agent refuse a repair because the
  // retrieval for "fix it" came back as license text.
  expect(text.indexOf("Use only") < 0);
  expect(text.indexOf("tools or skills") >= 0);
  // And it opens with the words threads.ts recognises passage turns by.
  expect(text.indexOf("Passages retrieved from the knowledge base") == 0);
});

test("no chunks is no context, rather than an empty instruction", () => {
  let none: Retrieved[] = [];
  expect(asContext(none) == "");
});

test("the suite leaves nothing behind", () => {
  fresh();
  expect(dropTable(database, modelsMapping()).ok);
  database.close();
});

// --- scopes ---------------------------------------------------------------------------

test("a scope is normalised to one spelling", () => {
  // Two spellings of the same folder is how a grant silently matches nothing.
  expect(normalScope("/specs/") == "/specs");
  expect(normalScope("specs") == "/specs");
  expect(normalScope("  /specs/plume//  ") == "/specs/plume");
  expect(normalScope("") == "/");
  expect(normalScope("/") == "/");
});

test("a scope covers its own folder and everything under it", () => {
  expect(scopeCovers("/specs", "/specs"));
  expect(scopeCovers("/specs", "/specs/plume"));
  expect(scopeCovers("/specs", "/specs/plume/relations"));
  // The root covers everything.
  expect(scopeCovers("/", "/anything/at/all"));
});

test("a scope does not cover a folder that merely starts the same way", () => {
  // The whole point of scopes. A string prefix would hand /specifications to
  // anyone granted /spec.
  expect(!scopeCovers("/spec", "/specs"));
  expect(!scopeCovers("/specs", "/specifications"));
  expect(!scopeCovers("/specs/plume", "/specs"));
  expect(!scopeCovers("/a", "/b"));
});

test("the scope clause binds two parameters per scope", () => {
  let db = sqlite();
  let two: string[] = ["/specs", "/policies"];
  let clause = scopeClause(db, two, 3);
  expect(clause.indexOf("scope = ") >= 0);
  expect(clause.indexOf("scope LIKE ") >= 0);
  expect(clause.indexOf(" OR ") >= 0);

  let args = scopeArgs(two);
  expect(args.length == 4);
  expect(args[0] == "/specs");
  expect(args[1] == "/specs/%");
  expect(args[2] == "/policies");
  expect(args[3] == "/policies/%");
});

// A grant is compared twice: in SQL, to pick documents, and in memory, to draw
// the folder tree. The two have to give the same answer, and LIKE has two
// wildcards that a folder name is entitled to contain.

test("a scope holding an underscore grants that folder and no lookalike", () => {
  fresh();
  execute(database, "CREATE TABLE IF NOT EXISTS scope_probe (scope text)");
  execute(database, "DELETE FROM scope_probe");
  execute(database, "INSERT INTO scope_probe VALUES ('/team_docs/handbook')");
  execute(database, "INSERT INTO scope_probe VALUES ('/team-docs/handbook')");

  let granted: string[] = ["/team_docs"];
  let sql = "SELECT scope FROM scope_probe WHERE " + scopeClause(database, granted, 1) + " ORDER BY scope";
  database.query(sql, scopeArgs(granted));
  // "_" is LIKE's single-character wildcard, so an unescaped pattern hands
  // /team-docs to whoever was granted /team_docs.
  expect(database.rows() == 1);
  expect(database.value(0, 0) == "/team_docs/handbook");

  // And the tree says the same thing. Two answers to "who may read this" is
  // worse than either answer on its own.
  expect(scopeCovers("/team_docs", "/team_docs/handbook"));
  expect(!scopeCovers("/team_docs", "/team-docs/handbook"));
});

test("a scope holding a percent grants that folder and not the whole corpus", () => {
  fresh();
  execute(database, "CREATE TABLE IF NOT EXISTS scope_probe (scope text)");
  execute(database, "DELETE FROM scope_probe");
  execute(database, "INSERT INTO scope_probe VALUES ('/a%/notes')");
  execute(database, "INSERT INTO scope_probe VALUES ('/anything/secret')");

  let granted: string[] = ["/a%"];
  let sql = "SELECT scope FROM scope_probe WHERE " + scopeClause(database, granted, 1) + " ORDER BY scope";
  database.query(sql, scopeArgs(granted));
  expect(database.rows() == 1);
  expect(database.value(0, 0) == "/a%/notes");
  expect(!scopeCovers("/a%", "/anything/secret"));
});

test("an ordinary scope still matches its own subtree", () => {
  fresh();
  execute(database, "CREATE TABLE IF NOT EXISTS scope_probe (scope text)");
  execute(database, "DELETE FROM scope_probe");
  execute(database, "INSERT INTO scope_probe VALUES ('/specs')");
  execute(database, "INSERT INTO scope_probe VALUES ('/specs/plume')");
  execute(database, "INSERT INTO scope_probe VALUES ('/specifications')");

  let granted: string[] = ["/specs"];
  let sql = "SELECT scope FROM scope_probe WHERE " + scopeClause(database, granted, 1) + " ORDER BY scope";
  database.query(sql, scopeArgs(granted));
  expect(database.rows() == 2);
  expect(database.value(0, 0) == "/specs");
  expect(database.value(1, 0) == "/specs/plume");
});

test("no scopes produces no clause, and the root binds a wildcard", () => {
  let db = sqlite();
  let none: string[] = [];
  expect(scopeClause(db, none, 3) == "");
  let root: string[] = ["/"];
  expect(scopeArgs(root)[1] == "/%");
});

// --- chunking -------------------------------------------------------------------------

test("a document is split on paragraph boundaries", () => {
  let body = "First paragraph.\n\nSecond paragraph.\n\nThird.";
  let chunks = splitIntoChunks(body, 30);
  expect(chunks.length >= 2);
  // Nothing is cut mid-sentence when a boundary was available.
  expect(chunks[0] == "First paragraph.");
});

test("short paragraphs are packed together rather than stored one by one", () => {
  // A chunk per sentence retrieves fragments with no context.
  let body = "One.\n\nTwo.\n\nThree.";
  let chunks = splitIntoChunks(body, 1000);
  expect(chunks.length == 1);
  expect(chunks[0].indexOf("One.") >= 0);
  expect(chunks[0].indexOf("Three.") >= 0);
});

test("a paragraph longer than the cap is split rather than refused", () => {
  // Refusing would mean a document with one long section cannot be stored.
  let long = "x".repeat(2500);
  let chunks = splitIntoChunks(long, 1000);
  expect(chunks.length == 3);
  expect(chunks[0].length == 1000);
});

test("blank paragraphs are not chunks", () => {
  let chunks = splitIntoChunks("One.\n\n\n\n   \n\nTwo.", 1000);
  expect(chunks.length == 1);
});

test("no scopes granted reads nothing, rather than everything", () => {
  // The dangerous default. Treating an empty grant as a wildcard would make
  // revoking an agent's access the most destructive edit in the system.
  fresh();
  let m = embeddingModel(database, "e1");
  let none: string[] = [];
  let r = retrieve(database, m, none, "question", 3, "sk-fake");
  expect(!r.ok);
  expect(r.error.indexOf("no scopes granted") >= 0);
});
