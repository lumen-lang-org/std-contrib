# Seed the starting points a capability page offers — Kimi's "featured cases".
#
# A template is artifacts, not instructions: the files land as version 1 when
# a conversation starts from one, and the skill named on the row is what the
# page pins to work on them. That split is the whole design — a template with
# a briefing inside would be a skill nobody could attach, and a skill that
# shipped starting documents would stage them into every run.
#
# Idempotent, like the skills seed: PUT when the row is there, POST when it
# is not.

import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("AGENTS_API", "http://127.0.0.1:8100")


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


# The brief is markdown, not the finished document: the skill turns it into a
# .docx/.xlsx/.pptx. A template that shipped the binary would be a document to
# edit; this is a document to write, which is what an agent is for.
TEMPLATES = [
    {
        "id": "tpl-doc-report",
        "label": "Status report",
        "description": "Context, what happened, what is next, and the decisions waiting on someone",
        "kind": "doc",
        "skillName": "make-doc",
        "rank": 1,
        "files": [
            {
                "path": "/brief.md",
                "title": "Report brief",
                "body": """# Status report

Fill this in, then ask for the document.

## Period
<what span this covers>

## Context
<one paragraph: what the reader needs before the detail>

## What happened
- <shipped, decided, discovered>

## What is next
- <the next span's intent, not a wish list>

## Decisions waiting
- <the question, who owns it, what it blocks>
""",
            }
        ],
    },
    {
        "id": "tpl-sheet-budget",
        "label": "Budget tracker",
        "description": "Line items against a plan, with the variance doing the arguing",
        "kind": "sheet",
        "skillName": "make-sheet",
        "rank": 1,
        "files": [
            {
                "path": "/brief.md",
                "title": "Budget brief",
                "body": """# Budget tracker

Fill this in, then ask for the spreadsheet.

## Period
<month, quarter, project>

## Lines
| Item | Planned | Actual |
|---|---|---|
| <name> | <number> | <number> |

Numbers stay numbers — the sheet's own formulas add them, and a number
written as text is a column that silently refuses to total.

## Questions the sheet should answer
- <what a reader opens it to find out>
""",
            }
        ],
    },
    {
        "id": "tpl-deck-pitch",
        "label": "Pitch deck",
        "description": "Problem, insight, what you built, why it wins, what you want",
        "kind": "deck",
        "skillName": "make-deck",
        "rank": 1,
        "files": [
            {
                "path": "/brief.md",
                "title": "Pitch brief",
                "body": """# Pitch deck

Fill this in, then ask for the deck.

## The one sentence
<what this is, to someone who will not read slide two>

## Problem
<whose, how often, what it costs them today>

## Insight
<what you know that the room does not>

## What you built
<the thing, not the roadmap>

## Why it wins
<the moat, the wedge, or the unfair advantage — pick one and defend it>

## The ask
<amount, hire, decision — be specific>
""",
            }
        ],
    },
]


def main():
    for t in TEMPLATES:
        row = {
            "id": t["id"],
            "label": t["label"],
            "description": t["description"],
            "kind": t["kind"],
            "skillName": t["skillName"],
            "visibility": "public",
            "featuredRank": t["rank"],
        }
        exists = call("/templates/" + t["id"])[0] == 200
        status, out = (
            call("/templates/" + t["id"], "PUT", row) if exists else call("/templates", "POST", row)
        )
        print(f"{t['label']:16} template {status}", "" if status < 400 else out[:120])

        for n, f in enumerate(t["files"]):
            frow = {
                "id": f"{t['id']}-f{n}",
                "templateId": t["id"],
                "path": f["path"],
                "title": f["title"],
                "body": f["body"],
            }
            status, out = call(f"/templates/{t['id']}/files/{frow['id']}", "PUT", frow)
            if status == 404:
                status, out = call(f"/templates/{t['id']}/files", "POST", frow)
            print(f"{t['label']:16} file     {status}", "" if status < 400 else out[:120])

    for kind in ["doc", "sheet", "deck"]:
        print(f"kind={kind}:", call(f"/templates?kind={kind}")[1][:100])


if __name__ == "__main__":
    main()
