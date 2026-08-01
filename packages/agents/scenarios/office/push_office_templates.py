# Push the built office templates — the real .docx/.xlsx/.pptx files beside
# this script — onto an engine, as template rows plus one file row each.
#
#     python3 make_templates.py            # in agents-office:1, builds the files
#     python3 push_office_templates.py     # AGENTS_API + AGENTS_X_USER to aim it
#
# This supersedes what seed_templates.py pushed for files: that script ships a
# /brief.md per template — a document to WRITE — and the pages have since moved
# to shipping the document itself, styled and half-empty, for the agent to fill
# in. The row shape is the same; only the body changed species. Kept as its own
# script rather than editing seed_templates.py because the briefs are still the
# honest record of what each template is FOR, and the eval scenarios read them.
#
# Idempotent the same way every seed here is: PUT when the row answers, POST
# when it does not.
import base64
import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("AGENTS_API", "http://127.0.0.1:8100")
X_USER = os.environ.get("AGENTS_X_USER", "")
HERE = os.path.dirname(os.path.abspath(__file__))

# Rank 1 in each kind is the original card; these shelve in after it. Order is
# the order a page shows, so the everyday ones sit before the quarterly ones.
TEMPLATES = [
    # --- doc ---------------------------------------------------------------
    {"id": "tpl-doc-report", "kind": "doc", "rank": 1, "file": "status-report.docx",
     "label": "Status report",
     "description": "Context, what happened, what is next, and the decisions waiting on someone"},
    {"id": "tpl-doc-meeting", "kind": "doc", "rank": 2, "file": "meeting-notes.docx",
     "label": "Meeting notes",
     "description": "Attendees, decisions, and an actions table with owners and dates"},
    {"id": "tpl-doc-brief", "kind": "doc", "rank": 3, "file": "project-brief.docx",
     "label": "Project brief",
     "description": "Problem, goal, what is out of scope, milestones with proof"},
    {"id": "tpl-doc-proposal", "kind": "doc", "rank": 4, "file": "proposal.docx",
     "label": "Proposal",
     "description": "Options compared honestly, a recommendation, and the next steps"},
    {"id": "tpl-doc-memo", "kind": "doc", "rank": 5, "file": "decision-memo.docx",
     "label": "Decision memo",
     "description": "The decision, the options that lost, and what would reopen it"},
    # --- sheet -------------------------------------------------------------
    {"id": "tpl-sheet-budget", "kind": "sheet", "rank": 1, "file": "budget-tracker.xlsx",
     "label": "Budget tracker",
     "description": "Line items against a plan, with the variance doing the arguing"},
    {"id": "tpl-sheet-timeline", "kind": "sheet", "rank": 2, "file": "project-timeline.xlsx",
     "label": "Project timeline",
     "description": "Tasks with owners and dates, the duration computed for you"},
    {"id": "tpl-sheet-invoice", "kind": "sheet", "rank": 3, "file": "invoice.xlsx",
     "label": "Invoice",
     "description": "Line items, quantities and totals that keep adding up after edits"},
    {"id": "tpl-sheet-expenses", "kind": "sheet", "rank": 4, "file": "expense-report.xlsx",
     "label": "Expense report",
     "description": "Dated expenses by category, summed at the bottom"},
    {"id": "tpl-sheet-calendar", "kind": "sheet", "rank": 5, "file": "content-calendar.xlsx",
     "label": "Content calendar",
     "description": "What publishes where and when, with an owner and a status per row"},
    # --- deck --------------------------------------------------------------
    {"id": "tpl-deck-pitch", "kind": "deck", "rank": 1, "file": "pitch-deck.pptx",
     "label": "Pitch deck",
     "description": "Problem, insight, what you built, why it wins, what you want"},
    {"id": "tpl-deck-kickoff", "kind": "deck", "rank": 2, "file": "project-kickoff.pptx",
     "label": "Project kickoff",
     "description": "Why now, the goal, scope, plan, team and the risk that matters"},
    {"id": "tpl-deck-review", "kind": "deck", "rank": 3, "file": "quarterly-review.pptx",
     "label": "Quarterly review",
     "description": "Highlights, numbers without adjectives, what missed, what is next"},
    {"id": "tpl-deck-allhands", "kind": "deck", "rank": 4, "file": "team-update.pptx",
     "label": "Team update",
     "description": "Wins, the metrics the team steers by, what lands next, help wanted"},
    {"id": "tpl-deck-roadmap", "kind": "deck", "rank": 5, "file": "product-roadmap.pptx",
     "label": "Product roadmap",
     "description": "Themes, then now / next / later — with dates only where they are real"},
]

SKILL = {"doc": "make-doc", "sheet": "make-sheet", "deck": "make-deck"}


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


def main():
    for t in TEMPLATES:
        row = {
            "id": t["id"], "label": t["label"], "description": t["description"],
            "kind": t["kind"], "skillName": SKILL[t["kind"]],
            "visibility": "public", "featuredRank": t["rank"],
        }
        exists = call("/templates/" + t["id"])[0] == 200
        status, out = (
            call("/templates/" + t["id"], "PUT", row) if exists
            else call("/templates", "POST", row)
        )
        print(f"{t['label']:18} template {status}", "" if status < 400 else out[:120])

        with open(os.path.join(HERE, t["file"]), "rb") as f:
            body = base64.b64encode(f.read()).decode()
        # Adopt an existing row for this path rather than minting an id: the
        # first seeding named its rows `-doc`, this script names them `-f0`,
        # and a PUT to an id that is not there 404s into a POST — which is how
        # the three originals briefly held their document twice, and every
        # conversation started from them would have landed two copies of it.
        listed, held = call(f"/templates/{t['id']}/files")
        fid = t["id"] + "-f0"
        if listed == 200:
            for row in json.loads(held):
                if row["path"] == "/" + t["file"]:
                    fid = row["id"]
                    break
        frow = {
            "id": fid, "templateId": t["id"],
            "path": "/" + t["file"], "title": t["label"], "body": body,
        }
        status, out = call(f"/templates/{t['id']}/files/{fid}", "PUT", frow)
        if status == 404:
            status, out = call(f"/templates/{t['id']}/files", "POST", frow)
        print(f"{t['label']:18} file     {status}", "" if status < 400 else out[:120])

    for kind in ["doc", "sheet", "deck"]:
        n = len(json.loads(call(f"/templates?kind={kind}")[1]))
        print(f"kind={kind}: {n} templates")


if __name__ == "__main__":
    main()
