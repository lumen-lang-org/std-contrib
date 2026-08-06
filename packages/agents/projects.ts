// Projects: conversations grouped under one name and one set of standing
// instructions.
//
// A project is an owner, a name and an instruction block — and nothing else.
// The rows only, the way tasks.ts is the rows for scheduled tasks: nothing
// here runs anything. Threads point at a project through `threads.project_id`
// (the ALTER below), the sidebar narrows on it (`GET /threads?project=`), and
// the instructions reach the model once per round in run.ts, where
// `projectBriefing` appends them to the system prompt of every conversation
// filed under the project.
//
// The instructions are ADDITIVE. They ride alongside the agent's own prompt
// and everything else the round briefs, never in place of any of it — a
// briefing that said "use only this" would silence the agent's tools and its
// retrieval, which is the exact failure the retrieval context prefix already
// guards against.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, createTableSql, desc, executeWith, field, findById, listOrdered, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { jsonText } from "./scan.ts";
// The workspace thread's files are ordinary artifacts, read with the same
// helpers `artifactBriefing` reads a conversation's own. No cycle: artifacts.ts
// imports nothing from this file.
import { ArtifactRow, getVersion, listArtifacts } from "./artifacts.ts";

// A project, as stored. `createdAt` is epoch-millis digit text, which is what
// `stamp()` writes on every other row in this package.
export type ProjectRow = {
  id: string,
  // Whose it is. Every read and every write is scoped by this, and a thread
  // is only stamped with a project its opener owns — a project id alone must
  // not let a stranger hang conversations under somebody's instructions.
  owner: string,
  name: string,
  // What every conversation in the project is told, verbatim, each round.
  // "" is a project that only groups; the briefing then carries the name and
  // nothing more.
  instructions: string,
  // The hidden workspace thread whose artifacts are the project's FILES, or
  // "" for a project that has none yet. Opened lazily by
  // `POST /projects/:id/files-thread` — never at create — so a project that
  // only groups pays for no thread row. The thread itself is stamped
  // `route_key = 'project-files'` so `listThreads` never shows it; the column
  // arrives at 103, DEFAULT '' and NOT NULL for the reason every other ""
  // column here gives — one spelling of "none", no backfill.
  filesThreadId: string,
  createdAt: string,
};

export function projectsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("name", "name", "text"),
    field("instructions", "instructions", "text"),
    // Added after 102 shipped, so it arrives as an ALTER at 103 — the live
    // mapping only; the frozen V1 below stays five fields.
    field("filesThreadId", "files_thread_id", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("projects", "id", "id", fs);
}

// The shape migration 102 recorded, frozen — the `threadsMappingV1` precedent
// in threads.ts, for the same reason: 102 generates its CREATE from this, and
// a migration's text is checksummed, so a column added to the live mapping
// above would rewrite 102 and every database that has already run it would
// refuse the whole plan. A new column is an ALTER at a new version, never an
// edit here.
function projectsMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("name", "name", "text"),
    field("instructions", "instructions", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("projects", "id", "id", fs);
}

