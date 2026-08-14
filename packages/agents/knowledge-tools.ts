import { Db } from "../plume/driver.ts";
import { DbOrder, executeWith, findById, listOrdered, persist, placeholderAt } from "../plume/plume.ts";
import { ToolSpec, toolSpec } from "./provider.ts";
import { FileToolResult } from "./workspace.ts";
import { jsonText } from "./scan.ts";
import { AgentRow, SkillRow, agentsMapping, skillsMapping, modelsMapping, ModelRow, writeSetting } from "./schema.ts";
import { listSources, normalScope } from "./knowledge.ts";
import { JobRepository } from "./routes/jobs/job.repository.ts";
import { JOB_QUEUED } from "./routes/jobs/entities/index-job.entity.ts";
import { DocumentRepository } from "./routes/documents/document.repository.ts";
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

export function knowledgeTools(): ToolSpec[] {
  let out: ToolSpec[] = [];

  out.push(toolSpec("add_document",
    "Put text into the knowledge corpus, where agents scoped to its folder retrieve it. It is "
    + "queued for indexing and searchable in about a minute. The text itself goes in `body` — "
    + "for a web page, read it first and pass what matters.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"source\":{\"type\":\"string\",\"description\":\"A plain name to file it under: letters, digits, _ and - only. Retrieval cites it.\"},"
    + "\"scope\":{\"type\":\"string\",\"description\":\"The folder, such as /hackathon or /specs/plume. Agents only see folders they are scoped to.\"},"
    + "\"body\":{\"type\":\"string\",\"description\":\"The document's text, whole.\"}},"
    + "\"required\":[\"source\",\"scope\",\"body\"]}"));

  out.push(toolSpec("list_documents",
    "What the corpus holds in one folder: each source with its chunk count and size. Call "
    + "before forgetting, and to answer \\\"what do I have about…\\\" questions about the corpus itself.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"scope\":{\"type\":\"string\",\"description\":\"The folder, such as /hackathon. Defaults to /.\"}},"
    + "\"required\":[]}"));

  out.push(toolSpec("forget_document",
    "Remove one source from the corpus — its chunks and its kept original file. Gone from every "
    + "agent's retrieval at once, no undo. Name it exactly, from list_documents.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"source\":{\"type\":\"string\",\"description\":\"The source name, from list_documents.\"}},"
    + "\"required\":[\"source\"]}"));

  out.push(toolSpec("list_skills",
    "The skills on this deployment: named instruction sets any agent can load with use_skill. "
    + "Name and one-line description each. Call before creating one that may exist.",
    "{\"type\":\"object\",\"properties\":{}}"));

  out.push(toolSpec("create_skill",
    "A new skill: a name, a one-line description for choosing, and the FULL instructions — "
    + "write them complete and imperative, as for a capable colleague, because they are served "
    + "verbatim to whichever agent loads the skill.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"name\":{\"type\":\"string\",\"description\":\"letters, digits and dashes — it becomes use_skill's argument and a path segment.\"},"
    + "\"description\":{\"type\":\"string\",\"description\":\"One line, for choosing; never the doing.\"},"
    + "\"instructions\":{\"type\":\"string\",\"description\":\"The whole body, markdown welcome.\"}},"
    + "\"required\":[\"name\",\"description\",\"instructions\"]}"));

  out.push(toolSpec("change_skill",
    "Replace a skill's description or instructions. Whole texts, not diffs. show it first: "
    + "use_skill loads the current body for reading.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"skill\":{\"type\":\"string\",\"description\":\"The skill's name, from list_skills.\"},"
    + "\"description\":{\"type\":\"string\",\"description\":\"A new one-liner.\"},"
    + "\"instructions\":{\"type\":\"string\",\"description\":\"The whole new body.\"}},"
    + "\"required\":[\"skill\"]}"));

  out.push(toolSpec("set_banner",
    "The one sentence shown above every visitor's page — maintenance tonight, a new "
    + "capability, a holiday notice. Empty text takes it down. Live without a deploy.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"text\":{\"type\":\"string\",\"description\":\"The sentence, or \\\"\\\" to clear.\"}},"
    + "\"required\":[\"text\"]}"));

  return out;
}

