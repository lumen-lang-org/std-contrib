// The /preview routes.

import { Db } from "../plume/driver.ts";
import { placeholderAt } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, header, notFound, ok, param, problem, queryParam, reply } from "../rest/server.ts";
import { stamp } from "./api-core.ts";
import { ArtifactRow, findByToken, getArtifact, getVersion, imageMediaType } from "./artifacts.ts";
import { officeRender, officeRenderExt } from "./office-render.ts";

// Everything an artifact is allowed to do once a browser has it: run the
// script that came in the same document, style itself, draw images it carries
// inline — and reach nothing. No origin to fetch from, no form to post to, no
// base to rewrite relative URLs against, and a sandbox without same-origin, so
// the document cannot read a cookie or a storage entry belonging to the host
// it was served from even when that host is the preview host.
//
// `script-src 'unsafe-inline'` reads alarming and is the point: an artifact is
// one self-contained document, its script is part of the body an author wrote,
// and `default-src 'none'` has already removed every way to load another one.
//
// This is the policy when there is no preview host, and it is also the policy
// on every other host a preview is ever reachable from. Nothing below relaxes
// it except on the one host an operator configured for exactly that.
const PREVIEW_CSP_CLOSED: string = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

// The configured preview host, trimmed and lowercased, or "" when there is
// none. Compared as a whole string including the port — see `previewType`.
function previewHost(): string {
  let configured = process.env("AGENTS_PREVIEW_HOST") ?? "";
  let text = configured.trim().toLowerCase();
  // The variable may be given as a bare host or as a whole origin. Only the
  // host part is ever compared against the request's own Host header, which
  // never carries a scheme.
  let mark = text.indexOf("://");
  if (mark >= 0) { return text.substring(mark + 3, text.length); }
  return text;
}

// Whether this request arrived on the preview host.
//
// One predicate, because the content type and the policy have to agree about
// what "the preview host" means: a request answered text/html under the closed
// policy could not load the stylesheet it names, and a request answered
// text/plain under the relaxed one would have widened the policy for a document
// nothing can run anyway. Two copies of this comparison would eventually
// disagree about a trailing dot, a case, or a port.
//
// Fail-closed in every direction: no configuration, no Host, or any mismatch,
// and the answer is false.
function onPreviewHost(req: Request): bool {
  let configured = previewHost();
  if (configured == "") { return false; }
  let asked = header(req, "host").trim().toLowerCase();
  if (asked == "") { return false; }
  return asked == configured;
}

// The preview host as a CSP source expression: a scheme and a host.
//
// A source list needs an origin, and AGENTS_PREVIEW_HOST holds no scheme —
// it is compared against the Host header, which has none either. A bare
// `example.com:9443` in a source list is legal but parses as host:port and
// matches http and https alike, which is looser than anything here intends, so
// a scheme is supplied: https, unless the host names the loopback, where a
// developer is running plain http and demanding https would break the only
// deployment that has no certificate.
//
// Deriving it rather than adding a second environment variable keeps the origin
// that appears in the policy and the host that unlocked it from ever naming two
// different places.
function previewOrigin(): string {
  let configured = (process.env("AGENTS_PREVIEW_HOST") ?? "").trim().toLowerCase();
  if (configured == "") { return ""; }
  // Said outright when the variable carries a scheme. Guessing it is what this
  // used to do, and the guess is unrecoverable when wrong: the policy names an
  // origin the browser never asked, so every stylesheet and script the page
  // references is refused, and the only evidence is a console message inside a
  // sandboxed frame nobody has open. An operator serving previews over plain
  // http on a hostname that is not localhost had no way to say so.
  if (configured.indexOf("://") >= 0) { return configured; }
  let host = previewHost();
  let name = host;
  let colon = host.indexOf(":");
  if (colon >= 0) { name = host.substring(0, colon); }
  // Still a guess, but only for the shorthand form, and https is the guess
  // that fails closed: a page served over http against an https policy loses
  // its subresources, which is visible, rather than the reverse.
  if (name == "localhost" || name == "127.0.0.1") { return "http://" + host; }
  return "https://" + host;
}

