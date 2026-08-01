# The edit_hard_add_external_import_chain case, as a live conversation on the
# gemini docflow agent — the plan's turns 0 to 3, then the harness scores the
# final artifact against the validator and the image's own valid answer.
import json, subprocess, time, urllib.request

API = "http://127.0.0.1:8100"
S = "/tmp/claude-1000/-home-ubuntu-projects/d7a464b1-451d-46f9-a4ea-42eb8304004d/scratchpad"
IMAGE = "nuralyio/docflow-validator:latest"


def call(m, p, b=None, timeout=900):
    req = urllib.request.Request(API + p, data=json.dumps(b).encode() if b else None,
        method=m, headers={"content-type": "application/json"})
    r = urllib.request.urlopen(req, timeout=timeout)
    t = r.read().decode()
    return json.loads(t) if t.strip() else None


# One attempt, no backoff: these agents run on Vertex, which does not 429 us
# in bursts the way the old Mistral key did. A failure is a finding to read,
# not a queue to wait out.
def ask(tid, text):
    return call("POST", f"/threads/{tid}/messages", {"text": text})


def turn(tid, label, text):
    r = ask(tid, text)
    steps = [(s["name"], "ok" if s["ok"] else "X") for s in r.get("steps", [])]
    print(f"== {label}: ok={r['ok']} steps={steps}")
    print((r.get("text") or r.get("error") or "")[:400].replace("\n", " "))
    print()
    return r


doc = open(S + "/print-with-driver.json").read()
t = call("POST", "/threads", {"agentId": "a-docflow-gemini"})
print("thread:", t["id"])
open(S + "/addsteps-thread", "w").write(t["id"])
call("POST", f"/threads/{t['id']}/artifacts",
     {"path": "/print-with-driver.json", "title": "PrintWithDriver", "content": doc, "note": "uploaded by the customer"})

turn(t["id"], "T1 (the request)",
     "Before the AssemblyStep, add a document-import branch made of three new steps in order: "
     "an ExternalDocumentCreation step declaring a PDF from https://example.com/contract.pdf, "
     "then a DocumentDownload step, then an ExternalDocumentConversion step; rewire the transitions "
     "so the flow becomes StartEvent -> ExternalDocumentCreation -> DocumentDownload -> "
     "ExternalDocumentConversion -> AssemblyStep -> ... and set staging cleanup flags on the new "
     "steps where applicable. My docflow is uploaded as /print-with-driver.json.")

turn(t["id"], "T2 (validate + converge)",
     "Validate it and fix everything the validator refuses, until it passes.")

turn(t["id"], "T3 (the flags)",
     "Are the staging cleanup flags set on the new steps? Show me the lines.")

# --- the harness's own verdict ---------------------------------------------------
arts = call("GET", f"/threads/{t['id']}/artifacts")
a = next(x for x in arts if x["path"] == "/print-with-driver.json")
final = call("GET", f"/threads/{t['id']}/artifacts/{a['slot']}/versions/{a['version']}")["content"]
open(S + "/addsteps-final.json", "w").write(final)

p = subprocess.run(["docker", "run", "--rm", "-i", "--entrypoint", "sh", IMAGE, "-c",
    "cat > /tmp/x.json && python /app/docflow_validate.py --json /tmp/x.json"],
    input=final, capture_output=True, text=True)
out = p.stdout[p.stdout.find("{"):]
valid = json.loads(out)["summary"]["invalid"] == 0

ref = subprocess.run(["docker", "run", "--rm", "--entrypoint", "sh", IMAGE, "-c",
    "cat /app/reference/examples/add-steps-import-chain-valid.json"], capture_output=True, text=True).stdout
want = json.loads(ref)
got = json.loads(final)
before = json.loads(doc)

print("=== SCORE ===")
print("artifact version:", a["version"])
print("validator passes:", valid)
print("steps:", sorted(got.get("Steps", {}).keys()))
print("step set matches valid answer:", sorted(got.get("Steps", {}).keys()) == sorted(want.get("Steps", {}).keys()))
print("transitions:", len(got.get("Transitions", {})), "(valid answer has", len(want.get("Transitions", {})), ")")
starts = [v.get("Target") for v in got.get("Transitions", {}).values() if v.get("Source") == "StartEvent"]
print("StartEvent ->", starts)
untouched = all(got.get("Steps", {}).get(k) == before.get("Steps", {}).get(k)
                for k in before.get("Steps", {})
                if k != "AssemblyStep")
print("original non-assembly steps untouched:", untouched)
