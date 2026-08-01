# Six docflows, one conversation each, scored against the validator's own verdict.
#
# The ground truth is not written down here: it is whatever the validator in the
# image says today, read once at the start. A fixture would drift the first time
# the proto changes, and this eval exists to catch exactly that kind of drift.
import json, re, subprocess, sys, time, urllib.request, urllib.error

API = "http://127.0.0.1:8100"
IMAGE = "nuralyio/docflow-validator:latest"
EXAMPLES = "/app/reference/examples"


def call(method, path, body=None, timeout=900):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body else None,
        method=method,
        headers={"content-type": "application/json"},
    )
    r = urllib.request.urlopen(req, timeout=timeout)
    t = r.read().decode()
    return json.loads(t) if t.strip() else None


def truth():
    """What the validator says about every example, by file name."""
    out = subprocess.run(
        ["docker", "run", "--rm", "--entrypoint", "sh", IMAGE, "-c",
         f"ls {EXAMPLES}/*.json && python /app/docflow_validate.py --json {EXAMPLES}/*.json"],
        capture_output=True, text=True,
    )
    body = out.stdout[out.stdout.find("{"):]
    d = json.loads(body)
    by = {}
    for r in d["reports"]:
        name = r["file"].split("/")[-1]
        by[name] = {
            "valid": r["valid"],
            "violations": [
                {
                    "step": v.get("step", ""),
                    "category": v.get("category", ""),
                    # The invented field name is only in the message for
                    # unknown-field; the enum case names the enum instead.
                    "message": v.get("message", ""),
                }
                for v in r.get("violations", [])
            ],
        }
    return by


def body_of(name):
    """The example's bytes, read out of the image the way a customer would send them."""
    out = subprocess.run(
        ["docker", "run", "--rm", "--entrypoint", "sh", IMAGE, "-c", f"cat {EXAMPLES}/{name}"],
        capture_output=True, text=True,
    )
    return out.stdout


def ask(name, tries=3):
    """One conversation per case, as a customer: upload the docflow, then ask.

    The agent is never told where the file is in its own image — that would
    evaluate a lookup it will never do in production. It gets an artifact, which
    is what the console gives it when someone drags a docflow in.
    """
    doc = body_of(name)
    for attempt in range(tries):
        t = call("POST", "/threads", {"agentId": "a-docflow"})
        call("POST", f"/threads/{t['id']}/artifacts", {
            "path": "/" + name, "title": name, "content": doc, "note": "uploaded by the customer",
        })
        r = call("POST", f"/threads/{t['id']}/messages", {
            "text": f"Here is my docflow, /{name}. Is it valid? "
                    f"If it is not, name every violation: the field or value at fault, "
                    f"the step it sits on, and its category.",
        })
        if r["ok"]:
            return r, t["id"]
        err = (r.get("error") or "")
        return r, t["id"]
    return r, t["id"]


def scored(name, want, said):
    """Did the agent reach the validator's verdict, and name what it named?"""
    low = said.lower()
    verdict_ok = ("valid" in low) and (
        ("not valid" in low or "invalid" in low or "violation" in low)
        if not want["valid"] else
        not ("invalid" in low or "not valid" in low)
    )
    # Every violation's step must appear, and the identifying token from its
    # message — the invented field, or the rejected enum value.
    missed = []
    for v in want["violations"]:
        if v["step"] and v["step"].lower() not in low:
            missed.append("step " + v["step"])
        token = ""
        m = re.search(r"Invalid enum value (\w+)", v["message"])
        if m:
            token = m.group(1)
        else:
            m = re.search(r'"?([A-Z][A-Za-z0-9_]{3,})"? ', v["message"])
            token = m.group(1) if m else ""
        if token and token.lower() not in low:
            missed.append(token)
    return verdict_ok, missed


def main():
    want_all = truth()
    print(f"{len(want_all)} examples, ground truth from the validator\n")
    rows = []
    for name in sorted(want_all):
        want = want_all[name]
        r, tid = ask(name)
        said = r.get("text", "") or ""
        steps = len(r.get("steps", []))
        if not r["ok"]:
            rows.append((name, want, "RUN FAILED", (r.get("error") or "")[:70], steps, tid))
            print(f"  {name}: run failed — {(r.get('error') or '')[:70]}")
            continue
        verdict_ok, missed = scored(name, want, said)
        mark = "PASS" if verdict_ok and not missed else "FAIL"
        rows.append((name, want, mark, ", ".join(missed), steps, tid))
        print(f"  {name}: {mark} ({steps} steps)" + (f" — missed {missed}" if missed else ""))
    print()
    passed = sum(1 for r in rows if r[2] == "PASS")
    print(f"{passed}/{len(rows)} passed")
    json.dump(
        [{"file": n, "want": w, "mark": m, "missed": x, "steps": s, "thread": t} for n, w, m, x, s, t in rows],
        open("/tmp/claude-1000/-home-ubuntu-projects/d7a464b1-451d-46f9-a4ea-42eb8304004d/scratchpad/eval-results.json", "w"),
        indent=1,
    )


main()
