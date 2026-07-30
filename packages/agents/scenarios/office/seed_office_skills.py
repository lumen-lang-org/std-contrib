# Seed make-doc, make-sheet and make-deck as public, featured skills.
#
# Idempotent: PUT when the row is there, POST when it is not, so running it
# twice is how you update a briefing. The builders beside this file are the
# skills' staged files — the briefing tells the model to import them from
# /skills/<name>/, and run-script materialises them fresh on every run, so an
# edit here is live on the next call with no restart.
#
# The skills are public (visibility) and featured (featured_rank), which is
# what puts them in every agent's briefing without an attachment and in the
# console's capability chips in that order.

import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("AGENTS_API", "http://127.0.0.1:8100")
HERE = os.path.dirname(os.path.abspath(__file__))


def call(path, method="GET", body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


# The briefing is the whole skill. It names the environment because the
# libraries live in one image and not the other, and it names the /artifacts
# prefix because that is where the run's reconcile looks — a document written
# anywhere else is a file in a container nobody will ever see again.
def brief(what, env_lib, module, out_dir, spec, closing):
    return f"""Write {what} the reader can download.

Run this in the office environment — it has {env_lib}; main does not.
One call does everything:

run_script({{
  language: "python",
  environment: "office",
  mayCreate: true,
  paths: [],
  source: <the script below, with your spec filled in>,
}})

import sys; sys.path.insert(0, "/skills/{module}")
from {module.replace('-', '_')} import build
build({spec})

The path must start {out_dir} — the run captures it as an artifact and the
reader gets a card for it on your message. Write real content into the spec
yourself; the builder formats, it does not think. Check stdout for "wrote"
before telling the reader it exists.

{closing}"""


SKILLS = [
    {
        "name": "make-doc",
        "file": "build_doc.py",
        "rank": 1,
        "description": "Write a Word document (.docx) from titled sections of paragraphs and bullets",
        "body": brief(
            "a Word document (.docx)", "python-docx", "make-doc", "/artifacts/docs/",
            """{
  "path": "/artifacts/docs/<name>.docx",
  "title": "...",
  "subtitle": "...",
  "sections": [
    { "heading": "...", "paragraphs": ["..."], "bullets": ["..."] },
  ],
}""",
            "Headings carry the structure; do not fake them with bold paragraphs.",
        ),
    },
    {
        "name": "make-sheet",
        "file": "build_sheet.py",
        "rank": 2,
        "description": "Write a spreadsheet (.xlsx) from named sheets of columns and rows",
        "body": brief(
            "a spreadsheet (.xlsx)", "openpyxl", "make-sheet", "/artifacts/sheets/",
            """{
  "path": "/artifacts/sheets/<name>.xlsx",
  "sheets": [
    { "name": "...", "columns": ["..."], "rows": [["..."]], "widths": [20] },
  ],
}""",
            "Numbers go in as numbers, not strings, or the reader's own formulas will not add.",
        ),
    },
    {
        "name": "make-deck",
        "file": "build_deck.py",
        "rank": 3,
        "description": "Write a presentation (.pptx) from a title and bulleted slides",
        "body": brief(
            "a presentation (.pptx)", "python-pptx", "make-deck", "/artifacts/decks/",
            """{
  "path": "/artifacts/decks/<name>.pptx",
  "title": "...",
  "subtitle": "...",
  "slides": [
    { "title": "...", "bullets": ["..."], "notes": "..." },
  ],
}""",
            "One idea per slide, at most five bullets — a slide is a prompt for a speaker, not a page of prose.",
        ),
    },
]


def main():
    for s in SKILLS:
        sid = "sk-" + s["name"]
        row = {
            "id": sid,
            "skillName": s["name"],
            "description": s["description"],
            "body": s["body"],
            "updatedAt": "",
            "visibility": "public",
            "featuredRank": s["rank"],
        }
        exists = call("/skills/" + sid)[0] == 200
        status, out = call("/skills/" + sid, "PUT", row) if exists else call("/skills", "POST", row)
        print(f"{s['name']:12} skill {status}", "" if status < 400 else out[:120])

        body = open(os.path.join(HERE, s["file"])).read()
        frow = {"id": sid + "-builder", "skillId": sid, "path": s["file"], "body": body}
        status, out = call(f"/skills/{sid}/files/{frow['id']}", "PUT", frow)
        if status == 404:
            status, out = call(f"/skills/{sid}/files", "POST", frow)
        print(f"{s['name']:12} file  {status}", "" if status < 400 else out[:120])

    print("featured now:", call("/skills?featured=1")[1][:120])


if __name__ == "__main__":
    main()