export type KnowledgeToolCall = {
  owner: string,
  name: string,
  args: string,
  nowMs: number,
};

function anyEmbedder(db: Db): ModelRow {
  let keys: DbOrder[] = [{ column: "label" }];
  let rows = JSON.parse<ModelRow[]>(listOrdered(db, modelsMapping(), { order: keys }));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].kind == "embedding" && rows[i].enabled) {
      return rows[i];
    }
    i = i + 1;
  }
  let none: ModelRow = {
    id: "",
    label: "",
    apiName: "",
    provider: "",
    kind: "",
    dimensions: 0,
    baseUrl: "",
    enabled: false,
    contextTokens: 0,
  };
  return none;
}

function skillSaid(db: Db, said: string): SkillRow {
  let keys: DbOrder[] = [{ column: "skill_name" }];
  let rows = JSON.parse<SkillRow[]>(listOrdered(db, skillsMapping(), { order: keys }));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].skillName.toLowerCase() == said.toLowerCase()) {
      return rows[i];
    }
    i = i + 1;
  }
  let none: SkillRow = {
    id: "",
    skillName: "",
    description: "",
    body: "",
    source: "",
    sourceUrl: "",
    visibility: "",
    featuredRank: 0,
    updatedAt: "",
  };
  return none;
}

function plainName(name: string): bool {
  if (name == "" || name.length > 48) {
    return false;
  }
  let i: int = 0;
  while (i < name.length) {
    let c = name.charCodeAt(i);
    let ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 45 || c == 95;
    if (!ok) {
      return false;
    }
    i = i + 1;
  }
  return true;
}

