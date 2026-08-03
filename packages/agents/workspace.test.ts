// Workspace files: what a name may be, what the tools answer, and what
// promotion means. The live half — a model actually writing an artifact — is
// exercised through a thread against a real provider.
//
//   cd packages/agents && lumen test workspace.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../plume/migrate.ts";
import { WorkspaceFileRow, UPLOAD_MAX, workspacePlan, fileNameOk, putFile, getFile, listFiles, deleteFile, sourceOf, mimeOf, workspaceTools, callWorkspaceTool } from "./workspace.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_workspace_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP INDEX IF EXISTS files_by_thread");
  execute(database, "DROP TABLE IF EXISTS workspace_files");
  // The plan starts at 22; alone in a fresh database that is fine — the
  // history is per-database and these tests own theirs.
  migrate(database, workspacePlan(database));
}

// --- names --------------------------------------------------------------------------

test("a file name that climbs is refused at the door", () => {
  // These names arrive from the model as tool arguments. "../etc/passwd"
  // dies here, not in whatever later touches the file.
  expect(!fileNameOk("../etc/passwd"));
  expect(!fileNameOk("a/../../b"));
  expect(!fileNameOk("notes/../secret.md"));
  expect(!fileNameOk(".hidden"));
  expect(!fileNameOk("a..b.md"));
  expect(!fileNameOk(""));
});

test("ordinary names pass", () => {
  expect(fileNameOk("notes.md"));
  expect(fileNameOk("Q3 forecast.csv"));
  expect(fileNameOk("report_v2.html"));
});

test("a separator of any kind is not a name", () => {
  expect(!fileNameOk("a/b.md"));
  expect(!fileNameOk("a\\b.md"));
  expect(!fileNameOk("a:b.md"));
});

// --- storage ------------------------------------------------------------------------

test("writing a name that exists replaces it", () => {
  fresh();
  expect(putFile(database, { threadId: "t1", fileName: "notes.md", mime: "text/markdown", origin: "uploaded", body: "first", documentId: "", now: "now" }) == "");
  expect(putFile(database, { threadId: "t1", fileName: "notes.md", mime: "text/markdown", origin: "generated", body: "second", documentId: "", now: "now" }) == "");
  let file = getFile(database, "t1", "notes.md");
  expect(file.body == "second");
  expect(file.origin == "generated");
  expect(listFiles(database, "t1").length == 1);
});

test("threads do not see each other's files", () => {
  fresh();
  putFile(database, { threadId: "t1", fileName: "mine.md", mime: "text/markdown", origin: "uploaded", body: "a", documentId: "", now: "now" });
  putFile(database, { threadId: "t2", fileName: "theirs.md", mime: "text/markdown", origin: "uploaded", body: "b", documentId: "", now: "now" });
  expect(listFiles(database, "t1").length == 1);
  expect(listFiles(database, "t1")[0].fileName == "mine.md");
  expect(getFile(database, "t1", "theirs.md").id == "");
});

test("an unknown origin is refused", () => {
  fresh();
  expect(putFile(database, { threadId: "t1", fileName: "x.md", mime: "text/plain", origin: "conjured", body: "b", documentId: "", now: "now" }).indexOf("origin") >= 0);
});

test("deleting removes one file, not the workspace", () => {
  fresh();
  putFile(database, { threadId: "t1", fileName: "keep.md", mime: "text/plain", origin: "uploaded", body: "a", documentId: "", now: "now" });
  putFile(database, { threadId: "t1", fileName: "drop.md", mime: "text/plain", origin: "uploaded", body: "b", documentId: "", now: "now" });
  expect(deleteFile(database, "t1", "drop.md") == "");
  expect(listFiles(database, "t1").length == 1);
  expect(listFiles(database, "t1")[0].fileName == "keep.md");
});

// --- the byte cap ---------------------------------------------------------------------

// A body of exactly `n` bytes, doubled into place. Concatenating one character
// at a time is quadratic and this is a megabyte.
function bulk(n: int): string {
  let out = "x";
  while (out.length * 2 <= n) { out = out + out; }
  while (out.length < n) { out = out + "x"; }
  return out;
}

