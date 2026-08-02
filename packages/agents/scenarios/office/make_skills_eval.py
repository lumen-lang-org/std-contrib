# The office skills eval: one real conversation per builder skill, scored by
# opening the artifact the run produced.
#
# The scorer is total and trivial, and that is the point: base64-decode the
# artifact version, open it with zipfile, assert the format's own marker part
# is inside and the asked-for content is really in the XML. A placeholder
# body ("<docx>...</docx>"), a document that never got written, or a briefing
# the model could not follow all fail here instantly. Every office regression
# to date — the invented import, the wrong environment, the fabricated
# write_artifact success — would have been caught by this file.
#
#     python3 scenarios/office/make_skills_eval.py                 # default agent
#     AGENTS_EVAL_AGENT=a-docflow-gemini python3 .../make_skills_eval.py
#
# Drives the running engine at 127.0.0.1:8100 like every scenario here; run
# it against the local model first — it is the harsher test and the default.
import base64
import io
import json
import os
import sys
import urllib.request
import zipfile

API = os.environ.get("AGENTS_API", "http://127.0.0.1:8100")
AGENT = os.environ.get("AGENTS_EVAL_AGENT", "a-assistant")
USER = '{"uuid":"00000000-0000-0000-0000-00000000e0e1"}'


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


# Each case: the ask, the artifact suffix the briefing promises, the zip part
# that makes the format real, and phrases that must appear inside the part's
# XML — proof the model put the asked-for content in, not just any file out.
CASES = [
    {
        "skill": "make-doc",
        "ask": "Write a one-page Word document titled 'Migration Brief' about moving"
               " our internal wiki to a new platform: a background section, a goals"
               " section with 3 bullets, and a timeline paragraph. Use the make-doc skill.",
        "suffix": ".docx",
        "marker": "word/document.xml",
        "must": ["Migration Brief"],
    },
    {
        "skill": "make-sheet",
        "ask": "Make a spreadsheet with one sheet named Budget listing three line"
               " items with made-up costs: Hosting, Backups, Monitoring."
               " Use the make-sheet skill.",
        "suffix": ".xlsx",
        "marker": "xl/workbook.xml",
        # Shared strings or inline — either way the words are in some part;
        # checked across the whole zip below rather than one member.
        "must": ["Hosting", "Backups", "Monitoring"],
    },
    {
        "skill": "make-deck",
        "ask": "Make a short presentation titled 'Wiki Migration' with two slides:"
               " one on why we are migrating, one on the rollout plan."
               " Use the make-deck skill.",
        "suffix": ".pptx",
        "marker": "ppt/presentation.xml",
        "must": ["Wiki Migration"],
    },
]


def artifact_bytes(thread, suffix):
    """The newest artifact whose path ends with suffix, decoded, or None."""
    arts = call("GET", f"/threads/{thread}/artifacts") or []
    rows = [a for a in arts if a.get("path", "").endswith(suffix)]
    if not rows:
        return None, "no artifact ending " + suffix
    a = rows[-1]
    v = call("GET", f"/threads/{thread}/artifacts/{a['slot']}/versions/{a.get('version', 1)}")
    try:
        return base64.b64decode(v["content"]), ""
    except Exception as e:
        return None, f"undecodable content: {e}"


def score(raw, marker, must):
    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        head = raw[:24]
        return False, f"not a zip (starts {head!r}) — a fabricated body, not a document"
    if marker not in z.namelist():
        return False, f"zip without {marker} — right container, wrong format"
    everything = ""
    for name in z.namelist():
        if name.endswith(".xml"):
            everything += z.read(name).decode("utf8", "ignore")
    missing = [m for m in must if m not in everything]
    if missing:
        return False, "content absent from the document: " + ", ".join(missing)
    return True, ""


def main():
    passed = 0
    for case in CASES:
        t = call("POST", "/threads", {"agentId": AGENT})["id"]
        r = call("POST", f"/threads/{t}/messages", {"text": case["ask"]})
        tools = [s["name"] for s in r.get("steps", [])]
        raw, why = artifact_bytes(t, case["suffix"])
        if raw is None:
            ok, why = False, why
        else:
            ok, why = score(raw, case["marker"], case["must"])
        verdict = "PASS" if ok else "FAIL"
        print(f"{verdict}  {case['skill']:11} tools={tools}"
              + ("" if ok else f"  — {why}"))
        if not ok and r.get("text"):
            print(f"      model said: {r['text'][:160]}")
        passed += ok
    print(f"{passed}/{len(CASES)} passed")
    return 0 if passed == len(CASES) else 1


if __name__ == "__main__":
    sys.exit(main())
