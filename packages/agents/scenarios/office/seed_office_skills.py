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
def brief(what, command, ext, out_dir, spec, sample_name, closing, fill, source_name="spec.json"):
    # /artifacts/docs/ as the artifact path the run knows it by: /docs/.
    out_dir_short = out_dir.replace("/artifacts", "", 1)
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

cat > /tmp/{source_name} <<'EOF'
{spec}
EOF
{command} /tmp/{source_name} {out_dir}<name>.{ext}

The source goes in /tmp and nowhere else. Anything written under /artifacts
becomes an artifact with a card of its own, and a stray {source_name} sitting
beside the document is noise the reader has to work out.

{closing}

CHANGING one you built earlier — adding a section, fixing a title, dropping
a bullet — is the same command again, with one difference that the run
enforces: `paths` must name the file you are replacing.

  paths: ["{out_dir_short}<name>.{ext}"]

That is the ARTIFACT path — no /artifacts in front of it. Writing over an
existing artifact that was not named in `paths` is refused, and so is naming
a path that does not exist, so copy the path from the file you made and
change nothing about it. The command still writes to {out_dir}<name>.{ext},
the same path as the first time.

Write the WHOLE source: everything the finished {ext} should contain, the
earlier content exactly as it was plus the change. Re-read what you wrote
before, and carry every section across — a rebuild that answers the new
request and drops the old content has destroyed the thing you were asked to
add to.

Changing a TITLE does not change the FILE NAME. The path stays what it was,
whatever the document is now called: a new path is a new document, and the
reader is left holding a link to the old one.

Do not try to edit the file in place. A .{ext} is a zip; sed, grep and a
shell loop over it produce nothing, and repeating a script that just failed
produces nothing twice. If a run fails, change what you are doing rather
than running it again.

The output path must start {out_dir} and the file name is lowercase with
dashes — {sample_name}, never a name with spaces; a space in an unquoted
path splits the command. The run captures the file as an artifact and the
reader gets a download card on your message. Check stdout for "wrote"
before telling the reader the file exists. Never build a document with
write_artifact: a .{ext} is a zip, not text, and the engine refuses a body
that is not really one."""


# The two names one file has, and the sentence every fill briefing has to
# carry. An artifact's path is /docs/notes.docx; a run materialises it at
# /artifacts/docs/notes.docx, which is the only one that opens. The old
# fill-doc briefing showed the artifact path in both `paths` and the command,
# and the run that followed it read a file that was not there and told the
# person their upload was missing.
PREFIX_RULE = """The path in `paths` is the ARTIFACT path (/docs/notes.docx). The path in the
command is where the run puts it: /artifacts + that (/artifacts/docs/notes.docx).
They are two names for one file and only the second one opens."""

DOC_FILL = f"""To fill it: one run to see its placeholders, one to fill them. Both are
language "sh", environment "office", with the document named in paths and
mayCreate false.

{PREFIX_RULE}

  read-docx /artifacts/<its path> --holders

then, with real values for the placeholders it printed:

  fill-docx /artifacts/<its path> /artifacts/<its path> '{{"<TITLE>": "...", "<PERIOD>": "..."}}'

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


FILL_DOC_BODY = f"""Fill a Word document (.docx) that already exists — a template the
conversation started from, or one somebody uploaded.

run_script with environment "office" — never "main". The document tools only
exist in office; in main every one of them fails.

{PREFIX_RULE}

DO IT IN THIS ORDER. Skipping step 1 is how a run invents placeholder names
that are not in the document and then tells the person their template is
broken.

1. READ IT FIRST. Never guess what the placeholders are called:

    run_script(environment="office", language="sh", paths=["<the artifact path>"], source=
      'read-docx "/artifacts/<the artifact path>" --holders')

   It prints every <PLACEHOLDER> the document actually contains. Use those
   names exactly — they are usually not the words the person said.

2. FILL IT, saving over the same path so the run appends a version to the
   document they are looking at rather than making a second one:

    run_script(environment="office", language="sh", paths=["<the artifact path>"], mayCreate=false, source=
      'fill-docx "/artifacts/<the artifact path>" "/artifacts/<the same path>" \\'{{"<TITLE>": "...", "<DATE>": "..."}}\\'')

   It answers JSON: {{how, filled, left, still_unfilled}}. `filled` counts each
   replacement, `left` is keys that matched nothing — a key in `left` is YOUR
   mistake, not the document's — and `still_unfilled` lists the placeholders a
   reader will still see.

3. SAY WHAT IS STILL EMPTY. Report `still_unfilled` to the person rather than
   claiming the document is done. An unanswered placeholder is left visible on
   purpose: it should look unanswered, not become a blank line.

CORRECTING something you already filled is the same call with different
keys. The placeholder is GONE — your own fill replaced it — so passing it
again matches nothing, and a non-empty `left` means you are NOT FINISHED:
run it again in the same turn rather than telling the person it failed. Any
string is a valid key, so use the value you filled in earlier:

    fill-docx "/artifacts/<path>" "/artifacts/<path>" '{{"<the text as it reads now>": "<the new text>"}}'

The document gains another version; you are never starting over.

Why a script and not python-docx by hand: Word splits text across runs — a
revision id, a spell-check marker, a language switch — so "<MEETING>" is
commonly three separate runs, and the placeholder is stored XML-escaped as
&lt;MEETING&gt; inside word/document.xml. Any find-and-replace that walks
paragraph.runs finds nothing and reports the document is missing a
placeholder that is plainly on the page. These scripts merge the runs first
and search the escaped form, which is what makes the edit work at all.

A .dotx or a template written with {{{{ jinja }}}} tags is handled by the same
call — fill_docx.py picks the right path itself.

NEVER use edit_artifact on a .docx. It is a zip; there is no text in it to
match."""


SKILLS = [
    {
        "name": "fill-doc",
        # NOT featured, deliberately. featured_rank > 0 is what puts a skill in
        # the composer's chip row, and that row is starting points — "make me a
        # document". fill-doc acts on a document that is already in the
        # conversation, so as a chip it offers something there is nothing to do
        # yet. Public, so every agent still reaches it by name.
        "rank": 0,
        "files": [],
        "description": "Fill the placeholders in a Word document that already exists, in place",
        "body": FILL_DOC_BODY,
    },
    {
        "name": "make-doc",
        "rank": 1,
        "files": [],
        "description": "Write a Word document (.docx) from a title and blocks of headings, paragraphs and bullets",
        "body": brief(
            "document", "make-doc", "docx", "/artifacts/docs/",
            """# <the document title>
## <a section heading>
<a paragraph of real content, written normally — no quoting, no escaping>
- <a bullet>""",
            "project-brief.docx",
            "The source is markdown: # is the title, ## a section, ### a sub-section,\n"
            "- a bullet, and every other line a paragraph. Nothing needs quoting, and\n"
            "an apostrophe or a comma in a sentence cannot break the run. Headings\n"
            "carry the structure — never fake one with a bold paragraph. Write real\n"
            "content yourself; make-doc formats, it does not think.",
            DOC_FILL,
            source_name="brief.md",
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
    # fill-doc staged copies of the three helpers that are now on PATH in the
    # office image. Two copies of one script is the drift that produced the
    # build_doc.py/make_doc mismatch; the image is the source of truth.
    "sk-fill-doc": ["sk-fill-doc:fill_docx.py", "sk-fill-doc:merge_runs.py",
                    "sk-fill-doc:read_docx.py"],
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
