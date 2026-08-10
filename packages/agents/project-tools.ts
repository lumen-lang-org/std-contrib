import { Db } from "../plume/driver.ts";
import { findById, persist } from "../plume/plume.ts";
import { ToolSpec, toolSpec } from "./provider.ts";
import { FileToolResult } from "./workspace.ts";
import { jsonText } from "./scan.ts";
import { ProjectRow, assignProject, projectsMapping, projectsOf } from "./projects.ts";
import { maySchedule } from "./task-tools.ts";

function not(): FileToolResult {
  let none: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  return none;
}

function no(why: string): FileToolResult {
  let bad: FileToolResult = { handled: true, ok: false, text: why, line: 0, changed: "" };
  return bad;
}

function yes(text: string): FileToolResult {
  let good: FileToolResult = { handled: true, ok: true, text: text, line: 0, changed: "" };
  return good;
}

export function projectTools(): ToolSpec[] {
  let which = "From list_projects. Its name works too.";
  let out: ToolSpec[] = [];

  out.push(toolSpec("list_projects",
    "The projects this person keeps: groups of conversations, each optionally carrying "
    + "instructions every conversation inside is told. Call it before creating one.",
    "{\"type\":\"object\",\"properties\":{}}"));

  out.push(toolSpec("create_project",
    "A new project: a name, and optionally the instructions its conversations inherit.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"name\":{\"type\":\"string\",\"description\":\"A few words for the sidebar.\"},"
    + "\"instructions\":{\"type\":\"string\",\"description\":\"Told to every conversation in the project, verbatim, each round. Leave out for a plain group.\"}},"
    + "\"required\":[\"name\"]}"));

  out.push(toolSpec("move_to_project",
    "Put THIS conversation into a project, so it inherits the project's instructions from the "
    + "next message on. Only the conversation this is said in — moving another conversation is "
    + "done from its own chat or the sidebar.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"project\":{\"type\":\"string\",\"description\":\"" + which + "\"}},"
    + "\"required\":[\"project\"]}"));

  return out;
}

export type ProjectToolCall = {
  owner: string,
  threadId: string,
  name: string,
  args: string,
  nowMs: number,
};

function projectSaid(db: Db, owner: string, said: string): ProjectRow {
  let doc = findById(db, projectsMapping(), said);
  if (doc != "") {
    let row: ProjectRow = JSON.parse<ProjectRow>(doc);
    if (row.owner == owner) { return row; }
  }
  let rows = JSON.parse<ProjectRow[]>(projectsOf(db, owner));
  let found: int = -1;
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].name.toLowerCase() == said.toLowerCase()) {
      if (found >= 0) { return empty(); }
      found = i;
    }
    i = i + 1;
  }
  if (found >= 0) { return rows[found]; }
  return empty();
}

function empty(): ProjectRow {
  let none: ProjectRow = { id: "", owner: "", name: "", instructions: "", filesThreadId: "", createdAt: "" };
  return none;
}

export function callProjectTool(db: Db, call: ProjectToolCall): FileToolResult {
  if (call.name != "list_projects" && call.name != "create_project" && call.name != "move_to_project") {
    return not();
  }
  if (!maySchedule(call.owner)) {
    return no("signing in is what makes a project theirs to keep — say so.");
  }

  if (call.name == "list_projects") {
    let rows = JSON.parse<ProjectRow[]>(projectsOf(db, call.owner));
    if (rows.length == 0) { return yes("No projects yet — create_project starts one."); }
    let out = `${rows.length}` + " project(s):\n";
    let i: int = 0;
    while (i < rows.length) {
      out = out + "\n" + rows[i].name + " [" + rows[i].id + "]"
        + (rows[i].instructions == "" ? "" : "\n  instructions: " + firstLine(rows[i].instructions)) + "\n";
      i = i + 1;
    }
    return yes(out);
  }

  if (call.name == "create_project") {
    let name = jsonText(call.args, "name").trim();
    if (name == "") { return no("a project needs a name: {\"name\":\"...\"}"); }
    let taken = projectSaid(db, call.owner, name);
    if (taken.id != "") { return no("\"" + name + "\" exists already — move_to_project puts this conversation in it."); }
    let row: ProjectRow = {
      id: crypto.randomUUID(), owner: call.owner, name: name,
      instructions: jsonText(call.args, "instructions").trim(),
      filesThreadId: "", createdAt: `${call.nowMs}`,
    };
    persist(db, projectsMapping(), JSON.stringify(row));
    return yes("Created \"" + name + "\"."
      + (row.instructions == "" ? "" : " Its conversations will be told: " + firstLine(row.instructions))
      + " move_to_project puts this conversation in it.");
  }

  if (call.threadId == "") {
    return no("this run has no conversation to move — say it in the conversation that should move.");
  }
  let said = jsonText(call.args, "project").trim();
  if (said == "") { return no("say which project: {\"project\":\"...\"} — list_projects shows them."); }
  let project = projectSaid(db, call.owner, said);
  if (project.id == "") { return no("no project by that name or id — list_projects shows them."); }
  let problem = assignProject(db, call.threadId, project.id);
  if (problem != "") { return no(problem); }
  return yes("Moved. From the next message on, this conversation carries \"" + project.name + "\""
    + (project.instructions == "" ? "." : "\" and its instructions."));
}

function firstLine(said: string): string {
  let cut = said.indexOf("\n");
  let one = cut < 0 ? said : said.slice(0, cut);
  return one.length > 90 ? one.slice(0, 87) + "…" : one;
}