// The policy for one request.
//
// Off the preview host, exactly the closed policy above — an artifact is one
// self-contained document and cannot reach anything at all.
//
// On the preview host, an artifact is a small site: its siblings are served
// from that same origin under the same token, so `img-src`, `style-src`,
// `script-src` and `font-src` name that origin and a relative `css/main.css`
// loads. What does not change is everything that governs where the document can
// send data or be re-pointed: `connect-src 'none'`, `form-action 'none'`,
// `base-uri 'none'`, and a sandbox without `allow-same-origin`. Reading
// siblings is the capability the token already grants; talking to the network
// is not, and widening one is not an argument for widening the other.
//
// The origin is written out because 'self' cannot work here. `sandbox
// allow-scripts` without `allow-same-origin` gives the document an opaque
// origin, and 'self' matches the document's own origin — which for an opaque
// origin is nothing at all. A policy written with 'self' would look correct,
// pass review, and block every subresource.
function previewCsp(req: Request): string {
  if (!onPreviewHost(req)) { return PREVIEW_CSP_CLOSED; }
  let origin = previewOrigin();
  return "default-src 'none'"
    + "; script-src 'unsafe-inline' " + origin
    + "; style-src 'unsafe-inline' " + origin
    // Images may come from anywhere. This is the one relaxation of
    // self-containment, and it is deliberate: a model asked for a picture
    // from the web answered that it could not, and wrote a CSS cat instead —
    // the restriction was producing worse pages, not safer ones. An <img> is
    // a passive subresource: it cannot read the page, cannot reach /api, and
    // the sandbox's opaque origin means it carries no cookie. What it does
    // cost is a request to a third party carrying the reader's address, so
    // the tool still teaches fetching-and-saving as the better habit —
    // referrer-policy: no-referrer on every preview keeps the token out of
    // that request either way. Scripts, styles and fonts stay local: those
    // can read the document.
    + "; img-src data: blob: https: http: " + origin
    + "; font-src data: " + origin
    // connect-src used to be 'none'. The live reload below polls a version
    // stamp on this same origin, and that is the one connection a preview may
    // make: the preview origin itself, nothing else.
    + "; connect-src " + origin
    + "; form-action 'none'; base-uri 'none'; sandbox allow-scripts";
}

// The content type a preview answers with.
//
// The stored mime is what the artifact *is*; sending it is only safe on an
// origin that holds nothing worth stealing. text/html on the preview host is a
// page alone in its own sandbox. The same bytes on the console origin are
// script running next to the console's session. So the request's own Host
// decides, and everything else gets text/plain and is read, not run.
//
// The comparison is against the WHOLE host, port included, and is exact.
//
// It used to strip the port, on the reasoning that moving the listener should
// not silently change the content type. That was backwards: the port is part
// of the origin, and given a deployment with one process, a second port is the
// obvious way an operator makes a "separate preview host". With the port
// stripped, a console on example.com and previews on example.com:9443 compare
// equal — so a request to the *console* origin is answered text/html, which is
// the one thing this function exists to prevent. Cookies are not partitioned
// by port, so that is the worst case available.
//
// Everything about this is fail-closed. An unset variable, a Host the proxy
// rewrote, a mismatch of any kind: text/plain. The failure mode of a
// misconfiguration is an artifact you can read but not run, never the reverse.
function previewType(req: Request, mime: string): string {
  if (!onPreviewHost(req)) { return "text/plain; charset=utf-8"; }
  return mime;
}

// A preview, with the headers that make it safe to look at.
//
// `nosniff` matters most on the text/plain path: without it a browser is free
// to sniff a leading "<html" back into markup, which undoes the Host check
// before any policy is consulted. `no-referrer` keeps the token — which is the
// entire authorisation — out of the Referer header of anything the page links
// to. No access-control-allow-origin is set, here or anywhere: a token in a
// URL is a capability, and letting another origin read the response with
// script would hand that capability to whatever page a reader had open.
//
// `artifact` is the row the body came from, which for a sibling is the sibling
// and not the artifact the token names. Every preview answer goes through here
// so a sibling cannot end up with a weaker policy or its neighbour's type — a
// stylesheet answered text/html is a script the sandbox would then run.
// The chrome a live page carries: a poller that reloads when ANY artifact of
// the conversation gains a version, and a click handler that keeps the base
// route — an author writes <a href="/menu.html"> and the browser would leave
// /preview/<token>/ for the host's own root, where nothing lives.
//
// Injected only into a CURRENT html body on the preview host. A pinned ?v= is
// history and history does not reload; a sibling stylesheet is not a document;
// off the preview host everything is text/plain and runs nothing anyway.
// `newest` and not `stamp`: `stamp()` is a function in this module, and a
// parameter that shadows it resolved to the function under some compilations —
// JSON.stringify of a function, concatenated into a string, and a type error
// pointing at the return rather than at the name.
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

// One value that moves when anything in the thread's artifact log moves. The
// log is append-only and rows are never rewritten, so the row count IS the
// stamp: any write anywhere in the conversation changes it.
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

// An image artifact served as a page. The stored body is base64 text; raw
// image bytes never ride a Reply (a Lumen string is UTF-8 and a PNG is not),
// so the browser gets a page whose data: URI carries them — which the CSP
// already allows (img-src data:). Off the preview host this is never called
// and the base64 text is served as the text it is.
function previewImagePage(artifact: ArtifactRow, b64: string): string {
  return "<!doctype html><html><head><title>" + artifact.path + "</title></head>"
    + "<body style=\"margin:0;display:grid;place-items:center;min-height:100vh;background:#181a1d\">"
    + "<img alt=\"" + artifact.path + "\" style=\"max-width:100%;max-height:100vh\""
    + " src=\"data:" + imageMediaType(artifact.path) + ";base64," + b64 + "\"></body></html>";
}

