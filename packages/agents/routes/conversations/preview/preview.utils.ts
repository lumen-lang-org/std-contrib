import { View, view, render } from "../../../../press/template.ts";
import { Reply, Request, Respond, header } from "../../../../rest/server.ts";
import { ArtifactRow, imageMediaType } from "../../../artifacts.ts";

const PREVIEW_CSP_CLOSED: string = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

export function previewHost(): string {
  let configured = process.env("AGENTS_PREVIEW_HOST") ?? "";
  let text = configured.trim().toLowerCase();
  let mark = text.indexOf("://");
  if (mark >= 0) {
    return text.substring(mark + 3, text.length);
  }
  return text;
}

export function previewFacing(request: Request): bool {
  let configured = previewHost();
  if (configured == "") {
    return false;
  }
  let asked = header(request, "host").trim().toLowerCase();
  if (asked == "") {
    return false;
  }
  return asked == configured;
}

export function previewOrigin(): string {
  let configured = (process.env("AGENTS_PREVIEW_HOST") ?? "").trim().toLowerCase();
  if (configured == "") {
    return "";
  }
  if (configured.indexOf("://") >= 0) {
    return configured;
  }
  let host = previewHost();
  let name = host;
  let colon = host.indexOf(":");
  if (colon >= 0) {
    name = host.substring(0, colon);
  }
  if (name == "localhost" || name == "127.0.0.1") {
    return "http://" + host;
  }
  return "https://" + host;
}

export function previewCsp(facing: bool): string {
  if (!facing) {
    return PREVIEW_CSP_CLOSED;
  }
  let origin = previewOrigin();
  return "default-src 'none'"
    + "; script-src 'unsafe-inline' " + origin
    + "; style-src 'unsafe-inline' " + origin
    + "; img-src data: blob: https: http: " + origin
    + "; font-src data: " + origin
    + "; connect-src " + origin
    + "; form-action 'none'; base-uri 'none'; sandbox allow-scripts";
}

export function previewType(facing: bool, mime: string): string {
  if (!facing) {
    return "text/plain; charset=utf-8";
  }
  return mime;
}

export function previewChrome(token: string, newest: string): string {
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

export function previewIsHtml(mime: string): bool {
  return mime.startsWith("text/html");
}

const PREVIEW_IMAGE_PAGE: string = "<!doctype html><html><head><title><%= path %></title></head>"
  + "<body style=\"margin:0;display:grid;place-items:center;min-height:100vh;background:#181a1d\">"
  + "<img alt=\"<%= path %>\" style=\"max-width:100%;max-height:100vh\""
  + " src=\"data:<%= mime %>;base64,<%- data %>\"></body></html>";

export function previewImagePage(artifact: ArtifactRow, base64: string): string {
  let v: View = view();
  v.text.set("path", artifact.path);
  v.text.set("mime", imageMediaType(artifact.path));
  v.text.set("data", base64);
  return render(PREVIEW_IMAGE_PAGE, v);
}

export function previewPresentable(facing: bool, artifact: ArtifactRow): ArtifactRow {
  if (artifact.kind != "image" || !facing) {
    return artifact;
  }
  let asPage: ArtifactRow = {
    id: artifact.id, threadId: artifact.threadId, slot: artifact.slot,
    path: artifact.path, title: artifact.title, kind: artifact.kind,
    mime: "text/html; charset=utf-8", currentVersion: artifact.currentVersion,
    previewToken: artifact.previewToken, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
  };
  return asPage;
}

export function previewReply(facing: bool, artifact: ArtifactRow, body: string, cache: string): Reply {
  let answer = Respond(200, body, previewType(facing, artifact.mime));
  answer.headers.set("content-security-policy", previewCsp(facing));
  answer.headers.set("x-content-type-options", "nosniff");
  answer.headers.set("referrer-policy", "no-referrer");
  answer.headers.set("cache-control", cache);
  return answer;
}

export function previewBytes(facing: bool, bytes: string, mime: string, cache: string): Reply {
  let answer = Respond(200, bytes, mime);
  answer.headers.set("content-security-policy", previewCsp(facing));
  answer.headers.set("x-content-type-options", "nosniff");
  answer.headers.set("referrer-policy", "no-referrer");
  answer.headers.set("cache-control", cache);
  return answer;
}

export function previewPinnedReply(facing: bool, artifact: ArtifactRow, body: string): Reply {
  let row = previewPresentable(facing, artifact);
  let served = body;
  if (row.kind == "image" && row.mime.startsWith("text/html")) {
    served = previewImagePage(row, body);
  }
  return previewReply(facing, row, served, "private, max-age=31536000, immutable");
}
