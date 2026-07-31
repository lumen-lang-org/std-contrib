# The console, as one image: ghcr.io/nuralyio/agents-console.
#
#   docker build -t ghcr.io/nuralyio/agents-console .
#
# One image serves all three deployments — the AUTH tri-state is read from the
# environment at boot (pages/_middleware.ts), never baked in here. There is no
# community image and no hosted image; nuraly.io runs this exact tag with
# AUTH=proxy behind its gateway (packages/agents/GATEWAY.md).
#
# The build context is this directory and nothing above it. That is the whole
# reason the framework is vendored as a tarball (MIGRATION-LUMENJS.md, "How
# lumenjs is vendored today"): apps/social's Dockerfile takes the nuraly
# monorepo root as its context and spends two stages building nuraly-ui and
# lumenjs from source before it can start on the app. Here both come from
# node_modules like any other dependency, so those stages do not exist. What is
# left is the shape of social's file with the bulk removed: install, build,
# copy the output and the modules into a clean base, serve.
#
# nginx is gone with them. The old image was a Vite `dist/` behind nginx, with
# nginx.conf holding a second copy of the proxy rules; the app is its own
# server now and `server/api-proxy.ts` is the only place those rules live.

# --- build ------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /build

# The toolchain is for one module: better-sqlite3, which `AUTH=builtin` opens
# and the other two modes never touch. prebuild-install fetches a binary for
# most platform/ABI pairs and this is unused; on the ones it misses, the
# alternative to compiling is an image that boots fine until someone sets
# AUTH=builtin. It stays in this stage only — the runtime image gets the
# compiled `.node`, not the compiler.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Dependencies first, so a source edit does not reinstall them. BOTH vendored
# tarballs are part of this layer — the framework and LumenUI — because
# package.json names each by path and `npm ci` cannot run without them. See
# MIGRATION-LUMENJS.md, "How the nuraly libraries are vendored today", for what
# is in each and how to refresh it.
COPY package.json package-lock.json ./
COPY vendor ./vendor
# --omit=dev: the devDependencies are the test kit and the type checker,
# neither of which builds anything. Vite is not among them — it is a
# dependency of @nuraly/lumenjs, so `lumenjs build` has its bundler either way.
#
# This line is the whole point of the image, and it is what caught the one
# thing a developer's box could not: `src/ui.ts` imports
# `@nuraly/lumenui/overlay/bundle` and published `@nuraly/lumenui@0.16.1` has
# no `overlay` component at all. It built on a laptop only because someone had
# copied the directory into node_modules by hand, and `npm ci` starts from the
# lockfile and can fetch nothing that is not published. LumenUI is therefore
# vendored the same way the framework is, and this install is a clean one from
# the lockfile in every environment — which is the only kind of install an
# image gets.
RUN npm ci --omit=dev

COPY tsconfig.json lumenjs.config.ts lumenjs.plugins.js lumenjs.server.js head.html ./
COPY asset-prefix.sh ./
COPY pages ./pages
COPY server ./server
COPY src ./src

# Client bundle, server bundle, page manifest → .lumenjs/.
RUN npx lumenjs build

# Move the client bundles off /assets/, which on nuraly.io belongs to the login
# page — the gateway routes that prefix to the front app, so a console built
# into it is served someone else's HTML for its own JavaScript and never
# hydrates. The script explains it fully and fails the build if any absolute
# /assets/ url survives; read it before changing this line.
RUN ./asset-prefix.sh

# The global middleware chain, compiled.
#
# `lumenjs serve` loads lumenjs.server.js with a plain `import()`, so its
# TypeScript imports — pages/_middleware.ts, server/api-proxy.ts — are an
# `Unknown file extension ".ts"` that the framework warns about and swallows.
# The server then starts with no proxy and no auth: `/whoami` answers with the
# SPA's own HTML, which the console reads as "nothing authenticates here" and
# then offers every admin tool to everybody. That is the production bug
# server/api-proxy.ts's comment block was written about, arriving by a new
# route, and it is silent — the console looks fine until someone checks who it
# thinks they are.
#
# --packages=external keeps node_modules out of the bundle (they are copied
# whole below) and inlines only this app's own modules. esbuild comes with
# Vite, which comes with the framework.
RUN npx esbuild lumenjs.server.js \
      --bundle --platform=node --format=esm --packages=external \
      --outfile=compiled/lumenjs.server.js

# --- runtime ----------------------------------------------------------------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# `lumenjs serve` reads the config file as text at startup — its `integrations`
# and `db` are scraped out with a regular expression rather than evaluated
# (dev-server/config.ts), so the .ts source is what has to be present, not a
# compiled form of it.
COPY --from=build /build/lumenjs.config.ts /build/package.json ./
COPY --from=build /build/.lumenjs ./.lumenjs
COPY --from=build /build/node_modules ./node_modules
# Compiled, and under the name the framework looks for. The .ts source is
# deliberately not in this image: two files answering to one convention, one of
# which silently disables the proxy, is not a thing to leave lying about.
COPY --from=build /build/compiled/lumenjs.server.js ./lumenjs.server.js

# Two directories this process writes to, owned by the user that writes to
# them. `data/` is where AUTH=builtin keeps its users — a password store, so a
# deployment that means to keep accounts across restarts mounts a volume over
# it; the other two modes never open it. `uploads/` is the local storage
# adapter's fallback when no bucket is configured.
RUN useradd --system --create-home --home-dir /home/console console \
  && mkdir -p /app/data /app/uploads \
  && chown -R console:console /app/data /app/uploads
USER console

# The port is the console's own, not nginx's 80 — the app is the server now.
# `lumenjs serve` binds every interface and offers no way to say otherwise, so
# which addresses this is reachable on is decided by the port publication in
# compose, not here. AUTH=proxy checks that and refuses to start when the
# answer is "the internet" (pages/_middleware.ts).
EXPOSE 8080

# The framework's own endpoint, answered before rate limiting and before any
# app middleware. `node -e` rather than curl or wget: neither is in this base
# image, and adding one to run a healthcheck is a package to track for the
# lifetime of the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/__health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "node_modules/@nuraly/lumenjs/dist/cli.js", "serve", "--project", "/app", "--port", "8080"]