// The artifact, with its body as a page when it is an image on the preview
// host: the wrapper is html, so the row it is served under says html too —
// that is what previewType and the live chrome read.
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

// A preview answered as bytes rather than as text.
//
// Same headers as every other preview — the CSP, nosniff, no referrer — because
// none of those stop being true for a document. What it does NOT get is the
// live chrome: that is a script appended to an HTML body, and appending it to a
// PDF would corrupt the file rather than reload it.
function previewBytes(req: Request, bytes: string, mime: string, cache: string): Reply {
  let answer = reply(200, bytes, mime);
  answer.headers.set("content-security-policy", previewCsp(req));
  answer.headers.set("x-content-type-options", "nosniff");
  answer.headers.set("referrer-policy", "no-referrer");
  answer.headers.set("cache-control", cache);
  return answer;
}

// previewReply, plus the live chrome when this body qualifies for it. An
// image is wrapped into a page first, so it reloads like any other page.
function previewLiveReply(db: Db, req: Request, artifact: ArtifactRow, body: string, cache: string): Reply {
  // A document, served as the document.
  //
  // This is the binary path, and it exists because the alternative was the
  // reported defect: a .pdf preview answered a screen of base64, because the
  // stored body IS base64 and the route served the text it found. Two things
  // had to be true for this to work, and both were checked before it was
  // written rather than assumed:
  //
  //  * A Lumen string carries arbitrary BYTES to the socket. The server writes
  //    `Content-Length: res.body.len` and `writeAll(res.body)` with no
  //    transcoding and no UTF-8 validation (lumen_runtime_net.zig), so the
  //    "a string is UTF-8 and a PDF is not" note elsewhere in this package is
  //    about string OPERATIONS, not about the wire.
  //  * `crypto.base64Decode` is in the language (spec 474 — it is
  //    NAMESPACED, which is the ten minutes this cost). office-render.ts shells
  //    out to `base64 -d` for an unrelated reason — it needs a file on disk —
  //    which is what made this look impossible at first glance.
  //
  // Only on the preview host. Off it, `previewType` still answers text/plain
  // for everything, so this cannot be used to serve a document as itself from
  // the console's own origin.
  if (onPreviewHost(req)) {
    if (artifact.kind == "pdf") {
      return previewBytes(req, crypto.base64Decode(body), "application/pdf", cache);
    }
    // An office document is converted first, through the same LibreOffice pass
    // and the same immutable cache the artifact panel and the template
    // thumbnails already use — so the first open of one pays ~2s and every
    // open after it is a database read.
    if (artifact.kind == "office" && officeRenderExt(artifact.path) != "") {
      let made = officeRender(db, { artifactId: artifact.id, version: artifact.currentVersion,
        path: artifact.path, body: body, now: stamp() });
      if (made.ok) {
        return previewBytes(req, crypto.base64Decode(made.body), "application/pdf", cache);
      }
      // A box with no converter still answers, with the sentence saying why
      // rather than with a page of base64 nobody can read.
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

// Artifacts as themselves, addressed by token.
//
// There is no thread id on one of these requests and nothing to check it
// against: the token is the whole of the authorisation, which is why it is a
// UUID minted per artifact and why `rotate` above exists. Nothing here reports
// which tokens are wrong — an unknown token and a deleted artifact answer
// identically, and neither answer repeats the token back into a log.
//
// A token also opens the artifact's siblings, meaning every artifact in the
// same thread, addressed by path under the token's own prefix. That is what
// makes a document with a stylesheet work at all, and it is a real widening: a
// link shared once grants read of every artifact in that conversation, not just
// the one the link names. It is the price of relative URLs resolving the way an
// author wrote them, and `rotate` is still the answer when a link gets out.
//
// Deliberately outside the owner guard, then — the one place in this file a
// `/threads/:id/...` resolution is not what decides. A token is a capability:
// whoever holds it reads the thread's artifacts, owner or not, which is the
// whole point of handing a link to a reader who has no account. Said here
// rather than left for someone to discover, because "the owner check covers
// everything" would be false and this is where it is false.
@controller("/preview")
export class PreviewApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // The artifact the token names.
  //
  // `?v=3` pins a version, and a version row is never rewritten — that is what
  // append-only buys — so a pinned answer is cacheable forever. `private`
  // because the URL contains a secret and a shared cache holding it would serve
  // the artifact to whoever asks next.
  //
  // Absent, empty or unparseable `v` means the current version, never cached:
  // that URL follows the artifact, so a stored copy would keep serving a body
  // the author has already replaced. Unparseable falls to current rather than
  // 404 because `v` is a hint about which body to send, not part of the
  // addressing — a truncated link should still show the artifact.
  //
  // A number that parses but names no version is a 404, unlike an unparseable
  // one: it is a specific claim about the artifact's history that is false.
  //
  // The version moved off the path to get here. `/preview/:token/v/:n` is four
  // segments, and so is a sibling named `v/3.css`; resolving that needs a
  // best-match router, and this one matches in order on purpose.
  @get("/:token")
  preview(req: Request): Reply {
    let artifact = findByToken(this.db, param(req, "token"));
    if (artifact.id == "") { return notFound("artifact"); }
    let asked = parseInt(queryParam(req, "v", "")) ?? 0;
    if (asked < 1) {
      // Not the cached pointer: the newest row of the log itself, so the bare
      // URL follows the artifact even when the pointer is a commit stale.
      let newest = nextVersion(this.db, artifact.id) - 1;
      let current = getVersion(this.db, artifact.id, newest);
      if (current.id == "") { current = getVersion(this.db, artifact.id, artifact.currentVersion); }
      if (current.id == "") { return notFound("artifact"); }
      return previewLiveReply(this.db, req, artifact, current.body, "no-store");
    }
    let row = getVersion(this.db, artifact.id, asked);
    if (row.id == "") { return notFound("artifact"); }
    // Pinned history gets the image wrapper too — a version pill that opened
    // onto a page of base64 would read as broken — but never the live chrome:
    // a pinned version is immutable and immutable things do not reload.
    let pinnedRow = previewPresentable(req, artifact, row.body);
    let pinnedBody = row.body;
    if (pinnedRow.kind == "image" && pinnedRow.mime.startsWith("text/html")) {
      pinnedBody = previewImagePage(pinnedRow, row.body);
    }
    return previewReply(req, pinnedRow, pinnedBody, "private, max-age=31536000, immutable");
  }

  // Another artifact in the same thread, by path.
  //
  // The token's own row carries the thread id, so the token is still the whole
  // of the authorisation — nothing here reads a path from the client and trusts
  // it beyond the thread that token already opened.
  //
  // The path arrives from the router with each segment percent-decoded and the
  // separators intact, so it is a thread path missing only its leading slash.
  // `getArtifact` normalises it with `normalScope` before the lookup — the same
  // function that normalised it on the way in — so "/a/b.css" and "a/b.css"
  // find the same row, and a lookup is a primary-key read with nothing to
  // traverse. `..` needs no special case for the same reason: it is not a
  // filesystem, and `pathProblem` refuses to store a segment spelled that way,
  // so a path containing one matches nothing that exists.
  //
  // Siblings are always the current version. `?v` numbers the entry's own
  // history, and every artifact has an independent counter, so carrying that
  // number across would pin some unrelated revision of the stylesheet — which
  // is worse than not pinning, because it looks deliberate. A pinned entry can
  // therefore drift against its assets; the honest fix is a version scheme that
  // spans a thread, which does not exist yet.
  //
  // A path with no artifact answers `notFound("artifact")` — the same reply as
  // an unknown token, byte for byte. Anything that distinguished "token good,
  // path absent" from "token bad" would turn one shared link into an oracle for
  // which paths a conversation holds.
  @get("/:token/*path")
  sibling(req: Request): Reply {
    let artifact = findByToken(this.db, param(req, "token"));
    if (artifact.id == "") { return notFound("artifact"); }
    // The live-reload stamp. "__version" can never be an artifact path — an
    // underscore is outside the segment charset — so the name is unclaimable
    // and the check costs the sibling route nothing. The reply is a bare
    // number with CORS open: a sandboxed preview has an opaque origin, and a
    // fetch from one needs the header to read even its own host's answer. The
    // number is a count of stored versions, which is nothing a token holder
    // cannot already learn, and the token is still required to ask.
    if (param(req, "path") == "__version") {
      let stamp = reply(200, previewStamp(this.db, artifact.threadId), "text/plain; charset=utf-8");
      stamp.headers.set("access-control-allow-origin", "*");
      stamp.headers.set("cache-control", "no-store");
      return stamp;
    }
    let found = getArtifact(this.db, artifact.threadId, param(req, "path"));
    if (found.id == "") { return notFound("artifact"); }
    let row = getVersion(this.db, found.id, found.currentVersion);
    if (row.id == "") { return notFound("artifact"); }
    // `found`, not `artifact`: the type comes from the row whose body this is.
    // Live like the main page, so a menu page navigated to keeps the reload
    // and its own links keep the base.
    return previewLiveReply(this.db, req, found, row.body, "no-store");
  }
}
