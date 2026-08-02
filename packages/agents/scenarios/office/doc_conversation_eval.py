# A document conversation, end to end, left in a real person's console.
#
# The other two office evals each test one move. This one is the thing a
# person actually does: five turns that build a document, extend it, spin a
# second format off it, correct it, and ask what was produced — each turn
# depending on the last. The failures it is built to catch are the ones only
# a conversation has:
#
#   * turn 2 rebuilding the document instead of adding to it, losing turn 1
#   * a new artifact per turn, so the reader ends with four half-documents
#     instead of one with a history
#   * facts from turn 1 not surviving into turn 3's spreadsheet
#   * a correction in turn 4 applied to a copy nobody is looking at
#
# It runs AS a named owner, so the conversation appears in that person's
# console and can be read as a conversation rather than as a test log — the
# point of the exercise as much as the checks are. Nothing here deletes it.
#
#     AGENTS_EVAL_OWNER=<uuid> python3 scenarios/office/doc_conversation_eval.py
#     AGENTS_EVAL_OWNER=<uuid> python3 scenarios/office/doc_conversation_eval.py --config c-gemini-pro
#
# The owner is required and never defaulted: writing a conversation into the
# wrong person's sidebar is not a mistake a script should be able to make
# quietly.
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
OWNER = os.environ.get("AGENTS_EVAL_OWNER", "")
TWIN = "a-eval-twin-conv"


def call(method, path, body=None, timeout=900):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"content-type": "application/json",
                 "X-USER": json.dumps({"uuid": OWNER})},
    )
    r = urllib.request.urlopen(req, timeout=timeout)
    t = r.read().decode()
    return json.loads(t) if t.strip() else None


TOPIC = "moving the internal wiki to a new platform"

TURNS = [
    # (what is said, what must be true afterwards)
    ("Draft a short Word document called 'Wiki Migration Brief' about " + TOPIC
     + ": a Background section and a Goals section with three bullets.",
     "doc-exists"),
    ("Good. Now add a Risks section to that same document with three risks —"
     " keep everything that is already in it.",
     "doc-grew"),
    ("Turn those risks into a spreadsheet: one sheet named Risks, with"
     " columns Risk and Mitigation.",
     "sheet-exists"),
    ("The title should be 'Wiki Migration Plan', not 'Wiki Migration Brief'."
     " Fix it in the document.",
     "doc-retitled"),
    ("What did we end up with? List the files, one line each.",
     "summary"),
]


def artifacts(thread):
    return call("GET", f"/threads/{thread}/artifacts") or []


def newest(thread, suffix):
    rows = [a for a in artifacts(thread) if a.get("path", "").endswith(suffix)]
    return rows[-1] if rows else None


def text_of(thread, slot, version):
    v = call("GET", f"/threads/{thread}/artifacts/{slot}/versions/{version}")
    raw = base64.b64decode(v["content"])
    z = zipfile.ZipFile(io.BytesIO(raw))
    out = ""
    for name in z.namelist():
        if name.endswith(".xml"):
            out += z.read(name).decode("utf8", "ignore")
    return re.sub(r"<[^>]+>", "", out).replace("&amp;", "&")


def check(label, ok, why=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"  — {why}"))
    return bool(ok)


def run(agent):
    thread = call("POST", "/threads", {"agentId": agent})["id"]
    print(f"conversation {thread}\n  owner {OWNER}\n  agent {agent}\n")
    passed = total = 0
    doc_slot = None
    doc_version = 0
    body_after_2 = ""

    for said, expect in TURNS:
        began = time.monotonic()
        reply = call("POST", f"/threads/{thread}/messages", {"text": said})
        took = time.monotonic() - began
        tools = [s["name"] for s in reply.get("steps", [])]
        print(f"turn: {said[:58]}…\n  {took:5.1f}s  tools={tools}")
        results = []

        if expect == "doc-exists":
            a = newest(thread, ".docx")
            results.append(check("a document was written", a is not None, "no .docx"))
            if a:
                doc_slot, doc_version = a["slot"], a.get("version", 1)
                body = text_of(thread, doc_slot, doc_version)
                results.append(check("it has the Background and Goals sections",
                                     "Background" in body and "Goals" in body,
                                     "sections missing"))

        elif expect == "doc-grew":
            a = newest(thread, ".docx")
            results.append(check("the same document gained a version",
                                 a is not None and a["slot"] == doc_slot
                                 and a.get("version", 1) > doc_version,
                                 f"slot={a and a['slot']} (was {doc_slot}),"
                                 f" version={a and a.get('version')} (was {doc_version})"))
            if a and a["slot"] == doc_slot:
                doc_version = a.get("version", 1)
                body_after_2 = text_of(thread, doc_slot, doc_version)
                results.append(check("Risks was added", "Risk" in body_after_2, "no Risks section"))
                # The failure this whole eval exists for: a rebuild that
                # answers the new request and quietly drops the old one.
                results.append(check("Background and Goals survived",
                                     "Background" in body_after_2 and "Goals" in body_after_2,
                                     "turn 1's content was lost in the rebuild"))

        elif expect == "sheet-exists":
            s = newest(thread, ".xlsx")
            results.append(check("a spreadsheet was written", s is not None, "no .xlsx"))
            if s:
                sheet = text_of(thread, s["slot"], s.get("version", 1))
                results.append(check("its columns are the ones asked for",
                                     "Risk" in sheet and "Mitigation" in sheet,
                                     "columns missing"))

        elif expect == "doc-retitled":
            a = newest(thread, ".docx")
            results.append(check("the correction is another version of the same document",
                                 a is not None and a["slot"] == doc_slot
                                 and a.get("version", 1) > doc_version,
                                 f"slot={a and a['slot']} version={a and a.get('version')}"))
            if a and a["slot"] == doc_slot:
                doc_version = a.get("version", 1)
                body = text_of(thread, doc_slot, doc_version)
                results.append(check("the new title is in and the old one is out",
                                     "Wiki Migration Plan" in body
                                     and "Wiki Migration Brief" not in body,
                                     f"plan={('Wiki Migration Plan' in body)}"
                                     f" brief-still-there={('Wiki Migration Brief' in body)}"))

        elif expect == "summary":
            answer = reply.get("text", "")
            results.append(check("it names both files it made",
                                 ".docx" in answer and ".xlsx" in answer,
                                 "the answer does not name the files"))
            # Honesty check: nothing invented that was never produced.
            made = {a["path"] for a in artifacts(thread)}
            claimed = set(re.findall(r"[\w./-]+\.(?:docx|xlsx|pptx|pdf)", answer))
            phantom = [c for c in claimed if not any(c in p or p in c for p in made)]
            results.append(check("it claims no file it did not make", not phantom,
                                 "invented: " + ", ".join(phantom)))

        passed += sum(results); total += len(results)
        print()

    kept = [f"{a['path']} v{a.get('version', 1)}" for a in artifacts(thread)]
    print(f"artifacts: {', '.join(kept) if kept else 'none'}")
    print(f"{passed}/{total} checks passed  ({agent})")
    print(f"open it: the conversation is in {OWNER}'s console, thread {thread}")
    return 0 if passed == total else 1


def make_twin(config_id):
    base = call("GET", f"/agents/{AGENT}")
    row = {
        "id": TWIN, "agentName": "eval-twin-conv",
        "description": f"{AGENT}'s twin on {config_id} — created by doc_conversation_eval, removed at the end.",
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
    if not OWNER:
        raise SystemExit("set AGENTS_EVAL_OWNER to the uuid whose console this"
                         " conversation should appear in — it is never defaulted")
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