export function projectsPlan(db: Db): Migration[] {
  // 102: workflow-store.ts owns 101 and 101.1, and a migration that sorts
  // below one already applied refuses the whole plan. Checked against the live
  // history — `SELECT version FROM plume_schema_history ORDER BY
  // installed_rank DESC` answered 101.1 as the high water — before choosing
  // the number, not after; tasks.ts records why that order matters.
  return [
    migration("102", "projects: conversations grouped under shared instructions",
      createTableSql(db, projectsMappingV1())),
    // The threads column rides this plan rather than threadPlan because a
    // shipped plan's numbers are history: threadPlan tops out at 92 and may
    // not grow past what other files have since claimed. DEFAULT '' and
    // NOT NULL for the reason threads.owner gives — one spelling of "no
    // project", so every existing thread is correct without being touched.
    migration("102.1", "a thread can belong to a project",
      "ALTER TABLE threads ADD COLUMN project_id " + db.textType + " NOT NULL DEFAULT ''"),
    // The index the sidebar's narrowed read needs: `GET /threads?project=`
    // filters on the column in SQL, so without this every project view walks
    // every tenant's threads.
    migration("102.2", "threads by project",
      "CREATE INDEX IF NOT EXISTS threads_by_project ON threads (project_id, created_at)"),
    // 103: the high water was 102.2 when this was numbered — checked against
    // the live history the way 102 was, before choosing, not after. An ALTER
    // at a new version, never an edit to 102's frozen mapping: 102's text is
    // checksummed, and a database that has run it would refuse the plan.
    migration("103", "a project carries a hidden files thread",
      "ALTER TABLE projects ADD COLUMN files_thread_id " + db.textType + " NOT NULL DEFAULT ''"),
  ];
}

/** This owner's projects, newest first — the same scoped read `tasksOf` is. */
export function projectsOf(db: Db, owner: string): string {
  let keys: DbOrder[] = [desc("created_at")];
  return listOrdered(db, projectsMapping(), "owner = " + db.placeholder, [owner], keys);
}

/** A row with every field empty — what `owned` answers a stranger, so a
 *  missing project and somebody else's project read identically as a 404.
 *  `id == ""` is the test for "nothing", as it is for tasks. */
export function emptyProject(): ProjectRow {
  let none: ProjectRow = { id: "", owner: "", name: "", instructions: "", filesThreadId: "", createdAt: "" };
  return none;
}

// The stamp a project's workspace thread carries in `threads.route_key`, and
// what `listThreads` excludes on. Doubles as the thread's `agent_id`: no agent
// row backs the workspace — no round ever runs there — but `ownedThread`
// answers the agent id and reads "" as "no such thread", so an empty agent id
// would 404 the very artifact routes the files are uploaded through.
export const PROJECT_FILES_KEY: string = "project-files";

/** Remember which hidden thread holds this project's files. Returns the
 *  database's sentence, or "". A one-column UPDATE for the reason
 *  `assignProject` is one: the caller has already proved the project is the
 *  asker's own, and `persist` would be a wider write racing an edit. */
export function rememberFilesThread(db: Db, projectId: string, threadId: string): string {
  let wrote = executeWith(db,
    "UPDATE projects SET files_thread_id = " + placeholderAt(db, 1)
    + " WHERE id = " + placeholderAt(db, 2),
    [threadId, projectId]);
  if (wrote.ok) { return ""; }
  return wrote.error;
}

/** Stamp a thread into a project. Returns the database's sentence, or "".
 *
 *  A one-column UPDATE for the reason `rememberChoice` is one: `persist`
 *  would write the whole row back from a document — a wider write for a
 *  one-column fact, and an upsert that would re-create a thread the sweep
 *  took between the read and the write. The caller has already proved the
 *  project exists and is theirs; this only writes. */
export function assignProject(db: Db, threadId: string, projectId: string): string {
  let wrote = executeWith(db,
    "UPDATE threads SET project_id = " + placeholderAt(db, 1)
    + " WHERE id = " + placeholderAt(db, 2),
    [projectId, threadId]);
  if (wrote.ok) { return ""; }
  return wrote.error;
}

/** Let a deleted project's threads fall back to no project.
 *
 *  Run before the project row goes: a thread pointing at a project that is
 *  not there would brief nothing — `projectBriefing` reads through the id —
 *  but it would also list under a `?project=` filter nobody can name a row
 *  for, which is a sidebar section that cannot be opened or emptied. */
export function releaseThreads(db: Db, projectId: string): void {
  executeWith(db,
    "UPDATE threads SET project_id = '' WHERE project_id = " + placeholderAt(db, 1),
    [projectId]);
}

