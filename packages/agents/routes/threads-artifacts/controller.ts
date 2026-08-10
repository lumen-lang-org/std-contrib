import { Db } from "../../../plume/driver.ts";
import { executeWith, findById, listWhere, placeholderAt } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, createdJson, noContent, notFound, okJson, param, problem, queryParam } from "../../../rest/server.ts";
import { callerTags, stamp } from "../../api-core.ts";
import { ArtifactRow, TURN_SEQ_NONE, TurnArtifact, artifactsByTurn, artifactsForTurn, artifactsMapping, deleteArtifact, getVersion, listArtifacts, putArtifact } from "../../artifacts.ts";
import { normalScope } from "../../knowledge.ts";
import { OfficeRenderAsk, officeRender } from "../../office-render.ts";
import { jsonList, jsonText } from "../../scan.ts";
import { ownedThread } from "../../threads.ts";
import { ArtifactCreated, ArtifactPdfView, ArtifactPost, ArtifactRotated, ArtifactVersionView, ArtifactView, TemplateStarted, TurnArtifactView } from "./types.ts";

function artifactAtSlot(db: Db, threadId: string, slot: int): ArtifactRow {
  let absent: ArtifactRow = {
    id: "", threadId: "", slot: -1, path: "", title: "", kind: "", mime: "",
    currentVersion: 0, previewToken: "", createdAt: "", updatedAt: "",
  };
  if (slot < 0) { return absent; }
  let rows = listArtifacts(db, threadId);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].slot == slot) { return rows[i]; }
    i = i + 1;
  }
  return absent;
}

function slotParam(req: Request): int {
  return parseInt(param(req, "slot")) ?? -1;
}

