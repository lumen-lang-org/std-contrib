import { Db } from "../../../plume/driver.ts";
import { View, view, render } from "../../../press/template.ts";
import { placeholderAt } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, header, notFound, param, reply } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { ArtifactRow, findByToken, getArtifact, getVersion, imageMediaType } from "../../artifacts.ts";
import { officeRender, officeRenderExt } from "../../office-render.ts";

const PREVIEW_CSP_CLOSED: string = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

function previewHost(): string {
  let configured = process.env("AGENTS_PREVIEW_HOST") ?? "";
  let text = configured.trim().toLowerCase();
  let mark = text.indexOf("://");
  if (mark >= 0) { return text.substring(mark + 3, text.length); }
  return text;
}

function onPreviewHost(req: Request): bool {
  let configured = previewHost();
  if (configured == "") { return false; }
  let asked = header(req, "host").trim().toLowerCase();
  if (asked == "") { return false; }
  return asked == configured;
}

function previewOrigin(): string {
  let configured = (process.env("AGENTS_PREVIEW_HOST") ?? "").trim().toLowerCase();
  if (configured == "") { return ""; }
  if (configured.indexOf("://") >= 0) { return configured; }
  let host = previewHost();
  let name = host;
  let colon = host.indexOf(":");
  if (colon >= 0) { name = host.substring(0, colon); }
  if (name == "localhost" || name == "127.0.0.1") { return "http://" + host; }
  return "https://" + host;
}

function previewCsp(req: Request): string {
  if (!onPreviewHost(req)) { return PREVIEW_CSP_CLOSED; }
  let origin = previewOrigin();
  return "default-src 'none'"
    + "; script-src 'unsafe-inline' " + origin
    + "; style-src 'unsafe-inline' " + origin
    + "; img-src data: blob: https: http: " + origin
    + "; font-src data: " + origin
    + "; connect-src " + origin
    + "; form-action 'none'; base-uri 'none'; sandbox allow-scripts";
}

function previewType(req: Request, mime: string): string {
  if (!onPreviewHost(req)) { return "text/plain; charset=utf-8"; }
  return mime;
}

function previewChrome(token: string, newest: string): string {
  return "\n<script>(function(){"
    + "var base='/preview/'+" + JSON.stringify(token) + ";"
    + "var was=" + JSON.stringify(newest) + ";"
    + "setInterval(function(){fetch(base+'/__version',{cache:'no-store'})"
    + ".then(function(r){return r.text()})"
    + ".then(function(v){if(v!==was){location.reload()}})"
    + ".catch(function(){})},2000);"
    + "document.addEventListener('click',function(e){"
    + "var a=e.target&&e.target.closest?e.target.closest('a'):null;"
    + "if(!a){return}var h=a.getAttribute('href');"
    + "if(h&&h.charAt(0)==='/'&&h.indexOf('/preview/')!==0){e.preventDefault();location.href=base+h}"
    + "},true);"
    + "})()</script>";
}

function previewStamp(db: Db, threadId: string): string {
  let sql = "SELECT COUNT(*) FROM artifact_versions"
    + " JOIN artifacts ON artifacts.id = artifact_versions.artifact_id"
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1);
  if (!db.query(sql, [threadId])) { return "0"; }
  if (db.rows() == 0) { return "0"; }
  return db.value(0, 0);
}

function previewIsHtml(mime: string): bool {
  return mime.startsWith("text/html");
}

const PREVIEW_IMAGE_PAGE: string = "<!doctype html><html><head><title><%= path %></title></head>"
  + "<body style=\"margin:0;display:grid;place-items:center;min-height:100vh;background:#181a1d\">"
  + "<img alt=\"<%= path %>\" style=\"max-width:100%;max-height:100vh\""
  + " src=\"data:<%= mime %>;base64,<%- data %>\"></body></html>";

function previewImagePage(artifact: ArtifactRow, b64: string): string {
  let v: View = view();
  v.text.set("path", artifact.path);
  v.text.set("mime", imageMediaType(artifact.path));
  v.text.set("data", b64);
  return render(PREVIEW_IMAGE_PAGE, v);
}

