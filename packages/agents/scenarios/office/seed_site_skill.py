# Seed make-site: a static website, written into the conversation's artifacts.
#
# Kept beside the office skills and seeded the same way — public, featured,
# idempotent (PUT when the row is there, POST when it is not) — because it is
# the same product idea: a capability the person picks before they type, which
# the console draws as a chip.
#
# Different from the office three in one way that matters, and the briefing has
# to be explicit about it: a website is SEVERAL files that reference each other
# by relative path. A model that writes /artifacts/site/index.html with
# <link href="style.css"> and never writes style.css has produced a page that
# renders unstyled and looks like a bug in the preview rather than a missing
# file. So the briefing insists on writing every file it links, in one call.
#
# No builder module and no environment: HTML, CSS and JS are text the model
# already writes well, and there is no library that would help. That is why
# this skill ships a briefing and no staged files — put_artifact is enough, and
# a run_script round-trip through a container would only add a way to fail.
import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("AGENTS_API", "http://127.0.0.1:8100")
X_USER = os.environ.get("AGENTS_X_USER", "")


def call(path, method="GET", body=None):
    headers = {"content-type": "application/json"}
    if X_USER:
        headers["x-user"] = X_USER
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


BRIEF = """Build a small website the reader can open.

Write the files as artifacts under /site/ — index.html first, then every file
it references. The preview host serves that directory as a site, so a relative
href resolves against its siblings exactly as it would on a real server.

Rules that decide whether the page works at all:

- WRITE EVERY FILE YOU LINK, in the same turn. A <link> to style.css or a
  <script src="app.js"> whose file you never wrote renders as an unstyled,
  dead page — which reads as a broken preview rather than as a missing file.
  If you are not going to write it, do not link it.
- Relative paths only. `href="style.css"`, never `/style.css` and never a
  path with the artifact prefix in it: the preview serves /site/ as the root,
  so an absolute path points outside the site.
- No CDNs, no external fonts, no remote images. The preview runs under a
  content policy that blocks every external host, so a page built on a CDN
  stylesheet is a blank page there. System fonts, and CSS you wrote.
- One file per artifact, each written with put_artifact. Do not concatenate a
  site into a single artifact and do not use run_script — there is nothing to
  run, and a container round-trip only adds a way to fail.

Make it real. A page with lorem text and a grey box where a picture goes is
not a website; write the actual copy, and draw with CSS (gradients, shapes,
type) where a photograph would otherwise be.

Structure that works for most asks, and deviate when the ask deviates:

  /site/index.html   the page: semantic markup, one <main>, real content
  /site/style.css    the whole design — colours, type scale, layout, responsive
  /site/app.js       only if something genuinely needs behaviour

Design it deliberately. Choose a palette and a type pairing that suit the
subject rather than defaulting; give the page a clear hierarchy; make it work
at phone width. Dark and light both, through a
`prefers-color-scheme` block, unless the subject calls for committing to one.

When you are done, tell the reader what you built and name the entry file, so
they know which artifact to open."""


SKILL = {
    "id": "k-make-site",
    "skillName": "make-site",
    "description": "Build a small static website — HTML, CSS and JS as artifacts under /site/",
    "body": BRIEF,
    "updatedAt": "0",
    "visibility": "public",
    # After the office three, which are the older and more used capability.
    "featuredRank": 4,
}


def main():
    exists = call("/skills/" + SKILL["id"])[0] == 200
    status, out = (
        call("/skills/" + SKILL["id"], "PUT", SKILL) if exists
        else call("/skills", "POST", SKILL)
    )
    print(f"make-site skill {status}", "" if status < 400 else out[:200])

    listed = call("/skills?featured=1")
    if listed[0] == 200:
        rows = json.loads(listed[1])
        print("featured now:", ", ".join(f"{r['skillName']}({r['featuredRank']})" for r in rows))


if __name__ == "__main__":
    main()
