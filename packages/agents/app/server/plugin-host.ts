// The sandbox document that runs plugin renderers.
//
// Served by the console itself at /plugin-host and embedded as
// <iframe sandbox="allow-scripts"> — which is the whole security design, so
// it is worth saying precisely. `allow-scripts` WITHOUT `allow-same-origin`
// gives the document a null origin: no cookies, no storage, no reach into the
// parent, and the CSP below denies it every kind of network. A plugin
// renderer executing here can compute a wrong string and nothing else.
//
// The parent talks to it over postMessage: {kind:"load", source} hands it a
// module's source (the engine's snapshot — the console never fetches a CDN),
// {kind:"render", id, marker, content, evidence} asks for HTML, and the
// answer {kind:"html", id, html} is SANITIZED by the parent before insertion
// (src/plugin-cards.ts) — the sandbox contains execution, the sanitizer
// contains output, and neither is asked to do the other's job.
//
// Served as middleware rather than as a page: a page rides the app shell,
// the auth chain and the framework's own scripts, and this document must
// carry none of them — its value is precisely that nothing else is in it.

import type { IncomingMessage, ServerResponse } from "node:http";

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

// The document, inline. The script is the protocol's whole implementation,
// and keeping it beside the CSP that governs it beats a second file that can
// drift. `blob:` in script-src is what lets the module import run; nothing
// else is grantable to a null-origin document that should reach nothing.
const HOST_DOCUMENT = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>plugin host</title>
</head>
<body>
<script>
(function () {
  "use strict";
  // marker -> render function, across every module loaded into this host.
  var renderers = {};

  function answer(msg) { parent.postMessage(msg, "*"); }

  window.addEventListener("message", function (event) {
    var m = event.data || {};
    if (m.kind === "load" && typeof m.source === "string") {
      var url = URL.createObjectURL(new Blob([m.source], { type: "text/javascript" }));
      import(url).then(function (mod) {
        var list = Array.isArray(mod.default) ? mod.default : [];
        var markers = [];
        for (var i = 0; i < list.length; i++) {
          var one = list[i] || {};
          if (typeof one.marker === "string" && typeof one.render === "function"
              && !renderers[one.marker]) {
            renderers[one.marker] = one.render;
            markers.push(one.marker);
          }
        }
        answer({ kind: "loaded", plugin: m.plugin, markers: markers });
      }).catch(function (e) {
        answer({ kind: "loaded", plugin: m.plugin, markers: [], problem: String(e) });
      }).finally(function () {
        URL.revokeObjectURL(url);
      });
      return;
    }
    if (m.kind === "render" && typeof m.id === "string") {
      var render = renderers[m.marker];
      var html = "";
      if (render) {
        try {
          var out = render(String(m.content || ""), Array.isArray(m.evidence) ? m.evidence : []);
          if (typeof out === "string") { html = out; }
        } catch (e) { html = ""; }
      }
      answer({ kind: "html", id: m.id, html: html });
    }
  });

  answer({ kind: "hello" });
})();
</script>
</body>
</html>`;

export function pluginHost(): Middleware {
  return (req, res, next) => {
    if ((req.url ?? "/").split("?")[0] !== "/plugin-host") return next();
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // The document's own law, replacing anything a gateway would add: no
      // network of any kind, scripts only inline and from the blobs the
      // loader mints. `sandbox` here is belt to the iframe attribute's
      // braces — the attribute is what makes the origin null.
      // frame-ancestors is stated EXPLICITLY and does not come from
      // default-src: that directive has no fallback, so a policy of
      // `default-src 'none'` says nothing about who may frame this — and with
      // nothing said, X-Frame-Options decides, which is how a document built
      // to be framed ended up refusing to be framed by its own origin.
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline' blob:; "
        + "frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      "cache-control": "no-store",
      // SAMEORIGIN, and it has to WIN: the framework sends DENY on every other
      // response and two X-Frame-Options headers resolve to the stricter one.
      // The gateway hides the inherited value for this route (locations/
      // joule.conf, locations/agents.conf) so only this one arrives.
      "x-frame-options": "SAMEORIGIN",
    });
    res.end(HOST_DOCUMENT);
  };
}

export default [pluginHost()];