function previewPresentable(req: Request, artifact: ArtifactRow, body: string): ArtifactRow {
  if (artifact.kind != "image" || !onPreviewHost(req)) { return artifact; }
  let asPage: ArtifactRow = {
    id: artifact.id, threadId: artifact.threadId, slot: artifact.slot,
    path: artifact.path, title: artifact.title, kind: artifact.kind,
    mime: "text/html; charset=utf-8", currentVersion: artifact.currentVersion,
    previewToken: artifact.previewToken, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
  };
  return asPage;
}

function previewReply(req: Request, artifact: ArtifactRow, body: string, cache: string): Reply {
  let answer = reply(200, body, previewType(req, artifact.mime));
  answer.headers.set("content-security-policy", previewCsp(req));
  answer.headers.set("x-content-type-options", "nosniff");
  answer.headers.set("referrer-policy", "no-referrer");
  answer.headers.set("cache-control", cache);
  return answer;
}

function previewBytes(req: Request, bytes: string, mime: string, cache: string): Reply {
  let answer = reply(200, bytes, mime);
  answer.headers.set("content-security-policy", previewCsp(req));
  answer.headers.set("x-content-type-options", "nosniff");
  answer.headers.set("referrer-policy", "no-referrer");
  answer.headers.set("cache-control", cache);
  return answer;
}

function previewLiveReply(db: Db, req: Request, artifact: ArtifactRow, body: string, cache: string): Reply {
  if (onPreviewHost(req)) {
    if (artifact.kind == "pdf") {
      return previewBytes(req, crypto.base64Decode(body), "application/pdf", cache);
    }
    if (artifact.kind == "office" && officeRenderExt(artifact.path) != "") {
      let made = officeRender(db, { artifactId: artifact.id, version: artifact.currentVersion,
        path: artifact.path, body: body, now: stamp() });
      if (made.ok) {
        return previewBytes(req, crypto.base64Decode(made.body), "application/pdf", cache);
      }
      return previewBytes(req, made.problem, "text/plain; charset=utf-8", cache);
    }
  }
  let row = previewPresentable(req, artifact, body);
  let served = body;
  if (row.kind == "image" && row.mime.startsWith("text/html")) {
    served = previewImagePage(row, body);
  }
  if (cache == "no-store" && previewIsHtml(row.mime) && onPreviewHost(req)) {
    served = served + previewChrome(param(req, "token"), previewStamp(db, row.threadId));
  }
  return previewReply(req, row, served, cache);
}

@controller("/preview")
export class PreviewApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/:token")
  preview(req: Request, @PathVariable("token") token: string,
          @RequestParam("v", "") asked: int): Reply {
    let artifact = findByToken(this.db, token);
    if (artifact.id == "") { return notFound("artifact"); }
    if (asked < 1) {
      let newest = nextVersion(this.db, artifact.id) - 1;
      let current = getVersion(this.db, artifact.id, newest);
      if (current.id == "") { current = getVersion(this.db, artifact.id, artifact.currentVersion); }
      if (current.id == "") { return notFound("artifact"); }
      return previewLiveReply(this.db, req, artifact, current.body, "no-store");
    }
    let row = getVersion(this.db, artifact.id, asked);
    if (row.id == "") { return notFound("artifact"); }
    let pinnedRow = previewPresentable(req, artifact, row.body);
    let pinnedBody = row.body;
    if (pinnedRow.kind == "image" && pinnedRow.mime.startsWith("text/html")) {
      pinnedBody = previewImagePage(pinnedRow, row.body);
    }
    return previewReply(req, pinnedRow, pinnedBody, "private, max-age=31536000, immutable");
  }

  @get("/:token/*path")
  sibling(req: Request, @PathVariable("token") token: string,
          @PathVariable("path") path: string): Reply {
    let artifact = findByToken(this.db, token);
    if (artifact.id == "") { return notFound("artifact"); }
    if (path == "__version") {
      let stamp = reply(200, previewStamp(this.db, artifact.threadId), "text/plain; charset=utf-8");
      stamp.headers.set("access-control-allow-origin", "*");
      stamp.headers.set("cache-control", "no-store");
      return stamp;
    }
    let found = getArtifact(this.db, artifact.threadId, path);
    if (found.id == "") { return notFound("artifact"); }
    let row = getVersion(this.db, found.id, found.currentVersion);
    if (row.id == "") { return notFound("artifact"); }
    return previewLiveReply(this.db, req, found, row.body, "no-store");
  }
}
