// The proxy table, ported from the Vite dev server's `server.proxy`
// (app/vite.config.ts). Every comment below is carried over from there on
// purpose: each of these three rules was a production bug once, and the
// comment is the only record of which one.
//
// Why `lumenjs.server.js` and not `lumenjs.plugins.js`: a Vite plugin's
// configureServer() hook never fires under `lumenjs serve`, so a proxy
// written as a plugin would work in dev and silently vanish in the built
// image. lumenjs.server.js is the seam that runs in both.
import http from 'node:http';
import https from 'node:https';

const TARGET = process.env.AGENTS_API ?? 'http://127.0.0.1:8100';

// Vite matches a string proxy key with a plain `startsWith`, so `/api` also
// catches `/apiary` — and rewrites it to `ary`. That is sloppy, and it is
// also the behaviour that ships today, so it is the behaviour reproduced
// here: the port is not the place to change what the proxy table means.
// Tightening this to a path boundary (`''`, `/`, or `?` after the prefix) is
// a one-line change and should be its own decision, made with the e2e suite
// watching, not a side effect of swapping frameworks.
function matches(url, prefix) {
  return url.startsWith(prefix);
}

const ROUTES = [
  // Previews are served by the API at its own root, not under /api: the
  // URL a page's relative links resolve against has to be the artifact's
  // own path, so it cannot carry a prefix belonging to the console.
  { prefix: '/preview', rewrite: (p) => p },

  // Not an engine route: the gateway answers this one itself, because it
  // is the only party that knows who the caller is. Unproxied, the dev
  // server answers it with the SPA's own HTML — which parses as no answer
  // at all, which the console reads as "nothing authenticates here" and
  // then offers every admin tool to everybody.
  { prefix: '/whoami', rewrite: (p) => p },

  { prefix: '/api', rewrite: (p) => p.replace(/^\/api/, '') || '/' },
];

export default [
  function agentsApiProxy(req, res, next) {
    const url = req.url || '';
    const route = ROUTES.find((r) => matches(url, r.prefix));
    if (!route) return next();

    const target = new URL(TARGET);
    const agent = target.protocol === 'https:' ? https : http;

    // Keep the browser's Host. `changeOrigin: true` rewrites it to the
    // target, which is the same hole nginx had: the preview route decides
    // its content type from that header, and a rewritten one is a decision
    // made about a host nobody asked for.
    //
    // Node's http.request defaults Host to the target when `headers.host`
    // is absent, so preserving it is an act, not an omission: the inbound
    // header is copied through untouched.
    const headers = { ...req.headers };

    const proxyReq = agent.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: route.rewrite(url),
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`proxy error: ${err.message}`);
    });

    // The body has not been read yet — this middleware runs before any body
    // parser — so the request pipes straight through.
    req.pipe(proxyReq);
  },
];
