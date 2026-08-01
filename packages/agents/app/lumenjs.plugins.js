// Vite plugins for the console's LumenJS server.
//
// LumenJS's dev server is a Vite server: the framework builds the Vite config
// itself and takes no `vite.config.ts` from the app, but it does load this
// file and passes its exports through as user plugins — and a user plugin's
// `config()` hook is merged over the config LumenJS assembled. That is the
// seam through which this app states the few things the framework's defaults
// get wrong for it. Everything below arrived from the console's old
// vite.config.ts, which phase 5 deleted; this is now the only copy.
//
// Dev-only by construction: a Vite plugin's configureServer() never fires
// under `lumenjs serve`. That is correct for everything in this file — the
// dep optimizer and the dev file server do not exist in a built image, and
// the Host check is nginx's job there. The proxy is the one thing that must
// survive into the image, which is why it lives in lumenjs.server.js instead.

import net from "node:net";

/** @type {import('vite').Plugin} */
const consoleViteConfig = {
  name: "agents-console-vite-config",
  config() {
    return {
      // The LumenUI entries this app registers, pre-bundled — one request each
      // instead of the module graph behind them.
      //
      // `src/ui.ts` imports the per-component entries (`@nuraly/lumenui/canvas`)
      // rather than the self-contained `…/bundle` files, because the bundles
      // inline their dependencies and two of them therefore cannot both be
      // loaded. That is the right import to make and it is not the right thing
      // to leave unoptimised: a bundle is one file however the optimizer is
      // configured, an entry is four hundred and forty. Excluding the package —
      // which is what this list said while the imports were bundles, and which
      // cost nothing then — meant the browser fetched every one of those over
      // a dev server that transforms each on demand, and `agent-console` was
      // not defined for the first five seconds of the page's life. The markup
      // is there the whole time, because the page is server-rendered, so what
      // that window looks like is a console that is drawn and does not answer:
      // a click on the account block in it is swallowed and never replayed.
      // Every e2e failure of the shell, settings and skills suites was that
      // click. Naming the entries here brings it back under a fifth of a
      // second.
      //
      // The list is `src/ui.ts`'s, and it has to stay that list: an entry
      // imported there and missing here is served raw again, which is slower
      // rather than broken and so will not announce itself.
      //
      // Its socket.io-client dependency chain is CommonJS, and the optimizer is
      // what converts it, so that chain is named too.
      //
      // The canvas brings another one: highlight.js, which it uses to draw
      // code inside a node. It is CommonJS, so without this the browser asks for a
      // `default` export the served module does not have — and because that throws
      // while the module graph is loading, nothing renders at all. The console
      // went blank, not just the canvas.
      //
      // One entry the old vite.config.ts had is missing on purpose: `lit`.
      // LumenJS's litDedupPlugin externalises lit so exactly one copy reaches
      // the page, and asking the optimizer to pre-bundle an externalised
      // entry is a hard esbuild error — `The entry point "lit" cannot be
      // marked as external` — which kills the dev server at boot rather than
      // degrading. Deduplication is what the include was buying under Vite,
      // and the framework already provides it.
      optimizeDeps: {
        include: [
          "@nuraly/lumenui/canvas",
          "@nuraly/lumenui/dropdown",
          "@nuraly/lumenui/modal",
          "@nuraly/lumenui/checkbox",
          "@nuraly/lumenui/textarea",
          "@nuraly/lumenui/overlay",
          "@nuraly/lumenui/chatbot",
          "@nuraly/lumenui/input",
          "@nuraly/lumenui/button",
          "@nuraly/lumenui/icon",
          "@nuraly/lumenui/select",
          "@nuraly/lumenui/popconfirm",
          "@nuraly/lumenui/code-editor",
          "socket.io-client", "dayjs",
          "highlight.js/lib/core",
          "highlight.js/lib/languages/css",
          "highlight.js/lib/languages/javascript",
          "highlight.js/lib/languages/json",
          "highlight.js/lib/languages/markdown",
          "highlight.js/lib/languages/python",
          "highlight.js/lib/languages/sql",
          "highlight.js/lib/languages/typescript",
          "highlight.js/lib/languages/xml",
          // Discovered LATE without these — and late discovery is not a slow
          // path, it is a broken one. When Vite meets a dep mid-page-load it
          // optimizes it and force-reloads the page; every fetch in flight is
          // killed, and the console's bootstrap calls (agents, model choices,
          // featured skills, threads) run exactly once. So the first visitor
          // to a cold server got a page that hydrated and then sat empty —
          // "Ask agent…", no picker, no chips. Safari surfaces the killed
          // fetches as "due to access control checks", which is how it was
          // finally caught: Chromium retried fast enough on the auto-reload
          // to hide it. The list is the two rounds the dev log names:
          //   ✨ new dependencies optimized: @lumenjs/auth
          //   ✨ new dependencies optimized: highlight.js/.../bash, pdfjs-dist,
          //      docx-preview, pptx-preview, xlsx
          "@lumenjs/auth",
          "highlight.js/lib/languages/bash",
          "pdfjs-dist",
          "docx-preview",
          "pptx-preview",
          "xlsx",
        ],
      },
      server: {
        // Which address to listen on. Loopback unless an operator says otherwise,
        // which is what a laptop wants and what the firewall notes assume.
        //
        // A gateway in a container cannot reach loopback on the host: it arrives
        // over the docker bridge, so `host.docker.internal:5173` from inside the
        // container hits an address this server is not listening on and every page
        // request 502s. A deployment that fronts this with the gateway sets
        // AGENTS_CONSOLE_BIND to the bridge address — and firewalls the port to the
        // bridge range, exactly as :8100 is (scripts/agents-gateway-firewall.sh in
        // the nuraly repo). Off loopback and un-firewalled, this is a dev server on
        // the internet.
        //
        // LumenJS's own default is `host: true`, i.e. 0.0.0.0 — the posture this
        // rule exists to refuse. Overriding it is the whole reason this hook is
        // here; drop it and the console listens on every interface.
        host: process.env.AGENTS_CONSOLE_BIND ?? "127.0.0.1",
        // Vite refuses a Host it does not recognise, and this server answers to
        // more than one name: the console's own, and the preview host, which is a
        // second name for the same server. Both have to be named here for dev.
        //
        // A tunnel makes the console's name the one that breaks first. Reaching
        // the server as anything but localhost — a Cloudflare hostname, a machine
        // name on the LAN — gets "Blocked request" rather than the console, and
        // the message names a vite.config.js the operator does not have. So the
        // console host is its own variable, not a guess derived from the preview
        // host: an operator who exposes one has no reason to expose the other.
        //
        // LumenJS's default here is `true` as well — every Host accepted. Vite
        // merges arrays by concatenation, so that `true` survives as the first
        // entry of the list below. It is inert: the check compares each entry to
        // the requested hostname by string, and no hostname is the boolean true.
        // localhost and bare IPv4 are allowed by Vite whatever the list says,
        // which is why an empty list is still a working laptop default.
        allowedHosts: [
          process.env.AGENTS_CONSOLE_HOST ?? "",
          process.env.AGENTS_PREVIEW_HOST ?? "",
        ]
          .map((h) => h.replace(/^[a-z]+:\/\//, "").split(":")[0].trim())
          .filter((h) => h !== ""),
      },
    };
  },
};

// Vite's own Host check, moved in front of the proxy.
//
// Vite orders its dev middlewares host-check → proxy, so its own `allowedHosts`
// refuses an unlisted Host before the request can reach the agents API. Under
// LumenJS the order inverts: the proxy is registered from lumenjs.server.js,
// which the framework splices ahead of every internal middleware — and it has
// to be there, because LumenJS's page handler answers any extensionless GET
// with the shell HTML, which is precisely how /whoami became a production bug
// the first time (see server/api-proxy.ts).
//
// So the check moves too, or it does not happen at all: a DNS-rebinding host
// pointed at the laptop would be proxied straight to the engine. The preview
// route would still refuse to render — its content type is decided by the same
// Host, which is not AGENTS_PREVIEW_HOST — but /api would answer, and the port
// is not the place to loosen that.
//
// The rules below are Vite's, transcribed from its hostCheckMiddleware:
// localhost, *.localhost and bare IP literals are always allowed (which is
// what makes an empty allowedHosts a working laptop default), a listed name
// matches exactly, and a listed name with a leading dot matches its
// subdomains. The right home for this is LumenJS itself — running user server
// middleware after the host check rather than before it — and this belongs in
// the small-patches budget risk 1 of MIGRATION-LUMENJS.md sets aside.
//
// Dev only, and that is not a gap: the shipped image is reached through a
// gateway or a published port, and Host is that layer's business. nginx has
// server_name; compose has the address it publishes to.
/** @type {import('vite').Plugin} */
const consoleHostCheck = {
  name: "agents-console-host-check",
  configureServer(server) {
    const allowed = () => server.config.server.allowedHosts;

    const isAllowed = (hostHeader) => {
      const list = allowed();
      if (list === true) return true;

      const trimmed = hostHeader.trim();
      if (trimmed[0] === "[") {
        const end = trimmed.indexOf("]");
        return end > 0 && net.isIP(trimmed.slice(1, end)) === 6;
      }
      const colon = trimmed.indexOf(":");
      const hostname = colon === -1 ? trimmed : trimmed.slice(0, colon);
      if (net.isIP(hostname) === 4) return true;
      if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;

      for (const entry of list) {
        if (entry === hostname) return true;
        if (typeof entry === "string" && entry[0] === "." &&
            (entry.slice(1) === hostname || hostname.endsWith(entry))) return true;
      }
      return false;
    };

    server.middlewares.use((req, res, next) => {
      const host = req.headers.host;
      if (host && isAllowed(host)) return next();
      // Vite's first sentence, kept verbatim so an operator who meets this
      // searches for the string everyone else's search results are about. The
      // second sentence is not Vite's: its version names a `vite.config.js`
      // that does not exist in this project — phase 5 deleted it — and sending
      // someone to edit a file that is not there is worse than saying nothing.
      // AGENTS_CONSOLE_HOST is the actual answer, and it is an environment
      // variable rather than a file, so a tunnel can be named at the point it
      // is started.
      const quoted = JSON.stringify(host?.replace(/:\d+$/, ""));
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(
        `Blocked request. This host (${quoted}) is not allowed.\n` +
        `To allow this host, start the console with AGENTS_CONSOLE_HOST=${quoted} ` +
        `(or AGENTS_PREVIEW_HOST, if this is the artifacts name).`,
      );
    });
  },
};

export default [consoleViteConfig, consoleHostCheck];