export function callKnowledgeTool(db: Db, call: KnowledgeToolCall): FileToolResult {
  if (call.name != "add_document" && call.name != "list_documents"
    && call.name != "forget_document" && call.name != "list_skills"
    && call.name != "create_skill" && call.name != "change_skill"
    && call.name != "set_banner") {
    return not();
  }
  if (!maySchedule(call.owner)) {
    return no("signing in is what makes the corpus theirs to grow — say so.");
  }

  if (call.name == "add_document") {
    let source = jsonText(call.args, "source").trim();
    if (!plainName(source)) {
      return no("a source is a plain name: lowercase letters, digits, _ and -.");
    }
    let scope = normalScope(jsonText(call.args, "scope").trim());
    let body = jsonText(call.args, "body");
    if (body.trim() == "") {
      return no("an empty document has nothing to retrieve — pass the text in body.");
    }
    let embedder = anyEmbedder(db);
    if (embedder.id == "") {
      return no("this deployment has no enabled embedding model, so nothing can be indexed.");
    }
    let id = new JobRepository(db).enqueue(source, scope, embedder.id, body, `${call.nowMs}`);
    if (id == "") {
      return no("the indexing queue refused the job.");
    }
    return yes("Queued \"" + source + "\" under " + scope + " — searchable in about a minute. "
      + "Agents scoped to " + scope + " will retrieve and cite it.");
  }

  if (call.name == "set_banner") {
    let said = jsonText(call.args, "text");
    let saved = writeSetting(db, "banner", said.trim());
    if (saved != "") {
      return no("the banner setting was not written — every page still shows what it showed.");
    }
    return yes(said.trim() == "" ? "Banner down." : "Up, above every page: " + said.trim());
  }

  if (call.name == "list_documents") {
    let scope = normalScope(jsonText(call.args, "scope").trim());
    let rows = listSources(db, scope);
    if (rows.length == 0) {
      return yes("Nothing in " + scope + " yet — add_document files the first.");
    }
    let out = `${rows.length}` + " source(s) in " + scope + ":\n";
    let i: int = 0;
    while (i < rows.length) {
      out = out + "\n" + rows[i].source + " — " + `${rows[i].chunks}` + " chunk(s), " + `${rows[i].bytes}` + " bytes";
      i = i + 1;
    }
    return yes(out);
  }

  if (call.name == "forget_document") {
    let source = jsonText(call.args, "source").trim();
    if (source == "") {
      return no("say which source: {\"source\":\"...\"} — list_documents shows them.");
    }
    let gone = executeWith(db, "DELETE FROM documents WHERE source = " + db.placeholder, [source]);
    if (!gone.ok) {
      return no("\"" + source + "\" is still in the corpus — the delete failed, so agents keep retrieving it.");
    }
    new DocumentRepository(db, "").forgetFiles(source);
    return yes("Forgotten: \"" + source + "\" — out of every agent's retrieval now.");
  }

  if (call.name == "list_skills") {
    let keys: DbOrder[] = [{ column: "skill_name" }];
    let rows = JSON.parse<SkillRow[]>(listOrdered(db, skillsMapping(), { order: keys }));
    if (rows.length == 0) {
      return yes("No skills yet — create_skill writes one.");
    }
    let out = `${rows.length}` + " skill(s):\n";
    let i: int = 0;
    while (i < rows.length) {
      out = out + "\n" + rows[i].skillName + " — " + rows[i].description;
      i = i + 1;
    }
    return yes(out);
  }

  if (call.name == "create_skill") {
    let name = jsonText(call.args, "name").trim().toLowerCase();
    if (!plainName(name)) {
      return no("a skill name is lowercase letters, digits and dashes, at most 48.");
    }
    if (skillSaid(db, name).id != "") {
      return no("\"" + name + "\" exists — change_skill replaces its text.");
    }
    let description = jsonText(call.args, "description").trim();
    let instructions = jsonText(call.args, "instructions");
    if (description == "" || instructions.trim() == "") {
      return no("a skill needs its one-line description and its whole instructions.");
    }
    let row: SkillRow = {
      id: crypto.randomUUID(), skillName: name, description: description,
      body: instructions,
      source: "local", sourceUrl: "", visibility: "private", featuredRank: 0, updatedAt: `${call.nowMs}`,
    };
    let stored = persist(db, skillsMapping(), JSON.stringify(row));
    if (!stored.ok) {
      return no("\"" + name + "\" was not written — nothing to load with use_skill.");
    }
    let keys2: DbOrder[] = [{ column: "agent_name" }];
    let agents = JSON.parse<AgentRow[]>(listOrdered(db, agentsMapping(), { order: keys2 }));
    let a: int = 0;
    let carrier = "";
    while (a < agents.length) {
      if (agents[a].isDefault) {
        let attached = executeWith(db, "INSERT INTO agent_skills (agent_id, skill_id) VALUES ("
          + db.placeholder + ", " + placeholderAt(db, 2) + ")", [agents[a].id, row.id]);
        if (attached.ok) {
          carrier = agents[a].agentName;
        }
      }
      a = a + 1;
    }
    return yes("Created" + (carrier == "" ? "" : " and attached to " + carrier) + ". "
      + "use_skill(\"" + name + "\") loads it — " + `${instructions.length}` + " characters of instructions.");
  }

  let saidName = jsonText(call.args, "skill").trim();
  if (saidName == "") {
    return no("say which skill: {\"skill\":\"...\"} — list_skills shows them.");
  }
  let skill = skillSaid(db, saidName);
  if (skill.id == "") {
    return no("no skill called \"" + saidName + "\" — list_skills shows them.");
  }
  if (skill.source == "repo") {
    return no("\"" + skill.skillName + "\" comes from a repository — the next sync would lose a chat edit. Fork it: create_skill under a new name.");
  }
  let description2 = jsonText(call.args, "description").trim();
  let instructions2 = jsonText(call.args, "instructions");
  if (description2 == "" && instructions2.trim() == "") {
    return no("say what changes: description, instructions, or both.");
  }
  let edited: SkillRow = {
    id: skill.id, skillName: skill.skillName,
    description: description2 == "" ? skill.description : description2,
    body: instructions2.trim() == "" ? skill.body : instructions2,
    source: skill.source, sourceUrl: skill.sourceUrl,
    visibility: skill.visibility, featuredRank: skill.featuredRank, updatedAt: `${call.nowMs}`,
  };
  let written = persist(db, skillsMapping(), JSON.stringify(edited));
  if (!written.ok) {
    return no("\"" + skill.skillName + "\" is unchanged — the write failed, so use_skill still loads the old text.");
  }
  return yes("Changed \"" + skill.skillName + "\".");
}
