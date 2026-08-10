// The /threads/:id/artifacts routes.

import { Db } from "../plume/driver.ts";
import { executeWith, findById, listWhere, placeholderAt } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem, queryParam } from "../rest/server.ts";
import { callerTags, stamp } from "./api-core.ts";
import { ArtifactRow, TURN_SEQ_NONE, TurnArtifact, artifactsByTurn, artifactsForTurn, artifactsMapping, deleteArtifact, getVersion, listArtifacts, putArtifact } from "./artifacts.ts";
import { normalScope } from "./knowledge.ts";
import { OfficeRenderAsk, officeRender } from "./office-render.ts";
import { jsonList, jsonText } from "./scan.ts";
import { ownedThread } from "./threads.ts";

// Every field is required, `note` included — JSON.parse refuses a body missing
// one, so "no note" is spelled "note":"" rather than left out.
type ArtifactPost = { path: string, title: string, content: string, note: string };

// The artifact a slot names, or a row whose id is "". Callers test `id == ""`.
//
// A slot and not a path in the URL, because the slot is the number a tab keeps
// while a title is edited and a path is a second thing to escape. There is no
// index on (thread_id, slot) and no lookup for it in the storage module, so
// this walks the list a tab strip already reads — a thread holds a handful of
// artifacts, and a scan of a handful is not worth an index that would then
// have to be kept honest against the slot-reuse bug the module documents.
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

// A slot from the URL, or -1 when it is not a number. -1 matches nothing:
// every stored slot counts up from 0.
function slotParam(req: Request): int {
  return parseInt(param(req, "slot")) ?? -1;
}