function artifactView(a: ArtifactRow): ArtifactView {
  let v: ArtifactView = {
    slot: a.slot,
    path: a.path,
    title: a.title,
    kind: a.kind,
    mime: a.mime,
    version: a.currentVersion,
    previewToken: a.previewToken,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
  return v;
}

@controller("/threads/:id/artifacts")
export class ArtifactApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let rows = listArtifacts(this.db, param(req, "id"));
    let out: ArtifactView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      out.push(artifactView(rows[i]));
      i = i + 1;
    }
    return okJson(out);
  }

  @post("/")
  create(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"path\":\"/report.html\",\"title\":\"Q3\",\"content\":\"...\",\"note\":\"\"}");
    }
    let body: ArtifactPost = JSON.parse<ArtifactPost>(req.body);
    let written = putArtifact(this.db, {
      threadId: param(req, "id"), path: body.path, title: body.title,
      content: body.content, note: body.note, origin: "uploaded",
      mustCreate: false,
      turnSeq: TURN_SEQ_NONE, now: stamp(),
    });
    if (!written.ok) { return badRequest(written.problem); }
    let v: ArtifactCreated = {
      slot: written.slot,
      path: normalScope(body.path),
      version: written.version,
      previewToken: written.previewToken,
    };
    return createdJson(v);
  }

  @post("/from-template")
  fromTemplate(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let templateId = jsonText(req.body, "templateId");
    if (templateId == "") { return badRequest("a body is required: {\"templateId\":\"tpl-...\"}"); }
    let held = findById(this.db, templatesMapping(), templateId);
    if (held == "") { return notFound("template " + templateId); }
    let tpl: TemplateRow = JSON.parse<TemplateRow>(held);
    if (tpl.visibility != "public") { return notFound("template " + templateId); }

    let where = "template_id = " + placeholderAt(this.db, 1);
    let listed = listWhere(this.db, templateFilesMapping(), where, [templateId]);
    let files: TemplateFileRow[] = listed == "" ? [] : JSON.parse<TemplateFileRow[]>(listed);
    let wrote: string[] = [];
    let refused: string[] = [];
    let i: int = 0;
    while (i < files.length) {
      let put = putArtifact(this.db, {
        threadId: param(req, "id"), path: files[i].path, title: files[i].title,
        content: files[i].body, note: "started from template " + tpl.label,
        origin: "uploaded", mustCreate: false, turnSeq: TURN_SEQ_NONE, now: stamp(),
      });
      if (put.ok) {
        wrote.push(normalScope(files[i].path));
      } else {
        refused.push(files[i].path + ": " + put.problem);
      }
      i = i + 1;
    }
    let v: TemplateStarted = {
      template: tpl.label,
      skillName: tpl.skillName,
      wrote: wrote,
      refused: refused,
    };
    return createdJson(v);
  }

  @get("/by-turn")
  byTurn(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let turn = queryParam(req, "turn", "");
    let rows: TurnArtifact[] = [];
    if (turn == "") {
      rows = artifactsByTurn(this.db, param(req, "id"));
    } else {
      rows = artifactsForTurn(this.db, param(req, "id"), parseInt(turn) ?? TURN_SEQ_NONE);
    }
    let out: TurnArtifactView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let each: TurnArtifactView = {
        turnSeq: rows[i].turnSeq,
        slot: rows[i].slot,
        path: rows[i].path,
        title: rows[i].title,
        kind: rows[i].kind,
        version: rows[i].version,
      };
      out.push(each);
      i = i + 1;
    }
    return okJson(out);
  }

  @get("/:slot")
  find(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }
    let v: ArtifactView = artifactView(artifact);
    return okJson(v);
  }

  @get("/:slot/versions/:n")
  version(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }
    let row = getVersion(this.db, artifact.id, parseInt(param(req, "n")) ?? 0);
    if (row.id == "") { return notFound("version " + param(req, "n")); }
    let v: ArtifactVersionView = {
      slot: artifact.slot,
      path: artifact.path,
      version: row.version,
      bytes: row.bytes,
      origin: row.origin,
      turnSeq: row.turnSeq,
      note: row.note,
      createdAt: row.createdAt,
      content: row.body,
    };
    return okJson(v);
  }

  @get("/:slot/pdf")
  pdf(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }
    let asked = parseInt(queryParam(req, "v", "")) ?? 0;
    let version = asked > 0 ? asked : artifact.currentVersion;
    let row = getVersion(this.db, artifact.id, version);
    if (row.id == "") { return notFound("version " + `${version}`); }

    let ask: OfficeRenderAsk = {
      artifactId: artifact.id, version: version,
      path: artifact.path, body: row.body, now: stamp(),
    };
    let made = officeRender(this.db, ask);
    if (!made.ok) { return badRequest(made.problem); }
    let v: ArtifactPdfView = {
      slot: artifact.slot,
      path: artifact.path,
      version: version,
      cached: made.cached,
      pdf: made.body,
    };
    let out = okJson(v);
    if (asked > 0) {
      out.headers.set("cache-control", "private, max-age=31536000, immutable");
    }
    return out;
  }

  @post("/:slot/rotate")
  rotate(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }

    let now = stamp();
    let mine = jsonList(listWhere(this.db, artifactsMapping(),
      "thread_id = " + placeholderAt(this.db, 1), [param(req, "id")]));
    let fresh = "";
    let i: int = 0;
    while (i < mine.length) {
      let each: ArtifactRow = JSON.parse<ArtifactRow>(mine[i]);
      let token = crypto.randomUUID();
      if (each.id == artifact.id) { fresh = token; }
      let turned = executeWith(this.db,
        "UPDATE artifacts SET preview_token = " + placeholderAt(this.db, 1)
        + ", updated_at = " + placeholderAt(this.db, 2)
        + " WHERE id = " + placeholderAt(this.db, 3),
        [token, now, each.id]);
      if (!turned.ok) { return badRequest("the links could not be replaced; try again"); }
      i = i + 1;
    }
    let v: ArtifactRotated = {
      slot: artifact.slot,
      previewToken: fresh,
      replaced: mine.length,
    };
    return okJson(v);
  }

  @del("/:slot")
  remove(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }
    let problem = deleteArtifact(this.db, param(req, "id"), artifact.path);
    if (problem != "") { return badRequest(problem); }
    return noContent();
  }
}