test("a file past the cap is refused, and nothing is written", () => {
  fresh();
  // This door had no cap at all: whatever JSON arrived went into a text
  // column, and a thread could be filled by one POST.
  let refused = putFile(database, { threadId: "t1", fileName: "huge.md", mime: "text/markdown", origin: "uploaded", body: bulk(UPLOAD_MAX + 1), documentId: "", now: "now" });
  expect(refused.indexOf("at most " + `${UPLOAD_MAX}` + " bytes") >= 0);
  // Named, because a person looking at a failed upload of six files needs to
  // know which one.
  expect(refused.indexOf("huge.md") >= 0);
  expect(listFiles(database, "t1").length == 0);
});

test("the model's own door inherits the cap", () => {
  fresh();
  // write_file goes through putFile, so a model cannot walk around a limit
  // the console obeys.
  let wrote = callWorkspaceTool(database, "t1", "write_file", "essay.md", bulk(UPLOAD_MAX + 1), "now");
  expect(wrote.handled);
  expect(!wrote.ok);
  expect(wrote.text.indexOf("at most") >= 0);
  expect(listFiles(database, "t1").length == 0);
});

test("with nothing configured the cap is a megabyte, and a file under it lands", () => {
  fresh();
  // Today's value as the default, which is the whole contract of moving these
  // to the environment: an operator who sets nothing gets what shipped.
  expect(UPLOAD_MAX == 1048576);
  expect(putFile(database, { threadId: "t1", fileName: "big.md", mime: "text/markdown", origin: "uploaded", body: bulk(UPLOAD_MAX), documentId: "", now: "now" }) == "");
  expect(getFile(database, "t1", "big.md").body.length == UPLOAD_MAX);
});

// --- the tools ----------------------------------------------------------------------

test("the three tools are described with schemas", () => {
  let ts = workspaceTools();
  expect(ts.length == 3);
  expect(ts[0].name == "list_files");
  expect(ts[1].name == "read_file");
  expect(ts[2].name == "write_file");
  expect(ts[1].schema.indexOf("\"required\":[\"name\"]") >= 0);
});

test("outside a thread the tools do not answer at all", () => {
  // handled=false sends the call on to MCP; a workspace tool must not shadow
  // a server's tool for a run that has no workspace.
  fresh();
  expect(!callWorkspaceTool(database, "", "list_files", "", "", "now").handled);
});

test("list, write and read behave as a loop would use them", () => {
  fresh();
  let empty = callWorkspaceTool(database, "t1", "list_files", "", "", "now");
  expect(empty.handled && empty.ok);
  expect(empty.text.indexOf("no files yet") >= 0);

  let wrote = callWorkspaceTool(database, "t1", "write_file", "draft.md", "# Title", "now");
  expect(wrote.handled && wrote.ok);
  // What the model wrote is a generated file with a mime from its name.
  let file = getFile(database, "t1", "draft.md");
  expect(file.origin == "generated");
  expect(file.mime == "text/markdown");

  let read = callWorkspaceTool(database, "t1", "read_file", "draft.md", "", "now");
  expect(read.ok);
  expect(read.text == "# Title");

  let listed = callWorkspaceTool(database, "t1", "list_files", "", "", "now");
  expect(listed.text.indexOf("draft.md") >= 0);
  expect(listed.text.indexOf("generated") >= 0);
});

test("reading a file that is not there tells the model what to do instead", () => {
  fresh();
  let missing = callWorkspaceTool(database, "t1", "read_file", "ghost.md", "", "now");
  expect(missing.handled);
  expect(!missing.ok);
  expect(missing.text.indexOf("list_files") >= 0);
});

test("a model-invented name is refused with the rule, not stored", () => {
  fresh();
  let bad = callWorkspaceTool(database, "t1", "write_file", "../escape.md", "x", "now");
  expect(bad.handled);
  expect(!bad.ok);
  expect(listFiles(database, "t1").length == 0);
});

// --- promotion helpers ---------------------------------------------------------------

test("a file name becomes a plain document source", () => {
  expect(sourceOf("Q3 forecast.csv") == "Q3_forecast_csv");
  expect(sourceOf("notes.md") == "notes_md");
});

test("a mime comes from the name, and text is the fallback", () => {
  expect(mimeOf("a.md") == "text/markdown");
  expect(mimeOf("a.csv") == "text/csv");
  expect(mimeOf("a.xyz") == "text/plain");
});

test("the suite leaves nothing behind", () => {
  fresh();
  execute(database, "DROP TABLE IF EXISTS workspace_files");
  database.close();
});
