# Starting points for make-site: real pages, not prompts.
#
# The office templates ship a styled .docx with <ANGLED> placeholders because a
# document is a thing you fill in. A site is the same idea in a different
# medium: a page whose structure, type scale and colour are already decided,
# with the words left to write. What the agent then does is edit, not invent —
# which is the difference between a template and a suggestion.
#
# Two files each, and that is deliberate: index.html plus style.css is the
# smallest thing that is honestly a SITE rather than a page, and it is the
# arrangement the make-site briefing tells the model to keep. A template that
# shipped one self-contained file would teach the opposite of what the skill
# asks for.
#
# Placeholders are [SQUARE] here, not <ANGLED> as in the office templates, and
# the reason is not taste. In HTML an angle bracket is structure: <TITLE> is a
# REAL element, so a browser parsed the article template's <h1><TITLE></h1> as
# an actual <title>, swallowed the rest of the document into it, and rendered a
# blank white page. The thumbnail showed it immediately, which is the argument
# for previewing a template at all.
#
# No placeholders in the CSS at all — a stylesheet with a placeholder colour is
# one nobody can preview, and the whole point of a template is that it looks
# like something before you fill it in.
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


# One stylesheet shape shared by all three, differing in its palette and type.
# Written out per template rather than factored into a shared file: a template
# is copied into somebody's conversation and edited there, so a stylesheet that
# referenced a file outside the template would break the moment it landed.
def sheet(bg, ink, accent, muted, display, body):
    return f"""/* Edit freely — this is yours once the conversation starts. */
:root {{
  --bg: {bg};
  --ink: {ink};
  --accent: {accent};
  --muted: {muted};
}}
* {{ box-sizing: border-box; }}
body {{
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.6 {body};
  -webkit-font-smoothing: antialiased;
}}
.wrap {{ max-width: 68ch; margin: 0 auto; padding: 72px 24px 96px; }}
h1 {{
  font: 600 clamp(34px, 6vw, 52px)/1.1 {display};
  letter-spacing: -0.02em;
  margin: 0 0 12px;
  text-wrap: balance;
}}
.lede {{ font-size: 19px; color: var(--muted); margin: 0 0 40px; }}
h2 {{
  font: 600 24px/1.25 {display};
  letter-spacing: -0.01em;
  margin: 44px 0 10px;
}}
p {{ margin: 0 0 16px; }}
a {{ color: var(--accent); }}
.eyebrow {{
  font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--accent); margin: 0 0 10px;
}}
.card {{
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 14px; padding: 20px; margin: 18px 0;
}}
footer {{
  margin-top: 64px; padding-top: 20px; font-size: 14px; color: var(--muted);
  border-top: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
}}
@media (prefers-color-scheme: dark) {{
  :root {{ --bg: #131316; --ink: #f2f2ef; --muted: #9c9ca4; }}
}}
"""


LANDING = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>[PRODUCT]</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="wrap">
    <p class="eyebrow">[ONE WORD: what category this is in]</p>
    <h1>[PRODUCT]: [the promise, in six words]</h1>
    <p class="lede">[one sentence a stranger could repeat to a colleague. Say what
      it does and who for — not how it works.]</p>

    <h2>Why it exists</h2>
    <p>[the problem, described as the reader experiences it rather than as the
      product solves it.]</p>

    <div class="card">
      <h2>[the one feature worth the page]</h2>
      <p>[what it lets somebody do that they could not do before.]</p>
    </div>

    <h2>How to start</h2>
    <p>[the first concrete step. A command, a link, a sign-up — something a
      reader can do in the next minute.]</p>

    <footer>[PRODUCT] — <a href="#">[your link]</a></footer>
  </main>
</body>
</html>
"""

ABOUT = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>About [SUBJECT]</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="wrap">
    <p class="eyebrow">About</p>
    <h1>[SUBJECT]</h1>
    <p class="lede">[who or what this is, in one sentence that would make sense
      to somebody who arrived from a search result.]</p>

    <h2>The story</h2>
    <p>[how it began, and what changed. Real dates and real names — an about
      page with no specifics reads as a placeholder even when it is finished.]</p>

    <h2>What we do now</h2>
    <p>[the present tense. What somebody would actually get from you today.]</p>

    <div class="card">
      <h2>Get in touch</h2>
      <p>[one address, one link, or one form. Not three.]</p>
    </div>

    <footer>[SUBJECT] — <a href="#">[your link]</a></footer>
  </main>
</body>
</html>
"""

