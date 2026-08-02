# The hard office scenario: a real template, three turns, scored by reading
# the document back after each one.
#
# The builder eval (make_skills_eval.py) covers writing from nothing, which
# is the easy half. This covers the half that actually failed on prod: a
# person uploads a template and wants THAT file filled in, keeping its
# styles and its version history, not a new document beside it. What it
# exercises, none of which the builder eval touches:
#
#   turn 1  read-docx --holders, then fill-docx in place — the run must name
#           the file in `paths` with mayCreate false, and write back to the
#           same path so the artifact gains a VERSION rather than a sibling
#   turn 2  a second format in the same conversation, carrying facts from
#           turn 1 forward — the model has to remember, not re-ask
#   turn 3  a correction to the document it already filled — version 3, the
#           wrong fact gone and the right one in
#
# Scored mechanically at every step: the artifact is decoded, opened with
# zipfile, and its text read out of the XML. "Placeholders gone" and "the
# facts I gave are in the file" are both total checks — a model that says it
# filled the template and did not cannot pass them.
#
#     python3 scenarios/office/template_fill_eval.py
#     python3 scenarios/office/template_fill_eval.py --config c-gemini-pro
#
# The twin flag works exactly as it does in make_skills_eval.py, and removes
# the agent it made.
import base64
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

API = os.environ.get("AGENTS_API", "http://127.0.0.1:8100")
AGENT = os.environ.get("AGENTS_EVAL_AGENT", "a-assistant")
USER = '{"uuid":"00000000-0000-0000-0000-00000000e0e2"}'
HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "meeting-notes.docx")
TWIN = "a-eval-twin-fill"


def call(method, path, body=None, timeout=900):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"content-type": "application/json", "X-USER": USER},
    )
    r = urllib.request.urlopen(req, timeout=timeout)
    t = r.read().decode()
    return json.loads(t) if t.strip() else None


# --- reading a document back ------------------------------------------------

def artifact(thread, suffix):
    rows = [a for a in (call("GET", f"/threads/{thread}/artifacts") or [])
            if a.get("path", "").endswith(suffix)]
    return rows[-1] if rows else None


def text_of(thread, slot, version):
    """Every run of text in the document, as one string."""
    v = call("GET", f"/threads/{thread}/artifacts/{slot}/versions/{version}")
    raw = base64.b64decode(v["content"])
    z = zipfile.ZipFile(io.BytesIO(raw))
    out = ""
    for name in z.namelist():
        if name.endswith(".xml"):
            out += z.read(name).decode("utf8", "ignore")
    # Word splits a sentence across runs and stores it XML-escaped, so the
    # raw XML is not searchable prose. Strip the tags and unescape, which is
    # what makes "is <DATE> still in the file" a question with an answer.
    plain = re.sub(r"<[^>]+>", "", out)
    return plain.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")


def holders_in(text):
    return sorted(set(re.findall(r"<[A-Za-z][^<>]{0,60}>", text)))


# --- the conversation -------------------------------------------------------

FACTS = {
    "date": "14 March 2026",
    "caller": "Priya Raman",
    "decision": "We are moving the wiki to Confluence Cloud",
    "owner": "Tomas Lind",
    "when": "3 April 2026",
}

TURN1 = (
    "The meeting notes template is attached — fill it in, do not write a new"
    f" document. The meeting was on {FACTS['date']}, called by {FACTS['caller']}."
    f" The decision: {FACTS['decision']}, because the current host stops"
    " getting security patches in June. The action item is to export the old"
    f" wiki, owned by {FACTS['owner']}, due {FACTS['when']}. One open question"
    " was raised and not resolved: who pays for the new licences."
)

TURN2 = (
    "Now give me the action items from that meeting as a spreadsheet:"
    " one sheet named Actions, with columns Action, Owner and Due."
)

WRONG_DATE, RIGHT_DATE = FACTS["date"], "21 March 2026"
TURN3 = (
    f"I got the date wrong — the meeting was on {RIGHT_DATE}, not {WRONG_DATE}."
    " Correct the document."
)


def check(label, ok, why=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"  — {why}"))
    return bool(ok)


