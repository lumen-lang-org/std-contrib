import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, createTableSql, executeWith, field, findById, listOrdered, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { jsonText } from "./scan.ts";
import { ArtifactRow, getVersion, listArtifacts } from "./artifacts.ts";
import { projectRepository } from "./routes/projects/entities/project.entity.ts";

export type ProjectRow = {
  id: string,
  owner: string,
  name: string,
  instructions: string,
  filesThreadId: string,
  createdAt: string,
};

export function projectsMapping(): DbRepository {
  return projectRepository();
}

function projectsMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("name", "name", "text"),
    field("instructions", "instructions", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository({ table: "projects", idField: "id", idColumn: "id", fields: fs });
}

export function projectsPlan(db: Db): Migration[] {
  return [
    migration("102", "projects: conversations grouped under shared instructions",
      createTableSql(db, projectsMappingV1())),
    migration("102.1", "a thread can belong to a project",
      "ALTER TABLE threads ADD COLUMN project_id " + db.textType + " NOT NULL DEFAULT ''"),
    migration("102.2", "threads by project",
      "CREATE INDEX IF NOT EXISTS threads_by_project ON threads (project_id, created_at)"),
    migration("103", "a project carries a hidden files thread",
      "ALTER TABLE projects ADD COLUMN files_thread_id " + db.textType + " NOT NULL DEFAULT ''"),
  ];
}

export function projectsOf(db: Db, owner: string): string {
  let keys: DbOrder[] = [{ column: "created_at", direction: "desc" }];
  return listOrdered(db, projectsMapping(), {
    where: "owner = " + db.placeholder,
    args: [owner],
    order: keys,
  });
}

export function emptyProject(): ProjectRow {
  let none: ProjectRow = {
    id: "",
    owner: "",
    name: "",
    instructions: "",
    filesThreadId: "",
    createdAt: "",
  };
  return none;
}

export const PROJECT_FILES_KEY: string = "project-files";

export function rememberFilesThread(db: Db, projectId: string, threadId: string): string {
  let wrote = executeWith(db,
    "UPDATE projects SET files_thread_id = " + placeholderAt(db, 1)
    + " WHERE id = " + placeholderAt(db, 2),
    [threadId, projectId]);
  if (wrote.ok) {
    return "";
  }
  return wrote.error;
}

export function assignProject(db: Db, threadId: string, projectId: string): string {
  let wrote = executeWith(db,
    "UPDATE threads SET project_id = " + placeholderAt(db, 1)
    + " WHERE id = " + placeholderAt(db, 2),
    [projectId, threadId]);
  if (wrote.ok) {
    return "";
  }
  return wrote.error;
}

export function releaseThreads(db: Db, projectId: string): void {
  executeWith(db,
    "UPDATE threads SET project_id = '' WHERE project_id = " + placeholderAt(db, 1),
    [projectId]);
}

export function projectBriefing(db: Db, threadId: string): string {
  if (!db.query("SELECT project_id FROM threads WHERE id = " + placeholderAt(db, 1), [threadId])) {
    return "";
  }
  if (db.rows() == 0) {
    return "";
  }
  let projectId = db.value(0, 0);
  if (projectId == "") {
    return "";
  }
  let document = findById(db, projectsMapping(), projectId);
  if (document == "") {
    return "";
  }
  let name = jsonText(document, "name");
  let instructions = jsonText(document, "instructions");
  let out = "Project: " + name;
  if (instructions != "") {
    out = out + "\nThis conversation belongs to that project. Follow these project instructions alongside everything above:\n"
      + instructions;
  }
  let files = filesBriefing(db, jsonText(document, "filesThreadId"));
  if (files != "") {
    out = out + "\n\n" + files;
  }
  return out;
}

const FILE_INLINE_MAX: int = 8000;
const FILES_TOTAL_MAX: int = 24000;

function textualPath(path: string): bool {
  let lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".txt")
    || lower.endsWith(".csv") || lower.endsWith(".json");
}

function filesBriefing(db: Db, filesThreadId: string): string {
  if (filesThreadId == "") {
    return "";
  }
  let rows: ArtifactRow[] = listArtifacts(db, filesThreadId);
  if (rows.length == 0) {
    return "";
  }
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
      if (cut) {
        out = out + "\n…cut";
      }
    } else {
      out = out + "\n- " + each.path + named;
    }
    i = i + 1;
  }
  return out;
}