POST = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>[TITLE]</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="wrap">
    <p class="eyebrow">[DATE] · [READING TIME]</p>
    <h1>[TITLE]</h1>
    <p class="lede">[the claim of the piece, stated before the argument. A reader
      who stops here should still know what you think.]</p>

    <p>[the opening: a concrete situation, not a definition.]</p>

    <h2>[the first turn of the argument]</h2>
    <p>[...]</p>

    <div class="card">
      <p>[the quote, the number, or the example the piece rests on.]</p>
    </div>

    <h2>[what follows from it]</h2>
    <p>[...]</p>

    <h2>What to do about it</h2>
    <p>[the reader's next action, or the honest admission that there isn't
      one yet.]</p>

    <footer><a href="#">More writing</a></footer>
  </main>
</body>
</html>
"""

TEMPLATES = [
    {
        "id": "tpl-site-landing",
        "label": "Landing page",
        "description": "A product page: the promise, the problem, one feature, one next step",
        "rank": 1,
        "files": [
            {"path": "/site/index.html", "title": "Landing page", "body": LANDING},
            {"path": "/site/style.css", "title": "Styles", "body": sheet(
                "#ffffff", "#16161a", "#2563eb", "#5b5b66",
                'system-ui, -apple-system, "Segoe UI", sans-serif',
                'system-ui, -apple-system, "Segoe UI", sans-serif')},
        ],
    },
    {
        "id": "tpl-site-about",
        "label": "About page",
        "description": "Who you are, how it began, and one way to get in touch",
        "rank": 2,
        "files": [
            {"path": "/site/index.html", "title": "About page", "body": ABOUT},
            {"path": "/site/style.css", "title": "Styles", "body": sheet(
                "#fbfaf8", "#1b1a17", "#9a6b3f", "#6b675f",
                'Georgia, "Times New Roman", serif',
                'system-ui, -apple-system, "Segoe UI", sans-serif')},
        ],
    },
    {
        "id": "tpl-site-post",
        "label": "Article",
        "description": "A piece of writing: the claim first, then the argument, then the ask",
        "rank": 3,
        "files": [
            {"path": "/site/index.html", "title": "Article", "body": POST},
            {"path": "/site/style.css", "title": "Styles", "body": sheet(
                "#ffffff", "#14171a", "#0f766e", "#5c6670",
                '"Iowan Old Style", Georgia, serif',
                'Georgia, "Times New Roman", serif')},
        ],
    },
]


def main():
    for t in TEMPLATES:
        row = {
            "id": t["id"], "label": t["label"], "description": t["description"],
            # The kind the console's CAPS table maps make-site to. A template
            # whose kind no chip asks for is a row nobody ever sees.
            "kind": "site", "skillName": "make-site",
            "visibility": "public", "featuredRank": t["rank"],
        }
        exists = call("/templates/" + t["id"])[0] == 200
        status, out = (
            call("/templates/" + t["id"], "PUT", row) if exists
            else call("/templates", "POST", row)
        )
        print(f"{t['label']:14} template {status}", "" if status < 400 else out[:140])

        # Adopt an existing row for this path rather than minting an id — the
        # same rule push_office_templates.py records, and for the same reason:
        # a PUT to an id that is not there 404s into a POST and the template
        # ends up holding the file twice.
        listed, held = call(f"/templates/{t['id']}/files")
        have = {r["path"]: r["id"] for r in json.loads(held)} if listed == 200 else {}
        for n, f in enumerate(t["files"]):
            fid = have.get(f["path"], f"{t['id']}-f{n}")
            frow = {"id": fid, "templateId": t["id"], "path": f["path"],
                    "title": f["title"], "body": f["body"]}
            status, out = call(f"/templates/{t['id']}/files/{fid}", "PUT", frow)
            if status == 404:
                status, out = call(f"/templates/{t['id']}/files", "POST", frow)
            print(f"{t['label']:14} {f['path']:18} {status}", "" if status < 400 else out[:140])

    n = len(json.loads(call("/templates?kind=site")[1]))
    print(f"kind=site: {n} templates")


if __name__ == "__main__":
    main()