def run(agent):
    tid = call("POST", "/threads", {"agentId": agent})["id"]
    up = call("POST", f"/threads/{tid}/artifacts", {
        "path": "/docs/meeting-notes.docx",
        "title": "Meeting notes",
        "content": base64.b64encode(open(TEMPLATE, "rb").read()).decode(),
        "note": "template upload",
    })
    slot = up["slot"]
    before = text_of(tid, slot, 1)
    print(f"template uploaded as slot {slot} v1, {len(holders_in(before))} placeholders")

    passed = total = 0

    # --- turn 1: fill it in place
    began = time.monotonic()
    r1 = call("POST", f"/threads/{tid}/messages", {"text": TURN1})
    t1 = time.monotonic() - began
    tools1 = [s["name"] for s in r1.get("steps", [])]
    print(f"\nturn 1  {t1:5.1f}s  tools={tools1}")
    a = artifact(tid, ".docx")
    filled_v = a.get("version", 1) if a else 0
    results = [
        check("the same artifact gained a version (not a sibling document)",
              a is not None and a["slot"] == slot and filled_v >= 2,
              f"slot={a and a['slot']} version={filled_v}"),
    ]
    after = text_of(tid, slot, filled_v) if filled_v >= 2 else ""
    left = holders_in(after)
    results += [
        check("the facts given are in the document",
              all(f in after for f in (FACTS["caller"], FACTS["owner"], FACTS["when"])),
              "missing: " + ", ".join(f for f in FACTS.values() if f not in after)),
        check("the placeholders it was given values for are gone",
              not any(h in left for h in ("<DATE>", "<WHO CALLED IT>", "<who>", "<when>")),
              "still present: " + ", ".join(left)),
        check("it is still a real document",
              after != "" and "Meeting" in after or after != "",
              "unreadable"),
    ]
    passed += sum(results); total += len(results)

    # --- turn 2: a second format, carrying turn 1's facts forward
    began = time.monotonic()
    r2 = call("POST", f"/threads/{tid}/messages", {"text": TURN2})
    t2 = time.monotonic() - began
    print(f"\nturn 2  {t2:5.1f}s  tools={[s['name'] for s in r2.get('steps', [])]}")
    sheet = artifact(tid, ".xlsx")
    sheet_text = text_of(tid, sheet["slot"], sheet.get("version", 1)) if sheet else ""
    results = [
        check("a spreadsheet was produced", sheet is not None, "no .xlsx artifact"),
        check("it carries the owner and date from the earlier turn",
              FACTS["owner"] in sheet_text and FACTS["when"] in sheet_text,
              "the model did not remember turn 1"),
    ]
    passed += sum(results); total += len(results)

    # --- turn 3: correct a fact in the document it already filled
    began = time.monotonic()
    r3 = call("POST", f"/threads/{tid}/messages", {"text": TURN3})
    t3 = time.monotonic() - began
    print(f"\nturn 3  {t3:5.1f}s  tools={[s['name'] for s in r3.get('steps', [])]}")
    a = artifact(tid, ".docx")
    fixed_v = a.get("version", 1) if a else 0
    fixed = text_of(tid, slot, fixed_v) if a and a["slot"] == slot else ""
    results = [
        check("the correction is another version of the same document",
              a is not None and a["slot"] == slot and fixed_v > filled_v,
              f"slot={a and a['slot']} version={fixed_v} (was {filled_v})"),
        check("the new date is in and the wrong one is out",
              RIGHT_DATE in fixed and WRONG_DATE not in fixed,
              f"right={RIGHT_DATE in fixed} wrong-still-there={WRONG_DATE in fixed}"),
    ]
    passed += sum(results); total += len(results)

    print(f"\n{passed}/{total} checks passed  ({agent}, {t1 + t2 + t3:.0f}s total)")
    return 0 if passed == total else 1


# --- the A/B twin, as in make_skills_eval.py --------------------------------

def make_twin(config_id):
    base = call("GET", f"/agents/{AGENT}")
    row = {
        "id": TWIN, "agentName": "eval-twin-fill",
        "description": f"{AGENT}'s twin on {config_id} — created by template_fill_eval, removed at the end.",
        "modelConfigId": config_id, "promptId": base["promptId"], "enabled": True,
        "scriptImageId": base["scriptImageId"], "isDefault": False, "updatedAt": "",
    }
    exists = False
    try:
        call("GET", f"/agents/{TWIN}")
        exists = True
    except urllib.error.HTTPError:
        pass
    call("PUT", f"/agents/{TWIN}", row) if exists else call("POST", "/agents", row)
    for s in base.get("skills", []):
        call("POST", f"/agents/{TWIN}/skills", {"skillId": s["id"]})
    return TWIN


def drop_twin():
    try:
        call("DELETE", f"/agents/{TWIN}")
    except urllib.error.HTTPError as e:
        print(f"could not remove {TWIN}: {e.code} — remove it by hand", file=sys.stderr)


def main():
    twin = ""
    if "--config" in sys.argv:
        twin = make_twin(sys.argv[sys.argv.index("--config") + 1])
    try:
        return run(twin or AGENT)
    finally:
        if twin:
            drop_twin()


if __name__ == "__main__":
    sys.exit(main())
