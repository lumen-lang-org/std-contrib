#!/bin/sh
# Move the built client bundles off /assets/ and onto /console-assets/.
#
# Run after `lumenjs build`, against the build output. The Dockerfile calls it;
# so must anything else that serves a built console behind the nuraly gateway.
#
# WHY
#
# The console and nuraly's login page are both LumenJS apps and both are served
# on lumen-agents.the-agent.dev. Both build their bundles into `assets/`, and
# both even name the entry chunk `__nk_build_index-<hash>.js`. The gateway
# sends `^/assets/` to the front app, because that is where the login page's
# bundles live — so a console built into `assets/` asks for its own entry and
# is handed the login page's HTML, with a 200 and `content-type: text/html`.
# The module does not parse, nothing hydrates, and the page is server-rendered
# markup that never answers a click. That is not hypothetical: it was live for
# about five minutes on 2026-07-31 before being rolled back.
#
# Nothing catches this earlier because the dev server never uses this path —
# it serves `/src/…`, `/node_modules/…` and `/@fs/…`. The collision exists only
# in a built console, which is why the gateway's own comment beside that rule
# still says "the console never asks for this root".
#
# WHY A SCRIPT AND NOT CONFIGURATION
#
# There is no configuration. Vite's `build.assetsDir` would be the right knob,
# but `lumenjs.plugins.js` is dev-only — a Vite plugin's hooks do not run under
# `lumenjs serve`, and the production build reads only title, integrations,
# i18n, prefetch and prerender out of lumenjs.config.ts. An nginx
# `error_page 404` fallback does not work either: the built console answers an
# unknown `/assets/` path with 200 and its own HTML, so there is no 404 to
# intercept. Rewriting the output is what is left.
#
# WHAT IT TOUCHES, AND WHAT IT MUST NOT
#
# Only the CLIENT output, and only ABSOLUTE urls. There are two:
#
#   .lumenjs/client/index.html            the entry <script src>
#   .lumenjs/client/assets/pdf.worker…js  the worker url from an `?url` import
#
# The chunks import each other with RELATIVE specifiers, so renaming the
# directory keeps them valid without touching a byte inside them.
#
# The SERVER output also contains `./assets/` and `../assets/`, and those are
# emphatically not urls — they are its own module graph on disk, under
# .lumenjs/server/assets/. Rewriting them would break the server bundle's
# imports. Hence the `client/` scoping below and the anchored patterns: a bare
# s|/assets/|…| would have hit every one of them.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-$HERE/.lumenjs}
CLIENT=$OUT/client

[ -d "$CLIENT/assets" ] || { echo "no $CLIENT/assets — did the build run?" >&2; exit 1; }

mv "$CLIENT/assets" "$CLIENT/console-assets"

# Two forms, and missing the second one is what made the first attempt at this
# script pass its own check while the page stayed broken.
#
#   "/assets/x.js"   absolute — the entry <script src> in index.html
#   "assets/x.js"    ROOT-RELATIVE — the framework's own lazy-chunk manifest,
#                    emitted inside the entry bundle as
#                    m.f=["assets/login-….js","assets/_id_-….js",…]
#
# The second has no leading slash, so a pattern anchored on one does not see
# it — and the browser resolves it against the document root anyway, asking
# for /assets/_id_-….js and getting the login page's HTML. Identical symptom,
# invisible to a check that only looked for the absolute form.
#
# Quoted only, never bare: `console-assets/` contains the substring `assets/`,
# so an unanchored replace would run twice and produce console-console-assets.
# The quote (or paren, for css url()) is what makes each match a whole path.
find "$CLIENT" -type f \( -name '*.html' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' \) \
  -exec sed -i \
    -e 's|"/assets/|"/console-assets/|g'  -e "s|'/assets/|'/console-assets/|g" \
    -e 's|(/assets/|(/console-assets/|g' \
    -e 's|"assets/|"console-assets/|g'    -e "s|'assets/|'console-assets/|g" \
    -e 's|(assets/|(console-assets/|g' {} +

# The check that makes this safe to run unattended: no reference to the old
# prefix may survive in the client output, in EITHER form. Anything left is a
# way of naming a chunk this script does not know about, and shipping it is
# another silent 200 of the wrong app's HTML.
#
# `[/]\?` covers both; the leading quote/paren keeps `console-assets/` from
# matching itself.
LEFT=$(grep -rl '["'"'"'(][/]\?assets/' "$CLIENT" 2>/dev/null || true)
if [ -n "$LEFT" ]; then
  echo "asset-prefix: absolute /assets/ urls still present in:" >&2
  echo "$LEFT" >&2
  exit 1
fi

echo "asset-prefix: client bundles now served from /console-assets/"