// An artifact's identity as JSON. The body is never in here — a listing that
// carried half a megabyte per row is why the versions table stores `bytes`.
function artifactJson(a: ArtifactRow): string {
  return "{\"slot\":" + `${a.slot}`
    + ",\"path\":" + JSON.stringify(a.path)
    + ",\"title\":" + JSON.stringify(a.title)
    + ",\"kind\":" + JSON.stringify(a.kind)
    + ",\"mime\":" + JSON.stringify(a.mime)
    + ",\"version\":" + `${a.currentVersion}`
    + ",\"previewToken\":" + JSON.stringify(a.previewToken)
    + ",\"createdAt\":" + JSON.stringify(a.createdAt)
    + ",\"updatedAt\":" + JSON.stringify(a.updatedAt) + "}";
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
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + artifactJson(rows[i]);
      i = i + 1;
    }
    return ok(out + "]");
  }

  // Save a body at a path. A path that already exists gets a new version, not
  // a second artifact, and the reply carries the version number so a caller
  // knows which of two concurrent saves it won.
  @post("/")
  create(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"path\":\"/report.html\",\"title\":\"Q3\",\"content\":\"...\",\"note\":\"\"}");
    }
    let body: ArtifactPost = JSON.parse<ArtifactPost>(req.body);
    // "uploaded", always. This route is a person with a console; the model's
    // writes come through the tool and say "generated". The distinction is the
    // only thing in a version row that answers "who wrote this", so a route
    // that let the caller name its own origin would erase it.
    let written = putArtifact(this.db, {
      threadId: param(req, "id"), path: body.path, title: body.title,
      content: body.content, note: body.note, origin: "uploaded",
      // A person may deliberately re-upload a path — that IS a new version.
      mustCreate: false,
      // A console upload happens outside any conversation round, so there is
      // no turn for the version row to point at.
      turnSeq: TURN_SEQ_NONE, now: stamp(),
    });
    if (!written.ok) { return badRequest(written.problem); }
    return created("{\"slot\":" + `${written.slot}`
      + ",\"path\":" + JSON.stringify(normalScope(body.path))
      + ",\"version\":" + `${written.version}`
      + ",\"previewToken\":" + JSON.stringify(written.previewToken) + "}");
  }

  // Start this conversation from a template: its files land as version 1,
  // in one call, before anything is said. "uploaded" for the same reason the
  // route above is — a template is a person choosing a starting point, and
  // nothing generated it.
  //
  // Partial application is possible and deliberate: a template whose third
  // file is refused still lays down the first two, and the reply names what
  // did not land. The alternative — a transaction across artifact writes —
  // would make one bad path lose the whole start.
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
    let wrote = "";
    let refused = "";
    let i: int = 0;
    while (i < files.length) {
      let put = putArtifact(this.db, {
        threadId: param(req, "id"), path: files[i].path, title: files[i].title,
        content: files[i].body, note: "started from template " + tpl.label,
        origin: "uploaded", mustCreate: false, turnSeq: TURN_SEQ_NONE, now: stamp(),
      });
      if (put.ok) {
        if (wrote != "") { wrote = wrote + ","; }
        wrote = wrote + JSON.stringify(normalScope(files[i].path));
      } else {
        if (refused != "") { refused = refused + ","; }
        refused = refused + JSON.stringify(files[i].path + ": " + put.problem);
      }
      i = i + 1;
    }
    return created("{\"template\":" + JSON.stringify(tpl.label)
      + ",\"skillName\":" + JSON.stringify(tpl.skillName)
      + ",\"wrote\":[" + wrote + "]"
      + ",\"refused\":[" + refused + "]}");
  }

  // Which versions each round produced — the join a chat client renders its
  // cards from, one query for the whole conversation. `?turn=N` narrows to one
  // round. Console uploads never appear: no round made them.
  //
  // Declared before the slot routes on purpose. "/by-turn" is a literal where
  // ":slot" is a parameter, and the router refuses at startup a table whose
  // literal is written second — the parameter would shadow it.
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
      // A turn that is not a number reads as TURN_SEQ_NONE, which the read
      // guards against and answers with nothing — the honest reply to a
      // question about a round that does not exist.
      rows = artifactsForTurn(this.db, param(req, "id"), parseInt(turn) ?? TURN_SEQ_NONE);
    }
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"turnSeq\":" + `${rows[i].turnSeq}`
        + ",\"slot\":" + `${rows[i].slot}`
        + ",\"path\":" + JSON.stringify(rows[i].path)
        + ",\"title\":" + JSON.stringify(rows[i].title)
        + ",\"kind\":" + JSON.stringify(rows[i].kind)
        + ",\"version\":" + `${rows[i].version}` + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  @get("/:slot")
  find(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }
    return ok(artifactJson(artifact));
  }

  // One version, body included. JSON, on the console origin, whatever the
  // artifact's own type is — a caller that wants it rendered follows the
  // preview link.
  @get("/:slot/versions/:n")
  version(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }
    let row = getVersion(this.db, artifact.id, parseInt(param(req, "n")) ?? 0);
    if (row.id == "") { return notFound("version " + param(req, "n")); }
    return ok("{\"slot\":" + `${artifact.slot}`
      + ",\"path\":" + JSON.stringify(artifact.path)
      + ",\"version\":" + `${row.version}`
      + ",\"bytes\":" + `${row.bytes}`
      + ",\"origin\":" + JSON.stringify(row.origin)
      + ",\"turnSeq\":" + `${row.turnSeq}`
      + ",\"note\":" + JSON.stringify(row.note)
      + ",\"createdAt\":" + JSON.stringify(row.createdAt)
      + ",\"content\":" + JSON.stringify(row.body) + "}");
  }

  // One office document as a PDF, base64, converted by the platform.
  //
  // The console draws .docx and .pptx from this rather than laying them out
  // itself: LibreOffice is the engine those formats were written against, and
  // a JavaScript re-implementation of one can be close but never right. See
  // office-render.ts for what runs and how it is contained.
  //
  // Base64 rather than the PDF's own bytes, and that is not a preference: a
  // Lumen string is UTF-8 and a PDF is not, so binary cannot ride a Reply at
  // all. It is the same boundary every binary artifact already crosses — the
  // store holds text, the viewer holds bytes — and the browser decodes it
  // where pdf.js wants an array.
  //
  // `?v=` pins a version and no `v` means the current one, matching the
  // preview route's rule. A pinned answer is immutable and says so; the
  // unpinned one is not cached at the edge because it follows the artifact.
  // The conversion underneath is cached either way, forever, because its key
  // is a version that can never be rewritten.
  //
  // A conversion is seconds of CPU in a container, so this is deliberately
  // behind the owner guard like every other route on this controller — the
  // token-addressed preview host does not offer it. Somewhere that hands out
  // a capability URL should not also hand out an unauthenticated way to make
  // the box run LibreOffice.
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
    // A refusal is a sentence a reader can act on — "is the image built",
    // "this document may be corrupt" — so it is answered as one rather than
    // as a 500 the console would render as a blank panel.
    if (!made.ok) { return badRequest(made.problem); }
    let out = ok("{\"slot\":" + `${artifact.slot}`
      + ",\"path\":" + JSON.stringify(artifact.path)
      + ",\"version\":" + `${version}`
      + ",\"cached\":" + (made.cached ? "true" : "false")
      + ",\"pdf\":" + JSON.stringify(made.body) + "}");
    if (asked > 0) {
      out.headers.set("cache-control", "private, max-age=31536000, immutable");
    }
    return out;
  }

  // Mint a new preview token, so every link handed out so far stops resolving.
  //
  // The token survives saving on purpose — a link shared with a reader must
  // not break because the author edited — which leaves this as the only way to
  // take one back after it reaches somebody it was not meant for.
  //
  // `persist` is right here and wrong one table over: the identity row is a
  // pointer where the last writer wins, so an upsert on the same id is the
  // intent. The versions log is append-only and takes an explicit INSERT.
  @post("/:slot/rotate")
  rotate(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let artifact = artifactAtSlot(this.db, param(req, "id"), slotParam(req));
    if (artifact.id == "") { return notFound("artifact " + param(req, "slot")); }

    // Only the two columns this route owns, by UPDATE — not the whole row.
    //
    // `persist` is an upsert of every column, so writing the row back here
    // wrote `current_version` back too, from a value read before the update.
    // A run appending version 6 between that read and this write had its
    // pointer rewound to 5: the v6 row stayed in the table with nothing
    // pointing at it, preview and read_artifact both served v5 with no error,
    // and the next write took 7 — so 6 was orphaned, invisible in the version
    // strip, and the agent's own "saved as version 6" referred to something no
    // reader could reach. `title` and `updatedAt` were clobbered the same way.
    // Every token in the thread, not just this one.
    //
    // A token resolves any artifact in its thread by path, so revoking one
    // artifact's link while its neighbours' links still reach it revokes
    // nothing: share /preview/<B>/, decide /a.html is sensitive, rotate
    // /a.html — and /preview/<B>/a.html still serves it. A control named
    // "New link" that leaves the content reachable is worse than none, because
    // it is believed.
    //
    // So rotation is thread-wide, which is the honest shape of a thread-wide
    // capability: every link previously handed out for this conversation stops
    // working together. Rotating one row alone is only correct if a token ever
    // addresses one row again.
    let now = stamp();
    // `listWhere` answers one JSON array, so the rows are scanned out of it.
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
    return ok("{\"slot\":" + `${artifact.slot}`
      + ",\"previewToken\":" + JSON.stringify(fresh)
      + ",\"replaced\":" + `${mine.length}` + "}");
  }

  // The artifact and every version it ever had. There is no undo.
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
