# Seed make-doc, make-sheet and make-deck as public, featured skills.
#
# Idempotent: PUT when the row is there, POST when it is not, so running it
# twice is how you update a briefing.
#
# The skills are public (visibility) and featured (featured_rank), which is
# what puts them in every agent's briefing without an attachment and in the
# console's capability chips in that order.
#
# The briefings name fixed commands — make-doc, make-sheet, make-deck, all
# baked into the office image (office.Dockerfile) beside read-docx and
# fill-docx — rather than python to import. The import shape failed on prod
# twice over: the briefing said `from make_doc import build` while the staged
# file was build_doc.py, and an 8B model asked to write builder code invents
# APIs where one asked to fill a JSON spec and run one command does not.
# Editing a sheet or deck that already exists still stages edit_sheet.py /
# edit_deck.py, whose import names match their files; a document is filled
# with fill-docx, which handles Word's run-splitting properly.

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


# The rules every briefing repeats, learned the hard way on the local model:
# the environment goes on line one because getting it wrong fails every
# command; the spec goes to /tmp so the run's reconcile does not capture it
# as a second artifact; the output name is dashed because an unquoted space
# splits the command; and no briefing carries realistic sample output,
# because a model shown one parrots it instead of running anything.
def brief(what, command, ext, out_dir, spec, sample_name, closing, fill):
    return f"""run_script with environment "office" — never "main". The document tools only
exist in office; in main every one of them fails.

FIRST look at this conversation's files. If a {what} you did not
write is already here, the person wants THAT file filled in, not a new one
beside it.

{fill}

OTHERWISE, with no {what} in the conversation, build one from
nothing. One sh script: write the spec, run one command. No imports, no
python.

run_script({{
  language: "sh",
  environment: "office",
  mayCreate: true,
  paths: [],
  source: <the script below, with your spec filled in>,
}})

cat > /tmp/spec.json <<'EOF'
{spec}
EOF
{command} /tmp/spec.json {out_dir}<name>.{ext}

{closing}

The output path must start {out_dir} and the file name is lowercase with
dashes — {sample_name}, never a name with spaces; a space in an unquoted
path splits the command. The run captures the file as an artifact and the
reader gets a download card on your message. Check stdout for "wrote"
before telling the reader the file exists. Never build a document with
write_artifact: a .{ext} is a zip, not text, and the engine refuses a body
that is not really one."""


DOC_FILL = """To fill it: one run to see its placeholders, one to fill them. Both are
language "sh", environment "office", with the document named in paths and
mayCreate false.

  read-docx /artifacts/<its path> --holders

then, with real values for the placeholders it printed:

  fill-docx /artifacts/<its path> /artifacts/<its path> '{"<TITLE>": "...", "<PERIOD>": "..."}'

Same path in and out, so the run appends a version to the document they
chose. Leave a placeholder you cannot answer as it is — unanswered should
look unanswered, not become a blank line."""

SHEET_FILL = """To fill it, name it in `paths` so the run materialises it, then edit it
where it lands and save it back to the same path (language "python",
environment "office", mayCreate false):

import sys; sys.path.insert(0, "/skills/make-sheet")
from edit_sheet import fill
# Only the columns a person fills — a row that reaches into the variance
# column overwrites the formula it was there to use.
fill("/artifacts/<the template's path>", [["<item>", 0, 0], ...])"""

DECK_FILL = """To fill it, name it in `paths` so the run materialises it, then edit it
where it lands and save it back to the same path (language "python",
environment "office", mayCreate false):

import sys; sys.path.insert(0, "/skills/make-deck")
from edit_deck import fill
fill("/artifacts/<the template's path>",
     {"<COMPANY>": "...", "<the one sentence>": "..."},
     {"Problem": ["...", "..."]})"""


SKILLS = [
    {
        "name": "make-doc",
        "rank": 1,
        "files": [],
        "description": "Write a Word document (.docx) from a title and blocks of headings, paragraphs and bullets",
        "body": brief(
            "document", "make-doc", "docx", "/artifacts/docs/",
            """{"title": "<the document title>",
 "blocks": [
  {"style": "h1", "text": "<a section heading>"},
  {"style": "p",  "text": "<a paragraph of real content>"},
  {"style": "li", "text": "<a bullet>"}
 ]}""",
            "project-brief.docx",
            "Styles are h1, h2, p, li, in the order you list them. Headings carry the\n"
            "structure — never fake one with a bold paragraph. Write real content into\n"
            "the spec yourself; make-doc formats, it does not think.",
            DOC_FILL,
        ),
    },
    {
        "name": "make-sheet",
        "rank": 2,
        "files": ["edit_sheet.py"],
        "description": "Write a spreadsheet (.xlsx) from named sheets of columns and rows",
        "body": brief(
            "spreadsheet", "make-sheet", "xlsx", "/artifacts/sheets/",
            """{"sheets": [
  {"name": "<tab name>", "columns": ["<header>", "<header>"],
   "rows": [["<text>", 0]],
   "widths": [28, 12]}
 ]}""",
            "q3-budget.xlsx",
            "columns is the bold header row; widths is optional. Numbers go in as JSON\n"
            "numbers, not strings, or the reader's own formulas will not add. Write real\n"
            "content into the spec yourself; make-sheet formats, it does not think.",
            SHEET_FILL,
        ),
    },
    {
        "name": "make-deck",
        "rank": 3,
        "files": ["edit_deck.py"],
        "description": "Write a presentation (.pptx) from a title and bulleted slides",
        "body": brief(
            "presentation", "make-deck", "pptx", "/artifacts/decks/",
            """{"title": "<the deck title>",
 "subtitle": "",
 "slides": [
  {"title": "<slide title>", "bullets": ["<a point>", "<a point>"], "notes": ""}
 ]}""",
            "q3-review.pptx",
            "One idea per slide, at most five bullets — a slide is a prompt for a\n"
            "speaker, not a page of prose. Write real content into the spec yourself;\n"
            "make-deck formats, it does not think.",
            DECK_FILL,
        ),
    },
]

# Files earlier seeds staged that no briefing names any more. A stale staged
# file is not harmless: the build_doc.py/make_doc mismatch is exactly what a
# model finds when it goes looking for something to import.
OBSOLETE_FILES = {
    "sk-make-doc": ["sk-make-doc-builder", "sk-make-doc-editor"],
    "sk-make-sheet": ["sk-make-sheet-builder"],
    "sk-make-deck": ["sk-make-deck-builder"],
}


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
            # Present since skills learned provenance: a PUT without them
            # parses as an empty row and 400s with "id must match the path".
            "source": "local",
            "sourceUrl": "",
        }
        exists = call("/skills/" + sid)[0] == 200
        status, out = call("/skills/" + sid, "PUT", row) if exists else call("/skills", "POST", row)
        print(f"{s['name']:12} skill {status}", "" if status < 400 else out[:120])

        for name in s["files"]:
            fid = f"{sid}-editor"
            body = open(os.path.join(HERE, name)).read()
            frow = {"id": fid, "skillId": sid, "path": name, "body": body}
            status, out = call(f"/skills/{sid}/files/{fid}", "PUT", frow)
            if status == 404:
                status, out = call(f"/skills/{sid}/files", "POST", frow)
            print(f"{s['name']:12} {name:15} {status}", "" if status < 400 else out[:120])

        for fid in OBSOLETE_FILES.get(sid, []):
            status, _ = call(f"/skills/{sid}/files/{fid}", "DELETE")
            if status < 400:
                print(f"{s['name']:12} removed {fid}")

    print("featured now:", call("/skills?featured=1")[1][:120])


if __name__ == "__main__":
    main()