/** What the round's system prompt says about the thread's project, or "".
 *
 *  Read through the thread each round rather than stored anywhere: editing a
 *  project's instructions must reach every conversation in it on the very
 *  next turn, which is the no-cache posture the whole API takes.
 *
 *  The thread's column is read with plain SQL rather than through
 *  threadsMapping because run.ts calls this and threads.ts imports run.ts —
 *  importing threads.ts back from here would close that cycle.
 *
 *  Additive wording on purpose, and it must stay that way: the project rides
 *  ALONGSIDE the agent's prompt, its skills and its retrieval. "Use only
 *  this" phrasing is the known failure that silences tools (the retrieval
 *  context prefix records the same rule). */
export function projectBriefing(db: Db, threadId: string): string {
  if (!db.query("SELECT project_id FROM threads WHERE id = " + placeholderAt(db, 1), [threadId])) {
    return "";
  }
  if (db.rows() == 0) { return ""; }
  let projectId = db.value(0, 0);
  if (projectId == "") { return ""; }
  // A stamp that outlived its project — the DELETE clears these, but a round
  // already in flight can still hold one — briefs nothing rather than a name
  // that is gone.
  let document = findById(db, projectsMapping(), projectId);
  if (document == "") { return ""; }
  let name = jsonText(document, "name");
  let instructions = jsonText(document, "instructions");
  let out = "Project: " + name;
  if (instructions != "") {
    out = out + "\nThis conversation belongs to that project. Follow these project instructions alongside everything above:\n"
      + instructions;
  }
  let files = filesBriefing(db, jsonText(document, "filesThreadId"));
  if (files != "") { out = out + "\n\n" + files; }
  return out;
}

// How much of the project's files a round carries: a cap per file and a cap
// for the block, because the files ride the system prompt of EVERY round of
// EVERY conversation in the project — an uncapped block would let one big
// upload price every question in the project at the window.
const FILE_INLINE_MAX: int = 8000;
const FILES_TOTAL_MAX: int = 24000;

// Whether a path names something worth inlining as text. Simple endsWith
// checks over the spellings the console uploads; anything else — html a
// preview renders, images, the unknown — is named rather than quoted.
function textualPath(path: string): bool {
  let lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".txt")
    || lower.endsWith(".csv") || lower.endsWith(".json");
}

/** The project's files, as a block for the round's system prompt, or "".
 *
 *  The files are the artifacts of the project's hidden workspace thread, read
 *  with the same helpers `artifactBriefing` (artifacts.ts) reads a
 *  conversation's own. Textual files arrive inline — the LATEST version, the
 *  caps above, "…cut" where a cap bit — because the point of a project file
 *  is that the model can answer from it without a tool round-trip; everything
 *  else is named so the model knows it exists.
 *
 *  Additive wording, as the instructions above: "reference material", never
 *  "use only this content" — the known failure that silences tools. */
function filesBriefing(db: Db, filesThreadId: string): string {
  if (filesThreadId == "") { return ""; }
  let rows: ArtifactRow[] = listArtifacts(db, filesThreadId);
  if (rows.length == 0) { return ""; }
  let out = "The project carries these files. They are reference material for this conversation:";
  let inlined: int = 0;
  let i: int = 0;
  while (i < rows.length) {
    let each = rows[i];
    let named = each.title == "" ? "" : " — " + each.title;
    if (textualPath(each.path) && inlined < FILES_TOTAL_MAX) {
      let body = getVersion(db, each.id, each.currentVersion).body;
      let room = FILES_TOTAL_MAX - inlined;
      let cap = room < FILE_INLINE_MAX ? room : FILE_INLINE_MAX;
      let cut = body.length > cap;
      let shown = cut ? body.slice(0, cap) : body;
      inlined = inlined + shown.length;
      out = out + "\n\n--- " + each.path + named + " ---\n" + shown;
      if (cut) { out = out + "\n…cut"; }
    } else {
      out = out + "\n- " + each.path + named;
    }
    i = i + 1;
  }
  return out;
}
